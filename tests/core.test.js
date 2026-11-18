import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ReedBore, DEFAULT_CONFIG, predictedFrequency, effectiveLength,
  maskEffectiveLength, maskToOpenCount, FINGERING_STEPS,
} from '../src/core/reed-bore.js';
import {
  zeroCrossingFrequency, fundamental, rms, peak, spectrum,
  timeToFraction, delayBudget,
} from '../src/core/analysis.js';

const FS = 48000;

function steady(openCount, pressure, { seconds = 1.2, os = 2 } = {}) {
  const m = new ReedBore({ fs: FS, oversampling: os });
  m.setFingeringImmediate(openCount);
  m.reset();
  const p = [];
  const a = [];
  let peakBore = 0;
  let fault = null;
  for (let i = 0; i < FS * seconds; i++) {
    const t = i / FS;
    const st = m.step(t < seconds * 0.85 ? pressure : 0);
    if (t > seconds * 0.35 && t < seconds * 0.85) {
      p.push(st.p);
      a.push(m.toAudio(st.p));
      peakBore = Math.max(peakBore, Math.abs(st.p));
    }
    if (st.fault) fault = st.fault;
  }
  return {
    model: m, pressure: Float64Array.from(p), audio: Float64Array.from(a), peakBore, fault,
  };
}

test('the loop oscillates at the predicted pitch for every fingering', () => {
  for (const step of FINGERING_STEPS) {
    const r = steady(step.openCount, 3000);
    assert.equal(r.fault, null);
    const zc = zeroCrossingFrequency(r.pressure, FS, { skip: 1 });
    const fft = fundamental(r.pressure, FS, { minHz: 60, maxHz: 2500 });
    const predicted = predictedFrequency(step.openCount);
    assert.ok(zc.hz > 0, `fingering ${step.openCount} did not oscillate`);
    // Both estimators must agree and sit on the geometric pitch.
    assert.ok(Math.abs(zc.hz - fft.hz) / predicted < 0.01,
      `estimators disagree at ${step.openCount}: ${zc.hz} vs ${fft.hz}`);
    const cents = 1200 * Math.log2(zc.hz / predicted);
    assert.ok(Math.abs(cents) < 8, `fingering ${step.openCount} off by ${cents.toFixed(1)} cents`);
  }
});

test('output is a real loop oscillation, not an amplitude-mapped sine', () => {
  const r = steady(0, 3000);
  const spec = spectrum(r.pressure, FS, { windowSize: 16384 });
  // Odd harmonics (a closed-open pipe) must carry real energy. A pure
  // pressure-to-sine mapping would put everything in the fundamental.
  const at = (hz) => {
    const i = Math.round(hz / spec.binHz);
    return Math.max(spec.bins[i - 1] ?? 0, spec.bins[i], spec.bins[i + 1] ?? 0);
  };
  const f0 = zeroCrossingFrequency(r.pressure, FS, { skip: 1 }).hz;
  const h3 = at(f0 * 3);
  const h1 = at(f0);
  assert.ok(h3 > 0, 'no third harmonic');
  assert.ok(h3 / h1 > 0.02, `third harmonic too weak: ${(h3 / h1).toFixed(3)}`);
  // No even harmonic series: this is a stopped (closed-open) bore.
  const h2 = at(f0 * 2);
  assert.ok(h2 / h1 < 0.5, `unexpected strong even harmonic: ${(h2 / h1).toFixed(3)}`);
});

test('pitch is stable against oversampling and interpolation choices', () => {
  const results = [];
  for (const os of [1, 2, 4]) {
    for (const interpolation of ['linear', 'cubic']) {
      const m = new ReedBore({ fs: FS, oversampling: os, interpolation });
      m.setFingeringImmediate(0);
      m.reset();
      const buf = [];
      for (let i = 0; i < FS * 1.2; i++) {
        const st = m.step(3000);
        if (i > FS * 0.4) buf.push(st.p);
      }
      results.push({ os, interpolation, hz: zeroCrossingFrequency(Float64Array.from(buf), FS, { skip: 1 }).hz });
    }
  }
  const hs = results.map((r) => r.hz);
  const spreadCents = 1200 * Math.log2(Math.max(...hs) / Math.min(...hs));
  assert.ok(spreadCents < 6, `numerical spread ${spreadCents.toFixed(2)} cents\n` +
    JSON.stringify(results));
});

test('pitch does not depend on the pitch-label or preset name', () => {
  // Fingering must be expressed as a hole mask; the geometry, not a label,
  // sets the speaking length.
  const oneOpen = maskEffectiveLength([false, false, false, false, false, false, false, true]);
  const twoOpen = maskEffectiveLength([false, false, false, false, false, false, true, true]);
  assert.ok(oneOpen > twoOpen, 'one open hole must be longer than two');
  assert.equal(maskToOpenCount([false, false, false, false, false, false, false, true]), 1);
  assert.equal(maskToOpenCount([true, false, false, false, false, false, false, true]), 1);
  assert.equal(maskToOpenCount([false, false, false, false, false, false, true, true]), 2);
  assert.equal(effectiveLength(0), maskEffectiveLength([false, false, false, false, false, false, false, false]));
});

test('a slow pressure rise starts the oscillation and the amplitude grows', () => {
  const m = new ReedBore({ fs: FS, oversampling: 2 });
  m.setFingeringImmediate(0);
  m.reset();
  const rmsAt = [];
  for (let i = 0; i < FS * 2; i++) {
    const t = i / FS;
    m.step(3000 * Math.min(1, t / 1.2));
    if (i % (FS / 4) === 0 && i > 0) rmsAt.push(rms(m.toAudio ? [m.lastState.p] : [0]));
  }
  // Measure with a sliding window instead of single samples.
  const m2 = new ReedBore({ fs: FS, oversampling: 2 });
  m2.setFingeringImmediate(0);
  m2.reset();
  const windows = [0.2, 0.5, 0.8, 1.1, 1.5].map(() => []);
  for (let i = 0; i < FS * 2; i++) {
    const t = i / FS;
    const st = m2.step(3000 * Math.min(1, t / 1.2));
    for (let w = 0; w < windows.length; w++) {
      const lo = [0.2, 0.5, 0.8, 1.1, 1.5][w] * FS;
      if (i >= lo && i < lo + FS * 0.1) windows[w].push(st.p);
    }
  }
  const levels = windows.map((w) => rms(Float64Array.from(w)));
  assert.ok(levels[4] > levels[1] * 2, `amplitude did not grow: ${levels}`);
  assert.ok(levels[2] > 100, `no oscillation above threshold: ${levels[2]}`);
});

test('near-threshold behaviour: no oscillation below, sustained above', () => {
  const below = steady(0, 800);
  const belowZc = zeroCrossingFrequency(below.pressure, FS, { skip: 1 });
  // Below threshold the valve hisses with a broadband trickle (tens of
  // Pa), but it is not a loop oscillation: its RMS stays orders of
  // magnitude below the sounding level. Above threshold the loop locks.
  assert.ok(rms(below.pressure) < 50, `oscillates below the threshold: ${rms(below.pressure)} Pa`);
  const above = steady(0, 1100);
  assert.ok(rms(above.pressure) > 100, 'no oscillation just above the threshold');
  // Just above threshold the oscillation is comfortably above the
  // broadband valve hiss but far below the saturation level it reaches at
  // higher blowing pressure; that is the signature of threshold behaviour.
  assert.ok(above.peakBore > 400 && above.peakBore < 3000);
});

test('step input produces a real attack, not an instantaneous maximum', () => {
  const m = new ReedBore({ fs: FS, oversampling: 2 });
  m.setFingeringImmediate(0);
  m.reset();
  const n = FS * 2;
  const audio = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    audio[i] = m.toAudio(m.step(t >= 0.1 && t < 1.4 ? 3000 : 0).p);
  }
  const attack = timeToFraction(audio, FS, 0.5, { startS: 0.1 });
  assert.ok(attack !== null && attack - 0.1 > 0.004,
    `attack too fast to be a loop build-up: ${attack}`);
  assert.ok(attack - 0.1 < 0.15, `attack too slow: ${attack}`);
});

test('after blowing stops the internal state decays to zero', () => {
  const m = new ReedBore({ fs: FS, oversampling: 2 });
  m.setFingeringImmediate(0);
  m.reset();
  let peakBore = 0;
  for (let i = 0; i < FS * 1.2; i++) {
    const st = m.step(i < FS ? 3000 : 0);
    if (i < FS) peakBore = Math.max(peakBore, Math.abs(st.p));
  }
  // Let the tail die.
  for (let i = 0; i < FS * 1.5; i++) m.step(0);
  const tail = [];
  for (let i = 0; i < FS * 0.1; i++) tail.push(m.step(0).p);
  assert.ok(peakBore > 1000);
  assert.ok(rms(Float64Array.from(tail)) < 1e-6, 'tail did not decay');
  assert.ok(Math.abs(m.gap - DEFAULT_CONFIG.reed.restGap) < 1e-12, 'reed did not return to rest');
  assert.equal(m.lastState.mouth, 0);
  assert.equal(m.lastState.fault, null);
});

test('the valve moves both ways and leaves no rectified DC in the bore', () => {
  const m = new ReedBore({ fs: FS, oversampling: 2 });
  m.setFingeringImmediate(0);
  m.reset();
  let maxBackflow = 0;
  for (let i = 0; i < FS * 1.5; i++) {
    const st = m.step(i < FS ? 3000 : 0);
    maxBackflow = Math.min(maxBackflow, st.flow);
  }
  assert.ok(maxBackflow < 0, 'valve never allowed backflow');
  // After release the mean pressure must be ~0, not a trapped DC offset.
  let sum = 0;
  let n = 0;
  for (let i = 0; i < FS * 0.5; i++) { sum += m.step(0).p; n++; }
  assert.ok(Math.abs(sum / n) < 1, `trapped DC: ${sum / n} Pa`);
});

test('out-of-range input is clamped and reported, not silently accepted', () => {
  const m = new ReedBore({ fs: FS, oversampling: 2 });
  const st = m.step(1e9);
  assert.equal(st.mouth, DEFAULT_CONFIG.maxMouthPressure);
  assert.equal(m.clamped, true);
  const st2 = m.step(-50);
  assert.equal(st2.mouth, 0);
  assert.equal(m.clamped, true);
  m.step(Number.NaN);
  assert.equal(m.fault, 'invalid-input');
});

test('delay budget accounts for measured pitch', () => {
  const r = steady(0, 3000);
  const hz = zeroCrossingFrequency(r.pressure, FS, { skip: 1 }).hz;
  const budget = delayBudget(r.model, hz);
  // The uncompensated geometric round trip would put the pitch at
  // c/(4L); the budget's job is to show how the loop period is composed.
  assert.ok(budget.geometricSamples > 0);
  assert.ok(Math.abs(budget.geometricSamples - r.model.nominalDelay) < 1e-6);
  assert.ok(r.model.phaseTrim > 0 && r.model.phaseTrim < 10);
  assert.ok(Math.abs(r.model.delayTarget -
    (r.model.nominalDelay - r.model.phaseTrim - r.model.reflectionPhaseDelaySamples())) < 1e-9);
});

test('renderTrajectory and the realtime class agree sample for sample', async () => {
  const { renderTrajectory } = await import('../src/core/reed-bore.js');
  const cfg = DEFAULT_CONFIG;
  const mouth = (t) => (t < 0.35 ? 2600 : 0);
  const a = renderTrajectory(cfg, FS, 0.5, mouth);
  const m2 = new ReedBore({ fs: FS, oversampling: cfg.oversampling });
  m2.setFingeringImmediate(0);
  // renderTrajectory stores the audio as Float32Array; the realtime path
  // also writes Float32 output buffers. Compare in that same precision.
  let maxDiff = 0;
  for (let i = 0; i < a.samples.length; i++) {
    const audio = Math.fround(m2.toAudio(m2.step(mouth(i / FS)).p));
    maxDiff = Math.max(maxDiff, Math.abs(audio - a.samples[i]));
  }
  assert.ok(maxDiff < 1e-7, `offline and realtime differ by ${maxDiff}`);
});
