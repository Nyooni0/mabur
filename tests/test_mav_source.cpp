#include "mtest.h"
#include "mav_source.h"

#include <vector>

using namespace mabur;

namespace {
std::vector<uint8_t> v2_frame(uint8_t len, uint8_t incompat = 0, uint8_t fill = 0xAA) {
  std::vector<uint8_t> f = {0xfd, len, incompat, 0x00, 0x01, 0x01, 0x01,
                            0x1e, 0x00, 0x00};
  for (uint8_t i = 0; i < len; ++i) f.push_back(static_cast<uint8_t>(fill + i));
  f.push_back(0);
  f.push_back(0);
  if (incompat & 0x01) f.insert(f.end(), 13, 0x5A);  // signature
  return f;
}

std::vector<uint8_t> v1_frame(uint8_t len, uint8_t fill = 0x33) {
  std::vector<uint8_t> f = {0xfe, len, 0x01, 0x01, 0x01, 0x1e};
  for (uint8_t i = 0; i < len; ++i) f.push_back(static_cast<uint8_t>(fill + i));
  f.push_back(0);
  f.push_back(0);
  return f;
}
}  // namespace

TEST(framer_emits_complete_frames_and_resyncs) {
  MavSourceCfg cfg;
  std::vector<std::vector<uint8_t>> got;
  MavSource src(cfg, [&](const uint8_t* p, size_t n) { got.emplace_back(p, p + n); });
  auto a = v2_frame(28);
  std::vector<uint8_t> stream = {0x00, 0x11, 0x22};  // garbage
  stream.insert(stream.end(), a.begin(), a.end());
  auto b = v2_frame(9);
  stream.insert(stream.end(), b.begin(), b.end());
  src.on_bytes(stream.data(), stream.size(), 1000);
  REQUIRE(got.size() == 2);
  CHECK(got[0] == a);
  CHECK(got[1] == b);
  CHECK(src.frames() == 2);
  CHECK(src.bytes() == a.size() + b.size());
}

TEST(framer_emits_v1_frames) {
  std::vector<std::vector<uint8_t>> got;
  MavSource src(MavSourceCfg{}, [&](const uint8_t* p, size_t n) { got.emplace_back(p, p + n); });
  auto f = v1_frame(20);
  src.on_bytes(f.data(), f.size(), 1000);
  REQUIRE(got.size() == 1);
  CHECK(got[0] == f);
}

TEST(framer_waits_for_a_frame_split_across_reads) {
  auto f = v2_frame(30);
  std::vector<std::vector<uint8_t>> got;
  MavSource s(MavSourceCfg{}, [&](const uint8_t* p, size_t n) { got.emplace_back(p, p + n); });
  s.on_bytes(f.data(), 5, 1000);
  CHECK(got.empty());
  s.on_bytes(f.data() + 5, f.size() - 5, 1001);
  REQUIRE(got.size() == 1);
  CHECK(got[0] == f);
}

TEST(framer_handles_a_signed_v2_frame) {
  std::vector<std::vector<uint8_t>> got;
  MavSource s(MavSourceCfg{}, [&](const uint8_t* p, size_t n) { got.emplace_back(p, p + n); });
  auto f = v2_frame(12, 0x01);
  REQUIRE(f.size() == 10 + 12 + 2 + 13);
  s.on_bytes(f.data(), f.size(), 1000);
  REQUIRE(got.size() == 1);
  CHECK(got[0] == f);
}

TEST(token_bucket_drops_over_budget) {
  auto f = v2_frame(100);   // 112 B on the wire
  uint64_t sent = 0;
  MavSource src(MavSourceCfg{500}, [&](const uint8_t*, size_t) { ++sent; });
  for (int i = 0; i < 8; ++i) src.on_bytes(f.data(), f.size(), 1000);
  CHECK(sent == 4);         // 4 * 112 = 448 <= 500; the 5th is dropped
  CHECK(src.frames() == 4);
  CHECK(src.dropped() == 4);
}

TEST(token_bucket_refills_over_time) {
  auto f = v2_frame(10);    // 22 B on the wire
  uint64_t sent = 0;
  MavSource src(MavSourceCfg{500}, [&](const uint8_t*, size_t) { ++sent; });
  for (int i = 0; i < 22; ++i) src.on_bytes(f.data(), f.size(), 1000);  // 484 B
  CHECK(sent == 22);
  src.on_bytes(f.data(), f.size(), 1000);   // 506 B: no budget
  CHECK(sent == 22);
  src.on_bytes(f.data(), f.size(), 1500);   // 500 ms refills the cap
  CHECK(sent == 23);
}

TEST(garbage_without_a_frame_boundary_is_bounded) {
  MavSource src(MavSourceCfg{}, [](const uint8_t*, size_t) {});
  std::vector<uint8_t> junk(9000, 0x55);
  src.on_bytes(junk.data(), junk.size(), 1000);
  CHECK(src.frames() == 0);
}

MTEST_MAIN