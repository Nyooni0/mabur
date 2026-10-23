// UplinkDelivery: the GS-side share of its RCFs the drone accepted, over a
// trailing ~10 s window, plus the uplink state the OSD colours by. The
// drone contributes Telem.rcf_rx (cumulative accepted RCFs) and
// Telem.state; the GS contributes its own RCF send count.
#include <cstring>
#include <optional>

#include "mtest.h"
#include "uplink_delivery.h"

using maburgs::to_string;
using maburgs::UplinkDelivery;
using maburgs::UplinkState;

namespace {

// A flight segment: RCFs every 1000/sent_per_s ms and one Telem per second
// whose rcf_rx advances by heard_per_s. The object keeps its own counters,
// so consecutive segments continue where the last one stopped.
struct Fly {
  UplinkDelivery u;
  uint16_t tlm_seq = 0;
  uint32_t rcf_rx = 0;

  void telem(uint64_t t_ms, uint8_t state = 2) {
    u.on_telem(++tlm_seq, rcf_rx, state, t_ms);
  }
  void run(uint64_t from_ms, uint64_t to_ms, int sent_per_s, int heard_per_s,
           uint8_t state = 2) {
    const uint64_t step = sent_per_s > 0 ? 1000 / sent_per_s : 0;
    uint64_t next_send = from_ms;
    for (uint64_t t = from_ms; t < to_ms; ++t) {
      if (step && t == next_send) {
        u.on_rcf_sent(t);
        next_send += step;
      }
      if ((t - from_ms) % 1000 == 999) {
        rcf_rx += static_cast<uint32_t>(heard_per_s);
        telem(t, state);
      }
    }
  }
};

}  // namespace

TEST(no_telem_is_none) {
  UplinkDelivery u;
  CHECK(u.view(0).state == UplinkState::kNone);
  CHECK(!u.view(0).pct);
  u.on_rcf_sent(10);
  CHECK(u.view(20).state == UplinkState::kNone);
}

TEST(steady_95_is_ok) {
  Fly f;
  f.run(0, 11000, 20, 19);
  const auto v = f.u.view(11000);
  CHECK(v.state == UplinkState::kOk);
  REQUIRE(v.pct);
  CHECK(*v.pct == 95);
}

TEST(under_80_is_low_and_80_is_ok) {
  Fly a;
  a.run(0, 11000, 20, 15);
  CHECK(a.u.view(11000).state == UplinkState::kLow);
  CHECK(a.u.view(11000).pct == std::optional<int>(75));
  Fly b;
  b.run(0, 11000, 20, 16);
  CHECK(b.u.view(11000).state == UplinkState::kOk);
  CHECK(b.u.view(11000).pct == std::optional<int>(80));
}

TEST(no_pct_before_nine_seconds) {
  Fly f;
  f.run(0, 5000, 20, 19);
  CHECK(f.u.view(5000).state == UplinkState::kWait);
  CHECK(!f.u.view(5000).pct);
}

TEST(stale_holds_last_pct) {
  Fly g;
  g.run(0, 11000, 20, 19);   // last Telem at 10999
  // RCFs keep going out; no Telem comes back.
  for (uint64_t t = 11000; t <= 14000; t += 50) g.u.on_rcf_sent(t);
  CHECK(g.u.view(10999 + 3000).state != UplinkState::kStale);
  const auto v = g.u.view(10999 + 3001);
  CHECK(v.state == UplinkState::kStale);
  CHECK(v.pct == std::optional<int>(95));
}

TEST(idle_beats_dead) {
  Fly f;
  f.run(0, 11000, 20, 19);   // last send at 10950
  // GS stops sending (BEACONING); the drone fails safe and says so.
  f.telem(11500, 3);
  f.telem(12500, 3);
  const auto v = f.u.view(10950 + 1001);
  CHECK(v.state == UplinkState::kIdle);
  CHECK(f.u.view(12600).state == UplinkState::kIdle);
}

TEST(dead_on_failsafe_while_sending) {
  Fly f;
  f.run(0, 11000, 20, 19);
  f.run(11000, 12000, 20, 0, 3);   // still sending; the drone reports FAILSAFE
  const auto v = f.u.view(12000);
  CHECK(v.state == UplinkState::kDead);
  CHECK(v.pct.has_value());
  CHECK(*v.pct > 0);   // the window still holds the earlier good number
}

TEST(dead_needs_two_seconds_of_sending) {
  UplinkDelivery u;
  for (uint64_t t = 1000; t <= 3000; t += 50) {
    u.on_rcf_sent(t);
    if (t == 1500) {
      u.on_telem(1, 0, 1, t);   // RENDEZVOUS, 500 ms into the sending run
      CHECK(u.view(t).state == UplinkState::kWait);
    }
    if (t == 3000) {
      u.on_telem(2, 0, 1, t);   // still RENDEZVOUS after 2 s of sending
      CHECK(u.view(t).state == UplinkState::kDead);
    }
  }
}

TEST(zero_window_is_dead) {
  Fly f;
  f.run(0, 11000, 20, 0);
  const auto v = f.u.view(11000);
  CHECK(v.state == UplinkState::kDead);
  CHECK(v.pct == std::optional<int>(0));
}

TEST(drone_restart_resets_the_window) {
  Fly f;
  f.run(0, 11000, 20, 19);
  f.rcf_rx = 3;   // maburd restarted: its counter starts over
  f.telem(11500);
  CHECK(!f.u.view(11500).pct);
  CHECK(f.u.view(11500).state == UplinkState::kWait);

  Fly g;
  g.run(0, 11000, 20, 19);
  g.rcf_rx += 19;
  g.u.on_telem(static_cast<uint16_t>(g.tlm_seq - 100), g.rcf_rx, 2, 11500);
  CHECK(!g.u.view(11500).pct);
}

TEST(duplicate_tlm_seq_is_ignored) {
  Fly f;
  f.run(0, 11000, 20, 19);
  const auto before = f.u.view(11000);
  f.u.on_telem(f.tlm_seq, f.rcf_rx + 500, 3, 11000);   // same seq, other copy
  const auto after = f.u.view(11000);
  CHECK(after.pct == before.pct);
  CHECK(after.state == before.state);
}

TEST(window_carries_across_a_gs_pause) {
  Fly f;
  f.run(0, 11000, 20, 19);
  // 1.5 s with no RCF out; the drone hears nothing new but stays LINKED.
  f.telem(11999);
  f.telem(12999);
  CHECK(f.u.view(12500).state == UplinkState::kIdle);
  f.run(13000, 14000, 20, 19);
  const auto v = f.u.view(14000);
  CHECK(v.pct.has_value());
  CHECK(v.state == UplinkState::kOk);
}

TEST(to_string_spellings) {
  CHECK(std::strcmp(to_string(UplinkState::kNone), "none") == 0);
  CHECK(std::strcmp(to_string(UplinkState::kWait), "wait") == 0);
  CHECK(std::strcmp(to_string(UplinkState::kOk), "ok") == 0);
  CHECK(std::strcmp(to_string(UplinkState::kLow), "low") == 0);
  CHECK(std::strcmp(to_string(UplinkState::kDead), "dead") == 0);
  CHECK(std::strcmp(to_string(UplinkState::kIdle), "idle") == 0);
  CHECK(std::strcmp(to_string(UplinkState::kStale), "stale") == 0);
}

MTEST_MAIN
