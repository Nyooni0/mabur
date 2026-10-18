#ifndef MABUR_THREADED_SINK_H_
#define MABUR_THREADED_SINK_H_

#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include "mabur/dvr_mux.h"

namespace mabur {

// A DvrSink that moves the I/O of another sink onto its own writer thread.
//
// DvrMux writes a fragment out whole when it closes: about 2.5 MB at the
// burned DVR's 20 Mbit/s, which takes ~22 ms through a FILE* on the GS's
// vfat card. Done on the burned DVR's encoder thread, whose per-frame
// budget at 60 fps is 16.7 ms with ~14 ms already spent encoding, that
// write cost one recorded frame per fragment. Wrapped in this sink, the
// caller only copies the bytes into a queue; the card's latency lands on
// the writer thread.
//
// Calls keep the inner sink's order. write()/flush() return as soon as the
// work is queued, so their result reports earlier failures: an inner write
// or flush that fails makes every later call return false and drops all
// queued work, which is how DvrMux learns the card is full or gone (one
// call late). sync() waits until everything queued before it has reached
// the inner sink and the inner sync() ran. The destructor drains the queue
// and then destroys the inner sink (fclose for a file sink).
//
// The queue is capped at max_queued_bytes; a write that would pass the cap
// waits for room, so a card that stalls for seconds pushes back on the
// caller instead of growing memory. One write larger than the cap is
// accepted once the queue is empty.
//
// The writer thread ("mbr-dvrw") runs kWriterNiceStep nice steps below the
// thread that created the sink. Writing a fragment is CPU work too (the copy
// into the page cache, the FAT updates), and at equal priority it competes
// with the GS's display loop, which then wakes a few ms late and misses a
// vblank. The writer has no deadline; the queue absorbs its delays.
//
// One producer: DvrMux calls it from a single thread.
class ThreadedSink final : public DvrSink {
 public:
  static constexpr size_t kDefaultMaxQueuedBytes = 32u << 20;  // ~13 s at 20 Mbit/s
  static constexpr int kWriterNiceStep = 10;
  explicit ThreadedSink(std::unique_ptr<DvrSink> inner,
                        size_t max_queued_bytes = kDefaultMaxQueuedBytes);
  ~ThreadedSink() override;
  ThreadedSink(const ThreadedSink&) = delete;
  ThreadedSink& operator=(const ThreadedSink&) = delete;

  bool write(const uint8_t* p, size_t n) override;
  bool flush() override;
  bool sync() override;

 private:
  enum class Op : uint8_t { Write, Flush, Sync };
  struct Item {
    Op op;
    std::vector<uint8_t> data;  // Write only
  };

  void run();
  bool enqueue(Item item, size_t bytes, uint64_t* seq);

  std::unique_ptr<DvrSink> inner_;
  const size_t max_queued_bytes_;

  std::mutex mu_;
  std::condition_variable work_cv_;  // writer thread: an item or stop
  std::condition_variable done_cv_;  // producer: room in the queue, or an item done
  std::deque<Item> queue_;
  size_t queued_bytes_ = 0;  // includes the item the writer is working on
  uint64_t enqueued_ = 0;    // items ever queued
  uint64_t done_ = 0;        // items the writer has finished (or dropped)
  bool failed_ = false;
  bool stop_ = false;
  std::thread thread_;
};

}  // namespace mabur

#endif  // MABUR_THREADED_SINK_H_
