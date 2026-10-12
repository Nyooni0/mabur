#include "v4l2req_backend.h"

#include <atomic>
#include <cstdio>
#include <utility>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_drm.h>
}

#include "frame_handoff.h"
#include "mabur/hevc_params.h"
#include "prime_frame.h"

// AV_HWDEVICE_TYPE_V4L2REQUEST is not in upstream FFmpeg: it is an enumerator
// the v4l2request fork adds to AVHWDeviceType, so this file builds only
// against the fork's headers (the Orange Pi image's ffmpeg-v4l2request).

namespace maburplay {

namespace {

// Frames the display side can hold at once beyond the decoder's own
// references: on screen + pending flip + mailbox (DrmPresenter), the
// regulator's held frame, and slack for a frame in the ready queue.
constexpr int kExtraHwFrames = 8;

enum AVPixelFormat pick_drm_prime(AVCodecContext*, const enum AVPixelFormat* fmts) {
  for (; *fmts != AV_PIX_FMT_NONE; ++fmts)
    if (*fmts == AV_PIX_FMT_DRM_PRIME) return *fmts;
  return AV_PIX_FMT_NONE;
}

PrimeDesc to_prime_desc(const AVDRMFrameDescriptor& d) {
  PrimeDesc p;
  p.nb_objects = d.nb_objects;
  for (int i = 0; i < d.nb_objects && i < 4; ++i)
    p.objects[i] = {d.objects[i].fd, d.objects[i].format_modifier};
  p.nb_layers = d.nb_layers;
  if (d.nb_layers > 0) {
    p.layer_format = d.layers[0].format;
    p.nb_planes = d.layers[0].nb_planes;
    for (int i = 0; i < d.layers[0].nb_planes && i < 4; ++i)
      p.planes[i] = {d.layers[0].planes[i].object_index,
                     static_cast<long>(d.layers[0].planes[i].offset),
                     static_cast<long>(d.layers[0].planes[i].pitch)};
  }
  return p;
}

}  // namespace

struct V4l2ReqBackend::Impl {
  FrameSink sink;
  AVCodecContext* cc = nullptr;
  AVBufferRef* hw = nullptr;
  AVPacket* pkt = nullptr;
  FrameHandoff<DmaFrame> handoff;
  IrapGate gate;
  std::atomic<uint64_t> frames{0}, errors{0}, dropped_shape{0}, gated{0};
  bool logged_shape = false;

  ~Impl() {
    free_all();
    av_packet_free(&pkt);
    avcodec_free_context(&cc);
    av_buffer_unref(&hw);
  }

  static void free_frame(const DmaFrame& f) {
    AVFrame* av = static_cast<AVFrame*>(f.opaque);
    av_frame_free(&av);
  }

  void free_releases() {
    for (const DmaFrame& f : handoff.take_releases()) free_frame(f);
  }

  void free_all() {
    for (const DmaFrame& f : handoff.drain_all()) free_frame(f);
  }

  bool open() {
    const AVCodec* dec = avcodec_find_decoder(AV_CODEC_ID_HEVC);
    if (!dec) {
      std::fprintf(stderr, "V4l2ReqBackend: no HEVC decoder in libavcodec\n");
      return false;
    }
    cc = avcodec_alloc_context3(dec);
    pkt = av_packet_alloc();
    if (!cc || !pkt) return false;
    // In-band VPS/SPS/PPS, no B-frames: emit each picture as it completes.
    cc->flags |= AV_CODEC_FLAG_LOW_DELAY;
    cc->thread_count = 1;
    const int hr = av_hwdevice_ctx_create(&hw, AV_HWDEVICE_TYPE_V4L2REQUEST, nullptr, nullptr, 0);
    if (hr < 0) {
      std::fprintf(stderr, "V4l2ReqBackend: v4l2request device create failed (%d)\n", hr);
      return false;
    }
    cc->hw_device_ctx = av_buffer_ref(hw);
    cc->get_format = pick_drm_prime;
    cc->extra_hw_frames = kExtraHwFrames;
    const int orc = avcodec_open2(cc, dec, nullptr);
    if (orc < 0) {
      std::fprintf(stderr, "V4l2ReqBackend: avcodec_open2 failed (%d)\n", orc);
      return false;
    }
    return true;
  }

  // One decoded frame -> the ready queue, or dropped (counted) if it is not
  // the shape DrmPresenter imports.
  void take(AVFrame* av) {
    if (av->format != AV_PIX_FMT_DRM_PRIME || !av->data[0]) {
      ++errors;
      av_frame_free(&av);
      return;
    }
    const auto* desc = reinterpret_cast<const AVDRMFrameDescriptor*>(av->data[0]);
    DmaFrame f;
    const PrimeReject why = prime_to_dma(to_prime_desc(*desc), av->width, av->height,
                                         static_cast<uint32_t>(av->pts), &f);
    if (why != PrimeReject::kNone) {
      ++dropped_shape;
      if (!logged_shape) {
        logged_shape = true;
        std::fprintf(stderr,
                     "V4l2ReqBackend: dropping frames: DRM-PRIME layout not linear NV12 (%s): "
                     "objects=%d layers=%d fmt=%.4s planes=%d mod=%#llx\n",
                     prime_reject_name(why), desc->nb_objects, desc->nb_layers,
                     reinterpret_cast<const char*>(&desc->layers[0].format),
                     desc->layers[0].nb_planes,
                     static_cast<unsigned long long>(desc->objects[0].format_modifier));
      }
      av_frame_free(&av);
      return;
    }
    f.opaque = av;
    handoff.push_ready(f);
  }
};

V4l2ReqBackend::V4l2ReqBackend() = default;
V4l2ReqBackend::~V4l2ReqBackend() = default;

bool V4l2ReqBackend::init(const BackendCfg&, FrameSink sink) {
  impl_ = std::make_unique<Impl>();
  impl_->sink = std::move(sink);
  if (!impl_->open()) {
    impl_.reset();
    return false;
  }
  return true;
}

void V4l2ReqBackend::submit_au(const uint8_t* au, size_t n, uint32_t pts_us) {
  if (!impl_ || !au || n == 0) return;
  Impl& m = *impl_;
  m.free_releases();
  if (!m.gate.admit(mabur::au_is_irap(au, n))) {
    m.gated.store(m.gate.gated(), std::memory_order_relaxed);
    return;
  }
  // The decoder copies what it keeps (the packet is not refcounted), so the
  // ring slot may be reused as soon as this returns.
  m.pkt->data = const_cast<uint8_t*>(au);
  m.pkt->size = static_cast<int>(n);
  m.pkt->pts = pts_us;
  const int sr = avcodec_send_packet(m.cc, m.pkt);
  av_packet_unref(m.pkt);
  if (sr < 0 && sr != AVERROR(EAGAIN)) ++m.errors;
  for (;;) {
    AVFrame* av = av_frame_alloc();
    const int rr = av ? avcodec_receive_frame(m.cc, av) : AVERROR(ENOMEM);
    if (rr != 0) {
      av_frame_free(&av);
      if (rr != AVERROR(EAGAIN) && rr != AVERROR_EOF) ++m.errors;
      break;
    }
    m.take(av);
  }
}

void V4l2ReqBackend::poll() {
  if (!impl_) return;
  DmaFrame f;
  while (impl_->handoff.pop_ready(&f)) {
    ++impl_->frames;
    if (impl_->sink) {
      impl_->sink(f);
    } else {
      impl_->handoff.push_release(f);
    }
  }
}

void V4l2ReqBackend::release_frame(const DmaFrame& f) {
  if (!impl_ || !f.opaque) return;
  impl_->handoff.push_release(f);
}

void V4l2ReqBackend::flush() {
  if (!impl_) return;
  // The presenter and regulator have already returned their frames
  // (main.cpp's flush order), so both queues hold everything outstanding.
  impl_->free_all();
  avcodec_flush_buffers(impl_->cc);
  impl_->gate.arm();
}

uint64_t V4l2ReqBackend::frames() const { return impl_ ? impl_->frames.load() : 0; }
uint64_t V4l2ReqBackend::errors() const { return impl_ ? impl_->errors.load() : 0; }
uint64_t V4l2ReqBackend::dropped_shape() const {
  return impl_ ? impl_->dropped_shape.load() : 0;
}
uint64_t V4l2ReqBackend::gated() const { return impl_ ? impl_->gated.load() : 0; }

}  // namespace maburplay
