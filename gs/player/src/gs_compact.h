#ifndef MABUR_PLAYER_GS_COMPACT_H_
#define MABUR_PLAYER_GS_COMPACT_H_

#include <cstdint>
#include <string>
#include <vector>

#include "gs_layer.h"
#include "osd_raster.h"  // Surface, DirtyRect

namespace maburplay {

class GsFont;
struct MaskAtlas;

// The GS link-status OSD: two plain-text rows along the bottom edge.
//
//                                                   ● REC 12:47   <- top right
//   ...
//   ch:149 mcs:5 air:62% rssi:-70/-72 snr:22/20 temp:41
//   bitrate:8.1 res:1280x720 fps:60 jit:5.2 lat:45/78 loss:0.3/0.0
//
// `temp` is the drone SoC temperature (sideport drone.sys.soc_temp_c),
// caution-coloured from 70 C; it sits on the radio row because it is
// drone-sourced, not player-measured.
//
// With the GS's channel scan enabled (sideport scan.state != "off") the
// channel reads "ch:149(a)": the number may be an auto-selected pick rather
// than the configured home (docs/channel-select.md).
//
// TWO rows, not one, purely for type size: the eleven items on a single
// line cap out at 22 px on a 1080p panel (132 worst-case characters into
// 1856 px), which is too small to read on the GS screen. Split across two
// rows the widest one is ~74 character advances, and the same "largest
// baked size that fits" rule lands on ~38 px -- 1.7x. The rows are split by
// SOURCE (link above, video below) rather than by width, so the pilot reads
// the radio on one line and the picture on the other; `loss` sits with the
// video row it explains rather than with the radio figures that cause it.
//
// No status colours, no meters, no bars -- every glyph takes
// tok::kTextPrimary, with three deliberate exceptions.
//
// The first is staleness: the six LINK-sourced items dim to
// tok::kTextLabel while the sideport is quiet, because the alternative is
// a line of frozen numbers that looks live, which is the failure this OSD
// exists to prevent. The player-measured items never dim -- they are
// current by construction.
//
// The second is the RECORDING indicator: a tok::kStatusRec dot, "REC" and
// an mm:ss clock, or "REC FAULT" in tok::kStatusCaution. The dot gets its
// own hue because recording is a mode, not a status, and a white dot does
// not read as recording. Armed draws nothing at all.
//
// It sits alone in the top-right corner, at half the bar's type size,
// rather than in either row for a purely mechanical reason: a row's width
// sets the type size the whole bar renders at (see kRow in the .cpp), so
// an item in a row costs every other figure a size step, and a box blank
// for the whole flight (armed is the normal state) inside a CENTRED row
// would drag that row off centre. Anchored in the corner it costs the bar
// nothing and never moves when the recorder starts or stops.
//
// The third is low-power (pre-arm) mode: while
// snap.low_power is set, the fps cell -- the one player-measured item
// this exception touches -- takes tok::kStatusCaution instead of
// tok::kTextPrimary, so the pilot can tell a deliberately throttled rate
// from a fault. Colour only: the text is exactly what it would be
// otherwise. The staleness interaction is the other way round from the
// first exception: the fps CELL is player-measured and never dims, but the
// low_power FLAG is link-sourced, so the tint is gated on !stale -- a
// quiet sideport makes the flag arbitrarily old, and a caution tint driven
// by a frozen flag over a live number is the same failure staleness
// dimming exists to prevent.
//
// The glyph mask's baked drop shadow stays. It is part of the glyph, not
// styling: without it the line is unreadable over bright video.
//
// Dirty tracking is per FIELD: each item has a box sized at layout() from
// its worst-case string, so a value change never reflows a row and a
// typical second redraws only the one or two items whose text moved,
// ~12 k px each at 1080p. That margin is load-bearing, not tidy: update()
// runs on maburplay's 2 ms pump loop. Measured against the real asset with
// four cards and a live REC (tools/bench/gs_osd_bench.cpp), a FULL repaint
// is 194,974 px at 1080p and 729,568 at 2160p -- ~4.6 ms and ~13.7 ms of
// draw + quantize projected on the A55, both past the pump period. So a full repaint is a
// startup/re-layout event and must never land on a cadence; do not add a
// caller that restates every field on a timer. (What that costs when it
// happens is flip-reap latency, not a dropped AU: ring.pump(2) is a poll()
// ceiling and the shm ring is slotted. And the quantize half is
// burned-DVR-only.)
// The order here is the draw order and the index into the shadow array.
// Which ROW each item lands on is kRow in the .cpp, not this enum.
enum class GsBarField {
  kCh = 0,
  kMcs,
  kAir,
  kRssi,
  kSnr,
  kTemp,
  kBitrate,
  kRes,
  kFps,
  kJit,
  kLat,
  kLoss,
  kRec,
  kCount,
};

class GsCompactBar final : public GsLayer {
 public:
  // rec_target sizes the kRec box (gs_layer.h rec_worst); the default is
  // dvr.target's own default, "gs".
  explicit GsCompactBar(GsFont& font, RecTarget rec_target = RecTarget::kGs)
      : font_(font), rec_target_(rec_target) {}

  // Picks the LARGEST baked atlas whose worst-case rows (kMaxCards cards,
  // every value at the magnitude its clamp allows) both fit between the
  // insets and stack inside the surface, then centres each row for however
  // many cards are actually reported. Type size is fixed at the worst case
  // on purpose: sizing it to the live card count would change the font
  // under the pilot the first time a card dropped out. Fails (with *err
  // set) when even the smallest baked size cannot fit.
  bool layout(int screen_w, int screen_h, std::string* err) override;

  int update(const GsSnapshot& snap, bool stale, const GsPlayerState& ps,
             const Surface& s, std::vector<DirtyRect>* out) override;
  int repaint_intersecting(const DirtyRect* rects, size_t n, const Surface& s,
                           std::vector<DirtyRect>* out) override;
  void invalidate() override;
  DirtyRect bounds() const override { return bounds_; }

  int field_count() const { return (int)GsBarField::kCount; }

  // Test hooks. `debug_field_text` formats without
  // drawing; `debug_field_box` is what the no-overflow tests measure text
  // against; `debug_atlas_px` is the size layout() resolved, 0 before it
  // has run.
  std::string debug_field_text(const GsSnapshot& snap, bool stale,
                               const GsPlayerState& ps, GsBarField id) const;
  uint32_t debug_field_rgb(const GsSnapshot& snap, bool stale,
                           const GsPlayerState& ps, GsBarField id) const {
    return state_of_(snap, stale, ps, id).rgb;
  }
  DirtyRect debug_field_box(GsBarField id) const;
  int debug_atlas_px() const;
  int debug_rec_atlas_px() const;  // the REC indicator's size, 0 before layout()
  // Width of worst-case row `row` in `a`, boxes included -- exactly what
  // layout() compares against the space between the insets. Exposed so the
  // size-choice test can assert "no larger baked size fits" by the same
  // measurement layout() makes, rather than by reimplementing it.
  static int worst_row_width(const MaskAtlas& a, int row, int n_cards);
  // Which row an item draws on: 0 (link figures), 1 (video figures), or
  // kCorner for the recording indicator, which is right-flushed at the top
  // inset and belongs to no row.
  static int row_of(GsBarField id);
  static constexpr int kRows = 2;
  static constexpr int kCorner = -1;
  // The widest string field `id` can render with `n_cards` cards -- what
  // its box is sized from, and the only thing standing between a corrupt
  // datagram's 300-character number and permanent garbage on the glass
  // (draw_text clips to the SURFACE, clear_region only to the box). Every
  // clamp in state_of_ exists to keep the live string inside this one.
  // Public (not just an implementation detail of layout()) so a worst-case
  // format change -- like the 40 MHz rung's width suffix -- can be pinned
  // by its own test rather than only indirectly through worst_row_width.
  // kRec's worst case depends on dvr.target (gs_layer.h rec_worst); every
  // other field ignores rec_target.
  static std::string worst_case(GsBarField id, int n_cards,
                                RecTarget rec_target = RecTarget::kGs);
  // The number of card slots the line is currently drawn for, -1 before the
  // first update() has reconciled one.
  int debug_cards() const { return n_cards_; }
  // Whether a field currently renders. Every field is active for the life
  // of a layout now that REC no longer joins and leaves a row; the hook
  // stays because the box-overlap tests scope themselves to active fields.
  bool debug_field_active(GsBarField id) const { return f_(id).active; }

 private:
  struct FieldState {
    std::string text;
    uint32_t rgb = 0;
    // 1 = paint the leading glyph in tok::kStatusRec (the recording dot),
    // -1 = unused. One field, two colours: they change together, so splitting them would double the dirty rects for
    // nothing.
    int aux = -1;
    bool operator==(const FieldState&) const = default;
  };
  struct Field {
    DirtyRect box{0, 0, 0, 0};
    int pen_x = 0;
    int baseline_y = 0;
    // false => this field never renders and never clears. Nothing sets it
    // false today; it exists so a future item that comes and goes cannot
    // draw or clear through a box it no longer owns.
    bool active = false;
    FieldState last;
    bool valid = false;
  };

  FieldState state_of_(const GsSnapshot& snap, bool stale,
                       const GsPlayerState& ps, GsBarField id) const;
  // Centres each row for `n_cards` and recomputes every box. Called by
  // layout() (with kMaxCards, to reserve nothing wider than the atlas was
  // chosen for) and by update() whenever the reported card count moves.
  void place_(int n_cards);
  void draw_field_(GsBarField id, const FieldState& st, const Surface& s);
  Field& f_(GsBarField id) { return fields_[(size_t)id]; }
  const Field& f_(GsBarField id) const { return fields_[(size_t)id]; }

  GsFont& font_;
  RecTarget rec_target_;
  Field fields_[(size_t)GsBarField::kCount];
  const MaskAtlas* atlas_ = nullptr;
  // The REC corner item's atlas: the nearest baked size to half of atlas_.
  // Every other field shares atlas_.
  const MaskAtlas* rec_atlas_ = nullptr;
  const MaskAtlas* atlas_for_(GsBarField id) const {
    return id == GsBarField::kRec && rec_atlas_ ? rec_atlas_ : atlas_;
  }
  DirtyRect bounds_{0, 0, 0, 0};
  int screen_w_ = 0, gap_ = 0, inset_x_ = 0;
  // Baseline of each row, absolute within the surface. Row 1 is the bottom
  // one, anchored to the inset; row 0 stacks above it.
  int baseline_y_[kRows] = {0, 0};
  // Baseline of the corner-anchored recording indicator, at the TOP inset.
  int corner_baseline_ = 0;
  int n_cards_ = -1;  // card slots the line is placed for; -1 = never placed
  bool laid_out_ = false;
};

}  // namespace maburplay

#endif  // MABUR_PLAYER_GS_COMPACT_H_
