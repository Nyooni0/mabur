# Phase lock

The GS steers the drone's sensor frame rate so that every frame's
capture-time slot sits a fixed margin before the vblank release it lands
on. Locked, glass latency is flat (no sensor/panel beat sawtooth) and the
regulator places frames by capture time, so late-tail frames keep their
slot. The evidence is `docs/findings/2026-10-17-phase-lock-spike.md` and
`docs/findings/2026-10-17-phase-lock-spike-2.md`.

## The loop

1. **maburplay measures.** For every frame, `FrameRegulator` computes
   `want = pts + delivery floor + allowance` (the lateness window, p1 and
   p99 − p1 + 1 ms capped at `display.sched_cap_ms`) and the release of
   the first vblank at or after it. The margin is release − want, in
   [0, P). It depends only on the capture clock, the window and the vblank
   grid, not on the frame's own arrival. It is measured in both placement
   modes.
2. **maburplay decides** (`gs/player/src/phase_lock.h`). Each 1 s window:
   - error = median of (margin − `display.phase_margin_ms`), wrapped into
     ±P/2;
   - a window with fewer than 10 margins is empty; one whose error spread
     (p90 − p10) exceeds 4 ms is incoherent: it never counts toward
     locking, counts toward unlocking and leaves the offset alone;
   - the phase slope (least squares, skipping the first 150 ms while the
     last offset reaches the drone) names the offset that would match the
     panel, n = o − slope / G with G = 1/60 ms/s per mfps (a rate error of
     D mfps at ~60 fps moves the phase D/60000 s per s); windows whose fit
     residual exceeds 1 ms RMS give no slope;
   - `centre` = EMA of n (α 0.3), the offset sent = centre − 30 mfps per
     ms of error, the correction clamped to ±60 mfps while acquiring and
     ±20 while locked, the whole clamped to ±200 mfps.
   The sensor only takes whole lines, so near lock the line count toggles
   between neighbours.
3. **maburgs forwards.** maburplay sends `phase <mfps>` to RecControl
   (UDP 127.0.0.1:8401) on change and every second. maburgs puts the value
   in every RCF; after 3 s without a `phase` line it sends 0.
4. **The drone applies.** `RcAgent` hands each new `snr_off` to venc. The
   encoder thread sets the sensor to the trim request plus the offset,
   clamped to ±200 mfps and never above the sensor mode's ceiling (maxFps
   × 1000: a mode whose maximum is its nominal rate, like 1728x972@100,
   has the driver refuse anything faster), once the boot trim has locked
   (or given up): one sensor writer. 0 restores the trim's own request. Link loss keeps the
   last value. A refused value is not retried until another request succeeds.

## States

| state | entered when | offset | placement |
|---|---|---|---|
| wait | start; 2 s without a non-empty window; a pts discontinuity (centre and offset reset to 0) | held | arrival |
| acq | the first non-empty window after wait; lock lost | centre − clamp(30·e, ±60) | arrival |
| lock | \|e\| < 1 ms for 3 coherent windows | centre − clamp(30·e, ±20) | capture |
| oor | acquiring for 60 s without locking | 0 (the drone runs on its trim) | arrival |

lock → acq after 2 windows with \|e\| > 3 ms or incoherent. oor → wait
after 60 s. An unreachable panel (50 Hz, 59 Hz) never produces a coherent
window and ends in oor.

## Rate mismatch

The player measures the drone's frame rate (median pts step over 1 s,
`SourceRate`) and compares it with the panel's refresh (`RateMatch`,
`gs/player/src/rate_match.h`). More than 0.25 Hz apart (the steer reaches
±0.2 fps) for 3 consecutive seconds is a mismatch: a drone `venc.fps` that
does not match `screen_mode`, or a display that fell back to another mode
because the sink does not offer the requested one. While it lasts the lock
is held in wait and sends nothing (maburgs' RCF `snr_off` falls to 0 after
its 3 s timeout, so the drone runs on its trim), capture-time placement is
off, the OSD fps cell reads `src/panel` in caution, and the player logs
`maburplay: rate mismatch: source X Hz, panel Y Hz -- phase lock paused`
(and `... cleared` once 3 matched seconds follow). A drone reporting
low-power is never a mismatch: its rate is low on purpose. The check runs
whether or not the GS OSD is up; the low-power flag comes from its sideport
reader and counts only while fresh. With the reader up but the sideport
quiet the check holds its last decision; with no reader at all the drone is
taken as armed. A pair close enough to call a match that the lock still
gives up on (out of range: the steer cannot reach the panel, e.g. a mode
whose ceiling sits just under it) tints the OSD fps cell caution too.

A sensor that refuses every `SetFps` (or a drone build with no venc
steering at all) never moves, so the centre walks to the range limit
without ever producing a coherent window: the lock unlocks, goes oor
after 60 s, and retries a minute later -- a steady acq/oor cycle visible
in `reg.log`, paired with a `[sensor] steer: ... refused` line on the
drone.

## Wire

`Rcf::snr_off`: int16 little-endian at RCF head offset 15, milli-fps on the
drone's trim request, 0 = no steering. `RC_VERSION` 16. The web GS and
spotters always send 0.

## Deploy

`RC_VERSION` 16 is a flag day for `maburd`, `maburgs` and the hosted web GS
page: finish the deploy on both devices (and republish the web page) before
judging the link, per `docs/deploy.md`. On the GS, the `maburplay` binary
goes in before its config -- an older binary exits on the new
`[display]` keys (`phase_lock`, `phase_margin_ms`).

## Configuration

`maburplay.toml` `[display]`: `phase_lock` (code false, bundle true),
`phase_margin_ms` (code and bundle 4, range 1-10), `sched_cap_ms` (bundle
16; with the lock on, capture placement runs only while locked).
`vsync_lead_ms` (bundle 5) is the release's lead before the vblank, the
only one -- recording runs under the same lead as live view.
`phase_lock` needs `vsync_lock = true`, `sched_cap_ms > 0` and
`regulate_ms > 0`, or the player refuses to start.

`screen_mode` is `WIDTHxHEIGHT@RATE`, RATE an integer or a decimal. The
presenter picks, among non-interlaced modes of that size within 0.5 Hz of
RATE, the one with the closest exact rate (from the pixel clock and
totals): a sink offering 60.000 and 59.94 under "@60" gets 60.000, `@59.94`
forces 59.94, a 59.94-only sink still matches "@60" and the lock steers
the camera there (~3 lines, centre near −50 mfps). It logs
`DrmPresenter: mode 1920x1080 @60.000 Hz (requested 1920x1080@60)`.

The drone has no phase-lock config.

## Observability

- `reg.log` (`# reglog 2`) regulator line: `lock=<off|wait|acq|lock|oor>
  lerr=<ms>ms loff=<mfps> lctr=<mfps>`.
- maburplay stderr: `phase-lock: <state> err= off= centre=` on each state
  change.
- Drone stats line: `snr_off=` (the offset on the sensor); `/tmp/mabur.log`
  `[sensor] steer:` lines for the first steer, clamps and refusals.
- `tools/flightreport.py` (session mode): PHASE LOCK — share of rows
  locked, acquire time, offset changes per minute, offset range, |lerr|
  while locked.
