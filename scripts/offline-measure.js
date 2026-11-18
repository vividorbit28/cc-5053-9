// Offline measurement harness. Runs the same ReedBore core used by the
// AudioWorklet, writes metrics as JSON and renders WAV files for listening.
//
// Run: node scripts/offline-measure.js [outDir]
// It writes:
//   out/measurements.json
//   out/ramp.wav, out/step.wav, out/critical-*.wav, out/fingerings.wav
//   out/traces.json  (decimated internal state for the whole set)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ReedBore, DEFAULT_CONFIG, predictedFrequency, predictedFrequencyForMask,
  effectiveLength, holePositions, FINGERING_STEPS,
} from '../src/core/reed-bore.js';
import {
  fundamental, zeroCrossingFrequency, rms, peak, timeToFraction,
  decayFit, delayBudget, spectrum, envelope,
} from '../src/core/analysis.js';

const FS = 48000;
const OUT = process.argv[2] ?? new URL('../out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function render(mouthAt, seconds, options = {}) {
  const model = new ReedBore({ fs: FS, config: DEFAULT_CONFIG, oversampling: options.oversampling ?? 2 });
  model.setFingeringImmediate(options.openCount ?? 0);
  if (options.interpolation) model.setInterpolation(options.interpolation);
  const n = Math.round(seconds * FS);
  const samples = new Float32Array(n);
  const pressure = new Float32Array(n);
  const mouthApplied = new Float32Array(n);
  const stateAt = {};
  const trace = [];
  const every = Math.round(FS / 200);
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    const st = model.step(mouthAt(t));
    const audio = model.toAudio(st.p);
    samples[i] = audio;
    pressure[i] = st.p;
    mouthApplied[i] = st.mouth;
    if (options.captureAt) {
      for (const mark of options.captureAt) {
        if (stateAt[mark] === undefined && t >= mark) {
          stateAt[mark] = { t, p: st.p, flow: st.flow, gap: st.gap, pPlus: st.pPlus, pMinus: st.pMinus };
        }
      }
    }
    if (i % every === 0) {
      trace.push({ t: +t.toFixed(4), mouth: +st.mouth.toFixed(1), p: +st.p.toFixed(2),
        flow: +st.flow.toExponential(3), gap: +(st.gap * 1e6).toFixed(2),
        gapTarget: +(st.gapTarget * 1e6).toFixed(2), audio: +audio.toFixed(5) });
    }
  }
  return { model, samples, pressure, mouth: mouthApplied, trace, stateAt };
}

function wav(samples, path, sampleRate = FS) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

function measureSteady(mouthPa, openCount = 0, options = {}) {
  const r = render(() => mouthPa, 1.4, { openCount, ...options });
  const seg = r.samples.slice(Math.round(0.3 * FS), Math.round(1.2 * FS));
  const arr = Float64Array.from(seg);
  const zc = zeroCrossingFrequency(arr, FS, { skip: 1 });
  const f = fundamental(arr, FS, { minHz: 60, maxHz: 2500 });
  const pseg = r.pressure.slice(Math.round(0.3 * FS), Math.round(1.2 * FS));
  return {
    mouthPa,
    openCount,
    measuredHz: zc.hz,
    fftHz: f.hz,
    peakAudio: peak(seg),
    peakBorePa: peak(pseg),
    rmsAudio: rms(seg),
    model: r.model,
  };
}

const results = { config: DEFAULT_CONFIG, fs: FS, generatedAt: new Date().toISOString() };

// 1. Pitch: geometry vs measurement across fingerings ------------------
results.pitchTable = [];
for (const step of FINGERING_STEPS) {
  const m = measureSteady(3000, step.openCount, { oversampling: 2 });
  const predicted = predictedFrequency(step.openCount);
  const cents = m.measuredHz > 0 ? 1200 * Math.log2(m.measuredHz / predicted) : null;
  results.pitchTable.push({
    openCount: step.openCount,
    name: step.name,
    acousticLengthM: effectiveLength(step.openCount),
    predictedHz: predicted,
    measuredHz: m.measuredHz,
    fftHz: m.fftHz,
    centsError: cents,
    peakBorePa: m.peakBorePa,
    peakAudio: m.peakAudio,
  });
}

// 2. Numerical sensitivity: oversampling and interpolation --------------
results.numerics = [];
for (const os of [1, 2, 4]) {
  for (const interp of ['linear', 'cubic']) {
    const m = measureSteady(3000, 0, { oversampling: os, interpolation: interp });
    results.numerics.push({
      oversampling: os, interpolation: interp, measuredHz: m.measuredHz,
      centsVsGeometric: 1200 * Math.log2(m.measuredHz / predictedFrequency(0)),
    });
  }
}

// 3. Slow ramp, step, and critical region -------------------------------
const rampRender = render((t) => (t < 2.0 ? 3000 * Math.min(1, t / 1.2) : 0), 3.0);
wav(rampRender.samples, join(OUT, 'ramp.wav'));

function windowedPitch(r, fromS, toS) {
  const a = Math.round(fromS * FS), b = Math.round(toS * FS);
  const seg = r.pressure.slice(a, b);
  const mean = seg.reduce((s, v) => s + v, 0) / seg.length;
  const arr = Float64Array.from(seg, (v) => v - mean);
  const z = zeroCrossingFrequency(arr, FS, { skip: 1 });
  return { hz: z.hz, rms: rms(arr), peak: peak(arr) };
}

results.ramp = {
  description: 'mouth pressure rises linearly to 3 kPa over 1.2 s, holds to 2 s, then releases',
  windows: [0.1, 0.3, 0.5, 0.7, 0.9, 1.1, 1.4, 1.8, 2.05, 2.2, 2.5].map((t0) => ({
    tStart: t0, ...windowedPitch(rampRender, t0, t0 + 0.15),
  })),
  onsetThreshold: (() => {
    // A single sample is not an onset: require the envelope to stay above
    // the floor for 20 ms. The raw first-sample crossing is also kept so
    // the difference between a transient click and sustained oscillation
    // is visible.
    // Classify per 10 ms window: a window is tonal if its mean-removed
    // pressure has zero crossings (a sustained oscillation); broadband
    // transient energy has no stable crossing rate. This separates the
    // small start-up transient from the oscillation onset.
    const win = Math.round(0.01 * FS);
    const env = envelope(rampRender.samples, FS, { attackMs: 2, releaseMs: 20 });
    const need = 3;
    let run = 0;
    let firstRaw = null;
    for (let i = 0; i < env.length; i++) {
      if (firstRaw === null && Math.abs(rampRender.samples[i]) > 0.002) firstRaw = i;
      if (i % win === 0 && i + win <= rampRender.samples.length) {
        const seg = rampRender.pressure.subarray(i, i + win);
        const mean = seg.reduce((s, v) => s + v, 0) / seg.length;
        const crossings = zeroCrossingFrequency(Float64Array.from(seg, (v) => v - mean), FS, { skip: 1 }).crossings;
        const level = rms(seg);
        // Tonal means sustained zero crossings at a musical rate and a
        // pressure swing well above the small start-up transient.
        const tonal = crossings >= 2 && crossings <= 20 && level > 40;
        if (tonal) {
          run++;
          if (run >= need) {
            const onsetIndex = i - (need - 1) * win;
            return {
              timeS: onsetIndex / FS,
              mouthPa: rampRender.mouth[Math.max(0, onsetIndex)],
              windowLevelPa: level,
              transientFirstSampleS: firstRaw === null ? null : firstRaw / FS,
            };
          }
        } else {
          run = 0;
        }
      }
    }
    return { timeS: null, mouthPa: null, transientFirstSampleS: firstRaw === null ? null : firstRaw / FS };
  })(),
};

const stepRender = render((t) => (t >= 0.25 && t < 1.75 ? 3000 : 0), 2.6);
wav(stepRender.samples, join(OUT, 'step.wav'));
const stepPeakEnv = peak(stepRender.samples, Math.round(0.25 * FS), Math.round(1.7 * FS));
const tailEnv = envelope(stepRender.samples, FS, { attackMs: 1, releaseMs: 10 });
const envAt = (t) => tailEnv[Math.min(tailEnv.length - 1, Math.round(t * FS))];
results.step = {
  description: 'mouth pressure steps from 0 to 3 kPa at 0.25 s and back to 0 at 1.75 s',
  attack50ms: timeToFraction(stepRender.samples, FS, 0.5, { startS: 0.25 }),
  // The step itself contains broadband energy from the pressure jump, so a
  // 50 % crossing can occur almost immediately. The loop then *builds*
  // from ~35 % to its final level; those times say how long the feedback
  // growth takes, separately from the jump's own click.
  attackTo90OfPeakS: (() => {
    for (let i = Math.round(0.25 * FS); i < tailEnv.length; i++) {
      if (tailEnv[i] >= 0.9 * stepPeakEnv) return (i / FS) - 0.25;
    }
    return null;
  })(),
  attackFrom10To90S: (() => {
    let t10 = null;
    for (let i = Math.round(0.25 * FS); i < tailEnv.length; i++) {
      if (t10 === null && tailEnv[i] >= 0.1 * stepPeakEnv) t10 = i;
      if (t10 !== null && tailEnv[i] >= 0.9 * stepPeakEnv) return (i - t10) / FS;
    }
    return null;
  })(),
  steadyEnv: envAt(1.6),
  sampleValues: [-0.001, 0, 0.002, 0.005, 0.01, 0.02]
    .map((dt) => ({ dtS: dt, env: envAt(0.25 + dt) })),
  startAmplitude: (() => { const i = Math.round(0.25 * FS); return rms(stepRender.samples, i, i + Math.round(0.01 * FS)); })(),
  steadyAmplitude: rms(stepRender.samples, Math.round(1.0 * FS), Math.round(1.6 * FS)),
  release: decayFit(stepRender.samples, FS, 1.75),
  finalState: stepRender.model.lastState,
};

// Ramp-speed dependence of the audible onset: the loop grows from the
// numerical noise floor, so a slower ramp needs more e-folds and therefore
// overshoots the static threshold further before the tone is detectable.
function rampOnset(rampSeconds, peakPa = 3000) {
  const r = render((t) => (t < rampSeconds ? peakPa * (t / rampSeconds) : peakPa), rampSeconds + 0.15);
  const win = Math.round(0.01 * FS);
  let run = 0;
  const need = 3;
  for (let i = 0; i + win <= r.pressure.length; i += win) {
    const seg = r.pressure.subarray(i, i + win);
    const mean = seg.reduce((s, v) => s + v, 0) / seg.length;
    const z = zeroCrossingFrequency(Float64Array.from(seg, (v) => v - mean), FS, { skip: 1 });
    const tonal = z.crossings >= 2 && z.crossings <= 20 && rms(seg) > 40;
    run = tonal ? run + 1 : 0;
    if (run >= need) {
      return {
        rampSeconds,
        onsetS: i / FS,
        onsetPa: r.mouth[Math.max(0, i - (need - 1) * win)],
      };
    }
  }
  return { rampSeconds, onsetS: null, onsetPa: null };
}

results.rampSpeed = {
  description: 'audible (sustained, tonal) onset pressure vs ramp speed at 48 kHz',
  points: [0.15, 0.3, 0.6, 1.2].map((sec) => rampOnset(sec)),
};

// Critical region: sweep pressure in fine steps and record whether the
// loop oscillates, and if so at what pitch/amplitude.
const critical = [];
for (let p = 600; p <= 1500; p += 50) {
  const r = render(() => p, 1.7);
  const seg = r.samples.slice(Math.round(0.7 * FS));
  const level = rms(seg);
  const zc = zeroCrossingFrequency(Float64Array.from(r.pressure.slice(Math.round(0.7 * FS))), FS, { skip: 1 });
  critical.push({ mouthPa: p, rmsAudio: level, measuredHz: zc.hz });
  if ([900, 1000, 1100, 1200].includes(p)) wav(r.samples, join(OUT, `critical-${p}.wav`));
}
results.criticalRegion = {
  description: 'fine pressure sweep through the oscillation threshold; RMS over the last second',
  points: critical,
  firstSustained: critical.find((c) => c.rmsAudio > 0.002) ?? null,
  firstAudibleHz: critical.find((c) => c.rmsAudio > 0.002 && c.measuredHz > 100) ?? null,
};

// 4. Fingerings: one held note per fingering, and a legato run ----------
const fingerSamples = [];
for (const step of FINGERING_STEPS) {
  const r = render((t) => (t < 0.45 ? 3200 * Math.min(1, t / 0.03) : 0), 0.5,
    { openCount: step.openCount });
  fingerSamples.push(r.samples);
}
const fingerAll = new Float32Array(fingerSamples.length * FS / 2);
for (let i = 0; i < fingerSamples.length; i++) {
  fingerAll.set(fingerSamples[i].subarray(0, FS / 2), i * FS / 2);
}
wav(fingerAll, join(OUT, 'fingerings.wav'));
results.fingeringsFile = 'fingerings.wav (nine 0.5 s notes, one per open-hole count)';

// 4b. A legato phrase: continuous blowing, stepwise fingering changes.
// This is the same sequence the UI's "Play scripted phrase" sends as
// messages; here it drives the core directly so it is reproducible offline.
{
  const phrase = [
    { t: 0.00, mouth: 0, fingering: 0 },
    { t: 0.05, mouth: 1200, fingering: 0 },
    { t: 0.55, mouth: 1200, fingering: 2 },
    { t: 0.90, mouth: 1600, fingering: 4 },
    { t: 1.25, mouth: 2800, fingering: 4 },
    { t: 1.65, mouth: 2800, fingering: 6 },
    { t: 2.05, mouth: 2800, fingering: 8 },
    { t: 2.50, mouth: 900, fingering: 8 },
    { t: 2.95, mouth: 0, fingering: 8 },
    { t: 3.45, mouth: 0, fingering: 0 },
  ];
  const model = new ReedBore({ fs: FS, config: DEFAULT_CONFIG, oversampling: 2 });
  model.setFingeringImmediate(0);
  const seconds = 4.2;
  const n = Math.round(seconds * FS);
  const buf = new Float32Array(n);
  const trace = [];
  const attack = 1 - Math.exp(-1 / (FS * 0.004)); // same 4 ms de-zipper as the worklet
  let mouth = 0;
  let cur = phrase[0];
  let fingerAt = [];
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    for (const step of phrase) if (t >= step.t) cur = step;
    mouth += (cur.mouth - mouth) * attack;
    if (model.openCount !== cur.fingering) {
      model.setFingering(cur.fingering);
      fingerAt.push({ t: +t.toFixed(3), openCount: cur.fingering });
    }
    const st = model.step(mouth);
    buf[i] = model.toAudio(st.p);
    if (i % 4800 === 0) {
      trace.push({ t: +t.toFixed(2), mouth: +mouth.toFixed(0), openCount: st.openCount,
        p: +st.p.toFixed(1), delaySamples: +st.delaySamples.toFixed(2) });
    }
  }
  let pk = 0;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(buf[i]));
  const gain = pk > 0 ? 0.89 / pk : 1;
  for (let i = 0; i < n; i++) buf[i] *= gain;
  wav(buf, join(OUT, 'demo-phrase.wav'));
  results.demoPhrase = {
    description: 'legato phrase: continuous breath with stepwise fingering 0→2→4→6→8, ' +
      'one dip near threshold, then release. Raw core output scaled to -1 dBFS for playback.',
    rawPeakBeforeNormalization: pk,
    normalizationGain: gain,
    fingeringChanges: fingerAt,
    trace,
    fault: model.fault,
  };
}

// 5. Tail: release and check that internal state decays -----------------
const tailRender = render((t) => (t < 1.0 ? 3000 : 0), 3.0, { captureAt: [1.02, 1.1, 1.5, 2.0, 2.9] });
results.tail = {
  description: '3 kPa for 1.0 s, then mouth pressure 0; observe bore pressure and audio',
  decayTauAudio: decayFit(tailRender.samples, FS, 1.0),
  stateSnapshots: tailRender.stateAt,
  finalState: tailRender.model.lastState,
  pressureTail: [1.0, 1.005, 1.01, 1.02, 1.05, 1.1, 1.2, 1.5, 2.0].map((t0) => ({
    t: t0,
    rmsPa: rms(tailRender.pressure, Math.round(t0 * FS), Math.round((t0 + 0.005) * FS)),
  })),
  residualRmsAt2s: rms(tailRender.samples, Math.round(2.8 * FS)),
  residualPressureAt2s: Math.abs(tailRender.pressure[tailRender.pressure.length - 1]),
};

// 5b. Pitch vs blowing pressure (model behaviour, reported not corrected).
results.pressurePitch = [1200, 1800, 2400, 3000, 3600, 4200, 4800].map((p) => {
  const m = measureSteady(p, 0, { oversampling: 2 });
  return {
    mouthPa: p,
    measuredHz: m.measuredHz,
    centsVsGeometric: 1200 * Math.log2(m.measuredHz / predictedFrequency(0)),
    peakBorePa: m.peakBorePa,
  };
});

// 6. Delay budget at the measured pitch --------------------------------
const ref = results.pitchTable[0];
const refModel = measureSteady(3000, 0).model;
results.delayBudget = {
  measuredHz: ref.measuredHz,
  budget: delayBudget(refModel, ref.measuredHz),
  phaseTrimSamples: refModel.phaseTrim,
  lowpassPhaseSamples: refModel.reflectionPhaseDelaySamples(),
  tubeDelaySamples: refModel.delayTarget,
  nominalRoundTripSamples: refModel.nominalDelay,
};

// 7. Trace dump for the docs / UI reproduction -------------------------
const traceRender = render((t) => {
  if (t < 0.6) return 3000 * Math.min(1, t / 0.5);      // slow rise
  if (t < 1.1) return 3000;                              // steady
  if (t < 1.35) return 950;                              // near threshold
  if (t < 1.6) return 0;                                 // release
  return 0;
}, 1.9);
results.deliveryTrajectory = {
  description: 'ramp 0->3 kPa, hold, drop to 950 Pa (near threshold), release to 0',
  trace: traceRender.trace,
};
writeFileSync(join(OUT, 'traces.json'), JSON.stringify({
  trajectory: traceRender.trace,
  fingers: results.pitchTable,
}, null, 2));

writeFileSync(join(OUT, 'measurements.json'), JSON.stringify(results, (k, v) => (
  typeof v === 'number' && !Number.isFinite(v) ? null : v
), 2));

// Human-readable summary next to the JSON.
const md = [];
md.push('# Measurement output\n');
md.push('Generated by `npm run offline` with `src/core/reed-bore.js`. The JSON is the source of truth.\n');
md.push(`- sample rate ${FS} Hz, oversampling 2×`);
md.push(`- c = ${DEFAULT_CONFIG.speedOfSound} m/s, bore radius ${(DEFAULT_CONFIG.boreRadius * 1000).toFixed(1)} mm`);
md.push(`- closed length ${(DEFAULT_CONFIG.boreLengthClosed * 1000).toFixed(0)} mm, ${DEFAULT_CONFIG.holeCount} tone holes\n`);
md.push('## Pitch vs acoustic length (3 kPa hold)\n');
md.push('| open holes | acoustic length | c/(4L) | measured | FFT peak | error | peak bore p |');
md.push('|---:|---:|---:|---:|---:|---:|---:|');
for (const p of results.pitchTable) {
  md.push(`| ${p.openCount} | ${(p.acousticLengthM * 1000).toFixed(1)} mm | ${p.predictedHz.toFixed(1)} Hz | ` +
    `${p.measuredHz.toFixed(1)} Hz | ${p.fftHz.toFixed(1)} Hz | ${p.centsError.toFixed(2)} ct | ${p.peakBorePa.toFixed(0)} Pa |`);
}
const spread = Math.max(...results.numerics.map((n) => n.centsVsGeometric)) -
  Math.min(...results.numerics.map((n) => n.centsVsGeometric));
md.push('\n## Numerical spread\n');
md.push('| oversampling | interpolation | pitch | cents vs geometric |');
md.push('|---:|---|---:|---:|');
for (const n of results.numerics) {
  md.push(`| ${n.oversampling}× | ${n.interpolation} | ${n.measuredHz.toFixed(2)} Hz | ${n.centsVsGeometric.toFixed(2)} |`);
}
md.push(`\nSpread over the six configurations: **${spread.toFixed(2)} cents**.\n`);
md.push('## Threshold\n');
md.push(`- static threshold (1.5 s hold): **${results.criticalRegion.firstSustained?.mouthPa ?? '—'} Pa**, ` +
  `pitch ${results.criticalRegion.firstSustained?.measuredHz.toFixed(1) ?? '—'} Hz`);
md.push('- audible onset vs ramp speed:');
for (const p of results.rampSpeed.points) {
  md.push(`  - ${p.rampSeconds.toFixed(2)} s ramp → ${p.onsetPa ?? '—'} Pa`);
}
md.push('\n| mouth pressure | RMS | measured Hz |');
md.push('|---:|---:|---:|');
for (const c of results.criticalRegion.points) {
  md.push(`| ${c.mouthPa} Pa | ${c.rmsAudio.toFixed(3)} | ${c.measuredHz.toFixed(1)} |`);
}
md.push('\n## Envelope after a 3 kPa step\n');
md.push(`- 50 % of final envelope: ${((results.step.attack50ms - 0.25) * 1000).toFixed(1)} ms after the step`);
md.push(`- 10 %→90 %: ${(results.step.attackFrom10To90S * 1000).toFixed(1)} ms (loop build-up)`);
md.push(`- release: τ = ${(results.step.release.tau * 1000).toFixed(1)} ms, r² = ${results.step.release.r2.toFixed(6)}\n`);
md.push('## Tail after release\n');
md.push('| t (s) | RMS bore pressure |');
md.push('|---:|---:|');
for (const p of results.tail.pressureTail) {
  md.push(`| ${p.t.toFixed(3)} | ${p.rmsPa.toExponential(3)} Pa |`);
}
md.push(`\nFinal: p = ${results.tail.finalState.p.toExponential(2)} Pa, flow = ${results.tail.finalState.flow}, ` +
  `gap = ${(results.tail.finalState.gap * 1e6).toFixed(1)} µm, fault = ${results.tail.finalState.fault}.\n`);
md.push('## Pitch vs blowing pressure\n');
md.push('| mouth pressure | cents vs geometric |');
md.push('|---:|---:|');
for (const p of results.pressurePitch) {
  md.push(`| ${p.mouthPa} Pa | ${p.centsVsGeometric.toFixed(1)} |`);
}
md.push('\n## Delay budget (all closed)\n');
const db = results.delayBudget;
md.push(`- geometric round trip: ${db.nominalRoundTripSamples.toFixed(3)} internal samples ` +
  `(${(db.budget.geometricSeconds * 1e3).toFixed(3)} ms)`);
md.push(`- reed-end phase trim: ${db.phaseTrimSamples.toFixed(3)} samples`);
md.push(`- reflection lowpass phase: ${db.lowpassPhaseSamples.toFixed(3)} samples`);
md.push(`- actual tube delay: ${db.tubeDelaySamples.toFixed(3)} samples`);
md.push(`- measured ${db.measuredHz.toFixed(2)} Hz vs geometric ${results.pitchTable[0].predictedHz.toFixed(2)} Hz\n`);
md.push('## Reproduction\n\n```bash\nnpm test          # 12 core tests\nnpm run offline   # this file + WAVs\n```');
writeFileSync(join(OUT, 'measurements.md'), md.join('\n') + '\n');

console.log(JSON.stringify({
  out: OUT,
  pitchCents: results.pitchTable.map((r) => ({ open: r.openCount, cents: r.centsError?.toFixed(2) })),
  numerics: results.numerics.map((r) => ({ os: r.oversampling, interp: r.interpolation, cents: r.centsVsGeometric.toFixed(2) })),
  onsetThreshold: results.ramp.onsetThreshold,
  firstSustained: results.criticalRegion.firstSustained,
  rampSpeed: results.rampSpeed.points,
  pressurePitch: results.pressurePitch.map((p) => ({ mouthPa: p.mouthPa, cents: +p.centsVsGeometric.toFixed(1) })),
  attack50ms: results.step.attack50ms,
  attack10to90ms: results.step.attackFrom10To90S,
  attackTo90ms: results.step.attackTo90OfPeakS,
  releaseTau: results.step.release.tau,
  tailResidual: results.tail.residualPressureAt2s,
  delayBudget: results.delayBudget,
}, null, 2));
