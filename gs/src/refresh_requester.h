#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string_view>
#include <vector>

namespace maburgs {

// Asks the drone for an IDR when the picture on the GS is known to be
// damaged and nothing periodic will heal it (the encoder runs with no
// GOP). Fed per finished AU from the core and by the player's own
// damage reports; the request is the RCF's idr_epoch byte, which the
// drone serves once per change, so this class only decides WHEN the byte
// changes. I/O-free: the main loop reads epoch() into the controller and
// take_events() into fec.log.
//
// Arms on: a base AU finished incomplete (the NACK's repair window has
// already passed by then), a base AU rebuilt by slice salvage (a filled
// base band is a stale reference), any AU the stream advanced past (its
// layer is unknown, so it counts as base), or a player report. Never on
// enhance damage: nothing references an enhance frame.
//
// Clears on: a COMPLETE base AU whose first slice NAL is an IRAP
// (16..21), requested or not. A refresh-start picture (TRAIL_R) does not
// clear. While armed the byte is bumped again every kRetryMs: the
// expected heal is one RCF period plus the IDR's transit (~150 ms), so a
// retry only ever means the IDR itself was lost or truncated.
class RefreshRequester {
 public:
  enum class Reason : uint8_t { kHole, kSalvaged, kLost, kStart, kResync, kDecoder, kDvr, kCount };
  static constexpr uint64_t kRetryMs = 300;
  static constexpr size_t kReasons = static_cast<size_t>(Reason::kCount);

  struct Counters {
    uint64_t requests = 0;       // epoch bumps that started a request (one per arming)
    uint64_t retries = 0;        // bumps while already armed
    uint64_t heals = 0;          // clearing IRAPs
    uint64_t heal_ms_last = 0;   // arming -> clearing IRAP, last heal
    uint64_t by_reason[kReasons] = {};
  };
  // fec.log rows: 'I' per bump (reason = what armed the request; a retry
  // repeats it), 'H' per clearing IRAP.
  struct Event {
    char kind;
    Reason reason;
    uint8_t epoch;
    uint64_t t_ms;
    uint64_t heal_ms;
    uint64_t retries;
  };

  void note_au(uint8_t sid, bool complete, bool salvaged, uint8_t vcl_nal, uint64_t now_ms) {
    if (sid != 0) return;
    if (complete && !salvaged) {
      if (vcl_nal >= 16 && vcl_nal <= 21) clear_(now_ms);
      return;
    }
    arm_(salvaged && complete ? Reason::kSalvaged : Reason::kHole, now_ms);
  }

  // Cumulative FrameStream::frames_dropped(); a rise is AUs the stream
  // force-advanced past.
  void note_dropped_total(uint64_t total, uint64_t now_ms) {
    if (have_dropped_ && total > dropped_seen_) arm_(Reason::kLost, now_ms);
    dropped_seen_ = total;
    have_dropped_ = true;
  }

  void request(Reason r, uint64_t now_ms) { arm_(r, now_ms); }

  // Retry cadence; call once per main-loop iteration.
  void poll(uint64_t now_ms) {
    if (!armed_ || now_ms < last_bump_ms_ + kRetryMs) return;
    bump_(now_ms);
    ++c_.retries;
    ++retries_this_;
  }

  uint8_t epoch() const { return epoch_; }
  bool armed() const { return armed_; }
  const Counters& counters() const { return c_; }
  std::vector<Event> take_events() {
    std::vector<Event> out;
    out.swap(events_);
    return out;
  }

  static const char* reason_name(Reason r) {
    static const char* const names[kReasons] = {"hole", "salvaged", "lost", "start",
                                                "resync", "decoder", "dvr"};
    const size_t i = static_cast<size_t>(r);
    return i < kReasons ? names[i] : "?";
  }
  static std::optional<Reason> reason_from(std::string_view s) {
    for (size_t i = 0; i < kReasons; ++i)
      if (s == reason_name(static_cast<Reason>(i))) return static_cast<Reason>(i);
    return std::nullopt;
  }

 private:
  void arm_(Reason r, uint64_t now_ms) {
    ++c_.by_reason[static_cast<size_t>(r)];
    if (armed_) return;          // one request outstanding; the retry clock runs
    armed_ = true;
    reason_ = r;
    armed_since_ms_ = now_ms;
    retries_this_ = 0;
    ++c_.requests;
    bump_(now_ms);
  }
  void bump_(uint64_t now_ms) {
    ++epoch_;                    // uint8_t: wraps 255 -> 0, still a change
    last_bump_ms_ = now_ms;
    events_.push_back({'I', reason_, epoch_, now_ms, 0, retries_this_});
  }
  void clear_(uint64_t now_ms) {
    if (!armed_) return;
    armed_ = false;
    const uint64_t heal = now_ms - armed_since_ms_;
    ++c_.heals;
    c_.heal_ms_last = heal;
    events_.push_back({'H', reason_, epoch_, now_ms, heal, retries_this_});
  }

  bool armed_ = false;
  Reason reason_ = Reason::kHole;
  uint8_t epoch_ = 0;
  uint64_t armed_since_ms_ = 0;
  uint64_t last_bump_ms_ = 0;
  uint64_t retries_this_ = 0;
  uint64_t dropped_seen_ = 0;
  bool have_dropped_ = false;
  Counters c_;
  std::vector<Event> events_;
};

}  // namespace maburgs
