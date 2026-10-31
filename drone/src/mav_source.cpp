#include "mav_source.h"

#include <algorithm>
#include <utility>

namespace mabur {

namespace {
// MAVLink v1/v2 frame sizes. A v1 frame is its 6-byte header, the payload
// and the 2-byte CRC. A v2 frame adds a 3-byte message id and, when the
// incompat_flags signature bit is set, a 13-byte signature.
constexpr size_t kV1Head = 6;
constexpr size_t kV2Head = 10;
constexpr size_t kCrcLen = 2;
constexpr size_t kSigLen = 13;
constexpr size_t kMaxFrame = kV2Head + 255 + kCrcLen + kSigLen;  // 280

size_t frame_size(const uint8_t* p, size_t avail) {
  const bool v2 = p[0] == 0xFD;
  const size_t head = v2 ? kV2Head : kV1Head;
  if (avail < head) return 0;  // need the length byte / the whole header
  const size_t payload = p[1];
  const size_t sig = v2 && (p[2] & 0x01) ? kSigLen : 0;
  return head + payload + kCrcLen + sig;
}
}  // namespace

MavSource::MavSource(const MavSourceCfg& cfg, EmitFn emit)
    : cfg_(cfg), emit_(std::move(emit)) {
  buf_.reserve(1024);
}

void MavSource::take_budget(uint64_t now_ms) {
  const double cap = static_cast<double>(std::max(500, cfg_.max_bps));
  if (!have_last_) {
    tokens_ = cap;
    last_ms_ = now_ms;
    have_last_ = true;
    return;
  }
  const uint64_t dt = now_ms > last_ms_ ? now_ms - last_ms_ : 0;
  tokens_ = std::min(cap, tokens_ + cap * static_cast<double>(dt) / 1000.0);
  last_ms_ = now_ms;
}

void MavSource::on_bytes(const uint8_t* p, size_t n, uint64_t now_ms) {
  if (!p || n == 0) return;
  buf_.insert(buf_.end(), p, p + n);

  size_t off = 0;
  while (off < buf_.size()) {
    // Resync: a MAVLink frame starts with 0xFD (v2) or 0xFE (v1).
    if (buf_[off] != 0xFD && buf_[off] != 0xFE) {
      ++off;
      continue;
    }
    if (buf_.size() - off < 2) break;
    const size_t total = frame_size(buf_.data() + off, buf_.size() - off);
    if (total == 0) break;  // header (or the length byte) not here yet
    if (total > kMaxFrame) {  // not a plausible MAVLink frame; resync past it
      ++off;
      continue;
    }
    if (buf_.size() - off < total) break;  // wait for the rest

    take_budget(now_ms);
    if (tokens_ < static_cast<double>(total)) {
      ++dropped_;
    } else {
      tokens_ -= static_cast<double>(total);
      ++frames_;
      bytes_ += total;
      if (emit_) emit_(buf_.data() + off, total);
    }
    off += total;
  }

  if (off) buf_.erase(buf_.begin(), buf_.begin() + static_cast<std::ptrdiff_t>(off));
  // A stream with no frame boundary for a long time is not MAVLink; drop it
  // rather than growing without bound.
  if (buf_.size() > 4096) {
    buf_.clear();
    ++dropped_;
  }
}

}  // namespace mabur
