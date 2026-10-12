# Orange Pi Zero 2W: streamed (slice-by-slice) decode A/B — findings 2026-10-12

**Status:** built; streamed decode is the Orange Pi default. Current: docs/opi-zero2w.md ("Streamed decode").

**Question.** Does decoding each picture slice by slice as it arrives — the
patched libav (`AV_PKT_FLAG_PARTIAL`, one slice per packet) driving Cedrus
from `StreamFeeder` — cut the `dec` latency segment by at least 3 ms on the
H618, with pictures bit-identical to whole-AU decode?

## Spike (before building)

- Cedrus HEVC: decode mode Slice-Based only, no start codes, one slice per
  request (`HEVC_SLICE_PARAMS` 1 element), OUTPUT queue supports requests
  and `M2M_HOLD_CAPTURE_BUF`, driver implements the stateless
  `VIDIOC_DECODER_CMD`.
- The bench stream: 4 equal slices per AU (~18 KB each) at ~61 fps; first
  fragment → AU complete p50 7.3 ms, p90 9 ms, p99 14–15 ms; whole-picture
  decode ~7 ms. Expected saving ~5 ms (all but the last slice overlap the
  arrival).
- FFmpeg 7.1 HEVC took one packet as one picture, and the v4l2request
  hwaccel queued slice k only on seeing slice k+1. Hence the patch.

## Bugs found on the board

- **Later slices dropped.** The first streamed run decoded 356 of 369
  pictures differently from whole-AU decode; every slice after the first
  logged "Error constructing the reference lists for the current slice".
  Cause: libav sizes a frame's per-slice reference-list array from the NAL
  count of the packet that starts the picture — one NAL when streamed — so
  later slices ran past it and `init_slice_rpl` failed. The patch now grows
  the array by each continuation packet's NAL count.
- **A frame handed out too early would stall.** With no reordering libav
  queues the current frame for output when the picture starts; handing it
  out runs the hwaccel's capture wait, which a held capture buffer blocks
  for 2 s. The patch keeps the frame back while a streamed picture is open
  (found in review before the first board run).

## Results (build `001a31fc`, patched libavcodec, 1080p60 sink)

**Bit-exactness** (`v4l2req_streamcheck`, 375-AU live capture): whole vs
streamed `mismatched 0, missing 0`, 19309 ms streamed vs 19262 ms whole for
the full run; `--abort 50` (picture ended after 2 slices with an AUD):
`abort_fired true`, every picture from the next entry point on matches.

**Decode-only, 30 s:** stream on `fps_active 60.34`, `errors 0`; stream off
(same library) `fps_active 60.20`, `errors 0`.

**Live A/B**, 2 min per arm, same board/build/drone/rung, medians over the
121 `lat:` lines of each arm (each line = 1 s p50/p99), ms:

| arm | `dec` p50 / p99 | `e2e` p50 / p99 | `reg` p50 / p99 | `fec` p50 / p99 |
|---|---|---|---|---|
| stream on | **4 / 6** | **35 / 40** | 11 / 16 | 4 / 9 |
| stream off | 7 / 10 | 38 / 41 | 11 / 16 | 4 / 9 |

Stream on: `stream: on streamed=6931 whole=267 aborted=0` (96.3 % of AUs
stream; the rest are the one-slice AUs) — `v4l2req: errors=0 bitstream=0`
in both arms.

**ausniff while streaming, 20 s:** 1215 AUs, 0 frame-id gaps, 0
incomplete, 0 resyncs.

## Conclusions

- Pass: `dec` drops 3 ms at the median and 4 ms at p99; glass-to-glass
  drops 3 ms at the median. Short of the spike's ~5 ms estimate — per-slice
  request overhead on Cedrus and the last slice's decode remain.
- Streamed and whole decode give the same pixels.
- Known limit, not exercised: a hard (non-bitstream) decoder error in the
  middle of a streamed picture can leave the capture buffer held, costing
  up to one 2 s capture wait; whole-AU decode on Cedrus has the same
  exposure.
- Still open: latency parity against the Radxa under the same conditions.
