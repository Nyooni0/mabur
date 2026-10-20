#!/usr/bin/env python3
"""Test for tools/bench/latchgate.py: the release-thread bench gate reads a
synthetic frame.log/reg.log pair and reports missed vsync latches
(`t_flip - t_commit > 12 ms`) and the regulator's pend/pdrop delta over a
--from/--to window.

Covers: a miss plus a pend delta (exit 1), a clean pair (exit 0), `#
reglog 2` tolerance (no rlate/hand -> `-`), and `--skip-after-flush`
excluding a miss that falls in the window right after a detected
discontinuity (a rise in reg.log's cumulative `disconts=`) while still
counting one further out.
"""
import os
import subprocess
import sys
import tempfile
import unittest

LATCHGATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                          'tools', 'bench', 'latchgate.py')


def frame_row(t_flip, t_commit, dsp=4000, e2e=9000):
    pts = t_flip % (1 << 32)
    t_submit = t_flip - 20000
    t_complete = t_flip - 18000
    t_decoded = t_flip - 10000
    t_release = t_flip - 8000
    # t_flip pts fid sid len flags slices t_submit t_complete t_decoded
    # t_release enc dq air fec dec reg dsp e2e exact t_commit pbits
    return (f"{t_flip} {pts} 1 0 1000 0x00 1 {t_submit} {t_complete} "
            f"{t_decoded} {t_release} 500 200 300 100 1000 200 {dsp} {e2e} 1 "
            f"{t_commit} 0x00")


def reg_row(t, pend=0, pdrop=0, disconts=0, rlate=None, hand=None):
    base = (f"{t} regulator: held=1 late=0 replaced=0 disconts={disconts} "
            f"hold_ema=0.00ms present_jitter=0.00ms vsync=locked skips=0 "
            f"fallback=0 pend={pend} heals=0 pdrop={pdrop} chained=0 chain=0 "
            f"chain_max=0 chains=0 cuts=0 alw=2.0ms lslot=0 lock=off "
            f"lerr=0.00ms loff=0 lctr=0.0 present=60 acq=1/2 req=1/2 "
            f"ioctl=300/900")
    if rlate is not None:
        base += f" rlate={rlate[0]}/{rlate[1]} hand={hand[0]}/{hand[1]} rt=1"
    return base


def write(d, name, text):
    with open(os.path.join(d, name), 'w') as f:
        f.write(text)


def run(d, t0=0, t1=2, skip=24):
    return subprocess.run(
        [sys.executable, LATCHGATE, d, '--from', str(t0), '--to', str(t1),
         '--skip-after-flush', str(skip)],
        capture_output=True, text=True)


class LatchgateTest(unittest.TestCase):
    def test_miss_and_pend_delta_trip_the_gate(self):
        with tempfile.TemporaryDirectory() as d:
            rows = [
                frame_row(1_000_000, 995_000),       # 5 ms, clean
                frame_row(1_016_666, 1_000_666),     # 16 ms, a miss
                frame_row(1_033_332, 1_028_332),     # 5 ms, clean
            ]
            write(d, 'frame.log', '# framelog 3\n' + '\n'.join(rows) + '\n')
            write(d, 'reg.log', '# reglog 3\n'
                  + reg_row(1_000_000, pend=3, rlate=(100, 200), hand=(50, 100)) + '\n'
                  + reg_row(1_500_000, pend=4, rlate=(120, 250), hand=(60, 110)) + '\n')
            r = run(d)
        self.assertIn('misses 1', r.stdout, r.stdout)
        self.assertIn('pend +1', r.stdout, r.stdout)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)

    def test_clean_pair_exits_zero(self):
        with tempfile.TemporaryDirectory() as d:
            rows = [
                frame_row(1_000_000, 995_000),
                frame_row(1_016_666, 1_011_666),
                frame_row(1_033_332, 1_028_332),
            ]
            write(d, 'frame.log', '# framelog 3\n' + '\n'.join(rows) + '\n')
            write(d, 'reg.log', '# reglog 3\n'
                  + reg_row(1_000_000, pend=3, rlate=(100, 200), hand=(50, 100)) + '\n'
                  + reg_row(1_500_000, pend=3, rlate=(90, 180), hand=(45, 90)) + '\n')
            r = run(d)
        self.assertIn('misses 0', r.stdout, r.stdout)
        self.assertIn('pend +0', r.stdout, r.stdout)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_reglog_2_prints_dash_for_rlate_and_hand(self):
        with tempfile.TemporaryDirectory() as d:
            rows = [
                frame_row(1_000_000, 995_000),
                frame_row(1_016_666, 1_011_666),
            ]
            write(d, 'frame.log', '# framelog 3\n' + '\n'.join(rows) + '\n')
            write(d, 'reg.log', '# reglog 2\n'
                  + reg_row(1_000_000, pend=3) + '\n'
                  + reg_row(1_500_000, pend=3) + '\n')
            r = run(d)
        self.assertIn('rlate -', r.stdout, r.stdout)
        self.assertIn('hand -', r.stdout, r.stdout)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_skip_after_flush_excludes_only_the_near_miss(self):
        with tempfile.TemporaryDirectory() as d:
            rows = []
            for i in range(40):
                t_flip = i * 16667
                miss = i in (10, 30)
                t_commit = t_flip - (16000 if miss else 5000)
                rows.append(frame_row(t_flip, t_commit))
            write(d, 'frame.log', '# framelog 3\n' + '\n'.join(rows) + '\n')
            # disconts rises between the two reg.log lines: a discontinuity
            # happened somewhere in (0, 200000] us; the proxy anchors the
            # flush at the EARLIER line's stamp (t=0), so --skip-after-flush
            # 24 (the default) drops frame.log rows 0..23 -- row 10's miss
            # is in that span, row 30's is not.
            write(d, 'reg.log', '# reglog 3\n'
                  + reg_row(0, pend=0, disconts=0, rlate=(100, 200), hand=(50, 100)) + '\n'
                  + reg_row(200_000, pend=0, disconts=1, rlate=(100, 200), hand=(50, 100)) + '\n')
            r = run(d, t0=0, t1=1, skip=24)
        self.assertIn('frames 40', r.stdout, r.stdout)
        self.assertIn('misses 1', r.stdout, r.stdout)

    def test_missing_logs_exit_2(self):
        with tempfile.TemporaryDirectory() as d:
            r = run(d)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)


if __name__ == '__main__':
    unittest.main()
