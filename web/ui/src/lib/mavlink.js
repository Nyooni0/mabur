// Raw MAVLink v1/v2 frame parser and the small flight-state view the web OSD
// uses. The drone forwards the FC's frames verbatim (T_MAV); this file owns
// CRC validation and the message -> state mapping.
//
// Supported messages (enough for the first MAVLink OSD pass):
//   HEARTBEAT 0, SYS_STATUS 1, GPS_RAW_INT 24, ATTITUDE 30,
//   GLOBAL_POSITION_INT 33, VFR_HUD 74, BATTERY_STATUS 147.
// Unknown message IDs are skipped (their CRC_EXTRA is unknown here).

const CRC_EXTRA = new Map([
  [0, 50],    // HEARTBEAT
  [1, 124],   // SYS_STATUS
  [24, 24],   // GPS_RAW_INT
  [30, 39],   // ATTITUDE
  [33, 104],  // GLOBAL_POSITION_INT
  [49, 39],   // GPS_GLOBAL_ORIGIN
  [74, 20],   // VFR_HUD
  [147, 154], // BATTERY_STATUS
]);

export const MAVLINK_CRC_EXTRA = CRC_EXTRA;

const DEG = 180 / Math.PI;

// MAVLink CRC-16/MCRF4XX (init 0xFFFF, no final xor).
function crcByte(crc, b) {
  let tmp = (b ^ (crc & 0xff)) & 0xff;
  tmp = (tmp ^ ((tmp << 4) & 0xff)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}

function crcFrame(bytes, from, to, extra) {
  let crc = 0xffff;
  for (let i = from; i < to; i++) crc = crcByte(crc, bytes[i]);
  return crcByte(crc, extra);
}

export function mavlinkCrc(bytes, from, to, extra) {
  return crcFrame(bytes, from, to, extra);
}

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function i16(b, o) { return (u16(b, o) << 16) >> 16; }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function i32(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24); }
function f32(b, o) { return new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, true); }

const PLANE_MODES = {
  0: 'MANUAL', 1: 'CIRCLE', 2: 'STABILIZE', 3: 'TRAINING', 4: 'ACRO',
  5: 'FBWA', 6: 'FBWB', 7: 'CRUISE', 8: 'AUTOTUNE', 10: 'AUTO', 11: 'RTL',
  12: 'LOITER', 13: 'TAKEOFF', 14: 'AVOID_ADSB', 15: 'GUIDED',
  16: 'INITIALISING', 17: 'QSTABILIZE', 18: 'QHOVER', 19: 'QLOITER',
  20: 'QLAND', 21: 'QRTL', 22: 'QAUTOTUNE', 23: 'QACRO', 24: 'THERMAL',
};
const COPTER_MODES = {
  0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED',
  5: 'LOITER', 6: 'RTL', 7: 'CIRCLE', 9: 'LAND', 11: 'DRIFT', 13: 'SPORT',
  14: 'FLIP', 15: 'AUTOTUNE', 16: 'POSHOLD', 17: 'BRAKE', 18: 'THROW',
  19: 'AVOID_ADSB', 20: 'GUIDED_NOGPS', 21: 'SMART_RTL', 22: 'FLOWHOLD',
  23: 'FOLLOW', 24: 'ZIGZAG', 25: 'SYSTEMID', 26: 'AUTOROTATE', 27: 'AUTO_RTL',
};

export function modeName(type, customMode) {
  // INAV maps its modes onto ArduPilot-style custom_mode values; ArduPilot
  // Plane/Copter use the same tables. Fall back to a number for anything
  // outside the table rather than claiming a wrong name.
  const table = type === 2 || type === 3 || type === 4 ? COPTER_MODES : PLANE_MODES;
  return table[customMode] || `MODE ${customMode}`;
}

export class MavlinkFeed {
  constructor() {
    this.buf = new Uint8Array(0);
    this.state = MavlinkFeed.blank();
  }

  static blank() {
    return {
      roll: 0, pitch: 0, heading: 0,
      alt: 0, relAlt: 0, vario: 0, altMsl: 0,
      airspeed: 0, groundspeed: 0, track: 0,
      velN: 0, velE: 0, velD: 0,
      lat: 0, lon: 0,
      homeLat: NaN, homeLon: NaN, homeAlt: 0,
      homeRelN: NaN, homeRelE: NaN, homeRelD: NaN,
      homeDist: NaN, homeBearing: NaN,
      throttle: 0,
      sats: 0, fix: 0,
      batteryV: NaN, cellV: NaN, cells: 0, currentA: NaN, mah: NaN, batteryPct: NaN,
      mode: '', armed: false, type: 0,
      attMs: 0, posMs: 0, statusMs: 0,
      frames: 0, crcErrors: 0, updated: 0,
    };
  }

  reset() { this.buf = new Uint8Array(0); this.state = MavlinkFeed.blank(); }

  // One T_MAV payload (a complete frame, or a chunk that continues one).
  push(chunk, ptsUs = 0, nowMs = Date.now()) {
    const src = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const merged = new Uint8Array(this.buf.length + src.length);
    merged.set(this.buf); merged.set(src, this.buf.length);
    this.buf = merged;

    let off = 0;
    while (this.buf.length - off >= 2) {
      const magic = this.buf[off];
      if (magic !== 0xfd && magic !== 0xfe) { off++; continue; }
      const v2 = magic === 0xfd;
      const hdr = v2 ? 10 : 6;
      if (this.buf.length - off < hdr) break;
      const len = this.buf[off + 1];
      const sig = v2 && (this.buf[off + 2] & 0x01) ? 13 : 0;
      const total = hdr + len + 2 + sig;
      if (total > 300) { off++; continue; }
      if (this.buf.length - off < total) break;

      const msgid = v2
        ? this.buf[off + 7] | (this.buf[off + 8] << 8) | (this.buf[off + 9] << 16)
        : this.buf[off + 5];
      const extra = CRC_EXTRA.get(msgid);
      if (extra === undefined) { off += total; continue; }  // not ours
      const crcAt = off + hdr + len;
      const want = u16(this.buf, crcAt);
      const got = crcFrame(this.buf, off + 1, crcAt, extra);
      if (want !== got) {
        this.state.crcErrors++;
        off++;   // resync one byte; the next magic may start a good frame
        continue;
      }
      this.decode(msgid, this.buf, off + hdr, len, ptsUs, nowMs);
      this.state.frames++;
      off += total;
    }
    if (off) this.buf = this.buf.slice(off);
    if (this.buf.length > 4096) this.buf = new Uint8Array(0);  // not MAVLink
  }

  updateHome(s) {
    if (!Number.isFinite(s.homeLat) || !Number.isFinite(s.homeLon)) return;
    if (!s.lat && !s.lon) return;
    s.homeRelN = (s.homeLat - s.lat) * 111320;
    s.homeRelE = (s.homeLon - s.lon) * 111320 * Math.cos(s.lat * Math.PI / 180);
    s.homeRelD = (Number.isFinite(s.altMsl) && s.altMsl ? s.altMsl : 0) - s.homeAlt;
    s.homeDist = Math.hypot(s.homeRelN, s.homeRelE);
    s.homeBearing = ((Math.atan2(s.homeRelE, s.homeRelN) * 180 / Math.PI) + 360) % 360;
  }

  decode(msgid, b, p, len, ptsUs, nowMs) {
    const s = this.state;
    if (msgid === 0 && len >= 9) {                       // HEARTBEAT
      s.type = b[p + 4];
      s.armed = (b[p + 6] & 0x80) !== 0;
      s.mode = modeName(s.type, u32(b, p));
      s.statusMs = nowMs;
      s.updated = nowMs;
    } else if (msgid === 30 && len >= 28) {              // ATTITUDE
      s.roll = f32(b, p + 4) * DEG;
      s.pitch = f32(b, p + 8) * DEG;
      s.heading = ((f32(b, p + 12) * DEG) % 360 + 360) % 360;
      s.attMs = nowMs;
      s.updated = nowMs;
    } else if (msgid === 24 && len >= 30) {              // GPS_RAW_INT
      s.sats = b[p + 29];
      s.fix = b[p + 28];
      s.lat = i32(b, p + 8) / 1e7;
      s.lon = i32(b, p + 12) / 1e7;
      if (u16(b, p + 24) !== 0xffff) s.groundspeed = u16(b, p + 24) / 100;
      if (u16(b, p + 26) !== 0xffff) s.track = u16(b, p + 26) / 100;
      s.posMs = nowMs;
      this.updateHome(s);
      s.updated = nowMs;
    } else if (msgid === 33 && len >= 28) {              // GLOBAL_POSITION_INT
      s.lat = i32(b, p + 4) / 1e7;
      s.lon = i32(b, p + 8) / 1e7;
      s.relAlt = i32(b, p + 16) / 1000;
      if (!Number.isFinite(s.altMsl) || !s.altMsl) s.alt = s.relAlt;
      // vx/vy/vz are NED cm/s. Kept for the FPM when the fancy HUD lands.
      s.velN = i16(b, p + 20) / 100;
      s.velE = i16(b, p + 22) / 100;
      s.velD = i16(b, p + 24) / 100;
      s.track = u16(b, p + 26) / 100;
      s.posMs = nowMs;
      this.updateHome(s);
      s.updated = nowMs;
    } else if (msgid === 49 && len >= 12) {              // GPS_GLOBAL_ORIGIN
      s.homeLat = i32(b, p + 0) / 1e7;
      s.homeLon = i32(b, p + 4) / 1e7;
      s.homeAlt = i32(b, p + 8) / 1000;
      this.updateHome(s);
      s.updated = nowMs;
    } else if (msgid === 74 && len >= 20) {              // VFR_HUD
      s.airspeed = f32(b, p + 0);
      s.groundspeed = f32(b, p + 4);
      s.alt = f32(b, p + 8);
      s.altMsl = s.alt;
      s.vario = f32(b, p + 12);
      s.heading = ((i16(b, p + 16) % 360) + 360) % 360;
      s.throttle = u16(b, p + 18);
      s.statusMs = nowMs;
      this.updateHome(s);
      s.updated = nowMs;
    } else if (msgid === 147 && len >= 36) {             // BATTERY_STATUS
      const consumed = i32(b, p + 0);
      s.mah = consumed >= 0 ? consumed : NaN;
      const amps = i16(b, p + 30);
      s.currentA = amps >= 0 ? amps / 100 : NaN;
      const pct = (b[p + 35] << 24) >> 24;
      s.batteryPct = pct >= 0 ? pct : NaN;
      let sum = 0, n = 0, min = Infinity;
      for (let i = 0; i < 10; i++) {
        const mv = u16(b, p + 10 + i * 2);
        if (mv !== 0xffff && mv > 0) { sum += mv; n++; min = Math.min(min, mv); }
      }
      if (n === 1) {                 // cell 0 is the pack total, not a cell
        s.batteryV = sum / 1000;
        s.cellV = NaN; s.cells = 0;
      } else if (n > 1) {
        s.batteryV = sum / 1000;
        s.cells = n;
        s.cellV = min / 1000;
      }
      s.statusMs = nowMs;
      s.updated = nowMs;
    } else if (msgid === 1 && len >= 19) {               // SYS_STATUS
      if (!Number.isFinite(s.batteryV)) s.batteryV = u16(b, p + 14) / 1000;
      if (!Number.isFinite(s.currentA)) {
        const amps = i16(b, p + 16);
        if (amps >= 0) s.currentA = amps / 100;
      }
      const pct = (b[p + 18] << 24) >> 24;
      if (!Number.isFinite(s.batteryPct) && pct >= 0) s.batteryPct = pct;
      s.updated = nowMs;
    }
  }

  ageMs(nowMs) {
    const t = Math.max(this.state.attMs, this.state.posMs, this.state.statusMs);
    return t ? nowMs - t : Infinity;
  }
}

export const MAVLINK_MESSAGES = [...CRC_EXTRA.keys()];
