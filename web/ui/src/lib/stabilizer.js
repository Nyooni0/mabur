// Page-only video stabilizer. Translates and rotates the decoded video
// canvas with a CSS transform; the OSD canvas is a sibling and stays put.
//
// Two tracking windows at (W/3, H/2) and (2W/3, H/2) give a similarity
// transform: average displacement is the centre translation, and the change
// in the baseline angle is the rotation. The centre-window mode uses one
// window and translation only.
//
// Motion is integer-pixel SAD over a 64x64 luma window (search +/-10 px),
// then lightly smoothed. It is deliberately a small, fixed cost: only the
// two ROIs are read back, never the full frame. When the mode is off the
// caller never constructs this class, so the disabled path adds no work.
export const STAB_MODES = ['off', 'translate', 'rotate'];

const WIN = 64;
const SEARCH = 10;
const MIN_VAR = 80;       // flat sky/water: no usable feature
const MAX_SCORE = 24;     // mean abs luma difference for a confident match
const SMOOTH_S = 0.35;    // fixed-wing auto modes can take a slow follow
const EST_MS = 50;        // estimate at 20 Hz, not on every decoded frame
const RECENTER_S = 2.0;   // slowly pull a held correction back to centre
const LOG_MS = 1000;      // one copyable debug line per second

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Mean absolute luma difference for a shift of the current window relative
// to the previous one: current(x+dx, y+dy) ~= previous(x, y).
export function sadShift(prev, curr, win = WIN, max = SEARCH) {
  let best = Infinity, bx = 0, by = 0;
  for (let dy = -max; dy <= max; dy++) {
    const y0 = Math.max(0, -dy), y1 = Math.min(win, win - dy);
    if (y1 <= y0) continue;
    for (let dx = -max; dx <= max; dx++) {
      const x0 = Math.max(0, -dx), x1 = Math.min(win, win - dx);
      if (x1 <= x0) continue;
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        const pi = y * win, ci = (y + dy) * win + dx;
        for (let x = x0; x < x1; x++) sum += Math.abs(curr[ci + x] - prev[pi + x]);
        n += x1 - x0;
      }
      const score = sum / n;
      if (score < best) { best = score; bx = dx; by = dy; }
    }
  }
  return { dx: bx, dy: by, score: best };
}

function variance(a) {
  let sum = 0, sum2 = 0;
  for (let i = 0; i < a.length; i++) { sum += a[i]; sum2 += a[i] * a[i]; }
  const mean = sum / a.length;
  return sum2 / a.length - mean * mean;
}

// Rotation of the window baseline. Centers are [x, y] pairs, `d` their
// matched displacements; both are in source pixels.
export function rotationRad(c0, c1, d0, d1) {
  const v0x = c1[0] - c0[0], v0y = c1[1] - c0[1];
  const v1x = (c1[0] + d1.dx) - (c0[0] + d0.dx);
  const v1y = (c1[1] + d1.dy) - (c0[1] + d0.dy);
  return Math.atan2(v0x * v1y - v0y * v1x, v0x * v1x + v0y * v1y);
}

export class Stabilizer {
  constructor() {
    const c = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(WIN, WIN)
      : Object.assign(document.createElement('canvas'), { width: WIN, height: WIN });
    this.ctx = c.getContext('2d', { willReadFrequently: true });
    if (!this.ctx) throw new Error('2D canvas unavailable');
    this.canvas = c;
    this.mode = 'off';
    this.prev = [null, null];
    this.size = 0;
    this.lastT = 0;
    this.lastEstT = 0;
    this.lastLog = 0;
    this.sx = 0; this.sy = 0; this.sa = 0;
    this.rawX = 0; this.rawY = 0; this.rawA = 0;
    this.cx = 0; this.cy = 0; this.ca = 0;
    this.last = { x: 0, y: 0, rad: 0 };
  }

  reset() {
    this.prev = [null, null];
    this.lastT = 0;
    this.lastEstT = 0;
    this.lastLog = 0;
    this.sx = this.sy = this.sa = 0;
    this.rawX = this.rawY = this.rawA = 0;
    this.cx = this.cy = this.ca = 0;
    this.last = { x: 0, y: 0, rad: 0 };
  }

  // One luma ROI; returns null when the frame is too small or unreadable.
  roi(frame, cx, cy) {
    const w = frame.displayWidth, h = frame.displayHeight;
    const size = Math.min(WIN, w, h);
    if (size < 16) return null;
    if (size !== this.size) {
      this.size = size;
      this.canvas.width = size;
      this.canvas.height = size;
      this.prev = [null, null];
    }
    const sx = clamp(Math.round(cx - size / 2), 0, w - size);
    const sy = clamp(Math.round(cy - size / 2), 0, h - size);
    try {
      this.ctx.drawImage(frame, sx, sy, size, size, 0, 0, size, size);
    } catch {
      return null;
    }
    const data = this.ctx.getImageData(0, 0, size, size).data;
    const out = new Uint8Array(size * size);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      out[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
    }
    return out;
  }

  // frame: VideoFrame. mode: 'translate' | 'rotate'. Returns the correction
  // to apply to the video canvas, in source pixels and radians.
  update(frame, mode) {
    if (mode !== this.mode) {
      this.mode = mode;
      this.reset();
    }
    const now = performance.now();
    if (this.lastEstT && now - this.lastEstT < EST_MS) return this.last;
    this.lastEstT = now;
    const w = frame.displayWidth, h = frame.displayHeight;
    const dt = this.lastT ? clamp((now - this.lastT) / 1000, 0.001, 0.2) : 0.05;
    this.lastT = now;

    const centers = mode === 'rotate'
      ? [[w / 3, h / 2], [(2 * w) / 3, h / 2]]
      : [[w / 2, h / 2]];
    const results = [];
    for (let i = 0; i < centers.length; i++) {
      const cur = this.roi(frame, centers[i][0], centers[i][1]);
      if (!cur) { results.push(null); this.prev[i] = null; continue; }
      if (!this.prev[i]) { this.prev[i] = cur; results.push(null); continue; }
      const p = this.prev[i];
      this.prev[i] = cur;
      results.push(variance(p) < MIN_VAR ? null : sadShift(p, cur, this.size));
    }
    const ok = results.map((r) => r && r.score <= MAX_SCORE);

    let tx = null, ty = null, ra = 0;
    if (mode === 'rotate' && ok[0] && ok[1]) {
      tx = (results[0].dx + results[1].dx) / 2;
      ty = (results[0].dy + results[1].dy) / 2;
      ra = rotationRad(centers[0], centers[1], results[0], results[1]);
    } else {
      const i = ok.findIndex(Boolean);
      if (i >= 0) { tx = results[i].dx; ty = results[i].dy; }
    }
    if (tx === null) {
      const leak = Math.exp(-dt / RECENTER_S);
      this.cx *= leak; this.cy *= leak; this.ca *= leak;
      this.last = { x: this.cx, y: this.cy, rad: this.ca };
      this.log(now, mode, results, null);
      return this.last;   // no confident motion: hold, slowly recenter
    }

    const a = 1 - Math.exp(-dt / SMOOTH_S);
    this.sx += (tx - this.sx) * a;
    this.sy += (ty - this.sy) * a;
    this.sa += (ra - this.sa) * a;
    this.rawX = tx; this.rawY = ty; this.rawA = ra;

    const maxX = w * 0.12, maxY = h * 0.12, maxA = (8 * Math.PI) / 180;
    // Accumulate the correction: the canvas is not re-based each frame, so a
    // one-frame bump has to stay compensated until the smooth path catches
    // up. C = sum(smoothed) - sum(raw), with a slow leak so a sustained yaw
    // cannot park the correction against its clamp.
    const leak = Math.exp(-dt / RECENTER_S);
    this.cx = clamp(this.cx * leak + (this.sx - tx), -maxX, maxX);
    this.cy = clamp(this.cy * leak + (this.sy - ty), -maxY, maxY);
    this.ca = clamp(this.ca * leak + (this.sa - ra), -maxA, maxA);
    this.last = { x: this.cx, y: this.cy, rad: this.ca };
    this.log(now, mode, results, { tx, ty, ra });
    return this.last;
  }

  log(now, mode, results, m) {
    if (now - this.lastLog < LOG_MS) return;
    this.lastLog = now;
    const scores = results.map((r) => (r ? +r.score.toFixed(1) : null));
    const d = results.map((r) => (r ? [r.dx, r.dy] : null));
    const deg = (v) => +((v * 180) / Math.PI).toFixed(2);
    console.log('[webgs] stab', {
      mode,
      scores,
      d,
      tx: m ? +m.tx.toFixed(2) : null,
      ty: m ? +m.ty.toFixed(2) : null,
      ra: m ? deg(m.ra) : null,
      cx: +this.cx.toFixed(2),
      cy: +this.cy.toFixed(2),
      ca: deg(this.ca),
    });
  }
}
