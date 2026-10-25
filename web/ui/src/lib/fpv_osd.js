// FPV OSD layer for the web viewer.
//
// Drawing model: one canvas over the video, everything laid out in a fixed
// 1280x720 reference space and letterbox-scaled to the real backing store
// (CSS px * devicePixelRatio). Pure vector: thin strokes and outlined text,
// no fills, no panels, no shaded tape strips.
//
// `flight` carries:
//   pitch, roll (degrees, +nose up / +right bank)
//   heading (deg true), alt (m), speed (m/s), vario (m/s, + climbing)
// (battery / timer / voltage / link belong on the separate telemetry OSD.)
//
// Style lives in OSD_THEME and OSD_CFG below; nothing else hard-codes a colour
// or a size. Change `ink` to recolour the whole HUD.
//
// Composite marks (a rung plus its end hook, a tape spine plus its caps and
// ticks, the horizon plus its compass ticks) are built as ONE path and
// stroked once, so the dark text/stroke outline never eats into another
// mark's white line.

export const OSD_W = 1280;
export const OSD_H = 720;

export const OSD_THEME = {
  ink: '#ffffff',                 // marks, numerals, boxes
  muted: '#c3cbd8',               // secondary ticks, units, negative rungs
  warn: '#ffd23f',                // stall hatch (the only colour by default)
  halo: 'rgba(0, 0, 0, 0.7)',     // outline behind strokes/text, not a fill
};

export const OSD_CFG = {
  center: { x: 640, y: 360 },
  // Lens FOV, in degrees across the screen. The screen is rectilinear, so
  // horizontal and vertical are independent; the defaults are the ~130 deg
  // diagonal of the real camera at 16:9 (tan-based: 124 x 93). Measure one
  // axis on the bench and set it here -- the pitch ladder uses vfovDeg, the
  // velocity vector and world markers use hfovDeg.
  hfovDeg: 124,
  vfovDeg: 93,
  camPitchDeg: 12,        // camera boresight tilted down from the nose (deg)
  compassPpd: 2.3,        // px per degree of heading along the horizon rung
  ladder: { horizon: 200, rung: 112, gap: 26, rungGap: 22, clipTop: 190 },
  roll: { cy: 130, r: 54, span: 60 },
  tape: { half: 170, speedX: 270, altX: 1010, boxW: 72, boxH: 34, point: 10 },
  speed: {
    min: 0, max: 300, major: 10, minor: 5, ppu: 6.8, unit: 'km/h', scale: 3.6, stall: 30,
  },
  alt: { min: 0, max: 600, major: 20, minor: 10, ppu: 3.4, unit: 'm', scale: 1 },
  hdg: { labelY: 22, valueY: 44 },
  vvi: { offset: -34, half: 45, ppu: 4.5 },
  fpm: { margin: 36, wing: 26, r: 8, tick: 18 },
  home: { hideWithinM: 20, centreFrac: 0.15, margin: 36, glyphH: 8.2, glyphW: 5.8, glyphStroke: 2.8 },
};

const FONT = "'JetBrains Mono', ui-monospace, monospace";
const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrap180 = (d) => ((d + 540) % 360) - 180;
const COMPASS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

// Set per render() so a caller can pass its own palette/config.
let T = OSD_THEME;
let K = OSD_CFG;

// ---------------------------------------------------------------- primitives

function paint(ctx, o = {}) {
  const { w = 1.2, color = T.ink, dash = null, halo = 0 } = o;
  ctx.save();
  ctx.setLineDash(dash || []);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (halo > 0) {
    ctx.strokeStyle = T.halo;
    ctx.lineWidth = w + halo;
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke();
  ctx.restore();
}

// One path, one paint pass: the outline can never overlap its own main line.
function polyline(ctx, pts, o = {}) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  paint(ctx, o);
}

function line(ctx, x1, y1, x2, y2, o = {}) {
  polyline(ctx, [[x1, y1], [x2, y2]], o);
}

function txt(ctx, s, x, y, o = {}) {
  const { size = 13, align = 'center', baseline = 'middle', color = T.ink, weight = 500, halo = 2.6 } = o;
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (halo > 0) {
    ctx.lineWidth = halo;
    ctx.strokeStyle = T.halo;
    ctx.lineJoin = 'round';
    ctx.strokeText(s, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

// ---------------------------------------------------------------- attitude

// The horizon rung is also the compass: cardinal ticks and labels ride just
// above it, banked with the world. Letters stay upright for readability.
function drawHorizon(ctx, heading, roll) {
  const half = K.ladder.horizon;
  const gap = K.ladder.gap;
  const ppd = K.compassPpd;
  const letters = [];
  const minors = [];

  ctx.beginPath();
  for (const s of [-1, 1]) {
    ctx.moveTo(s * gap, 0);
    ctx.lineTo(s * half, 0);
    ctx.lineTo(s * half, 9);
  }
  const from = Math.floor((heading - half / ppd) / 15) * 15;
  const to = Math.ceil((heading + half / ppd) / 15) * 15;
  for (let b = from; b <= to; b += 15) {
    const x = wrap180(b - heading) * ppd;
    if (Math.abs(x) > half - 6) continue;
    const norm = ((b % 360) + 360) % 360;
    if (norm % 45 === 0) {
      ctx.moveTo(x, 4);
      ctx.lineTo(x, 12);
      letters.push([x, COMPASS[norm]]);
    } else {
      minors.push(x);
    }
  }
  paint(ctx, { w: 1.6, halo: 1.6 });

  // Minor ticks sit clear of the line and get no halo, so they cannot cut it.
  ctx.save();
  ctx.strokeStyle = T.muted;
  ctx.lineWidth = 1;
  for (const x of minors) { ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, 8); ctx.stroke(); }
  ctx.restore();

  for (const [x, label] of letters) {
    ctx.save();
    ctx.translate(x, -13);
    ctx.rotate(roll * DEG);
    txt(ctx, label, 0, 0, { size: 13, color: T.ink, weight: 600, halo: 2.8 });
    ctx.restore();
  }
}

// One rung: line + outer end hook in a single path, so the halo does not eat
// into the corner. Labels bank with the rung.
function drawRung(ctx, p, y) {
  const half = K.ladder.rung;
  const gap = K.ladder.rungGap;
  const col = p < 0 ? T.muted : T.ink;
  const dash = p < 0 ? [6, 5] : null;
  const hook = p > 0 ? 8 : -8;      // up on -pitch, down on +pitch
  for (const s of [-1, 1]) {
    polyline(ctx, [[s * gap, y], [s * half, y], [s * half, y + hook]], { w: 1.5, color: col, dash, halo: 1.5 });
    txt(ctx, `${p}\u00b0`, s * (half + 10), y, {
      size: 13, align: s > 0 ? 'left' : 'right', color: col, halo: 2.4,
    });
  }
}

function drawAttitude(ctx, f) {
  const cx = K.center.x, cy = K.center.y;
  const roll = clamp(f.roll || 0, -180, 180);
  const heading = ((f.heading || 0) % 360 + 360) % 360;
  const pitch = f.pitch || 0;
  const cam = K.camPitchDeg || 0;
  const ty = Math.tan((K.vfovDeg * DEG) / 2);
  // Screen y (relative to the boresight/centre) of a rung at pitch p, for a
  // camera tilted down by `cam`: exact rectilinear mapping, same maths as the
  // world markers, so the ladder and the home/FPM agree.
  const yFor = (p) => (-Math.tan((p - pitch + cam) * DEG) / ty) * (OSD_H / 2);

  // Rungs are clipped below the bank arc; the horizon/compass is not, so it
  // stays visible when a nose-down attitude pushes it up the screen.
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx - 330, K.ladder.clipTop, 660, OSD_H - K.ladder.clipTop);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-roll * DEG);
  for (let p = -80; p <= 80; p += 10) {
    if (p === 0) continue;
    const y = yFor(p);
    if (y < -600 || y > 600) continue;
    drawRung(ctx, p, y);
  }
  ctx.restore();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-roll * DEG);
  ctx.translate(0, yFor(0));
  drawHorizon(ctx, heading, roll);
  ctx.restore();

  // Centre reference: two small brackets above the horizon, no dot.
  for (const s of [-1, 1]) {
    polyline(ctx, [[cx + s * 19, cy - 7], [cx + s * 47, cy - 7], [cx + s * 47, cy + 2]], { w: 2.4, halo: 1.8 });
  }
}

function drawRollArc(ctx, f) {
  const x = K.center.x, y = K.roll.cy;
  const { r, span } = K.roll;
  ctx.beginPath();
  ctx.arc(x, y, r, (-90 - span) * DEG, (-90 + span) * DEG);
  for (let a = -60; a <= 60; a += 10) {
    if (Math.abs(a) > span) continue;
    const ang = (-90 + a) * DEG;
    const len = a % 30 === 0 ? 5 : 3;
    ctx.moveTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
    ctx.lineTo(x + Math.cos(ang) * (r - len), y + Math.sin(ang) * (r - len));
  }
  paint(ctx, { w: 1.1, halo: 1.5 });

  const pa = (-90 + clamp(f.roll || 0, -span, span)) * DEG;
  ctx.save();
  ctx.translate(x + Math.cos(pa) * (r + 2), y + Math.sin(pa) * (r + 2));
  ctx.rotate(pa + Math.PI / 2);
  ctx.beginPath();
  ctx.moveTo(0, 5); ctx.lineTo(-4, -2); ctx.lineTo(4, -2);
  ctx.closePath();
  ctx.fillStyle = T.ink;
  ctx.fill();
  ctx.restore();
}

function drawHeadingReadout(ctx, f) {
  const hdg = String(Math.round(((f.heading || 0) % 360 + 360) % 360) % 360);
  txt(ctx, 'HDG', K.center.x, K.hdg.labelY, { size: 11, color: T.muted, halo: 2.2 });
  txt(ctx, hdg.padStart(3, '0'), K.center.x, K.hdg.valueY, { size: 26, weight: 600, halo: 3 });
}

// ---------------------------------------------------------------- world markers

// Project a relative NED vector (north/east/down, metres) through the camera
// for the current attitude, using the rectilinear lens model. Everything that
// has a real-world position -- the home point, POIs, INAV-radar style friends
// -- goes through this one function.
//
// Returns screen coordinates in the 1280x720 reference space. `behind` is set
// when the point is behind the camera (x3 <= 0); the body-frame components
// are still returned so an edge marker can pick a side.
export function projectWorldPoint(relN, relE, relD, att, fov = OSD_CFG) {
  const psi = (att.heading || 0) * DEG;
  const theta = (att.pitch || 0) * DEG;
  const phi = (att.roll || 0) * DEG;

  // NED -> body (yaw, then pitch, then roll).
  const cyw = Math.cos(psi), syw = Math.sin(psi);
  const x1 = relN * cyw + relE * syw;
  const y1 = -relN * syw + relE * cyw;
  const z1 = relD;
  const cp = Math.cos(theta), sp = Math.sin(theta);
  const x2 = x1 * cp - z1 * sp;
  const y2 = y1;
  const z2 = x1 * sp + z1 * cp;
  const cr = Math.cos(phi), sr = Math.sin(phi);
  const x3 = x2;
  const y3 = y2 * cr + z2 * sr;
  const z3 = -y2 * sr + z2 * cr;

  // Camera-frame axes. A camera tilted down by camPitchDeg has its boresight
  // along body (cos, 0, sin) and its screen-down axis along (-sin, 0, cos).
  const cam = (fov.camPitchDeg || 0) * DEG;
  const cc = Math.cos(cam), sc = Math.sin(cam);
  const x4 = x3 * cc + z3 * sc;
  const z4 = -x3 * sc + z3 * cc;
  const y4 = y3;

  const out = { behind: x4 <= 1e-6, x3, y3, z3, x4, y4, z4, x: null, y: null };
  if (out.behind) return out;
  const tx = Math.tan(((fov.hfovDeg || 124) * DEG) / 2);
  const ty = Math.tan(((fov.vfovDeg || 93) * DEG) / 2);
  out.x = OSD_W / 2 + (y4 / x4 / tx) * (OSD_W / 2);
  out.y = OSD_H / 2 + (z4 / x4 / ty) * (OSD_H / 2);
  return out;
}

// Ground velocity vector in NED. Prefers explicit components; falls back to
// the fixed-wing telemetry pair the airframe usually has (GPS ground speed +
// course over ground) plus barometric climb.
function velocityVector(f) {
  if (Number.isFinite(f.velN) && Number.isFinite(f.velE)) {
    return [f.velN, f.velE, Number.isFinite(f.velD) ? f.velD : -(f.vario || 0)];
  }
  if (Number.isFinite(f.groundSpeed) && Number.isFinite(f.track)) {
    const tr = f.track * DEG;
    return [f.groundSpeed * Math.cos(tr), f.groundSpeed * Math.sin(tr), -(f.vario || 0)];
  }
  return null;
}

function homeVector(f) {
  if (Number.isFinite(f.homeRelN) && Number.isFinite(f.homeRelE)) {
    return [f.homeRelN, f.homeRelE, Number.isFinite(f.homeRelD) ? f.homeRelD : 0];
  }
  if (Number.isFinite(f.homeDist) && Number.isFinite(f.homeBearing)) {
    const br = f.homeBearing * DEG;
    return [f.homeDist * Math.cos(br), f.homeDist * Math.sin(br), 0];
  }
  return null;
}

// Flight-path marker: where the aircraft is actually going (ground track and
// climb), not where the nose points. Drawn as the circle-and-wings symbol.
function drawFlightPath(ctx, f) {
  const v = velocityVector(f);
  if (!v) return;
  const p = projectWorldPoint(v[0], v[1], v[2], f);
  if (p.behind) return;
  const m = K.fpm.margin;
  const x = clamp(p.x, m, OSD_W - m);
  const y = clamp(p.y, m, OSD_H - m);
  const { r, wing, tick } = K.fpm;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.moveTo(x - r, y); ctx.lineTo(x - wing, y);
  ctx.moveTo(x + r, y); ctx.lineTo(x + wing, y);
  ctx.moveTo(x, y - r); ctx.lineTo(x, y - tick);
  paint(ctx, { w: 2.2, halo: 2.2 });
}

function edgeTriangle(ctx, x, y, dir) {
  const s = 6, off = 20;
  ctx.beginPath();
  if (dir === 'right') {
    ctx.moveTo(x + off + s, y); ctx.lineTo(x + off - s, y - s); ctx.lineTo(x + off - s, y + s);
  } else if (dir === 'left') {
    ctx.moveTo(x - off - s, y); ctx.lineTo(x - off + s, y - s); ctx.lineTo(x - off + s, y + s);
  } else if (dir === 'bottom') {
    ctx.moveTo(x, y + off + s); ctx.lineTo(x - s, y + off - s); ctx.lineTo(x + s, y + off - s);
  } else {
    ctx.moveTo(x, y - off - s); ctx.lineTo(x - s, y - off + s); ctx.lineTo(x + s, y - off + s);
  }
  ctx.closePath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = T.halo;
  ctx.stroke();
  ctx.fillStyle = T.ink;
  ctx.fill();
}

// Project and clamp to a margin. Returns the marker position and, when the
// point is off screen or behind, which edge gets the direction triangle.
// POIs / INAV-radar icons can use this directly after projecting their point.
//
// Off-screen placement uses the camera-frame direction (y4, z4), not the
// perspective ratio, so it is continuous through the 90-degree/behind
// boundary: the marker slides around the perimeter instead of jumping
// between edges when the target passes abeam.
export function placeWorldPoint(relN, relE, relD, att, fov = OSD_CFG, margin = 36) {
  const p = projectWorldPoint(relN, relE, relD, att, fov);
  if (!p.behind
    && p.x >= margin && p.x <= OSD_W - margin
    && p.y >= margin && p.y <= OSD_H - margin) {
    return { x: p.x, y: p.y, edge: null, behind: false };
  }

  let dx = p.y4, dy = p.z4;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) { dx = 0; dy = 1; } else { dx /= len; dy /= len; }
  if (p.behind) {
    // Behind the camera the screen direction is ambiguous; bias it toward the
    // bottom edge as it goes further behind. The bias ramps from 0 at abeam,
    // so the marker slides around the perimeter instead of jumping.
    const b = clamp(-p.x4 / Math.max(1e-6, Math.hypot(p.x4, p.y4, p.z4)), 0, 1);
    const w = 0.85 * b;
    dx *= (1 - w);
    dy = dy * (1 - w) + w;
    const l2 = Math.hypot(dx, dy) || 1;
    dx /= l2; dy /= l2;
  }
  const sx = dx ? (OSD_W / 2 - margin) / Math.abs(dx) : Infinity;
  const sy = dy ? (OSD_H / 2 - margin) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return {
    x: OSD_W / 2 + dx * s,
    y: OSD_H / 2 + dy * s,
    // Triangle follows the edge that was actually hit.
    edge: sx <= sy ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top'),
    behind: p.behind,
  };
}

// Home point: projected at its real position, clamped to the edge with a
// direction triangle when off screen, 60% opacity normally / 10% over the
// centre 30%, hidden under 20 m.
function drawHome(ctx, f) {
  const rel = homeVector(f);
  if (!rel) return;
  const dist = Math.hypot(rel[0], rel[1], rel[2]);
  if (dist < K.home.hideWithinM) return;

  const { x, y, edge } = placeWorldPoint(rel[0], rel[1], rel[2], f, K, K.home.margin);
  const nearCentre = Math.abs(x - OSD_W / 2) <= K.home.centreFrac * OSD_W
    && Math.abs(y - OSD_H / 2) <= K.home.centreFrac * OSD_H;
  ctx.save();
  ctx.globalAlpha = nearCentre ? 0.1 : 0.6;
  drawHomeGlyph(ctx, x, y);
  ctx.restore();
  if (edge) {
    ctx.save();
    ctx.globalAlpha = 0.4;
    edgeTriangle(ctx, x, y, edge);
    ctx.restore();
  }
}

// Blocky vector "H", independent of the UI font.
function drawHomeGlyph(ctx, x, y) {
  const h = K.home.glyphH, w = K.home.glyphW;
  ctx.beginPath();
  ctx.moveTo(x - w, y - h); ctx.lineTo(x - w, y + h);
  ctx.moveTo(x + w, y - h); ctx.lineTo(x + w, y + h);
  ctx.moveTo(x - w, y); ctx.lineTo(x + w, y);
  paint(ctx, { w: K.home.glyphStroke, halo: 3 });
}

// ---------------------------------------------------------------- tapes

// Hatched stall band on the speed tape, no warning text. y0/y1 are already
// clamped to the visible tape.
function stallHatch(ctx, x, y0, y1) {
  const top = Math.min(y0, y1), h = Math.abs(y1 - y0);
  if (h < 2) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, top, 26, h);
  ctx.clip();
  ctx.strokeStyle = T.warn;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1.4;
  for (let y = top - 26; y < top + h + 26; y += 7) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 26, y - 19);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTape(ctx, f, side) {
  const left = side === 'left';
  const cfg = left ? K.speed : K.alt;
  const spine = left ? K.tape.speedX : K.tape.altX;
  const inward = left ? 1 : -1;        // ticks stay on the centre side
  const outward = -inward;             // caps, labels, box go outboard
  const cy = K.center.y, half = K.tape.half;
  const top = cy - half, bot = cy + half;
  const value = clamp(left ? (f.speed || 0) * cfg.scale : (f.alt || 0), cfg.min, cfg.max);

  const bw = K.tape.boxW, bh = K.tape.boxH, pt = K.tape.point;
  const tipX = spine;
  const nearX = spine + outward * pt;
  const farX = nearX + outward * bw;
  const boxTop = cy - bh / 2, boxBot = cy + bh / 2;
  const boxL = Math.min(nearX, farX), boxR = Math.max(nearX, farX);

  if (left && cfg.stall > cfg.min) {
    const yStall = cy + (value - cfg.stall) * cfg.ppu;
    const yZero = cy + (value - cfg.min) * cfg.ppu;
    const h0 = Math.max(top, Math.min(yStall, yZero));
    const h1 = Math.min(bot, Math.max(yStall, yZero));
    if (h1 - h0 > 1) stallHatch(ctx, spine + inward, h0, h1);
    if (yStall >= top && yStall <= bot) {
      line(ctx, spine, yStall, spine + inward * 26, yStall, { w: 1.6, color: T.warn, halo: 1.2 });
    }
  }

  const lo = Math.max(cfg.min, Math.floor((value - half / cfg.ppu) / cfg.major) * cfg.major);
  const hi = Math.min(cfg.max, Math.ceil((value + half / cfg.ppu) / cfg.major) * cfg.major);

  // Spine + outward caps + major ticks, one path (no halo cutting the line).
  ctx.beginPath();
  ctx.moveTo(spine, top); ctx.lineTo(spine, bot);
  ctx.moveTo(spine, top); ctx.lineTo(spine + outward * 20, top);
  ctx.moveTo(spine, bot); ctx.lineTo(spine + outward * 20, bot);
  for (let v = lo; v <= hi + 1e-6; v += cfg.major) {
    const y = cy + (value - v) * cfg.ppu;
    if (y < top - 1 || y > bot + 1) continue;
    ctx.moveTo(spine, y); ctx.lineTo(spine + inward * 12, y);
  }
  paint(ctx, { w: 1.4, halo: 1.6 });

  // One short notch between each written value: two marks per label.
  ctx.save();
  ctx.strokeStyle = T.ink;
  ctx.lineWidth = 1;
  for (let v = lo; v <= hi + 1e-6; v += cfg.minor) {
    if (Math.abs(v % cfg.major) < 1e-6) continue;
    const y = cy + (value - v) * cfg.ppu;
    if (y < top - 1 || y > bot + 1) continue;
    ctx.beginPath();
    ctx.moveTo(spine, y);
    ctx.lineTo(spine + inward * 7, y);
    ctx.stroke();
  }
  ctx.restore();

  // Written values. The current-value box cuts its own slot out of the column.
  for (let v = lo; v <= hi + 1e-6; v += cfg.major) {
    const y = cy + (value - v) * cfg.ppu;
    if (y < top + 14 || y > bot - 14) continue;
    if (y > boxTop - 7 && y < boxBot + 7) continue;
    txt(ctx, String(Math.round(v)), spine - inward * 14, y, {
      size: 13, align: left ? 'right' : 'left', color: T.ink, halo: 2.4,
    });
  }

  // Transparent value box: point on the tape side, rectangle outboard.
  ctx.beginPath();
  ctx.moveTo(farX, boxTop);
  ctx.lineTo(nearX, boxTop);
  ctx.lineTo(tipX, cy);
  ctx.lineTo(nearX, boxBot);
  ctx.lineTo(farX, boxBot);
  ctx.closePath();
  paint(ctx, { w: 1.5, halo: 1.6 });
  txt(ctx, String(Math.round(value)), (boxL + boxR) / 2, cy + 1, { size: 22, weight: 600, halo: 3 });

  // Units under the bottom cap.
  txt(ctx, cfg.unit, spine + outward * 9, bot + 15, { size: 10, color: T.muted, halo: 2 });

  if (!left) drawVvi(ctx, f);
}

// Vertical-speed indicator on the inboard side of the altitude tape: five
// dots with a pointer that rides them, as in the reference HUD.
function drawVvi(ctx, f) {
  const x = K.tape.altX + K.vvi.offset;
  const cy = K.center.y, h = K.vvi.half;
  line(ctx, x, cy - h, x, cy + h, { w: 1, color: T.muted, halo: 0 });
  for (let d = -h; d <= h + 0.1; d += h / 2) {
    ctx.beginPath();
    ctx.arc(x, cy + d, 2, 0, Math.PI * 2);
    ctx.strokeStyle = T.muted;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  const y = cy - clamp(f.vario || 0, -10, 10) * K.vvi.ppu;
  ctx.beginPath();
  ctx.moveTo(x + 13, y);
  ctx.lineTo(x + 3, y - 5);
  ctx.lineTo(x + 3, y + 5);
  ctx.closePath();
  ctx.fillStyle = T.ink;
  ctx.fill();
}

// ---------------------------------------------------------------- layer

export class FpvOsd {
  constructor({ getCanvas, theme = OSD_THEME, cfg = OSD_CFG } = {}) {
    this.getCanvas = getCanvas;
    this.theme = { ...OSD_THEME, ...(theme || {}) };
    this.cfg = { ...OSD_CFG, ...(cfg || {}) };
    this.canvas = null;
  }

  attach(canvas) { this.canvas = canvas; }

  // CSS box + dpr -> backing store.
  resize(cssW, cssH, dpr = 1) {
    const c = this.canvas;
    if (!c) return;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }

  clear() {
    const c = this.canvas;
    if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }

  render(flight) {
    const c = this.canvas;
    if (!c || !flight) return;
    T = this.theme;
    K = this.cfg;
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const s = Math.min(c.width / OSD_W, c.height / OSD_H);
    ctx.setTransform(s, 0, 0, s, (c.width - OSD_W * s) / 2, (c.height - OSD_H * s) / 2);

    drawAttitude(ctx, flight);
    drawRollArc(ctx, flight);
    drawHeadingReadout(ctx, flight);
    drawTape(ctx, flight, 'left');
    drawTape(ctx, flight, 'right');
    drawFlightPath(ctx, flight);
    drawHome(ctx, flight);
  }
}
