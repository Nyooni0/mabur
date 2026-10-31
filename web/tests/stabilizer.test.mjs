import test from 'node:test';
import assert from 'node:assert/strict';
import { sadShift, rotationRad } from '../ui/src/lib/stabilizer.js';

function pattern(n) {
  const a = new Uint8Array(n * n);
  let v = 1234567;
  for (let i = 0; i < a.length; i++) {
    v = (v * 1664525 + 1013904223) >>> 0;
    a[i] = (v >>> 24) & 0xff;
  }
  return a;
}

function move(prev, n, dx, dy) {
  const out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const sy = y - dy, sx = x - dx;
      if (sx >= 0 && sx < n && sy >= 0 && sy < n) out[y * n + x] = prev[sy * n + sx];
      else out[y * n + x] = prev[y * n + x];
    }
  }
  return out;
}

test('SAD recovers the content shift', () => {
  const n = 64;
  const prev = pattern(n);
  const curr = move(prev, n, 3, -2);
  const r = sadShift(prev, curr, n, 6);
  assert.equal(r.dx, 3);
  assert.equal(r.dy, -2);
  assert.ok(r.score < 2);
});

test('SAD finds zero motion on an identical window', () => {
  const n = 64;
  const prev = pattern(n);
  const r = sadShift(prev, prev, n, 6);
  assert.equal(r.dx, 0);
  assert.equal(r.dy, 0);
  assert.ok(r.score < 1e-6);
});

test('baseline rotation is positive clockwise in screen coordinates', () => {
  const c0 = [100, 100], c1 = [300, 100];
  const ang = rotationRad(c0, c1, { dx: 0, dy: 0 }, { dx: 0, dy: 4 });
  assert.ok(ang > 0);   // the right window moved down: clockwise
  assert.ok(Math.abs(ang - Math.atan2(4, 200)) < 1e-9);
});
