#ifndef MABUR_PLAYER_DECODE_PUMP_H_
#define MABUR_PLAYER_DECODE_PUMP_H_

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

#include "au_router.h"  // FeedNote
#include "feed_loop.h"
#include "frame_regulator.h"
#include "lat_tracker.h"
#include "rate_match.h"  // SourceRate
#include "video_backend.h"
#include "wake_queue.h"

namespace maburplay {

// The decode-output thread. It drives backend->poll(), so the FrameSink runs
// here: every decoded frame is stamped and handed over through `out` the
// moment the decoder emits it, whatever the housekeeping loop is doing.
// Frames come back through `releases` (from any thread) and are returned to
// the backend here -- the decoder's output side has one thread.
//
// Per frame, on this thread, in this order:
//  1. the feed's submit notes (lat.on_submit; an incomplete AU's pts goes to
//     regulator.note_incomplete) -- a frame's note is out before its frame;
//  2. lat.on_decoded, the source-rate sample and the stats atomics;
//  3. the recorder hook (it only takes a buffer reference; it must see the
//     frame before anyone downstream can release it);
//  4. the hand-over: out.push({f, t_decoded});
//  5. the prime hook, after the hand-over so it never delays it.
//
// Loop: checkpoint (park) -> releases into the backend -> poll(). A backend
// that implements PollWait blocks in poll() up to kPollTimeoutMs; any other
// gets a 1 ms wait after a round that produced no frame.
//
// Threads: set_feed/set_prime before start(); set_backend before start() or
// while parked; set_recorder_submit and the reads below from anywhere.
class DecodePump {
 public:
  static constexpr int kPollTimeoutMs = 4;

  DecodePump(LatTracker& lat, FrameRegulator& regulator, WakeQueue<HandedFrame>& out,
             WakeQueue<DmaFrame>& releases);
  ~DecodePump();  // stops and joins, even a parked thread
  DecodePump(const DecodePump&) = delete;
  DecodePump& operator=(const DecodePump&) = delete;

  // Before start(): the source of submit notes; nullptr = none (tests,
  // --decode-only).
  void set_feed(FeedLoop* f);
  // Hand to backend->init(). It runs on whichever thread calls poll(): the
  // pump's own once started.
  VideoBackend::FrameSink sink();
  // Before start() or while parked. Releases still queued for a different
  // backend are discarded, never delivered to the new one: a frame of an old
  // decoder means nothing to a new one, and its buffer goes with the old
  // decoder. Sets the PollWait timeout when the backend has one.
  void set_backend(VideoBackend* b);
  // Before start(): runs after the hand-over.
  void set_prime(std::function<void(const DmaFrame&)> fn);
  // Any time; empty = none. Held under its own lock only for the call.
  void set_recorder_submit(std::function<void(const DmaFrame&)> fn);

  void start();
  // true = the thread sits outside every backend call (or has ended), and
  // every release queued before the call has reached the current backend.
  // false = not parked in time (nothing changed).
  bool park(std::chrono::milliseconds limit);
  void resume();
  // After it returns the caller owns the backend and the release queue.
  void stop_and_join();

  // Housekeeping reads.
  uint64_t frames() const { return frames_.load(); }
  bool have_frame() const { return have_frame_.load(); }
  uint32_t last_pts() const { return last_pts_.load(); }
  uint64_t last_frame_us() const { return last_frame_us_.load(); }  // its t_decoded
  int video_w() const { return video_w_.load(); }  // the decoded picture size
  int video_h() const { return video_h_.load(); }
  double source_hz() const;
  uint64_t releases_discarded() const { return discarded_.load(); }  // by set_backend

 private:
  void run_();
  bool checkpoint_();  // parks iff asked; false = stopping
  void drain_releases_();
  void on_frame_(const DmaFrame& f);

  LatTracker& lat_;
  FrameRegulator& regulator_;
  WakeQueue<HandedFrame>& out_;
  WakeQueue<DmaFrame>& releases_;

  // Pump thread once started; written before start() or while parked (the
  // park's mutex orders those writes before the thread's next read).
  FeedLoop* feed_ = nullptr;
  VideoBackend* backend_ = nullptr;
  bool blocking_poll_ = false;
  std::function<void(const DmaFrame&)> prime_;
  std::vector<FeedNote> notes_;
  std::vector<DmaFrame> rel_;

  std::mutex rec_mu_;
  std::function<void(const DmaFrame&)> rec_submit_;

  mutable std::mutex src_mu_;
  SourceRate source_rate_;

  std::atomic<uint64_t> frames_{0}, last_frame_us_{0}, discarded_{0};
  std::atomic<bool> have_frame_{false};
  std::atomic<uint32_t> last_pts_{0};
  std::atomic<int> video_w_{0}, video_h_{0};

  std::thread th_;
  std::mutex mu_;
  std::condition_variable cv_;
  bool parked_ = false;  // under mu_
  bool resume_ = false;  // under mu_
  std::atomic<bool> park_req_{false}, stop_{false}, finished_{false};
};

}  // namespace maburplay

#endif  // MABUR_PLAYER_DECODE_PUMP_H_
