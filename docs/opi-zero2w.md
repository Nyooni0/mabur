# Orange Pi Zero 2W ground station (Allwinner H618)

The Orange Pi Zero 2W runs the same GS as the Radxa ZERO 3 — `maburgs`
(musl-static, unchanged) and `maburplay` — with a different decoder:
Cedrus, the H618's V4L2 stateless (request API) HEVC decoder, driven
through libav's `v4l2request` hwaccel.

## Decode path

`backend = "v4l2req"` selects `V4l2ReqBackend`
(`gs/player/src/v4l2req_backend.cpp`, built with
`-DMABUR_PLAYER_DECODER=v4l2req`). Each access unit from the ring goes to
`avcodec_send_packet` whole (no parser); decoded frames come back as
DRM-PRIME linear NV12 and are handed to `DrmPresenter` unchanged.

- **One thread for libav.** Decode and frame frees run on the feed
  thread; `poll()`/`release_frame()` on main only touch a locked handoff
  (`frame_handoff.h`). Released frames are freed before the next decode.
- **Entry gate.** After init and every flush, AUs are dropped until the
  first entry point (`mabur::au_is_entry_point`: an IRAP, or an AU carrying
  an SPS), counted as `gated`. The drone's intra-refresh stream sends no
  IRAP at all: its periodic refresh AU is VPS/SPS/PPS + TRAIL_R (every
  `venc.gop_s`), so that is where decode starts. Joining on a bare P
  picture would make Cedrus reference never-decoded buffers. Not re-armed
  on decode errors.
- **Synchronous.** The hwaccel waits for the capture buffer before
  returning a frame, so `submit_au` blocks the feed thread for the decode.
- **Shape check.** A frame not in single-object linear NV12 is dropped and
  counted (`shape_drops`); the first one logs its descriptor.

Counters: `--decode-only` JSON (`errors`) plus a `maburplay: v4l2req`
line, and a `v4l2req: frames= errors= shape_drops= gated=` line every 5 s
in `/tmp/maburplay.log`.

## Not available on this board

| Feature | Why | Config |
|---|---|---|
| Burned DVR | no hardware encoder in mainline | `dvr.mode = "burned"` exits 2 at startup |
| colortrans | no CRTC `CUBIC_LUT`, no RGA | `colortrans.enable = false` (true only logs "no LUT") |
| Streamed (slice) decode | MPP-only | `decoder.stream = false` (true falls back to whole pictures) |
| Record button | the H618's GPIO lines carry no names, so `[input.rec]` cannot resolve | stripped from the image's default |

Raw DVR, both OSDs, the vsync servo and the latency log work as on the
Radxa.

## Display

`DrmPresenter` probes the DE33 like any other CRTC: video on the NV12 VI
overlay plane, OSD on an ARGB plane above it, zpos mutable on all three
planes. Full-screen scaling needs the image's DE33 scaler kernel patch
(`board/orangepi/zero2w/linux-patches/` in the image repo). Record here
what the bench shows for async flip and `vsync_ts_exact` (Task 6 fills
this in).

## Build and deploy

`tools/build-arm64.sh` stage 7 builds `out/arm64/maburplay-opi` against
`../sbc-groundstations-gilankpam/output/orangepi_zero2w_defconfig`
(override with `MABUR_BR_HOST_OPI=`). NEEDED: `libavcodec.so.61`,
`libavutil`, `libdrm.so.2`, libstdc++. Deploy: `docs/deploy.md`
("Orange Pi Zero 2W").
