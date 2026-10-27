#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>

namespace mabur {

struct MavSourceCfg {
  // Token bucket over the whole forwarder. 4000 B/s is roughly 3x a typical
  // 25 Hz ATTITUDE + 5 Hz position + 1 Hz battery MAVLink stream.
  int max_bps = 4000;
};

// Drone-side raw MAVLink tunnel: finds complete v1/v2 frames in the FC UART
// byte stream and hands each one to the caller unchanged. It deliberately
// does not validate CRC_EXTRA or decode messages -- the GS parser owns that,
// and forwarding the bytes verbatim is what lets the GS bridge the same
// frames to an external MAVLink client.
//
// Single-threaded (the serial thread). on_bytes() may be fed arbitrary spans;
// the framer resyncs on garbage and drops a frame that would exceed the
// byte-budget bucket.
class MavSource {
 public:
  using EmitFn = std::function<void(const uint8_t* frame, size_t len)>;

  MavSource(const MavSourceCfg& cfg, EmitFn emit);

  void on_bytes(const uint8_t* p, size_t n, uint64_t now_ms);

  uint64_t frames() const { return frames_; }
  uint64_t bytes() const { return bytes_; }
  uint64_t dropped() const { return dropped_; }

 private:
  void take_budget(uint64_t now_ms);

  MavSourceCfg cfg_;
  EmitFn emit_;
  std::vector<uint8_t> buf_;
  uint64_t frames_ = 0, bytes_ = 0, dropped_ = 0;
  double tokens_ = 0.0;
  uint64_t last_ms_ = 0;
  bool have_last_ = false;
};

}  // namespace mabur
