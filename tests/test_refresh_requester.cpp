#include "refresh_requester.h"
#include "mtest.h"
using maburgs::RefreshRequester;
using R = RefreshRequester::Reason;

TEST(idle_until_a_base_hole) {
  RefreshRequester q;
  q.note_au(0, true, false, 0, 100);     // clean base
  q.note_au(1, false, false, 0, 116);    // truncated enhance: nobody references it
  q.note_au(1, true, true, 0, 133);      // salvaged enhance
  CHECK(!q.armed());
  CHECK(q.epoch() == 0);
  CHECK(q.counters().requests == 0);
}

TEST(truncated_base_arms_and_bumps_at_once) {
  RefreshRequester q;
  q.note_au(0, false, false, 0, 1000);
  CHECK(q.armed());
  CHECK(q.epoch() == 1);
  CHECK(q.counters().requests == 1);
  CHECK(q.counters().by_reason[static_cast<size_t>(R::kHole)] == 1);
  auto ev = q.take_events();
  REQUIRE(ev.size() == 1);
  CHECK(ev[0].kind == 'I' && ev[0].reason == R::kHole && ev[0].epoch == 1 && ev[0].t_ms == 1000);
  CHECK(q.take_events().empty());
}

TEST(salvaged_base_and_lost_aus_arm_with_their_own_reason) {
  RefreshRequester a;
  a.note_au(0, true, true, 0, 10);        // salvaged base: still a stale reference
  CHECK(a.armed() && a.counters().by_reason[static_cast<size_t>(R::kSalvaged)] == 1);
  RefreshRequester b;
  b.note_dropped_total(0, 5);
  CHECK(!b.armed());
  b.note_dropped_total(2, 20);            // the stream advanced past two AUs
  CHECK(b.armed() && b.counters().by_reason[static_cast<size_t>(R::kLost)] == 1);
  b.note_dropped_total(2, 40);            // unchanged total: no new hole
  CHECK(b.counters().requests == 1);
}

TEST(retries_every_300_ms_while_armed) {
  RefreshRequester q;
  q.note_au(0, false, false, 0, 0);
  q.poll(299);
  CHECK(q.epoch() == 1 && q.counters().retries == 0);
  q.poll(300);
  CHECK(q.epoch() == 2 && q.counters().retries == 1);
  q.note_au(0, true, false, 0, 450);      // clean P frames do not clear it
  CHECK(q.armed() && q.epoch() == 2);
  q.note_au(0, false, false, 0, 500);     // another hole while armed: no early bump
  CHECK(q.epoch() == 2);
  q.poll(600);
  CHECK(q.epoch() == 3 && q.counters().retries == 2);
}

TEST(a_complete_base_irap_clears_and_books_the_heal) {
  RefreshRequester q;
  q.note_au(0, false, false, 0, 1000);
  q.poll(1300);                           // one retry
  q.note_au(0, true, false, 19, 1420);    // IDR_W_RADL, complete, base
  CHECK(!q.armed());
  CHECK(q.counters().heals == 1 && q.counters().heal_ms_last == 420);
  auto ev = q.take_events();
  REQUIRE(ev.size() == 3);                // I, I(retry), H
  CHECK(ev[2].kind == 'H' && ev[2].heal_ms == 420 && ev[2].retries == 1 && ev[2].t_ms == 1420);
  q.poll(2000);
  CHECK(q.epoch() == 2);                  // idle: no more bumps
}

TEST(every_irap_type_clears_but_a_refresh_start_does_not) {
  for (uint8_t t : {16, 17, 18, 19, 20, 21}) {
    RefreshRequester q;
    q.note_au(0, false, false, 0, 0);
    q.note_au(0, true, false, t, 50);
    CHECK(!q.armed());
  }
  RefreshRequester q;
  q.note_au(0, false, false, 0, 0);
  q.note_au(0, true, false, 1, 50);       // TRAIL_R with param sets: the old GDR start
  CHECK(q.armed());
  q.note_au(1, true, false, 19, 60);      // an IRAP on the enhance layer is not a base heal
  CHECK(q.armed());
}

TEST(irap_that_arrives_truncated_does_not_clear) {                // Review Focus 1
  RefreshRequester q;
  q.note_au(0, false, false, 0, 0);
  q.note_au(0, false, false, 19, 100);    // the IDR itself lost symbols
  CHECK(q.armed());
  q.poll(300);
  CHECK(q.epoch() == 2);                  // and the retry goes out
}

TEST(player_reasons_arm_like_a_hole) {
  RefreshRequester q;
  q.request(R::kStart, 10);
  CHECK(q.armed() && q.epoch() == 1);
  CHECK(q.counters().by_reason[static_cast<size_t>(R::kStart)] == 1);
  q.request(R::kDvr, 20);                 // already armed: counted, no early bump
  CHECK(q.epoch() == 1);
  CHECK(q.counters().by_reason[static_cast<size_t>(R::kDvr)] == 1);
  q.note_au(0, true, false, 20, 150);     // IDR_N_LP
  CHECK(!q.armed());
}

TEST(reason_names_round_trip) {
  for (size_t i = 0; i < static_cast<size_t>(R::kCount); ++i) {
    const auto r = static_cast<R>(i);
    auto back = RefreshRequester::reason_from(RefreshRequester::reason_name(r));
    REQUIRE(back.has_value());
    CHECK(*back == r);
  }
  CHECK(!RefreshRequester::reason_from("bogus").has_value());
  CHECK(!RefreshRequester::reason_from("").has_value());
}

TEST(epoch_wraps_without_repeating) {                               // Review Focus 2
  RefreshRequester q;
  q.note_au(0, false, false, 0, 0);
  uint8_t prev = q.epoch();
  for (int i = 1; i <= 300; ++i) {
    q.poll(static_cast<uint64_t>(i) * RefreshRequester::kRetryMs);
    CHECK(q.epoch() != prev);
    prev = q.epoch();
  }
  CHECK(q.counters().retries == 300);
}

TEST(first_bump_at_time_zero) {                                     // Review Focus 3
  RefreshRequester q;
  q.poll(0);
  CHECK(q.epoch() == 0);
  q.note_au(0, false, false, 0, 0);
  CHECK(q.epoch() == 1);
  q.poll(0);
  CHECK(q.epoch() == 1);                  // no double bump on the same instant
}

MTEST_MAIN
