# Orange Pi: the release thread, the v4l2req blocking poll, and lead 4

**Status:** closed — the branch runs on the Orange Pi unchanged apart from
`V4l2ReqBackend` implementing `PollWait`, and lead 4 holds there with no
burned recorder to disturb it. Reference: `docs/opi-zero2w.md` ("Decode
path"), `docs/phase-lock.md` ("Threads", "Configuration"),
`docs/findings/2026-10-21-release-thread-gate.md` (the Radxa gate).

Bench, 2026-10-21, Orange Pi Zero 2W GS on the 1080p60 desktop monitor,
`backend = "v4l2req"`, `stream = true`, raw DVR, one radio card, channel
pinned, drone at 1920x1080@60. Four player builds in turn, same maburgs
(unchanged between them), one debug-log session; every window is 5 min
read with `tools/bench/latchgate.py` and per-frame percentiles over
`frame.log` (`dec = t_decoded − t_complete`, `dsp`, `e2e`). The lock was
let settle 60 s after each player restart before the window opened. A
miss is a frame whose commit latched a vblank late.

## Results

| Arm | Build | Lead | Frames | Misses | dec p50 / p99 | reg p50 | dsp p50 | e2e p50 / p99 | latch max | rlate max |
|---|---|---|---|---|---|---|---|---|---|---|
| C | before the release thread (the fps100 base) | 5 | 18000 | 0 | 2.94 / 5.42 | 10.06 | 4.93 | 32.81 / 34.16 | 4.87 | — |
| A | release thread, no PollWait on v4l2req | 5 | 17999 | 0 | 2.15 / 4.03 | 9.46 | 4.96 | 31.05 / 33.87 | 4.91 | 0.12 |
| B | release thread + `V4l2ReqBackend::PollWait` | 5 | 17999 | 0 | 1.65 / 3.64 | 9.34 | 4.96 | 30.65 / 33.39 | 4.88 | 0.11 |
| A again | as A, after B and C | 5 | 17996 | 0 | 2.14 / 4.02 | 9.63 | 4.96 | 31.81 / 34.67 | 4.88 | 0.14 |
| B | as B | 4 | 17999 | 0 | 1.75 / 3.65 | 9.25 | 3.96 | 29.82 / 32.59 | 3.87 | 0.19 |

All times ms. `latch` is `t_flip − t_commit`; `rlate` is the release
thread's lateness (reg.log, max over the window).

## What it says

- **The release thread takes 0.8 ms off `dec` and about 1.8 ms off e2e
  on this board** (C → A). Before it, the housekeeping loop collected
  decoded frames between its other work; the decode-output thread
  collects them as they land.
- **The blocking poll takes another 0.5 ms off `dec`** (A → B), the
  expected half of the pump's 1 ms fallback sleep: without `PollWait`
  the pump woke every 1 ms and a decoded picture waited up to that long
  in the handoff's ready queue.
- **The repeat A window reproduces A's `dec` to 0.01 ms**, so the
  decode-side differences are the builds, not drift. e2e moved 0.8 ms
  between the two A windows: that is link transit (`reg` and the
  allowance follow it), the reason `dec` is the figure to compare.
- **Lead 4 holds**: zero misses in 5 min, every commit 3.79-3.87 ms
  ahead of its vblank, the release thread never later than 0.19 ms.
  The Radxa's lead-4 failure is under the burned recorder, which this
  board does not have, so the OPi gets the lower lead for free.
- **The release thread's `SCHED_FIFO` request is granted** on the image
  (`rt=1` on every reg.log line).

## Not covered

- The drone's 1728x972@100 mode: the monitor only offers 1080p at 60 Hz.
  It does offer 2560x1440 at 99.95 Hz and the H618 HDMI driver admits it
  (the H6 rule, 594 MHz), but whether the HDMI PHY and the DE33 scan it
  out, and whether Cedrus keeps up at 100 fps, is untested.
- Lead 3.
