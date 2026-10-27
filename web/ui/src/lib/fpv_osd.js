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
//   track/groundSpeed, NED velocity, the home vector
//   SATS/fix/HDOP, mode/armed/flightTime, battery/current/mAh/cells
//   trip/odometer/efficiency, throttle, messages and warnings.
// Missing optional fields are simply not drawn.
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
  good: '#39e75f',                // GPS 3D fix, track icon
  bad: '#ff5a5a',                 // no GPS fix
  halo: 'rgba(0, 0, 0, 0.7)',     // outline behind strokes/text, not a fill
};

export const OSD_CFG = {
  center: { x: 640, y: 360 },
  // Lens FOV, in degrees across the screen. The screen is rectilinear, so
  // horizontal and vertical are independent. These are the 16:9 split of a
  // 110 deg diagonal: tan(55) split by the 16:9 axes gives 102.5 x 70.0.
  // The pitch ladder uses vfovDeg; the velocity vector and world markers use
  // hfovDeg. Measure one axis on the bench and correct the pair together.
  hfovDeg: 102.5,
  vfovDeg: 70.0,
  camPitchDeg: 12,        // camera boresight tilted down from the nose (deg)
  compassPpd: 1.8,        // px per degree of heading along the horizon rung
  ladder: { horizon: 140, rung: 78, gap: 18, rungGap: 16, clipTop: 140, clipW: 520 },
  roll: { cy: 92, r: 38, span: 60 },
  tape: {
    half: 120, speedX: 310, altX: 970,
    boxW: 68, boxH: 38, point: 9, cap: 60,
    tickMajor: 12, tickMinor: 7, labelGap: 34, boxGap: 0,
  },
  speed: {
    min: 0, max: 300, major: 10, minor: 5, ppu: 4.8, unit: { top: 'KM', bottom: 'H' }, scale: 3.6, stall: 45,
  },
  alt: { min: 0, max: 600, major: 20, minor: 10, ppu: 2.4, unit: 'm', scale: 1 },
  hdg: { labelY: 14, valueY: 36 },
  vvi: { offset: -30, half: 50, ppu: 4.5, boxW: 44, boxH: 18 },
  fpm: { margin: 30, wing: 20, r: 7, tick: 14 },
  home: { hideWithinM: 20, centreFrac: 0.15, margin: 32, glyphH: 7.2, glyphW: 5.2, glyphStroke: 2.4 },
  // Edge blocks. Keep every one of these clear of the centre 0.7x AHI/tape
  // box: the left column ends at x~300, the right begins at x~980.
  status: { x: 22, y: 24, size: 14, label: 10 },
  mode: { x: 970, y: 226, size: 15 },
  battery: { x: 1272, y: 632, line: 17, size: 13, label: 10 },
  messages: { x: 22, y: 628, line: 18, size: 12, max: 3, ttlS: 5 },
  warnings: { x: 640, y: 660, line: 16, size: 13, max: 2 },
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
    ctx.lineTo(s * half, 7);
  }
  const from = Math.floor((heading - half / ppd) / 15) * 15;
  const to = Math.ceil((heading + half / ppd) / 15) * 15;
  for (let b = from; b <= to; b += 15) {
    const x = wrap180(b - heading) * ppd;
    if (Math.abs(x) > half - 5) continue;
    const norm = ((b % 360) + 360) % 360;
    if (norm % 45 === 0) {
      ctx.moveTo(x, 3);
      ctx.lineTo(x, 9);
      letters.push([x, COMPASS[norm]]);
    } else {
      minors.push(x);
    }
  }
  paint(ctx, { w: 1.2, halo: 1.4 });

  // Minor ticks sit clear of the line and get no halo, so they cannot cut it.
  ctx.save();
  ctx.strokeStyle = T.muted;
  ctx.lineWidth = 1;
  for (const x of minors) { ctx.beginPath(); ctx.moveTo(x, 3); ctx.lineTo(x, 6); ctx.stroke(); }
  ctx.restore();

  for (const [x, label] of letters) {
    ctx.save();
    ctx.translate(x, -10);
    ctx.rotate(roll * DEG);
    txt(ctx, label, 0, 0, { size: 12, color: T.ink, weight: 500, halo: 2.2 });
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
  const hook = p > 0 ? 6 : -6;      // up on -pitch, down on +pitch
  for (const s of [-1, 1]) {
    polyline(ctx, [[s * gap, y], [s * half, y], [s * half, y + hook]], { w: 1.1, color: col, dash, halo: 1.2 });
    txt(ctx, `${p}\u00b0`, s * (half + 8), y, {
      size: 12, align: s > 0 ? 'left' : 'right', color: col, halo: 2,
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
  ctx.rect(cx - K.ladder.clipW / 2, K.ladder.clipTop, K.ladder.clipW, OSD_H - K.ladder.clipTop);
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
    polyline(ctx, [[cx + s * 13, cy - 6], [cx + s * 33, cy - 6], [cx + s * 33, cy + 1]], { w: 1.8, halo: 1.4 });
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
    const len = a % 30 === 0 ? 4 : 2;
    ctx.moveTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
    ctx.lineTo(x + Math.cos(ang) * (r - len), y + Math.sin(ang) * (r - len));
  }
  paint(ctx, { w: 0.9, halo: 1.2 });

  const pa = (-90 + clamp(f.roll || 0, -span, span)) * DEG;
  ctx.save();
  ctx.translate(x + Math.cos(pa) * (r + 1), y + Math.sin(pa) * (r + 1));
  ctx.rotate(pa + Math.PI / 2);
  ctx.beginPath();
  ctx.moveTo(0, 4); ctx.lineTo(-3, -2); ctx.lineTo(3, -2);
  ctx.closePath();
  ctx.fillStyle = T.ink;
  ctx.fill();
  ctx.restore();
}

function drawHeadingReadout(ctx, f) {
  const hdg = String(Math.round(((f.heading || 0) % 360 + 360) % 360) % 360);
  txt(ctx, 'HDG', K.center.x, K.hdg.labelY, { size: 10, color: T.muted, halo: 1.8 });
  txt(ctx, hdg.padStart(3, '0'), K.center.x, K.hdg.valueY, { size: 20, weight: 500, halo: 2.6 });
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
function stallHatch(ctx, spine, y0, y1, width, dir) {
  const top = Math.min(y0, y1), h = Math.abs(y1 - y0);
  if (h < 2) return;
  const x0 = dir < 0 ? spine - width : spine;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, top, width, h);
  ctx.clip();
  ctx.strokeStyle = T.warn;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1.0;
  for (let y = top - width; y < top + h + width; y += 6) {
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + width, y - width);
    ctx.stroke();
  }
  ctx.restore();
}

// Nexus-style unit block: compound units are written top/bottom with a
// vinculum instead of a slash, and always sit after the number.
function drawUnit(ctx, unit, x, y, o = {}) {
  const { size = 6, color = T.muted, align = 'center' } = o;
  if (!unit) return;
  if (typeof unit === 'string') {
    txt(ctx, unit, x, y, { size: size + 2, color, align: align === 'right' ? 'right' : 'left', halo: 1.2 });
    return;
  }
  const top = unit.top || '', bottom = unit.bottom || '';
  ctx.save();
  ctx.font = `500 ${size}px ${FONT}`;
  const w = Math.max(ctx.measureText(top).width, ctx.measureText(bottom).width) + 2;
  const cx = align === 'right' ? x - w / 2 : align === 'left' ? x + w / 2 : x;
  txt(ctx, top, cx, y - size * 0.9, { size, align: 'center', color, halo: 1.1 });
  txt(ctx, bottom, cx, y + size * 0.95, { size, align: 'center', color, halo: 1.1 });
  // Vinculum as a filled bar, not a hairline stroke: at OSD scale a 1 px
  // stroke disappears once the canvas is letterboxed down.
  ctx.fillStyle = color;
  ctx.fillRect(cx - w / 2, y - 0.8, w, 1.6);
  ctx.restore();
}

function drawTape(ctx, f, side) {
  const left = side === 'left';
  const cfg = left ? K.speed : K.alt;
  const spine = left ? K.tape.speedX : K.tape.altX;
  const inward = left ? 1 : -1;        // stall hatch stays on the centre side
  const outward = -inward;             // caps, ticks, labels, box go outboard
  const cy = K.center.y, half = K.tape.half;
  const top = cy - half, bot = cy + half;
  const value = clamp(left ? (f.speed || 0) * cfg.scale : (f.alt || 0), cfg.min, cfg.max);

  const bw = K.tape.boxW, bh = K.tape.boxH, pt = K.tape.point;
  // A small gap between the spine and the box point leaves the notches
  // visible, so the box and the notch it selects can be compared by eye.
  const tipX = spine + outward * K.tape.boxGap;
  const nearX = tipX + outward * pt;
  const farX = nearX + outward * bw;
  const boxTop = cy - bh / 2, boxBot = cy + bh / 2;
  const boxL = Math.min(nearX, farX), boxR = Math.max(nearX, farX);

  if (left && cfg.stall > cfg.min) {
    const yStall = cy + (value - cfg.stall) * cfg.ppu;
    const yZero = cy + (value - cfg.min) * cfg.ppu;
    const h0 = Math.max(top, Math.min(yStall, yZero));
    const h1 = Math.min(bot, Math.max(yStall, yZero));
    if (h1 - h0 > 1) stallHatch(ctx, spine, h0, h1, K.tape.tickMajor, outward);
    if (yStall >= top && yStall <= bot) {
      line(ctx, spine, yStall, spine + outward * K.tape.tickMajor, yStall, { w: 1.2, color: T.warn, halo: 1.0 });
    }
  }

  const lo = Math.max(cfg.min, Math.floor((value - half / cfg.ppu) / cfg.major) * cfg.major);
  const hi = Math.min(cfg.max, Math.ceil((value + half / cfg.ppu) / cfg.major) * cfg.major);

  // Spine + extended outward caps + major ticks. The ticks and the labels
  // live on the same (number) side now.
  ctx.beginPath();
  ctx.moveTo(spine, top); ctx.lineTo(spine, bot);
  ctx.moveTo(spine, top); ctx.lineTo(spine + outward * K.tape.cap, top);
  ctx.moveTo(spine, bot); ctx.lineTo(spine + outward * K.tape.cap, bot);
  for (let v = lo; v <= hi + 1e-6; v += cfg.major) {
    const y = cy + (value - v) * cfg.ppu;
    if (y < top - 1 || y > bot + 1) continue;
    ctx.moveTo(spine, y); ctx.lineTo(spine + outward * K.tape.tickMajor, y);
  }
  paint(ctx, { w: 1.0, halo: 1.2 });

  // One short notch between each written value: two marks per label.
  ctx.save();
  ctx.strokeStyle = T.ink;
  ctx.lineWidth = 0.9;
  for (let v = lo; v <= hi + 1e-6; v += cfg.minor) {
    if (Math.abs(v % cfg.major) < 1e-6) continue;
    const y = cy + (value - v) * cfg.ppu;
    if (y < top - 1 || y > bot + 1) continue;
    ctx.beginPath();
    ctx.moveTo(spine, y);
    ctx.lineTo(spine + outward * K.tape.tickMinor, y);
    ctx.stroke();
  }
  ctx.restore();

  // Written values. Do not skip the ones the box overlaps: the box is
  // transparent, so a partly occluded number is still readable.
  for (let v = lo; v <= hi + 1e-6; v += cfg.major) {
    const y = cy + (value - v) * cfg.ppu;
    if (y < top + 10 || y > bot - 10) continue;
    txt(ctx, String(Math.round(v)), spine + outward * K.tape.labelGap, y, {
      size: 12, align: left ? 'right' : 'left', color: T.ink, weight: 500, halo: 1.8,
    });
  }

  // Transparent box: erase the scale marks under the wedge, then draw only
  // its outline. destination-out clears the OSD canvas, so the video shows
  // through while the tape numbers really are occluded, not just dimmed.
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.moveTo(farX, boxTop);
  ctx.lineTo(nearX, boxTop);
  ctx.lineTo(tipX, cy);
  ctx.lineTo(nearX, boxBot);
  ctx.lineTo(farX, boxBot);
  ctx.closePath();
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(farX, boxTop);
  ctx.lineTo(nearX, boxTop);
  ctx.lineTo(tipX, cy);
  ctx.lineTo(nearX, boxBot);
  ctx.lineTo(farX, boxBot);
  ctx.closePath();
  paint(ctx, { w: 1.2, halo: 1.4 });
  const bc = (boxL + boxR) / 2;
  txt(ctx, String(Math.round(value)), bc - 14, cy, { size: 17, weight: 500, halo: 2.2 });
  drawUnit(ctx, cfg.unit, bc + 20, cy, { size: 8, color: T.ink });

  if (!left) drawVvi(ctx, f);
}

// Vertical-speed tape on the inboard side of the altitude tape. A simple
// spine, caps, ticks and one value box; no dot ladder, no graph.
function drawVvi(ctx, f) {
  const x = K.tape.altX + K.vvi.offset;
  const cy = K.center.y, half = K.vvi.half;
  const top = cy - half, bot = cy + half;
  const v = clamp(f.vario || 0, -10, 10);
  const ppu = K.vvi.ppu;

  ctx.beginPath();
  ctx.moveTo(x, top); ctx.lineTo(x, bot);
  ctx.moveTo(x, top); ctx.lineTo(x - 12, top);
  ctx.moveTo(x, bot); ctx.lineTo(x - 12, bot);
  paint(ctx, { w: 0.9, color: T.muted, halo: 0 });
  for (let s = -10; s <= 10; s += 2) {
    const y = cy - s * ppu;
    if (y < top || y > bot) continue;
    line(ctx, x, y, x - 6, y, { w: 0.8, color: T.muted, halo: 0 });
  }

  const y = cy - v * ppu;
  const w = K.vvi.boxW, h = K.vvi.boxH;
  const farX = x - 8 - w, nearX = x - 8;
  ctx.beginPath();
  ctx.moveTo(farX, y - h / 2);
  ctx.lineTo(nearX, y - h / 2);
  ctx.lineTo(x, y);
  ctx.lineTo(nearX, y + h / 2);
  ctx.lineTo(farX, y + h / 2);
  ctx.closePath();
  paint(ctx, { w: 1.0, halo: 1.2 });
  const label = `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
  txt(ctx, label, (farX + nearX) / 2, y, { size: 11, align: 'center', halo: 1.8 });
}

// ---------------------------------------------------------------- edge blocks

function throttlePct(f) {
  if (Number.isFinite(f.throttlePct)) return Math.round(clamp(f.throttlePct, 0, 100));
  const t = f.throttle;
  if (!Number.isFinite(t)) return null;
  return Math.round(clamp(t <= 1 ? t * 100 : t, 0, 100));
}

function drawSatStatus(ctx, f) {
  const { x, y } = K.status;
  const fix = f.fix || 0;
  const sats = Number.isFinite(f.sats) ? Math.round(f.sats) : '--';
  txt(ctx, `SATS ${sats}`, x, y, { size: K.status.size, align: 'left', weight: 500, halo: 2 });
  if (fix >= 3) {
    txt(ctx, '3D', x + 62, y - 7, { size: 8, align: 'left', color: T.good, halo: 1.4 });
  }
  const hdop = Number.isFinite(f.hdop) ? f.hdop.toFixed(1) : '--';
  txt(ctx, `HDOP ${hdop}`, x, y + 20, { size: K.status.label, align: 'left', color: T.muted, halo: 1.4 });
}

function drawModeBlock(ctx, f) {
  const x = K.tape.altX + K.tape.cap / 2;
  txt(ctx, f.mode || '---', x, K.mode.y, {
    size: K.mode.size, align: 'center', weight: 500, halo: 2,
  });
}

function drawThrottle(ctx, f) {
  const pct = throttlePct(f);
  if (pct === null) return;
  const y = K.center.y - K.tape.half - 14;
  const x = K.tape.speedX - K.tape.cap / 2;
  txt(ctx, `THR ${pct}%`, x, y, {
    size: K.mode.size, align: 'center', weight: 500, halo: 2,
    color: pct > 70 ? T.warn : T.ink,
  });
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function drawTimerHome(ctx, f) {
  const x = K.tape.speedX - K.tape.cap / 2;
  const top = K.center.y + K.tape.half + 18;
  txt(ctx, `T+ ${fmtTime(f.flightTime)}`, x, top, { size: 16, align: 'center', weight: 500, halo: 2 });
  const hd = Number.isFinite(f.homeDist) ? `${(f.homeDist / 1000).toFixed(2)}km` : '--';
  txt(ctx, `DIST ${hd}`, x, top + 18, { size: 11, align: 'center', color: T.muted, halo: 1.4 });
}

function drawArmed(ctx, f) {
  txt(ctx, f.armed ? 'ARMED' : 'DISARMED', K.center.x, 700, {
    size: 11, align: 'center', color: f.armed ? T.warn : T.muted, halo: 1.6,
  });
}

function drawBattery(ctx, f) {
  const { x, y, line, size, label } = K.battery;
  const cell = Number.isFinite(f.cellV) ? f.cellV : (f.cells ? f.batteryV / f.cells : NaN);
  const warn = Number.isFinite(cell) && cell < 3.5;
  const rows = [];
  if (Number.isFinite(f.efficiency)) {
    rows.push(['EFF', String(Math.round(f.efficiency)), { top: 'MAH', bottom: 'KM' }]);
  }
  if (Number.isFinite(f.batteryV)) rows.push(['BAT', f.batteryV.toFixed(1), 'V']);
  if (Number.isFinite(cell)) rows.push(['CELL', cell.toFixed(2), 'V']);
  const cur = f.currentA ?? f.batteryA;
  if (Number.isFinite(cur)) rows.push(['CUR', cur.toFixed(1), 'A']);
  if (Number.isFinite(f.mah)) rows.push(['USED', String(Math.round(f.mah)), 'MAH']);
  rows.slice(0, 5).forEach(([k, v, unit], i) => {
    const yy = y + i * line;
    txt(ctx, k, x - 112, yy, { size: label, align: 'left', color: T.muted, halo: 1.2 });
    txt(ctx, v, x - 38, yy, {
      size, align: 'right', color: warn && k === 'CELL' ? T.warn : T.ink, halo: 1.6,
    });
    drawUnit(ctx, unit, x, yy, { size: 6, align: 'right' });
  });
}

function drawMessages(ctx, f) {
  const { x, y, line, size, max, ttlS } = K.messages;
  const list = Array.isArray(f.messages) ? f.messages : [];
  list.filter((m) => m && Number.isFinite(m.age) && m.age < ttlS).slice(0, max).forEach((m, i) => {
    ctx.save();
    ctx.globalAlpha = clamp(1 - m.age / ttlS, 0, 1);
    txt(ctx, m.text, x, y + i * line, { size, align: 'left', halo: 1.6 });
    ctx.restore();
  });
}

function drawWarnings(ctx, f) {
  const list = Array.isArray(f.warnings) ? f.warnings.filter(Boolean) : [];
  list.slice(0, K.warnings.max).forEach((w, i) => {
    txt(ctx, String(w), K.warnings.x, K.warnings.y + i * K.warnings.line, {
      size: K.warnings.size, color: T.warn, weight: 500, halo: 1.8,
    });
  });
}

function drawExtras(ctx, f) {
  // Low-importance fields fill the edges without entering the AHI box.
  // 3D speed sits under SAT/HDOP; G force under the right tape; trip and
  // total distance bottom-left; home bearing and battery % bottom-right.
  const xl = K.status.x;
  const v3 = Math.hypot(f.groundSpeed || 0, f.vario || 0);
  txt(ctx, '3D', xl, 64, { size: 10, align: 'left', color: T.muted, halo: 1.2 });
  txt(ctx, String(Math.round(v3 * 3.6)), xl + 18, 64, { size: 10, align: 'left', halo: 1.2 });
  drawUnit(ctx, { top: 'KM', bottom: 'H' }, xl + 44, 64, { size: 6.5, color: T.muted });
  if (Number.isFinite(f.gForce)) {
    txt(ctx, `G ${f.gForce.toFixed(1)}`, K.tape.altX + K.tape.cap / 2, K.center.y + K.tape.half + 18, {
      size: 10, align: 'center', color: T.muted, halo: 1.2,
    });
  }

  const yb = 686;
  const trip = Number.isFinite(f.tripDist) ? `${(f.tripDist / 1000).toFixed(2)}km` : '--';
  const odo = Number.isFinite(f.odometer) ? `${(f.odometer / 1000).toFixed(1)}km` : '--';
  txt(ctx, `TRIP ${trip}`, xl, yb, { size: 10, align: 'left', color: T.muted, halo: 1.2 });
  txt(ctx, `TOTAL ${odo}`, xl, yb + 14, { size: 10, align: 'left', color: T.muted, halo: 1.2 });
}


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
    drawSatStatus(ctx, flight);
    drawModeBlock(ctx, flight);
    drawThrottle(ctx, flight);
    drawTimerHome(ctx, flight);
    drawBattery(ctx, flight);
    drawMessages(ctx, flight);
    drawWarnings(ctx, flight);
    drawArmed(ctx, flight);
    drawExtras(ctx, flight);
  }
}
