# TX-power wall calibration — `maburcal`

An operator ssh'd into the ground station gets their own vtx's per-rate
PA compression walls, measured, applied and verified, in about 75 seconds:

```
$ ssh root@<gs>
# maburcal start
```

No toolchain, no repo checkout, no laptop-side step. This page is the
durable home for the kit — the design spec lives under
`docs/superpowers/specs/` (gitignored, one machine only), so anything that
must survive belongs here instead.

`maburcal` supersedes `bench/txagcbench/` (deleted 2026-09-10). The
measurement history that tool produced — the wall table, the transfer
curve, the comb finding — is still current hardware fact and lives in
`docs/findings/2026-07-16-txagc-calibration.md`. The kit's own bench
validation (2026-09-11 → 2026-09-14) is
`docs/findings/2026-09-11-maburcal-bench.md`.

Run `maburcal` with `[radio] relays = []`. `CalSession` tallies only cards
0 and 1 (`on_cal_frame` drops any higher card id), and relay cards come
after the USB cards in the roster — so on a GS with a single USB card the
relay *is* card 1, and its sweep frames (different antenna, ath9k RSSI)
would enter the cells.

## What a run does

`maburcal start` drives the whole thing from the GS: it sends one command
to `maburgs`' loopback-only `CalControl` listener (`127.0.0.1:8400`,
unreachable off-box), streams progress every 500 ms, and prints a final
table when the drone returns to normal video. Under the hood:

1. **Coarse sweep** (~30 s of sweep time): every 4th relative TXAGC
   index, rel −41..63 (27 cells per row, 216 total — 216 × 140 ms), across
   all 8 MCS rows, 20 frames per cell. The low end is −41 and not the
   rounder −40 so that the grid lands on **+63 exactly**: a no-dip row
   parks at that rail, and the rail has to be a cell the run actually
   measured.
2. **Fine sweep** (~0-41 s of sweep time, skipped for rows with no dip):
   ±8 indices around each row's coarse wall, at full resolution, 100
   frames per cell. The fine pass only sharpens the wall of a row the
   coarse pass already showed a real dip in; if the truncated fine window
   reads no-dip or undetermined, the coarse wall stands. When the fine
   wall lands more than 1 index from the coarse one, the row is flagged
   `drift`.
3. **Apply**: the GS computes final walls and sends them to the drone,
   which validates them, backs up and patches `/etc/mabur.toml`,
   reprograms the per-rate diffs live, and flips `power_mode` to
   `"offset"` — no restart.
4. **Verify** (~2 s of sweep time): the drone immediately sweeps its own
   eight newly parked indices; the GS tallies delivery at each and
   reports it.

Each phase also carries a further ~4 s tail after its last frame
(`phase_slack_ms` in `cal_session.h`) — a listen window the GS waits out
before declaring the phase over and issuing the next command. The
figures above are pure sweep time (cells × (settle + frames × gap), from
`gs/src/cal_plan.h`); the totals below fold in three of these ~4 s tails
(one per phase) on top of that sweep time, plus a small apply/report
overhead — they are not a straight sum of the three headline numbers
above.

On the reference unit a full run is **~72 s** (three rows — MCS 0-2 — never
dip, so they skip the fine phase). A unit whose PA walls every rate runs
closer to 87 s. The GS is **radio-silent while each sweep phase airs**
(`CalSession::radio_silent()`: the phase plus its `phase_slack_ms` tail):
no RCF, no keepalive DISC, nothing but the drone's sweep frames. In the
gaps between phases -- while a phase's `T_CAL_CMD` awaits its ack, and
around the result -- RCF and the DISC keepalive go out as usual, which is
harmless since the drone is not sweeping then. `T_CAL_RESULT` is the one
send made into a silent window, on purpose (it is repeated into verify
until the drone's first verify frame acks it). Video and telemetry both
pause and resume with the session.

`maburcal status` polls a running session; `maburcal abort` cancels one.
None of the three take arguments.

## Prerequisite: the pair must already be linked and flying video

There is no other way to reach the drone. `T_CAL_CMD` rides the same
uplink as everything else, and the drone refuses to enter calibration
without `CAP_CALIBRATE` in the DISC handshake and a session already
`LINKED`. If the link is down, fix that first — calibration cannot be
used to bring it up.

### The drone will be in `RENDEZVOUS` by the end of every run

The GS is radio-silent while each sweep phase airs — the coarse phase
alone is ~34 s with its tail — so the drone's `RcAgent` sees no RCF and no
DISC and ages out of `LINKED` on its own schedule:
`LINKED` → `FAILSAFE` at `link.failsafe_ms` (3 s in the shipped config),
`FAILSAFE` → `RENDEZVOUS` at a further `link.rendezvous_ms` (30 s) — about
33 s into the coarse sweep, on every run. This is expected and benign, not
a symptom: `RENDEZVOUS` is a passive waiting state, and `set_ladder` is
gated on `cal_active` while a session runs (`drone/src/main.cpp`), so the
agent cannot fight the sweep for the radio. The falling edge of
`cal_active` re-applies the operating ladder and TX power together.

Leaving `LINKED` also clears the drone's pairing session (link pairing,
`docs/link-pairing.md`), yet the run's later cal frames -- the next
phase's `T_CAL_CMD` and the `T_CAL_RESULT` sent into the silent verify
window -- are still tagged under the pair the run was going under. So
while a sweep is open the drone keeps accepting cal frames under the
newest pair a cal frame verified under (`RcAgent::verify_cal_frame`'s
`sweep_running` latch), and drops that latch the moment the sweep
closes. The GS side matches it: `CalSession` freezes the tag context at
`start()` (`tag_ctx()`), because the GS keeps beaconing between phases and
can adopt a fresh pair there that the drone has issued but not promoted.

The lapsed session must not move the GS's radios either. While a run is
going (`CalSession::running()` → `ChannelCore`'s `cal_running`)
`ChannelPlan` treats the link as in session, so the search/scout is never
released, and the in-flight hop verdict, hop controller and periodic scout
are all off (`hop_active()` is false) — otherwise a card would leave the
channel being measured mid-sweep and read as `card_disagree` with garbage
walls. A link-pairing move edge armed by a between-phase re-pair is held,
not acted on, until the run ends (`CalMoveEdgeHold`), mirroring the drone,
which defers its own retunes while `cal_active` and replays them after.
The one dwell the scout can still have in flight at `start` (it re-reads
`running()` only once per `dwell_period_ms`, and a dwell is 250 ms against
a 30 ms settle) is waited out: the first `T_CAL_CMD` is not sent while
`dwell_busy` (`cal_cmd_clear`), so no card is off-channel when the coarse
row opens. Net: no GS card changes channel from `start` to `done`.

The operator's job is only to **confirm the pair re-links after each
session**: video should resume within a couple of DISC beacons, with an
IDR at the join. If it doesn't, that is the ordinary stale-caps
restart-deadlock shape and not a calibration bug — see
`docs/deploy.md`.

Corollary: losing the link *during* a run is expected, not an error. The
drone's sweep is open-loop and wall-clock-bounded; it finishes or times
out and restores itself whether or not the GS is still talking. Killing
`maburgs` mid-sweep leaves the drone to time out on its own and resume
flying video with an **unchanged** config — nothing was written, because
nothing reached the apply step.

## One calibration covers every channel

Walls are stored as signed indices **relative to the chip's own TXAGC
anchor** (`radio.rate_walls_rel`, `radio.legacy_wall_rel`). The anchor is
the per-channel-group reference devourer programs from the module's
efuse on every channel set, and the chip adds it itself, so `maburcal` on
any member of the channel set (`radio.channels`, `docs/channel-select.md`)
produces a table that is valid on every member. The anchor never leaves
the drone: it is not in config, not on the wire, not in `cal.log`.
`maburd` re-applies TX power (devourer's `ReApplyTxPower()`) immediately
after every retune, so the diffs always sit on the anchor of the channel
the link is actually on, not on the boot channel's.

Why relative: across three channel groups on one unit (anchors 39 / 53 /
57), the rows with a real PA wall stayed flat to 3-5 indices relative to
the anchor while the absolute wall moved 13-17 with it. Same-channel
repeatability is 0-9 indices (mcs3/4 are the noisy rows). The residual
~1 dB slope toward the highest channel on mcs6/7 is inside the default
1 dB `wall_margin_db`. Table and runs:
`docs/findings/2026-09-11-maburcal-bench.md`.

## Geometry

Put the drone and GS at a normal bench distance — close enough that the
low end of the sweep (weak, low-index transmissions on the fastest MCS
rows) still has a chance to be heard, far enough that the high end
doesn't pin the GS's RX front end into its own compression. The
`saturated` flag below is exactly this second failure watched for you;
if it fires, back off and rerun rather than trusting the table.

## Reading the result

The final table has one row per MCS (0-7), each with a wall, a park
index, verify-pass delivery, and health flags:

```
run nonce=... margin=1.00dB
rate   wall(rel)  park verify   flags
mcs0          63    59    99%   no_dip
mcs1          63    59   100%   no_dip
mcs2          62    58    99%   no_dip
mcs3          45    41    98%
mcs4          22    18    97%
mcs5           6     2    96%   drift
mcs6           9     5    99%
mcs7           5     1    98%
legacy  63 (derived from mcs0)
written: /etc/mabur.toml (backup /etc/mabur.toml.pre-cal)
```

**The wall is the end of the first contiguous ≥90% delivery run**, scanning
upward from the sensitivity floor. Past that first dip, delivery is a
reproducible *comb*, not a cliff — islands of 90%+ delivery reappear at
higher indices. Those islands are **not usable headroom**. This is why the
kit walks the whole range rather than bisecting: a search that stops at
the first "good" reading past a bad one would land inside the comb and
overdrive the PA.

Scoring uses the **best single card**, never the union of both: diversity
protects against fading, not against PA compression (both cards receive
the same degraded waveform), and a union would inflate delivery and push
the wall up — the overdriving direction (`gs/src/cal_analysis.cpp`).

### Health flags

| Flag | Meaning | What to do |
|---|---|---|
| `saturated` | Peak median RSSI crossed the saturation threshold — the GS's own RX front end is compressing, not (only) the drone's PA. | Walls read **low** under this flag, which is the *conservative* direction: it costs some power headroom, never overdrives anything. Safe to ship, but move the drone farther out and rerun if you want a tighter number. |
| `no_dip` | The row never dropped below 90% delivery anywhere in the sweep — there is no compression wall to find, so the rate is parked at the **rail**, `+63`, the top of the chip's 7-bit per-rate diff field. The number is not a measurement; the flag is what says so. | Normal for MCS 0-2 on healthy hardware (BPSK/QPSK never compresses within the sweep's range). If it fires on a higher MCS, that rate is unusually clean — nothing to fix. If it is *missing* on MCS 0-2, see the known defect below. |
| `undetermined` | No cell in the row ever reached 90% delivery at any index — no first-dip exists to find. Reported as `-128` in `cal.log`. | **The config line is left untouched** — the kit never invents a wall from data that can't support one. Check geometry (likely too far for that rate) and rerun if you need a real number. |
| `narrow` | The floor edge (where delivery first reaches 90%, ascending) sits within 4 indices of the wall. The usable window between "too weak to hear" and "compressing" is too thin to trust. | Move closer and rerun; a wall this close to its own floor is not a reliable measurement. |
| `card_disagree` | The two GS RX cards' independently-computed walls differ by more than 2 indices. | Points at an antenna or card problem, not a PA — check cabling/orientation on the disagreeing card before trusting either number. |
| `drift` | The fine pass's wall landed more than 1 index from the coarse pass's wall for the same row, measured about a minute apart. | Informational. The coarse grid steps 4 indices, so small drift is partly resolution; a large one suggests thermal movement in the PA during the run — a rerun after the hardware has settled is reasonable. |

Thresholds are `CalThresholds` in `gs/src/cal_analysis.h` (90 % delivery,
`sat_rssi_dbm` −45, `narrow_span` 4, `card_disagree` 2).

### Why a no-dip row parks at the rail, not an RSSI knee

A row with no compression wall parks at `+63`, the top cell of the coarse
grid, so the parked index is one this very run measured at ≥90 % delivery.
The earlier rule — the RSSI saturation knee, the lowest index within 1 dB
of the row's peak RSSI — was not reproducible (the transfer curve creeps
~0.2 dB/index, so a 1 dB band spans ~5 indices before quantization) and
gave up ~1-1.5 dB on exactly the rates the link falls back to when it is
struggling. MCS 3-7 are the measured product; a no-dip MCS 0-2 row is a
deterministic constant.

### Known defect: one noisy coarse cell reroutes a no-dip row

With 20 frames per coarse cell, a 90 % threshold has no noise margin: a
single cell that loses 3 of 20 frames ends the "first contiguous ≥90 %
run", and a row that should take the no-dip path reports the cell below
the outlier as its wall instead. Because the rail is the top of the sweep,
the error is always in the **low** direction — power given up, never
overdrive — but an outlier low in the range parks that rate many dB low.
The flags never block the apply. The tell is MCS 0-2 coming back
**without** `no_dip`; rerun when that happens. (First seen in two of four
runs on 2026-09-11, `docs/findings/2026-09-11-maburcal-bench.md`.)

### `legacy_wall_rel` is derived, not swept

There is no legacy OFDM mode in mabur's wire encoding
(`common/include/mabur/profile.h`'s `PhyMode` is `{HT, VHT}` only), so the
kit does not sweep a ninth row for it. Instead `legacy_wall_rel` is set to
whatever the MCS0 result comes out to. **This is a stated physical
assumption, not a measurement**: legacy OFDM 6 Mb/s and HT MCS0 are both
BPSK 1/2 over the same OFDM waveform, so their peak-to-average ratio — and
therefore their PA compression wall — should track each other. The
reference config's own numbers corroborate it (both read 63), and the
hardware acceptance checklist below re-checks it on every unit calibrated:
if `legacy_wall_rel` ever diverges meaningfully from the MCS0 result on a
real run, the assumption needs revisiting, not the code.

## When it doesn't work

Three failure shapes fall outside every health flag above, because a flag
is only computed from the sweep phases' own delivery data.

**`maburcal start` refuses immediately, with a one-line reason.** Before
any sweep frame goes out, the GS checks preconditions and returns one of:
`err a calibration session is already running`, `err refused: link is
down`, or `err refused: peer does not advertise CAP_CALIBRATE`. The first
two are exactly what they say — wait for the running session to finish
(or `maburcal abort` it), or get the link back to `LINKED` first. A
half-deployed pair (mismatched `RC_VERSION`) never completes a `SESSION`
handshake at the wire level at all, so it surfaces here as **"link is
down"**, not as the capability error — the capability check is only
reachable once `LINKED` is already true, which a version-mismatched pair
never reaches. If `CAP_CALIBRATE` itself is ever the refusal on a pair
that otherwise links fine, one side predates the kit; rebuild and
redeploy both binaries from the same commit.

**The session starts, then ends in `state=failed` with no video loss and
no config change.** `maburcal start`'s streamed progress lines will show
`state=await_ack` repeating, then `state=failed`. This is the drone never
acknowledging the phase command within `ack_timeout_ms` (3 s, repeated
every 200 ms until then) — the *only* path to `Failed` in `CalSession`,
and it can only happen after `start()` already passed the link/capability
checks above. The reason string it records internally
(`"calibration ack timeout"`) is not surfaced through
`status`/`start`'s output, so `state=failed` with no other detail is all
you get. The most likely real cause is RF, not configuration: the uplink
is lossy by design (30-50% per frame,
`docs/findings/2026-08-14-rcf-uplink-loss.md`), so a genuinely poor link
at that moment can lose all of the ~15 repeats inside the 3 s window even
though it looked `LINKED` a second earlier. Improve geometry/orientation
and retry before suspecting anything else. Nothing was written in this
case — the drone only writes config after reaching `Result`, several
states past `AwaitAck`.

**The `verify` column is blank on every rate.** Read this first, before
the low-delivery case below: a dash in `verify` for *all eight* rates is
not a delivery problem, it means the drone never ran its verify sweep at
all. The report says so explicitly — `not written: walls were measured but
the drone never ran its verify sweep`. Two things produce it:

- The `T_CAL_RESULT` frame never arrived. It rides the same 30-50%-lossy
  uplink as everything else, so the GS repeats it every 200 ms (bounded,
  15 tries) until the drone's first verify frame acks it — the drone
  sweeps verify only after a successful apply, so that frame *is* the ack.
  Fifteen consecutive losses is unlikely but possible on a bad link.
- The drone refused the apply — an out-of-range table, a backup or write
  failure, or a candidate config that would not reload. All of these
  return before verify is armed, and all of them leave `/etc/mabur.toml`
  exactly as it was. `/tmp/mabur.log` on the drone names which
  (`maburd cal: apply_calibration failed: ...`).

A result frame that arrived but failed its pairing tag is counted, not
logged: `cal_auth_rej=N` on the drone's `maburd tx_send:` stats line (it is
cumulative, and only prints while video is flowing, so compare a line from
before the run with one after). The `sweep_running` latch described under
"The drone will be in `RENDEZVOUS`" is what keeps this at zero on a
normal run.

Either way **nothing was written**. Re-run; if it repeats, read the drone
log before touching geometry.

**One rate reads `0%` in `verify` while its neighbors show real
percentages.** This looks similar to the two shapes above but means
something different from both, and the report is deliberately built to
tell them apart:

- A `-` in `verify` together with `-` in the wall and park columns and
  `undetermined` in flags means this rate's wall was never determined at
  all — nothing was ever parked for it, so there was nothing to verify.
  Benign, and unrelated to the drone's radio. (A `callog 1`/`2` file
  shows its old sentinel, `-1`, in the wall column instead.)
- `-` in `verify` on *every* rate, alongside `not written`, means the
  drone's verify sweep never ran at all (the previous case above) — no
  rate was confirmed, full stop.
- `0%` on one rate, with `written: /etc/mabur.toml` still printed and
  other rates showing real delivery, means this rate genuinely *was*
  parked, the drone genuinely *did* sweep verify (proven by every other
  rate's nonzero reading), and this one rate's parked power is dead —
  the GS heard nothing there at all. This is the single most important
  reading the verify pass exists to produce, and it must not be confused
  with either "-" case above: unlike them, it says the config on the
  drone right now is untransmittable at this MCS.

  The most likely causes are specific to that one rate: a wall measured
  too high for it (the coarse/fine sweep's own dip landed a bit
  optimistic, without quite tripping a flag), or an antenna/geometry
  problem that only affects that rate's bandwidth or the RX card that
  happens to win verify's single-card best-of for it. Re-run first — a
  repeat pins it as real rather than a one-off miss on the verify pass
  itself. If it repeats, treat that MCS row as unreliable: widen
  `radio.wall_margin_db` on the drone if several rates show the same
  shape, or avoid that rate in the ladder (`link.max_mcs`) until a
  rerun at different bench geometry gives it a real number.

**Verify delivery reads low on a rate that has a number there and no flag
at all.** Flags are computed from the coarse/fine sweep data; the verify
pass has none of its own; a rate can measure a clean wall and still show
poor delivery when the drone parks there a minute or two later. Likely
causes are geometry having moved between the sweep and the verify pass,
or a wall estimate that a flag should have caught but the sweep data
didn't quite cross the threshold for. There is no automatic signal for
this beyond reading the `verify` column yourself — if a rate reads low
there, treat that number over the flag: rerun (a `drift` flag on the same
rate in the rerun would corroborate it), or back the parked power off by
widening the margin — edit `radio.wall_margin_db` in `/etc/mabur.toml` on
the drone and re-run — and check whether verify delivery recovers.

`maburcal start` takes no arguments, and in particular there is no
`--margin`. `wall_margin_db` is the operator's safety choice, hand-set on
the drone and applied exactly once, there; `maburcal` patches
`rate_walls_rel`, `legacy_wall_rel` and `power_mode`, never the margin.
The report's `park` column uses the GS's own margin (1.0 dB, the
`margin=` on the run's header line); the drone parks verify at its own
`wall_margin_db`, and the GS tallies verify by rate, so a differing drone
margin changes only what `park` predicts, not the verify reading.

## What gets written, and how to roll back

`maburcal` patches exactly three keys in `/etc/mabur.toml`:
`radio.rate_walls_rel`, `radio.legacy_wall_rel`, and `radio.power_mode`
(set to `"offset"`). The patch is line-surgical — every comment and every
other key survives untouched, because this file is also
`bundle/mabur.default.toml` verbatim (see below).

Before writing, the candidate values are validated with the exact same
derivation and range check `maburd` uses at boot (`drone/src/config.cpp`)
— every relative wall in `[-64, 63]` and `rel − round(wall_margin_db · 4)
≥ −64` under `power_mode = "offset"` — a fresh `mabur::load_config()` call
against the *candidate* file, not just a TOML-syntax check, since syntax
passing is not the same as boot succeeding. If validation fails, or the
rewritten file somehow fails to reload, nothing is touched: the original config is copied
to `/etc/mabur.toml.pre-cal` only once the new file has already proven
loadable, and the rename that publishes it is atomic
(`drone/src/cal_apply.h`). This is deliberately
the same shape as every other config-load safety net in this codebase
(`docs/deploy.md`): a config `maburd` cannot load makes its wrapper
respawn it forever at 2 s, which turns a calibration run into a trip for a
laptop and a serial cable.

**To roll back a calibration**, restore the pre-run file on the drone and
restart `maburd` (from a non-interactive ssh command, start the wrapper
under `setsid` — `docs/deploy.md`):

```sh
cp /etc/mabur.toml.pre-cal /etc/mabur.toml
/etc/init.d/S00mabur restart
```

`.pre-cal` is overwritten on every successful run, so it always holds the
config from immediately before the *most recent* calibration — not
necessarily the factory-default one.

## Walls are re-derived after a wipe, never restored from the bundle

The shipped bundle files (`bundle/mabur.default.toml` included) are the
live flight configs off the drone and GS, verbatim, down to every knob —
the standing rule is "retune in the repo or it's lost at the next wipe."
**That rule does not extend to the walls section.** `rate_walls_rel` and
`legacy_wall_rel` are per-unit PA measurements, relative to the chip's own
efuse anchor; the numbers in `bundle/mabur.default.toml` are one specific
board's, kept there only as a documented reference (and inert while the
bundle's `power_mode = "none"`). Restoring a wiped drone from the bundle
default, switching it to `"offset"` and calling it done would silently fly
someone else's PA compression points.

After any drone wipe or replacement, the walls section is the one part of
the config that must be **re-measured with `maburcal start`**, not copied
from git. Everything else in the bundle is fair game to restore as-is.

## Offline analysis: `maburcal report`

```sh
maburcal report /media/dvr/log/cal/cal.log
```

re-renders a saved run with no daemon involved — the same table `start`
prints live, computed straight from the log file. This is the entire
replacement for `bench/txagcbench`'s deleted Python analyzer: raw per-cell
tallies, final walls, and verify results all survive in `cal.log`, so
deleting the old tool cost the tool, not the ability to examine a run
after the fact.

**Where `cal.log` lives.** It is written regardless of `debug_log.enable`
— a calibration run is a bounded, rare, deliberately-triggered trace, not
the continuous per-second logging that knob exists to gate. With debug
logging on it goes into that session's directory
(`<debug_log.dir>/NNNN/cal.log`); with it off — the shipped GS bundle —
it goes to `<debug_log.dir>/cal/cal.log`, i.e. `/media/dvr/log/cal/cal.log`
(`gs/src/main.cpp`). `maburgs` logs the resolved path at each run's start
(`calibration started -> <dir>/cal.log`), and `maburcal start` finds it
from there.

**Format** (`gs/src/cal_log.h`; `gs/bundle/maburcal` is the in-repo reader
and changes with it):

```
callog 3                                      # once per file
R <nonce> <margin_db>                         # once per calibration run
C <phase> <rate> <idx> <expected> <recv0> <recv1> <corrupt> <rssi0> <rssi1>
W <rate> <wall> <floor> <best_card> <flags>   # per rate, at each phase end
V <rate> <idx> <pct>                          # per verify cell
```

Every index is signed and relative to the drone chip's anchor. A card
with no RSSI in a cell writes `-999`; an undetermined rate writes `-128`
for wall and floor. `W` rows are last-write-wins (coarse, then fine).
`flags` is a bitmask: 1 `no_dip`, 2 `undetermined`, 4 `narrow`,
8 `saturated`, 16 `card_disagree`, 32 `drift`. A `V` row means "this rate
was in the verify plan", never "verified clean" — `pct` 0 is a real
measurement.

**One `cal.log` can hold several runs.** The normal retry path is: run,
see a `narrow` or `saturated` flag, reposition the drone, run again — and
nothing about a retry rotates the file, so the second run's records land
in the same file as the first's. Each run is delimited by its own `R`
line; `maburcal report` renders every run the file holds, in order, and
each run's `C`/`W`/`V` rows are scoped to the `R` line that started it (a
rate's park index always uses *that run's own* margin, never a different
run's).

Older files stay readable: `callog 1` and `2` carry absolute indices and
a `base_ref` on the `R` line (`-1` = undetermined); `callog 2` existed
briefly on 2026-09-11 with two per-card EVM columns on `C`, reverted
because the sweep frames carry no EVM reading
(`docs/findings/2026-09-11-maburcal-bench.md`).

## Hardware acceptance checklist

Work through this on deployed hardware after any change to the kit. The
2026-09-11 / 2026-09-14 passes are recorded in
`docs/findings/2026-09-11-maburcal-bench.md`; the rows that say "capture
to confirm" were not exercised there. A kit change that touches
`cal_wire.h` or the RC frames is a two-device flag day — deploy both
binaries before judging anything (`docs/deploy.md`).

### 1. `ausniff`

```sh
python3 tools/bench/ausniff.py    # expect ~59.8 fps, 0 gaps
```

This is the standing regression gate for any `maburgs` change — it reads
the AU ring from outside the daemon, so it is not circular the way
gating on the sideport would be. Take a second pass if the first reports
a `frame_id_gap`; the first pass after a restart can show a phantom one.

### 2. `maburcal start` and the acceptance table

```sh
ssh root@<gs> maburcal start
```

Check every one of these against the run:

| Check | Expected |
|---|---|
| Wall table | `rel [63,63,62,45,22,6,9,5] ± run noise (mcs5-7 within ±5)` on the reference unit |
| MCS 0-2 | flagged `no_dip`, wall = `+63` |
| `legacy_wall_rel` | equals the MCS0 result (63) |
| Run duration | ~72 s |
| Radio silence | no GS PPDUs on air during a phase (capture to confirm) |
| TX power restored after a session | after BOTH a successful and an aborted calibration, confirm the index override is cleared (`-1`) and the rate-diff table is live — not a flat index masking it |
| Ladder restored after a session | video resumes on the operating ladder, not the last swept cell's |
| venc ring over a full session | ~180 s with nobody draining it: confirm no fault, and that the resume burst of ring-resident stale frames does not wedge the pipeline |
| devourer TX-setter thread safety | the TX writer thread calls power setters while the agent thread calls GetThermalStatus/GetTxStats — undocumented in devourer; watch for corruption or hangs |
| Video-silence fallback | a full coarse+fine+verify run sends zero video for ~72 s; confirm it does not trip the rendezvous/continuity fallback into a confusing intermediate state, and that video resumes cleanly |
| cal.log written | present at the path the GS logged at calibration start, even though `debug_log.enable = false` in the shipped config |
| Verify pass | high delivery at every parked index |
| Config | `/etc/mabur.toml` patched, comments intact, `.pre-cal` is the byte-identical original |
| Video | resumes with no restart |
| Re-link after the session | the drone is in `RENDEZVOUS` by ~33 s into the coarse phase, every run (see above) — confirm it rejoins and that an IDR lands at the join, after BOTH a successful and an aborted run |

### 3. Interruption test

Kill `maburgs` mid-sweep. Confirm the drone returns to flying video on
its own (open-loop timeout) with an **unchanged** `/etc/mabur.toml` — no
partial write, no `.pre-cal` created, no lingering `"offset"` mode from a
run that never reached apply.

### 4. Two open measurements

These are tuning knobs shipped with placeholder values, not defects —
both are safe to leave as shipped, but cheap to improve on real hardware:

- **`settle_ms`** (`kSettleMs` in `gs/src/cal_plan.h`, 100 ms): inherited
  from `txagcbench`'s default and never measured against this hardware's
  real TXAGC settle time. The coarse pass spends ~21.6 s settling and only
  ~8.6 s sending at 100 ms. Sweep 20 / 50 / 100 ms and confirm the wall
  table is unchanged at each; if 20 ms reproduces it, set
  `kSettleMs = 20` and a run drops to roughly 45 s.
- **`sat_rssi_dbm`** (`gs/src/cal_analysis.h`, -45.0): inherited from
  `txagcbench`'s bench precondition ("attenuate until max RSSI
  ≤ -45 dBm"). The 2026-07-29 clean reference run peaked at -67 dBm, well
  clear of it, so confirm the flag does not fire on a normal-geometry run,
  then deliberately provoke it by moving the drone within a metre of the
  GS and confirm it does. If the threshold never fires at any workable
  bench geometry it is discriminating against nothing and should be
  raised until it actually separates a good run from a saturated one.
