#include <atomic>
#include <chrono>
#include <thread>
#include <vector>
#include "fake_link_card.h"
#include "mtest.h"
#include "nhm_busy.h"
#include "window_sampler.h"
using namespace maburgs;

// The atomics ChannelCore owns, in test form.
struct Gates {
  std::atomic<bool> in_session{true}, cal_running{false};
  std::atomic<uint8_t> op{40};
  std::atomic<bool> dwell_busy{false};
  std::atomic<int> dwell_card{-1};
  std::vector<std::atomic<uint32_t>> dwell_gen, tune_gen;
  std::vector<std::atomic<bool>> card_blocked;
  explicit Gates(size_t n) : dwell_gen(n), tune_gen(n), card_blocked(n) {}
  WindowGates view() {
    return WindowGates{in_session, cal_running, op, dwell_busy, dwell_card, dwell_gen, tune_gen, card_blocked};
  }
};

struct Rig {
  FakeClock clk;
  std::vector<std::unique_ptr<FakeCard>> cards;
  std::vector<LinkCard*> ptrs;
  Gates gates;
  std::unique_ptr<WindowSampler> s;
  explicit Rig(int n_usb, int n_relays = 0) : gates(static_cast<size_t>(n_usb + n_relays)) {
    for (int i = 0; i < n_usb + n_relays; ++i) {
      auto c = std::make_unique<FakeCard>();
      c->clk = &clk; c->ch = 40; c->relay = i >= n_usb;
      ptrs.push_back(c.get()); cards.push_back(std::move(c));
    }
    WindowSamplerCfg cfg; cfg.window_ms = 150; cfg.nhm_period_4us = 35000; cfg.busy_dbm = -83;
    s = std::make_unique<WindowSampler>(ptrs, cfg, gates.view());
  }
};

static NhmBusyRead busy_read(uint16_t period) {
  NhmBusyRead r; r.valid = true; r.period = period;
  for (int i = 0; i < 12; ++i) r.buckets[i] = 10;   // half the buckets sit above -83 dBm
  return r;
}

TEST(one_pass_samples_every_card_in_order) {
  Rig g(2);
  g.cards[0]->fa_next = 7; g.cards[1]->fa_next = 9;
  g.cards[0]->fr.own = 100; g.cards[1]->fr.own = 200;
  const WindowRecord r = g.s->sample_once(1000);
  REQUIRE(r.cards.size() == 2);
  CHECK(r.t_ms == 1000);
  CHECK(r.cards[0].valid && r.cards[1].valid);
  CHECK(r.cards[0].energy.fa_ofdm == 7 && r.cards[1].energy.fa_ofdm == 9);
  CHECK(r.cards[0].frames.own == 100 && r.cards[1].frames.own == 200);
  CHECK(r.cards[0].channel == 40);
  // the sequence on a card: survey, nhm read, (energy, frames), nhm arm
  const auto& c = g.cards[0]->calls;
  REQUIRE(c.size() >= 3);
  CHECK(c[0] == "survey" && c[1] == "read_nhm" && c.back() == "arm_nhm 35000");
}

TEST(nhm_pct_needs_our_own_arm) {
  Rig g(1);
  g.cards[0]->nhm_arm_ok = true;
  g.cards[0]->nhm_read = busy_read(35000);
  const WindowRecord first = g.s->sample_once(1000);
  CHECK(!first.cards[0].nhm_busy_pct);          // nothing armed yet
  const WindowRecord second = g.s->sample_once(1150);
  REQUIRE(second.cards[0].nhm_busy_pct.has_value());
  CHECK(*second.cards[0].nhm_busy_pct == *nhm_busy_pct(busy_read(35000), -83));
}

TEST(dwell_tune_channel_or_period_change_empties_nhm_pct) {
  Rig g(1);
  g.cards[0]->nhm_arm_ok = true; g.cards[0]->nhm_read = busy_read(35000);
  g.s->sample_once(1000);
  g.gates.dwell_gen[0].fetch_add(1);
  CHECK(!g.s->sample_once(1150).cards[0].nhm_busy_pct);   // a dwell landed since the arm
  g.gates.tune_gen[0].fetch_add(1);
  CHECK(!g.s->sample_once(1300).cards[0].nhm_busy_pct);   // the core retuned since the arm
  g.cards[0]->nhm_read = busy_read(1250);
  CHECK(!g.s->sample_once(1450).cards[0].nhm_busy_pct);   // someone else's period
  g.cards[0]->nhm_read = busy_read(35000);
  CHECK(g.s->sample_once(1600).cards[0].nhm_busy_pct.has_value());   // ours again
}

TEST(blocked_off_op_or_not_ready_card_is_invalid_and_disarmed) {
  Rig g(2);
  for (auto& c : g.cards) { c->nhm_arm_ok = true; c->nhm_read = busy_read(35000); }
  g.s->sample_once(1000);
  g.gates.card_blocked[0].store(true);            // boot scout owns card 0
  g.gates.dwell_busy.store(true); g.gates.dwell_card.store(1);   // dwell on card 1
  WindowRecord r = g.s->sample_once(1150);
  CHECK(!r.cards[0].valid && !r.cards[1].valid);
  g.gates.card_blocked[0].store(false); g.gates.dwell_busy.store(false); g.gates.dwell_card.store(-1);
  r = g.s->sample_once(1300);
  CHECK(r.cards[0].valid && !r.cards[0].nhm_busy_pct);   // disarmed while blocked: no reading
  g.cards[0]->ch = 64;                              // off the op channel
  CHECK(!g.s->sample_once(1450).cards[0].valid);
  g.cards[0]->ch = 40; g.cards[0]->is_ready = false;
  CHECK(!g.s->sample_once(1600).cards[0].valid);
}

TEST(survey_window_is_read_even_for_a_blocked_card) {
  Rig g(1, 1);
  g.gates.card_blocked[1].store(true);
  g.s->sample_once(1000);
  int surveys = 0;
  for (const auto& c : g.cards[1]->calls) surveys += c == "survey";
  CHECK(surveys == 1);
  CHECK(g.cards[1]->calls.size() == 1);   // and nothing else on a blocked card
}

TEST(reset_drops_arms_and_the_mailbox) {
  Rig g(1);
  g.cards[0]->nhm_arm_ok = true; g.cards[0]->nhm_read = busy_read(35000);
  g.s->publish(g.s->sample_once(1000));
  g.s->reset(1100);
  CHECK(!g.s->take().has_value());
  CHECK(!g.s->sample_once(1250).cards[0].nhm_busy_pct);   // the old arm is gone
}

TEST(mailbox_keeps_newest_and_counts_dropped) {
  Rig g(1);
  g.s->publish(g.s->sample_once(1000));
  g.s->publish(g.s->sample_once(1150));
  CHECK(g.s->dropped() == 1);
  const auto r = g.s->take();
  REQUIRE(r.has_value());
  CHECK(r->t_ms == 1150);
  CHECK(!g.s->take().has_value());
}

TEST(stepped_cadence_is_one_record_per_window_while_active) {
  Rig g(1);
  g.s->reset(1000);
  g.s->step(1100); CHECK(!g.s->take().has_value());     // not due
  g.s->step(1150); CHECK(g.s->take().has_value());      // due
  g.s->step(1160); CHECK(!g.s->take().has_value());     // next window not due
  g.gates.in_session.store(false);
  g.s->step(1400); CHECK(!g.s->take().has_value());     // inactive: nothing
  g.gates.in_session.store(true);
  g.s->step_now(1500); CHECK(g.s->take().has_value());  // the seam samples regardless of the cadence...
  g.s->step(1600); CHECK(!g.s->take().has_value());     // ...and restarts it
}

TEST(thread_publishes_and_stops) {
  Rig g(1);
  WindowSamplerCfg cfg; cfg.window_ms = 20; cfg.nhm_period_4us = 35000; cfg.busy_dbm = -83;
  WindowSampler s(g.ptrs, cfg, g.gates.view());
  const auto t0 = std::chrono::steady_clock::now();
  s.start([&] { return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - t0).count()); },
          [](int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); });
  std::this_thread::sleep_for(std::chrono::milliseconds(120));
  s.stop();
  s.stop();   // idempotent
  CHECK(s.take().has_value());
  CHECK(s.dropped() >= 1);   // several windows elapsed, only the newest is kept
}
MTEST_MAIN
