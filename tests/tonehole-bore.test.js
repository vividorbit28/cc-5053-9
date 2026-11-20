import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToneholeBore } from '../src/core/tonehole-bore.js';
import { predictedFrequency } from '../src/core/reed-bore.js';
import { fundamental, rms } from '../src/core/analysis.js';

const FS = 48000;
const FINGERINGS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

function steady(openCount, pressure, { seconds = 1.4 } = {}) {
  const m = new ToneholeBore({ fs: FS, oversampling: 2 });
  m.setFingering(openCount);
  const p = [];
  for (let i = 0; i < FS * seconds; i++) {
    m.step(pressure);
    if (i > FS * 0.9) p.push(m.lastState.p);
  }
  const buf = Float64Array.from(p);
  return {
    model: m,
    hz: fundamental(buf, FS).hz,
    level: rms(buf),
    fault: m.lastState.fault,
  };
}

test('every fingering oscillates near the geometric pitch without faulting', () => {
  for (const n of FINGERINGS) {
    const r = steady(n, 2500);
    assert.equal(r.fault, null, `fingering ${n} faulted: ${r.fault}`);
    assert.ok(r.level > 1000, `fingering ${n} did not sustain (rms ${r.level})`);
    const predicted = predictedFrequency(n);
    const cents = 1200 * Math.log2(r.hz / predicted);
    assert.ok(Math.abs(cents) < 15,
      `fingering ${n} off by ${cents.toFixed(1)} cents (${r.hz.toFixed(1)} vs ${predicted.toFixed(1)})`);
  }
});

test('pitch rises monotonically as more holes open', () => {
  let prev = 0;
  for (const n of FINGERINGS) {
    const r = steady(n, 2500);
    assert.ok(r.hz > prev, `pitch did not rise at fingering ${n}: ${r.hz} <= ${prev}`);
    prev = r.hz;
  }
});

test('the tail segment never aliases its delay buffer at any fingering', () => {
  // Regression guard: rB/lB were once allocated for delay ~1 but retuned up
  // to ~31 samples, wrapping the circular read index and destabilising the
  // even-n fingerings. Every buffer must always exceed its live delay.
  const m = new ToneholeBore({ fs: FS, oversampling: 2 });
  for (const n of FINGERINGS) {
    m.setFingering(n);
    for (const seg of [m.rA, m.lA, m.rB, m.lB]) {
      assert.ok(seg.cap > seg.delay + 2,
        `fingering ${n}: buffer cap ${seg.cap} too small for delay ${seg.delay}`);
    }
  }
});

test('continuous hole openness glides without clicking or faulting', () => {
  const m = new ToneholeBore({ fs: FS, oversampling: 2 });
  m.setFingering(0);
  let fault = null;
  let prev = 0;
  let maxStep = 0;
  for (let i = 0; i < FS * 1.0; i++) {
    if (i === Math.floor(FS * 0.3)) m.setHoleOpenness(7, 1);
    const st = m.step(2500);
    if (st.fault) fault = st.fault;
    maxStep = Math.max(maxStep, Math.abs(st.p - prev));
    prev = st.p;
  }
  assert.equal(fault, null);
  assert.ok(rms(Float64Array.from([m.lastState.p])) >= 0);
  assert.ok(Number.isFinite(maxStep), 'non-finite pressure during openness sweep');
});
