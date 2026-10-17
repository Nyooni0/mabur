# Does demand refresh stay quiet on a clean link and heal a damaged base on the bench?

**Status:** bench record; the flight is pending. The mechanism is
described in `docs/fec-nack.md` "Demand refresh"; the `fec.log` I/H rows,
`link.refresh` and the REFRESH section in `docs/observability.md`. The
GOP ceiling it runs on is `docs/findings/2026-10-17-sdk-gop-ceiling.md`;
the 10 s GOP baseline is `docs/findings/2026-10-17-long-gop-spike.md`
(session 0133).

## Question

With the drone at `venc.gop_s = 0` (GOP 65535 frames, intra refresh off),
the base layer heals only when maburgs' `RefreshRequester` asks for an
IDR. On a clean link, does it ask for nothing beyond the player's start
report? Under injected base loss, do the requests follow the damage and
heal in about one RCF period? Do the player's reports and an outage
behave as designed? And does the GS still pass its standing gates
(ausniff, aucadence) and judder no more than the 10 s GOP did?

## Setup

Bench drone and bench Radxa GS, rung 4 (MCS 4, 40 MHz), static indoor
scene, 4 row slices, SVC-T, NACK on at the GS. The drone ran the maburd
from the GOP ceiling run (branch `demand-refresh`, `VENC_GOP_NONE` 65535;
the MI proc node read `CBR65535`), with `gop_s` 0 and
`intra_refresh_frames` 0 and no other config change. The GS ran
`maburgs` and `maburplay` built from branch `demand-refresh` at 5fb9cde0
(glibc Radxa build), deployed together. No GS config changed.

| session | GS binary | what ran |
|---|---|---|
| 0136 | maburgs (glibc) | link-up, player start, 326 s clean window, ausniff, aucadence, player restart, two record presses |
| 0137 | maburgs, musl `MABUR_LOSS_SIM` build, `--loss-sim 8303` | 3 % then 10 % base loss, then a 3 s full loss of both layers |
| 0138, 0139 | maburgs (glibc) | ausniff ×2, aucadence, then an 8 s drone power cut (0139 is the rotation at the drone's restart) |

- Loss: `tools/bench/losssim.py --port 8303`. `s0 eff=3 burst=6` for
  117 s, `s0 eff=10 burst=8` for 61 s, then `s0 loss=100` and
  `s1 loss=100` for 3 s (every body of both video layers dropped on both
  cards; the RCF uplink and telemetry stay up).
- The player record button was pressed with `kill -USR1`. The bench
  player records in `dvr.mode = "burned"`, target `both`.
- Pulling the USB radio needs a human. The 3 s full-loss burst and the
  drone power cut stand in for it.
- Judder seconds: `lat.log` seconds with e2e p99 ≥ p50 + 10 ms, the same
  measure as session 0133.

## Result

**Clean link (session 0136).** The window runs 326 s, from the player's
start to the end of the run.

| | 0136, demand refresh | 0133, GOP 10 s, no lock |
|---|---|---|
| `I` rows / `H` rows in the window | 0 / 0 | n/a |
| parameter-set AUs (IDRs) | 2, both `vcl` 19 | one refresh start per 10 s |
| `vcl` 1 (refresh start) rows | 0 | n/a |
| AUs / fps | 19558 / 60.0 | |
| judder seconds | 11 of 326, **3.4 %** | 5 % |
| e2e p50 (median second) | 42 ms | 41.8 ms |

The two IDRs belong to the ladder, not to the requester. One enhance FEC
episode (11 sources, all abandoned, `sid` 1) caused an `s3_residual`
demote 4 → 3 at 3644.6 s and a `promote_probed` back at 3646.3 s, and each
transition carried its bitrate-change IDR. Enhance damage armed nothing,
as designed.

Before the window, every link-up logged one request. The first base AUs
after link-up include one the stream force-advanced past, so maburgs
logs `I lost` 137 ms after the first AU, and the link-up IDR stream heals
it 99 ms later. The same thing happened in 0137 (heal 101 ms) and 0138
(twice, 83 and 149 ms). The player's start report then logs one
`I … start` and one `H` (86 ms). maburtop therefore shows
`refresh: idle req2 retry0 heal2 last86ms | hole0 salv0 lost1 player1`,
not `req1`.

**Standing gates.** ausniff:

| run | AUs | incomplete | `frame_id_gaps` | resyncs | fps |
|---|---|---|---|---|---|
| 0136, clean | 1815 | 0 | 0 | 0 | 60.5 |
| 0138, after the loss-sim binary was swapped back, pass 1 | 1815 | 0 | 0 | 0 | 60.5 |
| 0138, pass 2 | 1816 | 0 | 0 | 0 | 60.5 |

aucadence (`--gate-ms 4.0`, the regression criterion; the recorded
baseline is −1.1 to −3.0 ms at an MCS 5 park):

| run | n base / enh | IDR excluded | offset |
|---|---|---|---|
| 0136 | 750 / 750 | 0 | +0.02 ms (pass) |
| 0138 | 750 / 749 | 0 | −0.24 ms (pass) |

**Injected base loss (session 0137).**

| | 3 % eff, burst 6, 117 s | 10 % eff, burst 8, 61 s |
|---|---|---|
| bodies dropped (s0) | 16580 | 29501 |
| NACK requests / filled / wasted / deadline-dropped | 260 / 1827 / 315 / 0 | 279 / 1913 / 251 / 96 |
| base AUs incomplete / slice-salvaged | 0 / 0 | 6 / 22 |
| requests (runs) by reason | 1 `lost` | 27 `lost`, 21 `hole`, 0 `salvaged` |
| requests with a retry | 0 | 1 |
| heal_ms p50 / p90 / max | 71 | 97 / 144 / 423 |
| most `I` rows in one second | 1 | 5 (two seconds had more than 3) |

At 3 %, FEC and the NACK repaired every base AU. The only request was
one `lost` during the demote cascade (4 → 0 in 3.1 s on `residual`),
after which the ladder bounced between rungs 0 and 1. An ausniff pass in
the middle of it read 1815 AUs, all complete, 0 gaps, 60.5 fps.

At 10 %, each of the 28 damaged base AUs had an `I` row in the same
second. The seconds with 4 or 5 `I` rows are separate requests, each
healed in about 100 ms before the next damage, not retries. For example,
in second 3988 five requests healed in 106, 109, 87, 97 and 83 ms.

Two things in the rows do not match the design:

- **Salvaged base AUs arm as `hole`.** The 22 base AUs that au.log flags
  `0x40` (slice-salvaged) each logged `I … hole`. The sideport's
  `by_reason.salvaged` stayed 0 for the whole session while
  `slice_salvaged` counted 22. They still arm, so the heal is not
  affected, but the reason is wrong.
- **A `lost` arms right after a heal.** 11 of the 32 `lost` requests in
  0137 start within 30 ms of the `H` before them (for example
  `H 3988517 87 0` then `I 3988517 lost 25`, healed 97 ms later). One
  pair is logged out of time order (`H 4030948` then `I 4030940 lost`).
  The force-advanced AU that arms it is older than the IRAP that just
  cleared, so these look like one extra IDR each.

`flightreport.py`'s REFRESH section on 0137 reads requests=50 (hole 21,
lost 28, start 1), retries 17, heals 54, heal_ms p50/p90/max 97/144/3739,
6 within 2 s of a demote, 48 within 2 s of an FEC episode. Read in file
order, the rows give 54 requests and 13 retries. When an `H` and the next
`I` share a millisecond, the report's sort puts the `I` first and counts a
new request as a retry.

**Player triggers (session 0136).**

| trigger | rows | heal |
|---|---|---|
| `S97maburplay restart` | one `I … start` (epoch 3), one `H` | 158 ms, 0 retries; IRAP `vcl` 19 |
| record press (start), burned mode | none | no IRAP |
| record press (stop) | none | |

In burned mode the player sends no `refresh dvr`: only the raw DVR
(`dvr.mode = "raw"`) needs a key frame to open on. The burned recording
(564 frames) started at the next decoded frame. The raw-mode press was
not tested because it needs a GS `/config` edit.

**Outages.**

| | 3 s full loss, both layers (0137) | drone power cut, 8 s (0138 → 0139) |
|---|---|---|
| first `I` | `lost`, 0.40 s into the burst | none during the outage |
| retries | 12, every ~300 ms through the burst | none |
| `H` | 3739 ms (includes the dead time), as the loss stops | 36 ms after the new producer's first AUs |
| after the heal | one more `lost`, healed 85 ms | one more `lost`, healed 133 ms |
| demote | `starved` 4 → 0, 0.67 s after the first `I` | `starved` 4 → 0, 0.85 s after the cut |
| NACK | 0 requests (nothing arrives to NACK against) | |
| FEC rows | base: 4190 sources missing, 4189 abandoned; enhance: 2397 missing, all abandoned | |
| recovery | back at rung 4 7.5 s after the burst | climb 0 → 4 in 5.3 s once the drone relinked |

During the power cut nothing armed. No base AU was finished incomplete
while the drone was silent, so the request armed only when the restarted
producer's AUs force-advanced the stream past the dead one. That AU was
already covered by the link-up IDR. `docs/fec-nack.md` "Across an outage"
describes the old in-flight AU arming one request at the cut and retrying
through the outage. That is what the 3 s burst did, but not the power cut.

## Answer

On a clean bench link, demand refresh asks for nothing. In 326 s there
were 0 requests after the player's `start`, the only IDRs were the
ladder's own two, and there were no refresh-start pictures. Judder
seconds were 3.4 % against 5 % at the 10 s GOP, at the same 42 ms e2e
p50. ausniff stayed at 0 gaps and 60.5 fps, and aucadence at
+0.02 / −0.24 ms, inside the 4 ms gate. Each link-up still logs one
`lost` request, which the link-up IDR heals within 150 ms.

Under base loss, the requester fires only once FEC and the NACK have
given up: none at 3 %, and one per damaged base AU at 10 %, heal p50
97 ms and p90 144 ms, with a single retry in 48 requests. A 3 s blackout
retries every 300 ms and heals as the link returns, with the `starved`
demote inside a second.

Three things need a code look before the flight:

- salvaged base AUs are labelled `hole`;
- about a third of `lost` requests arm right after a heal, so each costs
  one redundant IDR;
- flightreport's REFRESH counts break on same-millisecond `H`/`I` ties.

The raw-DVR `dvr` trigger and a real radio pull remain untested. The
flight is pending.
