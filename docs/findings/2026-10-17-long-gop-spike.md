# Does a 10 s GOP still break the ladder, and what does the phase lock buy once the refresh picture is rare?

**Status:** spike, nothing shipped. `venc.gop_s` still ships 0.5; the
bitrate-step keyframe and the GOP-length caveat it tests are described in
`docs/airtime-model.md` ("Why the inputs are fixed", "GOP is not a free
knob"), the IDR pacer's reliance on the GOP in `docs/link-adaptation.md`
("RcAgent is the only IDR authority"). The phase-lock servo this reuses is
`docs/findings/2026-10-17-phase-lock-spike.md`.

## Question

The phase-lock spike showed that the refresh-start picture arrives 15 to
18 ms after a typical frame and cannot fit a display period at any phase,
so a locked stream still hitches once per GOP. The cheapest way to make
those hitches rare is a long GOP, but the airtime model records that a
10 s GOP once made every promote fail probation because SigmaStar CBR
converges over the GOP window. Every bitrate change now emits a keyframe
of its own. Does the long GOP still break the ladder, and with it rare,
what does the lock deliver?

## Setup

Bench drone and bench Radxa, rung 4, static night scene, `vsync_lead_ms`
5, `chain_budget` 0, the drone's `/etc/mabur.toml` `venc.gop_s` set to 10
(the config maximum), sessions 0131 and 0132.

- Ladder climb: maburd restarted three times; `ctl.log` E rows give the
  boot climb, `au.log` the 60 s after the top rung (bitrate per second,
  TxQueue wait `dq`, refresh pictures). Baseline: the two boot climbs at
  `gop_s` 0.5 in sessions 0129 and 0130.
- Mid-GOP bitrate step: the debug verb set the encoder to 7 Mbit/s and,
  30 s later, to 22 Mbit/s; RcAgent re-asserts its own rate within 5 s,
  so each is a step away and a step back.
- Run C: the phase-lock servo from the previous spike at a 15.5 ms hold
  for 328 s, read with the same per-window script as its run B.

## Result

The climb is unchanged by the GOP length. All three `gop_s` 10 restarts
and both 0.5 baselines went rung 0 → 4 in 5.2 to 5.3 s on four
`promote_probed` steps, no demote in the first 120 s, `dq` p90 1 ms in
every second after the top, bitrate flat at 12.8 to 14 Mbit/s with the
refresh picture (65 to 66 kB) adding one bump every 10 s.

The mid-GOP step neither overshoots nor queues. The 7 Mbit/s write took
effect within the same second (13.6 → 4.5 → 6.2 Mbit/s), RcAgent restored
13.6 four seconds later, and `dq` p90 stayed at 1 ms throughout; both
writes and both re-asserts emitted a keyframe (`nal0` 32 rows at the step
seconds), restarting the GOP period each time. The 22 Mbit/s write did not
raise the delivered rate above 14 Mbit/s; whether the static scene cannot
fill it or something clipped it was not pursued.

Run C against run B (`gop_s` 0.5, same servo, same target, same scene):

| | run B, GOP 0.5 s | run C, GOP 10 s |
|---|---|---|
| e2e p50 / p90 / p99 | 38.1 / 53.9 / 55.2 ms | 37.3 / 38.2 / 54.0 |
| e2e p50 range over 10 s buckets | 37 to 53 | 36 to 38 |
| judder seconds (lat p99 ≥ p50+10) | 66 % | 14 % |
| refresh pictures | 543 (2/s) | 33 (0.1/s) |
| refresh pictures late | 39 % | 73 % |
| displaced frames | 0.88/s | 0.14/s |
| pts holes from the rate toggles | 0 | 0 |

The refresh picture is larger and later at the long GOP (66 kB, excess
17 / 21 / 24 ms p50 / p90 / p99 against 15 / 18 / 21), so it misses more
often, but it comes 20 times less often. The remaining 14 % of judder
seconds is almost entirely the one miss per 10 s and its displacement.

## Answer

The CBR objection to a long GOP does not reproduce: with a keyframe on
every bitrate change the rate control settles within a second of a step
and the ladder climbs exactly as at 0.5 s. A 10 s GOP plus the phase lock
gives a flat 37 to 38 ms glass latency with judder in 14 % of seconds on a
clean bench, against 66 % at the shipped GOP and the 38 → 54 ms sawtooth
today. Taking the GOP longer than the config allows, or replacing the
periodic refresh with a GS-requested one, would remove the remaining
hitch on a clean link.

Before shipping a long GOP two things need re-arguing, both noted in the
code already: the IDR pacer drops a refused chain-break request because
the GOP is the backstop, and that backstop is now 10 s long; and the
ladder's demote/promote behaviour under real fades was not exercised
here, only the boot climb and a forced step on a clean bench.
