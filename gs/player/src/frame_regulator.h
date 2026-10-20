#ifndef MABUR_PLAYER_FRAME_REGULATOR_H_
#define MABUR_PLAYER_FRAME_REGULATOR_H_

#include <cstdint>
#include <mutex>

#include "lateness_window.h"
#include "pts_anchor.h"
#include "vblank_estimator.h"
#include "video_backend.h"

namespace maburplay {

// Phase-aware display release (display.regulate_ms). Decoded frames are
// held until floor(pts) + D on the GS monotonic clock, so presentation
// follows the encoder's capture cadence instead of arrival jitter — the
// dejitter spike measured today's mailbox presenter at ~750–940 vsync
// repeat+skip pairs/min and a D of 12–16 ms removing ~70% of them for
// under 5 ms of added mean latency (docs/findings/2026-08-30-dejitter.md).
//
// Clock map: pts is the drone's 32-bit µs counter; it is unwrapped by
// deltas and anchored by the FASTEST observed frame (min of mono − pts),
// so D means "delay past the best-case delivery path" — exactly how the
// spike measured the completion-delay distribution. The floor snaps down
// instantly when a faster frame proves it and leaks upward at kLeakPpm to
// follow relative clock drift (measured ~20 ppm; the leak is 3× that).
//
// Ownership: offer() either passes the frame through (present it NOW —
// regulator disabled, frame already past its release, or a pts
// discontinuity re-seed) or holds it in a kMaxHeld-deep queue. A held
// frame displaced by a newer one, or orphaned by a discontinuity, comes
// back via *out (up to kMaxHeld at once) and MUST be returned to the
// backend by the caller. release_due() surfaces held frames once their
// time arrives — call it in a loop, since more than one can be due in
// the same tick.
//
// Thread-sharing: the release thread calls offer/release_due/
// next_release_us/on_flip at its own clock, the decode-output thread calls
// note_incomplete, and the housekeeping loop reads the counters and calls
// heal_slip/set_capture_placement/take_margin -- three callers, one
// instance. Every public method locks mu_ for its whole body (counters'
// getters included) and no public method calls another, so the lock is
// never held across more than one method's work and never nests.
//
// offer()'s two timestamps come from different clocks: arrival_us is the
// decode stamp (when the frame actually finished decoding, set once at
// decode time) and now_us is the release thread's own clock at the moment
// it offers the frame. arrival_us feeds the pts anchor and the capture-time
// lateness window (both describe the decode pipeline's delivery), while
// now_us decides everything about "is this late, and relative to what
// clock does the next release fall" -- the vblank estimator's validity,
// the next release it computes, and the past-release/implausible-phase
// clamps.
//
// Queue depth (bench A/B): the old
// single-slot mailbox meant that once D approached the spacing to the
// next burst-decoded frame, displacement rate climbed and the dropped
// frames judder more than the smoothing helps — 12 ms measured 2.94 ms
// present-jitter with 5 replacements, 16 ms measured 5.32 ms with 804.
// Multiple slots let the queue hold one frame per vsync target instead
// of collapsing every arrival onto a single held frame; in fallback mode
// (no vsync lock) all entries share target_v == 0, so the same-target
// displacement rule below reproduces the old single-slot mailbox
// exactly. Depth 4 (was 2) covers the post-stall backlog: the decode
// sink offers before the main loop drains overdue releases, so a stall
// spanning a release deadline plus a decode burst legitimately wants 3+
// distinct vsync targets in hold — at 120 Hz (8.3 ms periods) with
// D=12–16 that window doubles relative to the 60 Hz bench. A full queue
// still evicts the oldest (most-overdue) head: latency-first.
class FrameRegulator {
 public:
  FrameRegulator(int regulate_ms, bool vsync_lock = false,
                 int vsync_lead_ms = 3, int chain_budget = 0,
                 int sched_cap_ms = 0)
      : d_us_(static_cast<int64_t>(regulate_ms) * 1000),
        vsync_lock_(vsync_lock),
        lead_us_(static_cast<uint64_t>(vsync_lead_ms) * 1000),
        chain_budget_(static_cast<uint64_t>(chain_budget)),
        sched_cap_us_(static_cast<int64_t>(sched_cap_ms) * 1000) {}

  bool enabled() const;

  static constexpr int kMaxHeld = 4;

  struct Displaced {
    DmaFrame f[kMaxHeld];
    int n = 0;
  };

  // Returns true when f should be presented immediately. Returns false
  // when the regulator holds it. Either way, any frame(s) displaced from
  // the queue are returned in *out and must be released by the caller.
  // arrival_us is the decode stamp (feeds the pts anchor and the
  // capture-time lateness window); now_us is the release thread's own
  // clock (decides lateness, and is the clock the vblank estimator's
  // validity and next release are computed against).
  bool offer(const DmaFrame& f, uint64_t arrival_us, uint64_t now_us,
             Displaced* out);

  // True (and fills *out) once the earliest held frame's release time has
  // arrived. Call in a loop to drain — more than one entry can be due in
  // the same tick.
  bool release_due(uint64_t now_us, DmaFrame* out);

  bool holding() const;

  // Forwarded from the presenter's FlipSink.
  void on_flip(uint64_t flip_us, bool exact);

  // Reseed the vblank estimator with the chosen DRM mode's exact period
  // (mode_period_us). The regulator is constructed before the presenter
  // (its flip-sink closures capture it by reference), so the panel rate
  // arrives here post-init rather than through the constructor. Call
  // before the first flip: reseeding discards any warm-up so far.
  void set_panel_period(double period_us);

  uint64_t held_count() const;
  uint64_t late_count() const;
  uint64_t replaced_count() const;
  uint64_t discont_count() const;
  double hold_ema_ms() const;
  uint64_t vsync_skips() const;
  // Sequential-slot chain accounting (bench): a frame whose
  // natural vblank is held by its predecessor takes the next slot, and
  // every frame after it at source cadence then finds ITS natural slot
  // occupied too, so the whole stream runs one period late until an
  // arrival gap wider than a period frees a slot. chained_count is every
  // such +1-slot assignment, chain_run the current consecutive run,
  // chain_max its high-water mark. In servo mode the extra period shows
  // up in the lat line's reg segment, nowhere else -- these make it
  // visible on the regulator line.
  uint64_t chained_count() const;
  uint64_t chain_run() const;
  uint64_t chain_max() const;
  uint64_t chains_count() const;  // runs started
  // display.chain_budget (bench): a chain breaks on its own
  // only when an arrival gap exceeds a period plus the phase margin, so
  // it lives longest exactly when the margin (and hence its cost) is
  // largest. With a budget N, the frame that would extend a run past N
  // takes its natural slot and the held occupant is displaced -- one
  // drop re-aligns the stream. 0 = unbounded. chain_cuts counts those.
  uint64_t chain_cuts() const;
  uint64_t fallback_frames() const;
  // Capture-time scheduling (display.sched_cap_ms > 0): the AU with this
  // pts was salvaged or truncated (loss), so its delivery time says nothing
  // about clean-link jitter and stays out of the lateness window. Call
  // before the frame is offered (the submit note precedes its decode).
  void note_incomplete(uint32_t pts_us);
  // Current allowance (ms): how late past the fast path a frame may be
  // and still keep its capture-time slot. Measured whenever sched_cap_ms
  // > 0, including in phase-lock mode while frames are placed by arrival
  // (lock not yet held) -- the margin needs it to judge the lock before
  // capture placement engages. 0 only when sched_cap_ms itself is 0.
  double allowance_ms() const;
  // Frames that missed their capture-time slot and were placed by arrival.
  uint64_t late_slot_count() const;
  bool servo_locked() const;

  // Phase lock (display.phase_lock). In phase-lock mode capture-time
  // placement runs only while set_capture_placement(true) -- the lock holds
  // -- and arrival placement otherwise; the margin is measured in both, so
  // the lock can steer before the screen changes behaviour. Off, the
  // sched_cap_ms > 0 rule alone decides, as before.
  void set_phase_lock_mode(bool on);
  void set_capture_placement(bool on);
  // The last offered frame's margin: µs from its capture-time `want` (pts +
  // delivery floor + allowance) to the release point of the vblank it would
  // take. Available once per offer that had one (vsync servo valid and
  // sched_cap_ms > 0).
  bool take_margin(double* margin_us);
  double panel_period_us() const;

  // Chain-break heal (hw): a single missed latch puts the
  // display into a stable one-vsync-late mode -- every present then
  // arrives while the previous flip is in flight, parks in the
  // presenter's mailbox, and latches a period late, indefinitely. The
  // main loop detects the chain from the presenter's engagement-counter
  // rate and calls this: every pending servo release slips one slot, so
  // one vblank goes unfilled (a single repeated frame), the flip
  // pipeline drains, and the phase re-aligns. No-op when the queue is
  // empty or holds only fallback (untargeted) frames.
  void heal_slip();
  uint64_t heals() const;

  // Earliest pending release (0 = nothing held). The main loop uses this
  // to schedule its heavy 1 Hz work (OSD compose, stats, statvfs) into
  // the gap between releases: a stall that overlaps a release deadline
  // makes the frame miss its latch and start a one-vsync-late chain
  // (hw), so heavy work defers when a release is imminent.
  uint64_t next_release_us() const;

 private:
  struct Held {
    DmaFrame f{};
    uint64_t release_us = 0;
    uint64_t target_v = 0;  // 0 = untargeted (fallback rule)
  };
  // Lock-free helpers: called only from public methods that already hold
  // mu_, never from each other in a way that would re-enter a lock.
  void displace(int idx, Displaced* out);
  // Capture-time slot for a frame: feeds the lateness window and computes
  // want = pts64 + floor + allowance and the release it lands on. False
  // while the window is empty.
  struct CaptureSlot {
    int64_t want = 0;
    VblankEstimator::Release r{};
  };
  bool capture_slot(uint64_t pts64, uint32_t pts32, uint64_t arrival_us, CaptureSlot* s);
  // Capture-time placement. True when the frame got its capture slot
  // (release/target filled in); false sends it down the arrival path.
  bool place_by_capture(const CaptureSlot& s, uint64_t now_us, uint64_t* release,
                        uint64_t* target_v, Displaced* out);
  bool was_incomplete(uint32_t pts_us) const {
    for (uint32_t p : incomplete_) if (p == pts_us) return true;
    return false;
  }
  static constexpr int kIncomplete = 8;

  mutable std::mutex mu_;

  const int64_t d_us_;
  const bool vsync_lock_;
  uint64_t lead_us_;
  const uint64_t chain_budget_;
  const int64_t sched_cap_us_;

  maburgs::PtsAnchor anchor_;
  VblankEstimator est_;
  Held held_[kMaxHeld];  // held_[0] releases first (sorted by release_us)
  int count_ = 0;
  bool servo_now_ = false;

  uint64_t held_count_ = 0;
  uint64_t late_count_ = 0;
  uint64_t replaced_count_ = 0;
  uint64_t discont_count_ = 0;
  double hold_ema_ms_ = 0.0;
  uint64_t vsync_skips_ = 0;
  uint64_t chained_count_ = 0;
  uint64_t chain_run_ = 0;
  uint64_t chain_max_ = 0;
  uint64_t chains_count_ = 0;
  uint64_t chain_cuts_ = 0;
  uint64_t heals_ = 0;
  uint64_t fallback_frames_ = 0;

  LatenessWindow win_;
  int64_t allowance_us_ = 0;
  uint64_t late_slot_ = 0;
  uint32_t incomplete_[kIncomplete] = {1, 1, 1, 1, 1, 1, 1, 1};  // odd: no real pts match at start
  int incomplete_head_ = 0;

  bool phase_lock_mode_ = false;
  bool capture_on_ = false;
  double margin_us_ = 0.0;
  bool margin_fresh_ = false;
};

}  // namespace maburplay

#endif  // MABUR_PLAYER_FRAME_REGULATOR_H_
