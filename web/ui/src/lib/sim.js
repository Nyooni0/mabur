// Dev-only flight/link simulator for the web page (`?sim=1`).
//
// With no VTX on the bench there is nothing on air, so this replaces the WASM
// core with a synthetic one: a smooth banked-circuit flight model feeding the
// OSD at frame rate, a plausible 1 Hz core stats line (so the header, Stats
// board and Debug tab come alive), and a still FPV frame drawn on the video
// canvas as the backdrop. It is inert unless the URL has `sim` (see
// SIM_ENABLED), so the production path is untouched.
//
// The OSD reads `sim.flight`; the page chrome reads `sim.core` / `sim.page`.
// A real telemetry feed can later fill the same two shapes.

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, d = 1) => Number(v.toFixed(d));

// World setup: a fixed home point, a steady crosswind (so the flight-path
// marker shows real crab instead of sitting on the nose), and the start
// position. Everything is local metres, NED for the relative vectors.
const HOME = { n: 0, e: 0, alt: 45 };
const WIND = { n: 2.5, e: 4 };
const START = { n: -500, e: 250, alt: 85, heading: 320 };

export const SIM_ENABLED = (() => {
  try { return new URLSearchParams(location.search).has('sim'); } catch { return false; }
})();

// Deliberate: only a query flag turns the simulator on, never localStorage.
export function simAutostart() {
  try { return new URLSearchParams(location.search).has('simstart'); } catch { return false; }
}

export class SimFeed {
  constructor() {
    this.running = false;
    this.paused = false;
    this.t = 0;
    this.ausAcc = 0;
    this.mah = 0;
    this.manual = null;      // { pitch, roll, alt, speed } when the panel pins values
    this.onVideo = null;     // (t) => void, called once per frame while running
    this.onStats = null;     // (text, core) => void, 1 Hz
    this.spark = [];         // page latency sparkline samples (12 s @ 200 ms)
    this.videoSize = { w: 1920, h: 1080 };

    this.flight = {
      pitch: 2, roll: 0, yaw: START.heading * DEG, heading: START.heading,
      alt: START.alt, vario: 0, speed: 17, groundSpeed: 18,
      // Local world position + ground velocity (NED). A fixed-wing feed would
      // fill these from GPS; the OSD projects them for the FPM and home icon.
      posN: START.n, posE: START.e, velN: 0, velE: 0, velD: 0, track: START.heading,
      homeRelN: 0, homeRelE: 0, homeRelD: 40, homeDist: 0, homeBearing: 0,
      throttle: 0.55, batteryV: 16.2, batteryA: 16, mah: 0,
      sats: 16, rssiDbm: -58, lq: 99, tempC: 56,
    };
    this.derive();

    this.page = { bitrateMbps: 24.6, fps: 60, jitterMs: 1.1, latencyMs: 38 };

    // A plausible maburgs stats snapshot. Keys mirror webgs::stats_json.
    this.core = {
      v: 1, mode: 'gs', session: true, peer_acked: true,
      rung: 2, mcs: 4, bw: 40, probe: 'off', key_mismatch: false, key_fp: 'sim0cafe',
      channel: 64, scan_state: 'idle', scan_rounds: 4, scan_pick: 64,
      hop: { state: 'idle', verdict: 'clear', evidence: 'snr', ref_rung: 2, epoch: 0,
        hops: 0, holds: 0, target: null, last_ms: null, sweep_timeouts: 0 },
      pre_fec_loss: 0.003, residual: 0, rtt_ms: 41.2, rtt_min_ms: 39.6, pts_off_us: 0,
      drone_rcf_rx: 2841, uplink_pct: 99, uplink: 'ok', drone_state: 3, drone_temp_c: 57,
      rec_state: 0, rec_err: 0, snr_db: 31.4, rssi_dbm: -57,
      bodies: 0, aus: 0, trunc: 0, trunc_base: 0, salvaged: 0, sends: 0, idr_req: 0,
      osd_snaps: 0, osd_screens: 0,
      lrec_avail: 0, lrec_state: 0, lrec_bytes: 0, lrec_err: 0, lrec_name: null,
      usb_p99_us: 1600, usb_max_us: 3900, txfail: 0, qdrop: 0, radio: 'usb',
      nack: { req: 12, rep: 3, syms: 48, tail: 0, fill: 47, late: 1, waste: 0, drop: 0,
        sup: 0, lead: 0, sent: 12, settle_ms: 4, fill_p50: 3, fill_p90: 5, fill_max: 9,
        fill_pps: 0.4, late_max: 11, drone_rx: 12, drone_syms: 48, drone_refused: 0 },
    };
  }

  // mode/ch/w come from the form so the chrome reads the same as a real session.
  start({ mode = 'gs', ch = 64, w = 40 } = {}) {
    this.stop();
    this.running = true;
    this.paused = false;
    this.t = 0;
    this.lastFrame = performance.now();
    this.lastStat = 0;
    this.lastSpark = 0;
    this.ausAcc = 0;
    this.mah = 0;
    this.spark = [];
    this.flight.posN = START.n;
    this.flight.posE = START.e;
    this.flight.alt = START.alt;
    this.flight.yaw = START.heading * DEG;
    this.flight.heading = START.heading;
    this.derive();
    const core = this.core;
    core.mode = mode;
    core.channel = ch;
    core.bw = w;
    core.rung = mode === 'gs' ? 2 : -1;
    core.mcs = 4;
    core.peer_acked = mode === 'gs';
    core.session = mode === 'gs';
    core.aus = core.bodies = core.sends = core.rcf_sent = 0;
    core.follow_state = mode === 'spotter' ? 'locked' : null;
    core.follows = mode === 'spotter' ? 0 : null;
    core.scan_state = mode === 'gs' ? 'idle' : null;
    core.hop = mode === 'gs' ? core.hop : null;
    core.nack = mode === 'gs' ? core.nack : null;
    core.uplink = mode === 'gs' ? 'ok' : 'idle';
    if (mode === 'spotter') { core.uplink_pct = null; core.rtt_ms = null; core.rtt_min_ms = null; }
    this.startedAt = performance.now();
    this._loadBackdrop();
    this._raf = (ts) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (ts - this.lastFrame) / 1000);
      this.lastFrame = ts;
      this.step(dt);
      // A drawing bug must not kill the feed: log it once and keep the loop
      // (and the 1 Hz stats) alive.
      try {
        if (this.onVideo) this.onVideo(ts);
      } catch (e) {
        const key = String(e && (e.stack || e.message) || e);
        if (key !== this._frameErr) { this._frameErr = key; console.error('[sim] frame callback failed', e); }
      }
      if (ts - this.lastStat >= 1000) { this.lastStat = ts; this.emitStats(); }
      if (ts - this.lastSpark >= 200) {
        this.lastSpark = ts;
        this.page.latencyMs = round(36 + 4 * Math.sin(this.t * 0.7) + Math.random() * 1.6);
        this.spark.push(this.page.latencyMs);
        if (this.spark.length > 60) this.spark.shift();
      }
      this._rafId = requestAnimationFrame(this._raf);
    };
    this._rafId = requestAnimationFrame(this._raf);
  }

  stop() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  setManual(vals) {
    this.manual = vals ? { ...vals } : null;
  }

  step(dt) {
    if (this.paused) return;
    this.t += dt;
    const f = this.flight;
    const t = this.t;
    if (this.manual) {
      f.pitch = this.manual.pitch;
      f.roll = this.manual.roll;
      f.alt = this.manual.alt;
      f.speed = this.manual.speed;
      f.vario = 0;
    } else {
      // Banked circuit: roll drives the turn rate (coordinated turn), and the
      // pitch/altitude wander on slower sines so the ladder keeps moving.
      const roll = 26 * Math.sin(t * 0.33) + 6 * Math.sin(t * 0.91);
      const speed = 17 + 6 * Math.sin(t * 0.21) + 1.5 * Math.sin(t * 0.9);
      const alt = 85 + 45 * Math.sin(t * 0.09) + 4 * Math.sin(t * 0.53);
      const prevAlt = f.alt;
      f.roll = roll;
      f.speed = speed;
      f.alt = alt;
      f.vario = round((alt - prevAlt) / Math.max(dt, 0.001), 1);
      f.pitch = 4 + 7 * Math.sin(t * 0.47) + 2 * Math.sin(t * 1.3);
      const yawRate = 9.81 * Math.tan(roll * DEG) / Math.max(speed, 6);
      f.yaw += yawRate * dt;
      f.heading = ((f.yaw * RAD) % 360 + 360) % 360;
      f.throttle = clamp(0.45 + speed / 90 + 0.05 * Math.sin(t * 0.8), 0, 1);
    }
    // Air velocity from the nose, plus the wind, integrated into a real ground
    // track. This is what makes the FPM sit off the nose when crabbing.
    this.derive();
    f.posN += f.velN * dt;
    f.posE += f.velE * dt;
    this.derive();
    f.mah = this.mah += (14 + 6 * Math.sin(t * 0.3)) * dt / 3.6;
    f.batteryV = round(16.6 - this.mah / 2200 - 0.35 * f.throttle, 2);
    f.batteryA = round(13 + 9 * f.throttle + Math.sin(t * 2.1), 1);
    f.tempC = round(54 + 4 * Math.sin(t * 0.05), 0);
    f.rssiDbm = round(-57 + 5 * Math.sin(t * 0.13) + Math.sin(t * 1.7), 0);
    f.lq = clamp(Math.round(99 - 3 * Math.abs(Math.sin(t * 0.13))), 0, 100);
    const core = this.core;
    core.snr_db = round(30 + 3 * Math.sin(t * 0.17), 1);
    core.rssi_dbm = f.rssiDbm;
    core.pre_fec_loss = round(clamp(0.002 + 0.004 * Math.abs(Math.sin(t * 0.21)), 0, 0.2), 4);
    core.residual = 0;
  }

  // Ground velocity (air vector + wind), ground track, and the home vector in
  // local NED. The OSD projects these for the flight-path marker and the home
  // icon; a real feed would fill the same fields from GPS/baro.
  derive() {
    const f = this.flight;
    const hd = (f.heading || 0) * DEG;
    f.velN = (f.speed || 0) * Math.cos(hd) + WIND.n;
    f.velE = (f.speed || 0) * Math.sin(hd) + WIND.e;
    f.velD = -(f.vario || 0);
    f.groundSpeed = Math.hypot(f.velN, f.velE);
    f.groundspeed = f.groundSpeed;
    f.track = ((Math.atan2(f.velE, f.velN) * RAD) % 360 + 360) % 360;

    f.homeRelN = HOME.n - f.posN;
    f.homeRelE = HOME.e - f.posE;
    f.homeRelD = (f.alt || 0) - HOME.alt;   // down-positive: home below is +
    f.homeDist = Math.hypot(f.homeRelN, f.homeRelE);
    f.homeBearing = ((Math.atan2(f.homeRelE, f.homeRelN) * RAD) % 360 + 360) % 360;
  }

  emitStats() {
    const core = this.core;
    const f = this.flight;
    this.ausAcc += Math.max(1, Math.round(this.page.fps));
    core.aus = Math.round(this.ausAcc);
    core.bodies = Math.round(core.aus * 4.4);
    core.sends = Math.round(this.t * 50);
    core.rcf_sent = Math.round(this.t * 45);
    core.drone_rcf_rx = Math.round(this.t * 44);
    core.drone_temp_c = f.tempC;
    core.uplink_pct = core.mode === 'gs' ? 99 : null;
    core.lrec_bytes = 0;
    if (core.nack) {
      core.nack.requests = Math.round(this.t * 0.3);
      core.nack.filled = Math.max(1, core.nack.requests - 1);
      core.nack.sent = core.nack.requests;
      core.nack.drone_rx = core.nack.requests;
    }
    if (this.onStats) this.onStats(JSON.stringify(core), core);
  }

  _loadBackdrop() {
    if (this._bg || this._bgLoading) return;
    this._bgLoading = true;
    const img = new Image();
    img.onload = () => { this._bg = img; };
    img.onerror = () => { this._bg = null; };
    img.src = new URL('../assets/fpv-feed.jpg', import.meta.url).href;
  }

  // Paints the "video": the still FPV frame with a slow drift so the OSD is
  // evaluated over a moving, contrasty background rather than flat black.
  drawVideo(canvas, nowMs) {
    if (!canvas) return;
    if (canvas.width !== 1280) { canvas.width = 1280; canvas.height = 720; }
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const t = (nowMs || performance.now()) / 1000;
    if (this._bg) {
      const zoom = 1.06 + 0.02 * Math.sin(t * 0.05);
      const iw = this._bg.width * zoom, ih = this._bg.height * zoom;
      const dx = (w - iw) / 2 + 10 * Math.sin(t * 0.03);
      const dy = (h - ih) / 2 + 6 * Math.cos(t * 0.037);
      ctx.drawImage(this._bg, dx, dy, iw, ih);
    } else {
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#3a6f9c'); sky.addColorStop(0.55, '#8fb6cc'); sky.addColorStop(0.56, '#4d6b3f'); sky.addColorStop(1, '#22301b');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    }
    // Mild vignette; the OSD must stay readable over the brightest corner.
    const vg = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.85);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
  }
}
