import test from 'node:test';
import assert from 'node:assert/strict';
import { MavlinkFeed, MAVLINK_CRC_EXTRA, MAVLINK_MIN_LEN, MAV_AUTOPILOT_BETAFLIGHT, mavlinkCrc } from '../ui/src/lib/mavlink.js';

// Build a v2 frame. `payload` is the wire-order payload (the caller owns the
// field offsets, as the FC's serializer does).
function frame(msgid, payload, seq = 0, sysid = 1, compid = 1) {
  const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(10 + p.length + 2);
  out[0] = 0xfd;
  out[1] = p.length;
  out[2] = 0; out[3] = 0;
  out[4] = seq;
  out[5] = sysid; out[6] = compid;
  out[7] = msgid & 0xff; out[8] = (msgid >> 8) & 0xff; out[9] = (msgid >> 16) & 0xff;
  out.set(p, 10);
  const crc = mavlinkCrc(out, 1, 10 + p.length, MAVLINK_CRC_EXTRA.get(msgid));
  out[10 + p.length] = crc & 0xff;
  out[11 + p.length] = (crc >> 8) & 0xff;
  return out;
}

// Build a v1 frame (6-byte header, one-byte message id).
function frameV1(msgid, payload, seq = 0, sysid = 1, compid = 1) {
  const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(6 + p.length + 2);
  out[0] = 0xfe;
  out[1] = p.length;
  out[2] = seq;
  out[3] = sysid; out[4] = compid; out[5] = msgid;
  out.set(p, 6);
  const crc = mavlinkCrc(out, 1, 6 + p.length, MAVLINK_CRC_EXTRA.get(msgid));
  out[6 + p.length] = crc & 0xff;
  out[7 + p.length] = (crc >> 8) & 0xff;
  return out;
}

function payload(n) { return new Uint8Array(n); }
function setF32(b, o, v) { new DataView(b.buffer, b.byteOffset + o, 4).setFloat32(0, v, true); }
function setI32(b, o, v) { new DataView(b.buffer, b.byteOffset + o, 4).setInt32(0, v, true); }
function setU16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; }
function setI16(b, o, v) { setU16(b, o, v < 0 ? v + 0x10000 : v); }
function setU32(b, o, v) { new DataView(b.buffer, b.byteOffset + o, 4).setUint32(0, v, true); }

test('CRC_EXTRA table is pinned to the message definitions', () => {
  assert.deepEqual(Object.fromEntries(MAVLINK_CRC_EXTRA), {
    0: 50, 1: 124, 24: 24, 30: 39, 33: 104, 35: 244, 49: 39, 74: 20, 147: 154, 253: 83,
  });
});

test('every decoded message pins a minimum payload length', () => {
  assert.deepEqual([...MAVLINK_MIN_LEN.keys()].sort(), [...MAVLINK_CRC_EXTRA.keys()].sort());
});

// Betaflight's sender passes its internal roll through unnegated, and that roll
// is negative for a right bank, so its ATTITUDE stream is mirrored. The HUD's
// convention is +right bank, so the decoder un-mirrors it from the autopilot
// the heartbeat advertises.
test('Betaflight ATTITUDE roll is un-mirrored', () => {
  const hb = payload(9);
  hb[4] = 2;                       // MAV_TYPE_QUADROTOR
  hb[5] = MAV_AUTOPILOT_BETAFLIGHT;
  const att = payload(16);         // trimmed: the three rates are zero
  setF32(att, 4, -0.5);            // BF sends a right bank as negative
  setF32(att, 8, 0.1);
  setF32(att, 12, 1.0);
  const f = new MavlinkFeed();
  f.push(frame(0, hb), 0, 900);
  f.push(frame(30, att), 0, 1000);
  assert.equal(f.state.autopilot, MAV_AUTOPILOT_BETAFLIGHT);
  assert.ok(f.state.roll > 0, 'a right bank must read positive');
  assert.ok(Math.abs(f.state.roll - (0.5 * 180 / Math.PI)) < 1e-6);
  assert.ok(Math.abs(f.state.pitch - (0.1 * 180 / Math.PI)) < 1e-6);
});

test('a non-Betaflight ATTITUDE roll is taken as sent', () => {
  const hb = payload(9);
  hb[4] = 1;                       // fixed wing
  hb[5] = 0;                       // MAV_AUTOPILOT_GENERIC (INAV)
  const att = payload(28);
  setF32(att, 4, -0.5);
  const f = new MavlinkFeed();
  f.push(frame(0, hb), 0, 900);
  f.push(frame(30, att), 0, 1000);
  assert.ok(f.state.roll < 0, 'only Betaflight is mirrored');
  assert.ok(Math.abs(f.state.roll - (-0.5 * 180 / Math.PI)) < 1e-6);
});

// MAVLink v2 drops trailing zero bytes, so a stationary aircraft's frames are
// shorter than their definition. Decoding a trimmed frame is what lets the HUD
// show before the aircraft moves: on the bench HEARTBEAT was the only message
// that survived the length guards.
test('a v2-trimmed ATTITUDE (zero rates) still decodes', () => {
  const att = payload(16);        // 28 in the definition; the three rates are 0
  setU32(att, 0, 1234);
  setF32(att, 4, 0.1);
  setF32(att, 8, -0.2);
  setF32(att, 12, 1.5);
  const f = new MavlinkFeed();
  f.push(frame(30, att), 0, 5000);
  assert.equal(f.state.frames, 1);
  assert.equal(f.state.crcErrors, 0);
  assert.equal(f.state.attMs, 5000);
  assert.ok(Math.abs(f.state.roll - (0.1 * 180 / Math.PI)) < 1e-6);
  assert.ok(Math.abs(f.state.pitch - (-0.2 * 180 / Math.PI)) < 1e-6);
  assert.ok(Math.abs(f.state.heading - ((1.5 * 180 / Math.PI) % 360)) < 1e-6);
});

test('a v2-trimmed VFR_HUD decodes its remaining fields', () => {
  const vfr = payload(18);        // throttle 0 -> the last two bytes are trimmed
  setF32(vfr, 0, 12);
  setF32(vfr, 4, 13);
  setF32(vfr, 8, 100);
  setF32(vfr, 12, -1.5);
  setI16(vfr, 16, 270);
  const f = new MavlinkFeed();
  f.push(frame(74, vfr), 0, 6000);
  assert.equal(f.state.frames, 1);
  assert.equal(f.state.heading, 270);
  assert.equal(f.state.throttle, 0);
  assert.equal(f.state.vario, -1.5);
});

test('a v2-trimmed STATUSTEXT decodes the short text', () => {
  const st = payload(8);          // severity + "NO GPS" + terminator, well under 51
  st[0] = 4;
  st.set(new TextEncoder().encode('NO GPS'), 1);
  const f = new MavlinkFeed();
  f.push(frame(253, st), 0, 7000);
  assert.equal(f.state.frames, 1);
  assert.equal(f.state.messages.length, 1);
  assert.equal(f.state.messages[0].text, 'NO GPS');
});

test('battery status decodes pack, cells, current and mAh', () => {
  const p = payload(54);
  setI32(p, 0, 1234);            // current_consumed mAh
  for (let i = 0; i < 4; i++) setU16(p, 10 + i * 2, 4000);
  for (let i = 4; i < 10; i++) setU16(p, 10 + i * 2, 0xffff);
  setI16(p, 30, 1520);           // 15.20 A
  p[35] = 80;                    // battery_remaining %
  const f = new MavlinkFeed();
  f.push(frame(147, p));
  assert.equal(f.state.batteryV, 16);
  assert.equal(f.state.cellV, 4);
  assert.equal(f.state.cells, 4);
  assert.equal(f.state.currentA, 15.2);
  assert.equal(f.state.mah, 1234);
  assert.equal(f.state.batteryPct, 80);
});

test('sys status falls back to voltage, current and remaining', () => {
  const p = payload(43);
  setU16(p, 14, 16800);          // 16.8 V
  setI16(p, 16, 1234);           // 12.34 A
  p[30] = 66;                    // battery_remaining %
  const f = new MavlinkFeed();
  f.push(frame(1, p));
  assert.equal(f.state.batteryV, 16.8);
  assert.equal(f.state.currentA, 12.34);
  assert.equal(f.state.batteryPct, 66);
});

test('attitude, heartbeat, gps and vfr hud map into state', () => {
  const att = payload(28);
  setU32(att, 0, 1234);
  setF32(att, 4, 0.1);
  setF32(att, 8, -0.2);
  setF32(att, 12, 1.5);

  const hb = payload(9);
  setU32(hb, 0, 11);             // ArduPilot Plane RTL
  hb[4] = 1;                     // fixed wing
  hb[5] = 3;                     // ArduPilot
  hb[6] = 0x80;                  // armed

  const gps = payload(30);
  setI32(gps, 8, 525000000);     // lat 52.5
  setI32(gps, 12, -12000000);    // lon -1.2
  setU16(gps, 24, 1800);         // 18 m/s
  setU16(gps, 26, 9000);         // 90 deg
  gps[28] = 3;
  gps[29] = 12;

  const vfr = payload(20);
  setF32(vfr, 0, 17);
  setF32(vfr, 4, 18);
  setF32(vfr, 8, 120);
  setF32(vfr, 12, 1.5);
  setI16(vfr, 16, 270);
  setU16(vfr, 18, 62);

  const f = new MavlinkFeed();
  f.push(frame(30, att));
  assert.ok(Math.abs(f.state.roll - (0.1 * 180 / Math.PI)) < 1e-6);
  assert.ok(Math.abs(f.state.pitch - (-0.2 * 180 / Math.PI)) < 1e-6);
  assert.ok(Math.abs(f.state.heading - ((1.5 * 180 / Math.PI) % 360)) < 1e-6);
  f.push(frame(0, hb));
  f.push(frame(24, gps));
  f.push(frame(74, vfr));
  assert.equal(f.state.mode, 'RTL');
  assert.equal(f.state.armed, true);
  assert.equal(f.state.sats, 12);
  assert.equal(f.state.fix, 3);
  assert.equal(f.state.groundspeed, 18);
  assert.equal(f.state.throttle, 62);
  assert.equal(f.state.vario, 1.5);
  assert.equal(f.state.alt, 120);
  assert.equal(f.state.frames, 4);
});

test('global position gives relative altitude, not the MSL value', () => {
  const pos = payload(28);
  setI32(pos, 16, 42300);        // relative_alt 42.3 m
  setI16(pos, 20, 100);          // 1 m/s north
  setU16(pos, 26, 9000);         // 90.00 deg
  const f = new MavlinkFeed();
  f.push(frame(33, pos));
  assert.equal(f.state.relAlt, 42.3);
  assert.equal(f.state.alt, 42.3);
  assert.equal(f.state.track, 90);
  assert.equal(f.state.velN, 1);
});

test('GPS dilution and home vector decode', () => {
  const gps = payload(30);
  setI32(gps, 8, 525000000);      // 52.5
  setI32(gps, 12, -12000000);     // -1.2
  setU16(gps, 20, 120);           // hdop 1.20
  gps[28] = 3;
  gps[29] = 12;
  const origin = payload(12);
  setI32(origin, 0, 525000000);
  setI32(origin, 4, -12000000);
  setI32(origin, 8, 100000);      // home 100 m MSL
  const pos = payload(28);
  setI32(pos, 4, 525001000);      // ~11 m north
  setI32(pos, 8, -12000000);
  setI32(pos, 16, 50000);         // 50 m relative
  const vfr = payload(20);
  setF32(vfr, 8, 150);            // 150 m MSL
  const f = new MavlinkFeed();
  f.push(frame(24, gps));
  assert.equal(f.state.hdop, 1.2);
  f.push(frame(49, origin));
  f.push(frame(33, pos));
  f.push(frame(74, vfr));
  assert.ok(f.state.homeRelN < 0);
  assert.ok(Math.abs(f.state.homeRelD - 50) < 1e-6);
  assert.ok(f.state.homeDist > 0);
});

test('armed time, odometer and efficiency derive from the stream', () => {
  const hb = payload(9);
  setU32(hb, 0, 0);
  hb[4] = 1;
  hb[6] = 0x80;                   // armed
  const pos = payload(28);
  setI32(pos, 4, 525000000);
  setI32(pos, 8, -12000000);
  const pos2 = payload(28);
  setI32(pos2, 4, 525006000);     // ~67 m north
  setI32(pos2, 8, -12000000);
  const bat = payload(36);
  setI32(bat, 0, 500);            // 500 mAh used
  const f = new MavlinkFeed();
  f.push(frame(0, hb), 0, 1000);
  f.push(frame(33, pos), 0, 2000);
  f.push(frame(33, pos2), 0, 3000);
  f.push(frame(147, bat), 0, 3000);
  assert.ok(f.state.tripDist > 60 && f.state.tripDist < 75);
  assert.ok(f.state.odometer >= f.state.tripDist);
  assert.ok(Number.isFinite(f.state.efficiency));
  hb[6] = 0;                      // disarmed
  f.push(frame(0, hb), 0, 4000);
  assert.ok(Math.abs(f.state.flightTime - 3) < 1e-6);
});

test('STATUSTEXT becomes a message with its severity', () => {
  const st = payload(51);
  st[0] = 4;                      // MAV_SEVERITY_WARNING
  const text = 'LOW BAT';
  for (let i = 0; i < text.length; i++) st[1 + i] = text.charCodeAt(i);
  const f = new MavlinkFeed();
  f.push(frame(253, st));
  assert.equal(f.state.messages.length, 1);
  assert.equal(f.state.messages[0].text, 'LOW BAT');
  assert.equal(f.state.messages[0].severity, 4);
});

test('a corrupted CRC is counted and does not update state', () => {
  const p = payload(28);
  setF32(p, 4, 1);
  const f = new MavlinkFeed();
  const bad = frame(30, p);
  bad[12] ^= 0x40;
  f.push(bad);
  assert.equal(f.state.crcErrors, 1);
  assert.equal(f.state.attMs, 0);
});

test('a frame split across two pushes still decodes', () => {
  const p = payload(28);
  setF32(p, 4, 0.5);
  const bytes = frame(30, p);
  const f = new MavlinkFeed();
  f.push(bytes.subarray(0, 5));
  assert.equal(f.state.frames, 0);
  f.push(bytes.subarray(5));
  assert.equal(f.state.frames, 1);
  assert.ok(Math.abs(f.state.roll - (0.5 * 180 / Math.PI)) < 1e-6);
});

test('garbage before a frame is resynced', () => {
  const p = payload(28);
  setF32(p, 4, 0.25);
  const f = new MavlinkFeed();
  f.push(new Uint8Array([1, 2, 3, 0x55, 0xaa, ...frame(30, p)]));
  assert.equal(f.state.frames, 1);
  assert.ok(Math.abs(f.state.roll - (0.25 * 180 / Math.PI)) < 1e-6);
});

test('a MAVLink v1 frame decodes', () => {
  const p = payload(28);
  setF32(p, 4, 0.75);
  const f = new MavlinkFeed();
  f.push(frameV1(30, p));
  assert.equal(f.state.frames, 1);
  assert.ok(Math.abs(f.state.roll - (0.75 * 180 / Math.PI)) < 1e-6);
});

test('a signed v2 frame decodes (signature is not part of the CRC)', () => {
  const p = payload(28);
  setF32(p, 4, 0.5);
  const f = new MavlinkFeed();
  const base = frame(30, p);
  const signed = new Uint8Array(base.length + 13);
  signed.set(base);
  signed[2] = 0x01;              // incompat: signed
  // Re-CRC with the signature bit set (the header byte is covered).
  const crc = mavlinkCrc(signed, 1, 10 + p.length, MAVLINK_CRC_EXTRA.get(30));
  signed[10 + p.length] = crc & 0xff;
  signed[11 + p.length] = (crc >> 8) & 0xff;
  signed.fill(0x5a, base.length);
  f.push(signed);
  assert.equal(f.state.frames, 1);
  assert.ok(Math.abs(f.state.roll - (0.5 * 180 / Math.PI)) < 1e-6);
});

test('an unknown message id is skipped, not counted as an error', () => {
  const p = payload(4);
  const bytes = frame(9999, p);   // CRC_EXTRA missing -> frame() would produce NaN; build raw
  bytes[10 + p.length] = 0;
  bytes[11 + p.length] = 0;
  const f = new MavlinkFeed();
  f.push(bytes);
  assert.equal(f.state.frames, 0);
  assert.equal(f.state.crcErrors, 0);
  // A known frame after it still decodes.
  const att = payload(28);
  setF32(att, 4, 0.1);
  f.push(frame(30, att));
  assert.equal(f.state.frames, 1);
});
