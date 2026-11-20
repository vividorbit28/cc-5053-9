import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PerformanceRecorder, ParallelStates,
  runDistinguishingFragment, runCloseRestore, summarizeDivergence,
} from '../src/core/performance.js';
import { rms } from '../src/core/analysis.js';

const FS = 48000;

test('recorder captures pressure, fingering and measured frequency', () => {
  const rec = new PerformanceRecorder({ fs: FS });
  const frameRate = rec.frameRate;
  const trajectory = [];
  const seconds = 1.0;
  for (let i = 0; i < seconds * frameRate; i++) {
    trajectory.push({ mouthPa: 2500, openCount: i < seconds * frameRate / 2 ? 2 : 4 });
  }
  const frames = rec.record(trajectory);
  assert.equal(frames.length, trajectory.length);
  assert.equal(frames[0].mouthPa, 2500);
  assert.equal(frames[0].openCount, 2);
  // Later frames (after the loop builds) must carry a measured fundamental.
  const late = frames.slice(Math.floor(frames.length * 0.8));
  assert.ok(late.some((f) => f.frequencyHz !== null && f.frequencyHz > 100),
    'no measured frequency in sustained frames');
});

test('reverse replay keeps pressure order but reverses fingering order', () => {
  const rec = new PerformanceRecorder({ fs: FS });
  const frameRate = rec.frameRate;
  const trajectory = [];
  // Three distinct fingering blocks so reversal is detectable.
  const block = 0.3 * frameRate;
  for (let i = 0; i < block * 3; i++) {
    const openCount = i < block ? 0 : i < block * 2 ? 4 : 8;
    trajectory.push({ mouthPa: 2500, openCount });
  }
  rec.record(trajectory);
  const forward = rec.replay({ reverseFingering: false });
  const reversed = rec.replay({ reverseFingering: true });
  const fwdFingers = [...new Set(forward.frames.map((f) => f.openCount))];
  const revFingers = [...new Set(reversed.frames.map((f) => f.openCount))];
  assert.deepEqual(fwdFingers, [0, 4, 8]);
  assert.deepEqual(revFingers, [8, 4, 0]);
  // Pressure column is unchanged by reversing fingering.
  assert.deepEqual(forward.frames.map((f) => f.mouthPa),
    reversed.frames.map((f) => f.mouthPa));
});

test('parallel states are identical without a restart event', () => {
  const ps = new ParallelStates({ fs: FS });
  const n = FS * 0.5;
  const { history, restart, divergence } = ps.run(n, () => ({ mouthPa: 2500, openCount: 2 }));
  assert.equal(divergence.peakDifferencePa, 0);
  assert.deepEqual(Array.from(history), Array.from(restart));
});

test('a short pressure dip separates history from restart states', () => {
  // R6/R7: a 10 ms dip is shorter than the bore decay, so the history engine
  // retains residual energy while the restart baseline is emptied.
  const result = runDistinguishingFragment({ fs: FS, dipSeconds: 0.01 });
  assert.ok(result.divergence.peakDifferencePa > 50,
    `states did not separate: peak diff ${result.divergence.peakDifferencePa}`);
  // Both must still be healthy, finite oscillations at comparable levels.
  assert.ok(Number.isFinite(result.history[result.history.length - 1]));
  assert.ok(Number.isFinite(result.restart[result.restart.length - 1]));
  const hSettled = rms(result.history.subarray(result.history.length - 4800));
  const rSettled = rms(result.restart.subarray(result.restart.length - 4800));
  assert.ok(hSettled > 500 && rSettled > 500, 'one state failed to sustain');
  assert.ok(Math.abs(hSettled - rSettled) / hSettled < 0.05,
    'steady-state levels should reconverge');
});

test('a long dip lets both states decay and they no longer separate', () => {
  // Control: with a 300 ms dip both bores empty, so the distinction vanishes.
  const result = runDistinguishingFragment({ fs: FS, dipSeconds: 0.3 });
  assert.ok(result.divergence.peakDifferencePa < 5,
    `unexpected separation after long dip: ${result.divergence.peakDifferencePa}`);
});

test('close-restore preserves the existing vibration without a reset', () => {
  // R5: brief close then restore must keep sounding (never near-silent).
  const r = runCloseRestore({ fs: FS, closeMs: 80 });
  assert.equal(r.vibrationSurvived, true);
  assert.ok(r.minRmsDuringClose > 200, `vibration died: min rms ${r.minRmsDuringClose}`);
  assert.ok(r.rmsAfter > 1000, 'note did not return after restore');
});

test('summarizeDivergence reports finite metrics on equal traces', () => {
  const a = new Float64Array(FS * 0.2).fill(123);
  const b = new Float64Array(FS * 0.2).fill(123);
  const d = summarizeDivergence(a, b, FS);
  assert.equal(d.peakDifferencePa, 0);
});
