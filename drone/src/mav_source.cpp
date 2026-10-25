#include "mav_source.h"

#include <algorithm>
#include <utility>

namespace mabur {

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
    const bool v2 = buf_[off] == 0xFD;
    const size_t hdr = v2 ? 10 : 6;   // v2 includes the 3-byte msgid
    if (buf_.size() - off < hdr) break;
    const size_t payload = buf_[off + 1];
    size_t sig = 0;
    if (v2 && (buf_[off + 2] & 0x01)) sig = 13;   // signed frame
    const size_t total = hdr + payload + 2 + sig;  // + CRC, + signature
    if (total > 300) {   // not a plausible MAVLink frame; resync past it
      ++off;
      continue;
    }
    if (buf_.size() - off < total) break;   // wait for the rest

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
