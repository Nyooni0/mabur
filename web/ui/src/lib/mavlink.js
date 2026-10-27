// Raw MAVLink v1/v2 frame parser and the flight-state view the web OSD draws.
// The drone forwards the FC's frames verbatim (T_MAV); this file owns
// CRC_EXTRA validation and the message -> state mapping.
//
// Supported messages: HEARTBEAT, SYS_STATUS, GPS_RAW_INT, ATTITUDE,
// GLOBAL_POSITION_INT, GPS_GLOBAL_ORIGIN, VFR_HUD, BATTERY_STATUS,
// STATUSTEXT. Unknown message IDs are skipped (their CRC_EXTRA is unknown
// here); the frame is not an error.
//
// Field offsets are MAVLink's wire order (payload-relative), not the XML
// order: the generator places the largest fields first. They are pinned in
// the tests against frames built by hand from the message definitions.

const CRC_EXTRA = new Map([
  [0, 50],    // HEARTBEAT
  [1, 124],   // SYS_STATUS
  [24, 24],   // GPS_RAW_INT
  [30, 39],   // ATTITUDE
  [33, 104],  // GLOBAL_POSITION_INT
  [49, 39],   // GPS_GLOBAL_ORIGIN
  [74, 20],   // VFR_HUD
  [147, 154], // BATTERY_STATUS
  [253, 83],  // STATUSTEXT
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
function i8(b, o) { return (b[o] << 24) >> 24; }
function f32(b, o) { return new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, true); }

// Short-baseline ground distance; the odometer never spans degrees.
function distanceM(lat1, lon1, lat2, lon2) {
  const dN = (lat2 - lat1) * 111320;
  const dE = (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot(dN, dE);
}

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
  // ArduPilot Plane and Copter keep separate custom_mode tables; INAV
  // reports its own values, which fall back to the number rather than
  // claiming a wrong name.
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
      alt: 0, relAlt: 0, mslAlt: NaN, vario: 0,
      airspeed: 0, groundspeed: 0, track: 0,
      velN: 0, velE: 0, velD: 0,
      lat: NaN, lon: NaN,
      homeLat: NaN, homeLon: NaN, homeAlt: 0,
      homeRelN: NaN, homeRelE: NaN, homeRelD: NaN,
      homeDist: NaN, homeBearing: NaN,
      hdop: NaN,
      flightTime: 0, armedSince: 0,
      tripDist: 0, odometer: 0, efficiency: NaN,
      messages: [],
      lastLat: NaN, lastLon: NaN, lastPosMs: 0,
      throttle: 0,
      sats: 0, fix: 0,
      batteryV: NaN, cellV: NaN, cells: 0, currentA: NaN, mah: NaN, batteryPct: NaN,
      mode: '', armed: false, type: 0,
      attMs: 0, posMs: 0, gpsMs: 0, statusMs: 0,
      frames: 0, crcErrors: 0, updated: 0,
    };
  }

  reset() { this.buf = new Uint8Array(0); this.state = MavlinkFeed.blank(); }

  // One T_MAV payload: a whole frame, or bytes continuing one.
  push(chunk, ptsUs = 0, nowMs = Date.now()) {
    const src = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (src.length === 0) return;
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

  // Vector from the aircraft to the FC's home point, in NED metres. The OSD
  // projects it into the camera; it is hidden while either position is
  // unknown, and the glyph itself hides within home.hideWithinM.
  updateHome(s) {
    if (!Number.isFinite(s.homeLat) || !Number.isFinite(s.homeLon)) return;
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return;
    if (!s.lat && !s.lon) return;
    s.homeRelN = (s.homeLat - s.lat) * 111320;
    s.homeRelE = (s.homeLon - s.lon) * 111320 * Math.cos(s.lat * Math.PI / 180);
    s.homeRelD = Number.isFinite(s.mslAlt) ? s.mslAlt - s.homeAlt : NaN;
    s.homeDist = Math.hypot(s.homeRelN, s.homeRelE);
    s.homeBearing = ((Math.atan2(s.homeRelE, s.homeRelN) * 180 / Math.PI) + 360) % 360;
  }

  // Integrate GLOBAL_POSITION_INT ground tracks. A gap over 3 s (link drop,
  // reconnect) and a jump over 200 m are not flight: drop the sample rather
  // than adding a straight line the aircraft never flew.
  noteDistance(s, nowMs) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return;
    if (Number.isFinite(s.lastLat) && (s.lastLat !== 0 || s.lastLon !== 0)) {
      const dt = nowMs - s.lastPosMs;
      const d = distanceM(s.lastLat, s.lastLon, s.lat, s.lon);
      if (dt > 0 && dt < 3000 && d < 200) {
        s.odometer += d;
        if (s.armed) s.tripDist += d;
        this.updateEfficiency(s);
      }
    }
    s.lastLat = s.lat;
    s.lastLon = s.lon;
    s.lastPosMs = nowMs;
  }

  updateEfficiency(s) {
    s.efficiency = Number.isFinite(s.mah) && s.tripDist > 50
      ? s.mah / (s.tripDist / 1000)
      : NaN;
  }

  decode(msgid, b, p, len, ptsUs, nowMs) {
    const s = this.state;
    if (msgid === 0 && len >= 9) {                       // HEARTBEAT
      const wasArmed = s.armed;
      s.type = b[p + 4];
      s.armed = (b[p + 6] & 0x80) !== 0;
      s.mode = modeName(s.type, u32(b, p));
      if (s.armed && !wasArmed) { s.armedSince = nowMs; s.tripDist = 0; s.efficiency = NaN; }
      if (!s.armed && wasArmed && s.armedSince) {
        s.flightTime += (nowMs - s.armedSince) / 1000;
        s.armedSince = 0;
      }
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
      const eph = u16(b, p + 20);
      s.hdop = eph !== 0xffff && eph > 0 ? eph / 100 : NaN;
      if (u16(b, p + 24) !== 0xffff) s.groundspeed = u16(b, p + 24) / 100;
      if (u16(b, p + 26) !== 0xffff) s.track = u16(b, p + 26) / 100;
      s.gpsMs = nowMs;
      this.updateHome(s);
      s.updated = nowMs;
    } else if (msgid === 33 && len >= 28) {              // GLOBAL_POSITION_INT
      s.lat = i32(b, p + 4) / 1e7;
      s.lon = i32(b, p + 8) / 1e7;
      s.relAlt = i32(b, p + 16) / 1000;
      s.alt = s.relAlt;
      s.velN = i16(b, p + 20) / 100;
      s.velE = i16(b, p + 22) / 100;
      s.velD = i16(b, p + 24) / 100;
      const hdg = u16(b, p + 26);
      if (hdg !== 0xffff) s.track = (hdg % 36000) / 100;
      s.posMs = nowMs;
      this.updateHome(s);
      this.noteDistance(s, nowMs);
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
      s.mslAlt = f32(b, p + 8);
      if (!s.posMs) s.alt = s.mslAlt;
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
      const pct = i8(b, p + 35);
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
      this.updateEfficiency(s);
      s.updated = nowMs;
    } else if (msgid === 1 && len >= 31) {               // SYS_STATUS
      const mv = u16(b, p + 14);
      if (!Number.isFinite(s.batteryV) && mv !== 0xffff) s.batteryV = mv / 1000;
      if (!Number.isFinite(s.currentA)) {
        const amps = i16(b, p + 16);
        if (amps >= 0) s.currentA = amps / 100;
      }
      const pct = i8(b, p + 30);
      if (!Number.isFinite(s.batteryPct) && pct >= 0) s.batteryPct = pct;
      s.updated = nowMs;
    } else if (msgid === 253 && len >= 51) {             // STATUSTEXT
      const severity = b[p + 0];
      let end = p + 1;
      const max = p + 51;
      while (end < max && b[end] !== 0) end++;
      const text = new TextDecoder().decode(b.subarray(p + 1, end)).trim();
      if (text) {
        s.messages.push({ text, severity, t: nowMs });
        if (s.messages.length > 8) s.messages.shift();
      }
      s.updated = nowMs;
    }
  }

  ageMs(nowMs) {
    const t = Math.max(this.state.attMs, this.state.posMs, this.state.gpsMs, this.state.statusMs);
    return t ? nowMs - t : Infinity;
  }
}

export const MAVLINK_MESSAGES = [...CRC_EXTRA.keys()];
