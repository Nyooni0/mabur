#!/usr/bin/env python3
"""latchgate.py -- the release thread's bench gate: missed vsync latches and
release-thread lateness over a time window, read straight from a maburplay
debug-log session directory (frame.log + reg.log; docs/observability.md).

A "miss" is a frame.log row whose kernel latch ran past the lead:
`t_flip - t_commit > 12 ms` (frame.log's own `t_flip - t_commit` is "the
kernel's latch", docs/observability.md "frame.log"). A row with `t_commit
== 0` (the presenter parked the frame instead of committing it) has no
latch to measure and is never a miss. `dsp`/`e2e` are frame.log's own
per-frame segment columns (seg[6]/seg[7]) -- NOT reg.log tokens: the
regulator line carries no `dsp=`/`e2e=` field, only `rlate=`/`hand=` for
the release thread's own lateness and hand-over, so this reads dsp/e2e as
true percentiles over the window's frames and rlate/hand as the max of
each 1 Hz reg.log line's own already-aggregated p99/max (a window p99
recomputed from raw per-frame samples is not recoverable from reg.log).

`--skip-after-flush N` excludes miss rows in the N frame.log rows
following a flush/discontinuity from the miss count (not from `frames N`,
which still counts them). Neither file carries a flush/discontinuity
event of its own -- no frame.log flag, no reg.log token -- so this uses
reg.log's cumulative `disconts=` counter as the only observable proxy: a
rise between two consecutive reg.log lines means a discontinuity
happened somewhere in that 1-second gap, and the EARLIER line's stamp is
taken as the flush time (the conservative bound: it widens the skip
window rather than narrowing it). A discontinuity already reflected in
the very first reg.log line of a session cannot be detected this way
(nothing to compare it against) and goes un-skipped.

`reg.log`'s `rlate=`/`hand=` tokens arrived with reglog 3; `# reglog 2`
rows (and reglog-2-only "off" lines) lack them and print `-` for both.
`frame.log` needs the `t_commit`/`pbits` columns (framelog 3) that misses
are computed from; an older frame.log is refused as unreadable.

Usage: python3 tools/bench/latchgate.py <session-dir> --from <mono_s>
         --to <mono_s> [--skip-after-flush 24]
  <session-dir>       a debug-log session directory (tools/session.py);
                       must have both frame.log and reg.log
  --from/--to          the analysis window, CLOCK_MONOTONIC seconds --
                       the same clock frame.log's `t_flip` and reg.log's
                       row stamp are already in (no unit conversion, no
                       relative-to-first-row rebasing)
  --skip-after-flush   frame.log rows after a detected flush to exclude
                       from the miss count (default 24)

All latency figures in the printed line (pend/pdrop excepted, which are
cumulative counts) are microseconds, frame.log/reg.log's native unit.

`pend`/`pdrop`'s `+P`/`+D` are reset-tolerant growth across the window's
reg.log rows, not last-minus-first: a player restart resets both
counters to 0 mid-window, and a plain subtraction would read that as a
negative delta that cancels real misses out of the exit-code sum (the
same convention as tools/flightreport.py's `_counter_growth` -- a value
going backwards contributes its post-restart value, never a negative
one).

Exit code 1 when `misses + pend-delta > 0` (the brief's literal gate;
`pdrop` is reported but does not itself trip the gate), 0 otherwise,
2 if the session directory or its logs can't be read.

(tests/test_latchgate.py)
"""
import argparse
import bisect
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import session as _session  # tools/session.py

MISS_US = 12000  # 12 ms


def counter_growth(vals):
    """Reset-tolerant delta across a cumulative counter's values in a
    window, same convention as tools/flightreport.py's _counter_growth: a
    player restart (the counter going backwards, e.g. pend 10 -> 0) is not
    a negative delta, it is a reset, and the post-restart value is the
    growth since it (0, then 0 -> 2 contributes +2). A plain monotonic
    counter still just sums to last-first. Needs at least 2 values to mean
    anything; the caller is responsible for that check."""
    total = 0
    prev = None
    for v in vals:
        if prev is not None:
            total += v if v < prev else v - prev
        prev = v
    return total


def pct(values, q):
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, int(q * len(s)))]


def parse_frame_log(path):
    """(version, rows); rows = [{'t_flip','t_commit','dsp','e2e'}], sorted
    by t_flip. Rows shorter than framelog-3's 22 columns are skipped (an
    older row has no t_commit/pbits to compute a miss from)."""
    version = None
    rows = []
    with open(path) as f:
        for line in f:
            if line.startswith('# framelog '):
                try:
                    version = int(line[len('# framelog '):].split()[0])
                except (ValueError, IndexError):
                    pass
                continue
            if line.startswith('#') or not line.strip():
                continue
            tok = line.split()
            if len(tok) < 22:
                continue
            try:
                rows.append({'t_flip': int(tok[0]), 'dsp': int(tok[17]),
                             'e2e': int(tok[18]), 't_commit': int(tok[20])})
            except ValueError:
                continue
    rows.sort(key=lambda r: r['t_flip'])
    return version, rows


def parse_reg_log(path):
    """(version, rows); rows = [{'t', 'pend'?, 'pdrop'?, 'disconts'?,
    'rlate_p99'?, 'rlate_max'?, 'hand_p99'?, 'hand_max'?}], sorted by t.
    A key is present only when the line carried it (regulator disabled ->
    no pend/pdrop/disconts; reglog 2 -> no rlate/hand)."""
    version = None
    rows = []
    with open(path) as f:
        for line in f:
            if line.startswith('# reglog '):
                try:
                    version = int(line[len('# reglog '):].split()[0])
                except (ValueError, IndexError):
                    pass
                continue
            if line.startswith('#') or not line.strip():
                continue
            tok = line.split()
            if len(tok) < 2 or tok[1] != 'regulator:':
                continue
            try:
                t = int(tok[0])
            except ValueError:
                continue
            kv = dict(t.split('=', 1) for t in tok[2:] if '=' in t)
            row = {'t': t}
            for key in ('pend', 'pdrop', 'disconts'):
                if key in kv:
                    try:
                        row[key] = int(kv[key])
                    except ValueError:
                        pass
            if 'rlate' in kv and 'hand' in kv:
                try:
                    rp99, rmax = (int(x) for x in kv['rlate'].split('/'))
                    hp99, hmax = (int(x) for x in kv['hand'].split('/'))
                    row['rlate_p99'], row['rlate_max'] = rp99, rmax
                    row['hand_p99'], row['hand_max'] = hp99, hmax
                except ValueError:
                    pass
            rows.append(row)
    rows.sort(key=lambda r: r['t'])
    return version, rows


def flush_times(reg_rows):
    """reg.log rows where `disconts` is both present and comparable with
    the previous such row: a rise marks a discontinuity in that gap, and
    the EARLIER row's stamp is kept (the conservative proxy -- see module
    docstring)."""
    out = []
    prev = None
    for r in reg_rows:
        if 'disconts' not in r:
            continue
        if prev is not None and r['disconts'] > prev['disconts']:
            out.append(prev['t'])
        prev = r
    return out


def skip_indices(frame_rows, flushes, n):
    """Indices into `frame_rows` (already sorted by t_flip) that fall in
    the first `n` rows at-or-after each flush time."""
    if n <= 0 or not flushes:
        return set()
    flips = [r['t_flip'] for r in frame_rows]
    out = set()
    for ft in flushes:
        i = bisect.bisect_left(flips, ft)
        out.update(range(i, min(len(frame_rows), i + n)))
    return out


def analyze(session_dir, t0_s, t1_s, skip_after_flush=24):
    sess = _session.resolve(session_dir)
    if sess.frame is None or sess.reg is None:
        raise LookupError(f"{session_dir}: missing frame.log or reg.log")
    fversion, frame_rows = parse_frame_log(sess.frame)
    rversion, reg_rows = parse_reg_log(sess.reg)
    if fversion is None or fversion < 3:
        raise ValueError(
            f"{sess.frame}: needs '# framelog 3' or later (has {fversion}); "
            "misses are computed from the t_commit/pbits columns framelog 3 adds")
    if rversion is None:
        raise ValueError(f"{sess.reg}: no '# reglog N' marker")

    lo, hi = t0_s * 1e6, t1_s * 1e6
    flushes = flush_times(reg_rows)
    skip = skip_indices(frame_rows, flushes, skip_after_flush)

    win = [(i, r) for i, r in enumerate(frame_rows) if lo <= r['t_flip'] <= hi]
    misses = sum(1 for i, r in win
                 if r['t_commit'] != 0 and r['t_flip'] - r['t_commit'] > MISS_US
                 and i not in skip)
    dsp_vals = [r['dsp'] for _, r in win]
    e2e_vals = [r['e2e'] for _, r in win]

    win_reg = [r for r in reg_rows if lo <= r['t'] <= hi]

    def delta(key):
        vals = [r[key] for r in win_reg if key in r]
        return counter_growth(vals) if len(vals) >= 2 else 0

    rl = [r for r in win_reg if 'rlate_p99' in r]
    return {
        'frames': len(win), 'misses': misses,
        'pend_delta': delta('pend'), 'pdrop_delta': delta('pdrop'),
        'rlate': (max(r['rlate_p99'] for r in rl), max(r['rlate_max'] for r in rl)) if rl else None,
        'hand': (max(r['hand_p99'] for r in rl), max(r['hand_max'] for r in rl)) if rl else None,
        'dsp_p50': pct(dsp_vals, .5),
        'e2e_p50': pct(e2e_vals, .5), 'e2e_p99': pct(e2e_vals, .99),
    }


def fmt(v):
    return '-' if v is None else str(v)


def fmt_pair(p):
    return '-' if p is None else f"{p[0]}/{p[1]}"


def format_line(r):
    return (f"frames {r['frames']}  misses {r['misses']} "
            f"(late-latch rows, flip-commit > 12 ms)  "
            f"pend +{r['pend_delta']}  pdrop +{r['pdrop_delta']}  "
            f"rlate {fmt_pair(r['rlate'])}  hand {fmt_pair(r['hand'])}  "
            f"dsp {fmt(r['dsp_p50'])}  e2e {fmt(r['e2e_p50'])}/{fmt(r['e2e_p99'])}")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__.split('\n\n')[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    ap.add_argument('session_dir')
    ap.add_argument('--from', dest='t0', type=float, required=True)
    ap.add_argument('--to', dest='t1', type=float, required=True)
    ap.add_argument('--skip-after-flush', type=int, default=24)
    args = ap.parse_args()

    try:
        r = analyze(args.session_dir, args.t0, args.t1, args.skip_after_flush)
    except (OSError, LookupError, ValueError) as e:
        print(f"latchgate: {e}", file=sys.stderr)
        sys.exit(2)

    print(format_line(r))
    sys.exit(1 if (r['misses'] + r['pend_delta']) > 0 else 0)


if __name__ == '__main__':
    main()
