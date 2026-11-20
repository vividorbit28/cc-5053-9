// Offline measurements for the physical tone-hole engine and the performance
// layer (register hysteresis, parallel-state divergence, close-restore).
// Uses the exact same ToneholeBore / performance code as the browser lab and
// the tests, so the numbers here are reproducible from the shipped core.
//
// Run: node scripts/tonehole-measure.js [outDir]
// Writes:
//   out/tonehole/pitch.json       - 9-fingering pitch vs geometric target
//   out/tonehole/hysteresis.json  - VdP register up/down openness thresholds
//   out/tonehole/parallel.json     - history vs restart divergence vs dip time
//   out/tonehole/close-restore.json - R5 survival metrics
//   out/tonehole/*.wav            - distinguishing fragment and close-restore

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToneholeBore } from '../src/core/tonehole-bore.js';
import { predictedFrequency } from '../src/core/reed-bore.js';
import { fundamental, rms } from '../src/core/analysis.js';
import {
  runDistinguishingFragment, runCloseRestore, summarizeDivergence,
} from '../src/core/performance.js';

const FS = 48000;
const OUT = process.argv[2] ?? new URL('../out/tonehole/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function steady(openCount, mouthPa, seconds = 1.4) {
  const m = new ToneholeBore({ fs: FS, oversampling: 2 });
  m.setFingering(openCount);
  const p = [];
  for (let i = 0; i < FS * seconds; i++) {
    m.step(mouthPa);
    if (i > FS * 0.9) p.push(m.lastState.p);
  }
  const buf = Float64Array.from(p);
  const hz = fundamental(buf, FS).hz;
  const predicted = predictedFrequency(openCount);
  return {
    openCount,
    mouthPa,
    measuredHz: +hz.toFixed(2),
    predictedHz: +predicted.toFixed(2),
    centsError: +(1200 * Math.log2(hz / predicted)).toFixed(2),
    rmsPa: Math.round(rms(buf)),
    register: m.lastState.register,
    fault: m.lastState.fault,
  };
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
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

// 1. Pitch table across all fingerings at a stable pressure.
const pitchTable = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => steady(n, 2500));
writeFileSync(join(OUT, 'pitch.json'), JSON.stringify({
  description: 'ToneholeBore single-active-junction pitch at 2500 Pa, 2x oversampling',
  fs: FS,
  rows: pitchTable,
  maxAbsCents: Math.max(...pitchTable.map((r) => Math.abs(r.centsError))),
}, null, 2));

// 2. Register hysteresis: openness up/down switch thresholds at fixed pressure.
function registerSwitch(mouthPa, direction) {
  const m = new ToneholeBore({ fs: FS, oversampling: 2 });
  m.setFingering(8);
  for (let i = 0; i < 8; i++) m.openTarget[i] = 0;
  const steps = 41;
  const grid = Array.from({ length: steps }, (_, k) =>
    direction === 'up' ? k / (steps - 1) : 1 - k / (steps - 1));
  let prev = direction === 'up' ? 'low' : 'high';
  let switchAt = null;
  for (const level of grid) {
    m.setHoleOpenness(7, level);
    for (let i = 0; i < FS * 0.35; i++) m.step(mouthPa);
    const reg = m.lastState.register;
    if (reg !== prev && switchAt === null) switchAt = level;
    prev = reg;
  }
  return switchAt;
}
const hysteresis = [1500, 2000, 2500, 3000].map((mouthPa) => {
  const up = registerSwitch(mouthPa, 'up');
  const down = registerSwitch(mouthPa, 'down');
  return {
    mouthPa,
    upSwitchOpenness: up,
    downSwitchOpenness: down,
    hysteresisWidth: up !== null && down !== null ? +(up - down).toFixed(3) : null,
  };
});
writeFileSync(join(OUT, 'hysteresis.json'), JSON.stringify({
  description: 'VdP register switch openness at constant pressure; width = up - down',
  rows: hysteresis,
}, null, 2));

// 3. Parallel-state divergence vs pressure-dip duration (the R6/R7 sweep).
const dipMs = [4, 6, 8, 10, 14, 20, 30, 50, 100, 300];
const parallel = dipMs.map((ms) => {
  const r = runDistinguishingFragment({ fs: FS, dipSeconds: ms / 1000 });
  return {
    dipMs: ms,
    peakDifferencePa: Math.round(r.divergence.peakDifferencePa),
    reconvergeS: r.divergence.reconvergeS,
    settledRmsPa: Math.round(r.divergence.settledRms),
  };
});
writeFileSync(join(OUT, 'parallel.json'), JSON.stringify({
  description: 'history-preserving vs from-scratch restart after a pressure-only dip, same fingering',
  shortestSeparatingDipMs: parallel.find((r) => r.peakDifferencePa > 50)?.dipMs ?? null,
  rows: parallel,
}, null, 2));

// 4. R5 close-restore survival across close durations.
const closeRows = [20, 40, 80, 150, 300].map((ms) => {
  const r = runCloseRestore({ fs: FS, closeMs: ms });
  return {
    closeMs: ms,
    vibrationSurvived: r.vibrationSurvived,
    minRmsDuringClosePa: Math.round(r.minRmsDuringClose),
    rmsBeforePa: Math.round(r.rmsBefore),
    rmsAfterPa: Math.round(r.rmsAfter),
  };
});
writeFileSync(join(OUT, 'close-restore.json'), JSON.stringify({
  description: 'brief hole close then restore with no engine reset; vibration must survive',
  rows: closeRows,
}, null, 2));

// 5. WAVs for the shortest distinguishing fragment and one close-restore.
{
  const frag = runDistinguishingFragment({ fs: FS, dipSeconds: 0.01 });
  // Normalise each trace to -1 dBFS for listening; keep them separate.
  const norm = (arr) => {
    let pk = 0;
    for (const v of arr) pk = Math.max(pk, Math.abs(v));
    const g = pk > 0 ? 0.89 / pk : 1;
    return Float64Array.from(arr, (v) => v * g);
  };
  wav(norm(frag.history), join(OUT, 'fragment-history.wav'));
  wav(norm(frag.restart), join(OUT, 'fragment-restart.wav'));
  const cr = runCloseRestore({ fs: FS, closeMs: 80 });
  wav(norm(cr.pressure), join(OUT, 'close-restore.wav'));
}

console.log(JSON.stringify({
  out: OUT,
  pitch: pitchTable.map((r) => ({ open: r.openCount, cents: r.centsError, fault: r.fault })),
  maxAbsCents: Math.max(...pitchTable.map((r) => Math.abs(r.centsError))),
  hysteresis,
  shortestSeparatingDipMs: parallel.find((r) => r.peakDifferencePa > 50)?.dipMs ?? null,
  closeRestoreAllSurvived: closeRows.every((r) => r.vibrationSurvived),
}, null, 2));
