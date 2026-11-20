// Performance layer for the physical tone-hole engine.
//
// This module does not add any new acoustics: the sound is always
// ToneholeBore.step(). It provides the performance machinery requested around
// that engine:
//
//   PerformanceRecorder - samples a control trajectory (breath pressure and
//     fingering) together with the model's *measured* audio frequency, and
//     can replay it with the fingering order reversed (R4).
//
//   ParallelStates - runs two ToneholeBore engines on the identical input,
//     differing only in whether the wave already in the bore is kept when a
//     fingering or breath event happens. "history" never clears its delay
//     lines; "restart" clears them at a marked event and regrows from the
//     seed. They are bit-identical in steady state and separate only in the
//     recovery transient (R3, R6).
//
//   built-in fragments - the shortest pressure/fingering trajectories that
//     make the two parallel states measurably diverge, and the brief
//     close-then-restore acceptance trajectory (R5, R7).
//
// Fingering changes never reset the engine. ToneholeBore retimes its delay
// lines in place (setDelay moves only the read head, never the buffer) and
// glides the hole admittance, so the waveform already travelling in the bore
// is retained and re-scattered at the new junction. That is how a real
// instrument carries energy through a fingering change, and it is what the
// "history" state demonstrates against the artificial "restart" baseline.

import { ToneholeBore } from './tonehole-bore.js';
import { fundamental, rms } from './analysis.js';

// Frames per second at which the recorder stores control state and measures
// frequency. Audio is generated at the engine sample rate between frames.
const DEFAULT_FRAME_RATE = 200;

// One recorded frame: the controls at this instant and, once measured on
// replay/record, the actual fundamental the bore produced.
export function makeFrame(timeS, mouthPa, openCount, frequencyHz = null) {
  return { timeS, mouthPa, openCount, frequencyHz };
}

// Drives a ToneholeBore from a list of control frames (piecewise-constant
// pressure and fingering), returning per-sample pressure and per-frame
// measured frequencies. Shared by record and replay paths so both exercise
// the exact same engine code.
function driveFrames(engine, frames, fs, onEvent) {
  if (frames.length === 0) {
    return { pressure: new Float64Array(0), frequencies: [] };
  }
  const totalSeconds = frames[frames.length - 1].timeS + 1 / DEFAULT_FRAME_RATE;
  const n = Math.max(1, Math.round(totalSeconds * fs));
  const pressure = new Float64Array(n);
  const frequencies = new Array(frames.length).fill(null);
  const frameStride = Math.max(1, Math.round(fs / DEFAULT_FRAME_RATE));
  let frameIndex = 0;
  let lastFingering = -1;
  // Accumulate a window of bore pressure per output frame for pitch tracking.
  const window = [];
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    while (frameIndex < frames.length - 1 && frames[frameIndex + 1].timeS <= t) frameIndex++;
    const frame = frames[frameIndex];
    if (frame.openCount !== lastFingering) {
      engine.setFingering(frame.openCount);
      lastFingering = frame.openCount;
      onEvent?.({ type: 'fingering', timeS: t, openCount: frame.openCount });
    }
    const st = engine.step(frame.mouthPa);
    pressure[i] = st.p;
    window.push(st.p);
    if (window.length >= frameStride) {
      const buf = Float64Array.from(window.splice(0, frameStride));
      const level = rms(buf);
      // Only assign a pitch when the loop is actually sounding; a near-silent
      // frame has no meaningful fundamental.
      frequencies[frameIndex] = level > 50 ? fundamental(buf, fs).hz : null;
    }
  }
  return { pressure, frequencies };
}

export class PerformanceRecorder {
  constructor(options = {}) {
    this.fs = options.fs ?? 48000;
    this.oversampling = options.oversampling ?? 2;
    this.frameRate = options.frameRate ?? DEFAULT_FRAME_RATE;
    this.frames = [];
    this._engine = null;
  }

  // Record a control trajectory given as arrays sampled at frameRate, or an
  // explicit frame list. The measured frequency column is filled by running
  // the engine, so the recording captures what was actually heard (R4).
  record(trajectory) {
    const engine = new ToneholeBore({ fs: this.fs, oversampling: this.oversampling });
    this._engine = engine;
    const frames = trajectory.map((row, i) =>
      makeFrame(i / this.frameRate, row.mouthPa, row.openCount));
    const { frequencies } = driveFrames(engine, frames, this.fs);
    frames.forEach((f, i) => { f.frequencyHz = frequencies[i]; });
    this.frames = frames;
    return frames.map((f) => ({ ...f }));
  }

  // Replay the recording. With reverseFingering the fingering sequence is
  // played back in reverse order while the pressure and timing are kept in
  // the original order, matching "reverse the fingering order and re-play".
  replay({ reverseFingering = false } = {}) {
    const engine = new ToneholeBore({ fs: this.fs, oversampling: this.oversampling });
    let frames = this.frames.map((f) => ({ ...f, frequencyHz: null }));
    if (reverseFingering && frames.length > 1) {
      const fingers = this.frames.map((f) => f.openCount);
      const reversed = fingers.slice().reverse();
      frames = frames.map((f, i) => ({ ...f, openCount: reversed[i] }));
    }
    const { pressure, frequencies } = driveFrames(engine, frames, this.fs);
    frames.forEach((f, i) => { f.frequencyHz = frequencies[i]; });
    return { frames, pressure, audio: this._toAudio(engine, pressure) };
  }

  _toAudio(engine, pressure) {
    const out = new Float64Array(pressure.length);
    for (let i = 0; i < pressure.length; i++) out[i] = engine.toAudio(pressure[i]);
    return out;
  }
}

// Two engines driven identically; the only difference is the handling of the
// in-bore wave at marked restart events.
export class ParallelStates {
  constructor(options = {}) {
    this.fs = options.fs ?? 48000;
    this.oversampling = options.oversampling ?? 2;
    this.history = new ToneholeBore({ fs: this.fs, oversampling: this.oversampling });
    this.restart = new ToneholeBore({ fs: this.fs, oversampling: this.oversampling });
    this._lastFingering = -1;
  }

  reset() {
    this.history.reset();
    this.restart.reset();
    this._lastFingering = -1;
  }

  // One sample of shared input. Pass restartNow=true once at the event where
  // the restart baseline should discard its stored waveform (the history
  // engine is never cleared). Returns both bore pressures.
  step(mouthPa, openCount, restartNow = false) {
    if (openCount !== this._lastFingering) {
      this.history.setFingering(openCount);
      this.restart.setFingering(openCount);
      this._lastFingering = openCount;
    }
    if (restartNow) {
      this.restart.reset();
      this.restart.setFingering(openCount);
    }
    const h = this.history.step(mouthPa).p;
    const r = this.restart.step(mouthPa).p;
    return { history: h, restart: r };
  }

  // Convenience: run a pressure/fingering callback over N samples and return
  // both full pressure traces plus a divergence summary (R6). The callback
  // receives time in seconds and returns { mouthPa, openCount, restartNow }.
  run(sampleCount, control) {
    const h = new Float64Array(sampleCount);
    const r = new Float64Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const c = control(i / this.fs, i);
      const out = this.step(c.mouthPa, c.openCount, Boolean(c.restartNow));
      h[i] = out.history;
      r[i] = out.restart;
    }
    return { history: h, restart: r, divergence: summarizeDivergence(h, r, this.fs) };
  }
}

// How strongly two parallel traces differ: peak pointwise gap and the time
// until they reconverge within 2% of the settled RMS for a sustained 5 ms.
export function summarizeDivergence(history, restart, fs) {
  const n = Math.min(history.length, restart.length);
  const settled = rms(history.subarray(Math.max(0, n - Math.round(0.1 * fs))));
  const tol = 0.02 * settled;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(history[i] - restart[i]));
  const win = Math.round(0.005 * fs);
  let run = 0;
  let reconvergeS = null;
  for (let s = 0; s + win < n; s += win) {
    let d = 0;
    for (let k = 0; k < win; k++) d += Math.abs(history[s + k] - restart[s + k]);
    if (d / win < tol) {
      run += win;
      if (run >= win) { reconvergeS = s / fs; break; }
    } else {
      run = 0;
    }
  }
  return { peakDifferencePa: peak, reconvergeS, settledRms: settled };
}

// --- Built-in fragments (R5, R7) ---------------------------------------

// The shortest pressure-only dip that leaves a measurable residual-energy
// difference between the history and restart states. Same fingering the whole
// time; the breath drops to zero for `dipSeconds` then returns. Empirically a
// ~10 ms dip (shorter than the ~100 ms bore decay) is the distinguishing
// fragment; longer dips let both bores empty and they no longer separate.
export function buildDistinguishingFragment(options = {}) {
  const fs = options.fs ?? 48000;
  const note = options.openCount ?? 2;
  const sustainP = options.sustainPa ?? 1500;
  const dipSeconds = options.dipSeconds ?? 0.01;
  const preSeconds = 0.8;
  const postSeconds = 0.6;
  const total = preSeconds + dipSeconds + postSeconds;
  const n = Math.round(total * fs);
  const dipStartSample = Math.round(preSeconds * fs);
  const dipEndSample = Math.round((preSeconds + dipSeconds) * fs);
  const control = (t) => ({
    mouthPa: (t >= preSeconds && t < preSeconds + dipSeconds) ? 0 : sustainP,
    openCount: note,
  });
  return {
    fs, note, sustainPa: sustainP, dipSeconds, totalSeconds: total, n,
    dipStartSample, dipEndSample,
    control,
    // The restart baseline clears its bore once, at this sample; the history
    // engine is never cleared. control() carries the shared input only.
    restartAtSample: dipStartSample,
  };
}

// Run the built-in distinguishing fragment through both parallel states and
// return the two traces and the measured divergence (R7).
export function runDistinguishingFragment(options = {}) {
  const frag = buildDistinguishingFragment(options);
  const parallel = new ParallelStates({ fs: frag.fs, oversampling: options.oversampling ?? 2 });
  let restarted = false;
  const h = new Float64Array(frag.n);
  const r = new Float64Array(frag.n);
  for (let i = 0; i < frag.n; i++) {
    const c = frag.control(i / frag.fs, i);
    const fire = !restarted && i === frag.restartAtSample;
    const out = parallel.step(c.mouthPa, c.openCount, fire);
    if (fire) restarted = true;
    h[i] = out.history;
    r[i] = out.restart;
  }
  return {
    fragment: frag,
    history: h,
    restart: r,
    divergence: summarizeDivergence(
      h.subarray(frag.dipEndSample), r.subarray(frag.dipEndSample), frag.fs),
  };
}

// R5 acceptance trajectory: hold a note with open holes, briefly close them,
// then restore. The engine is never reset, so the in-bore wave survives.
// Returns the bore trace and survival metrics for each requested duration.
export function runCloseRestore(options = {}) {
  const fs = options.fs ?? 48000;
  const note = options.openCount ?? 4;
  const mouthPa = options.mouthPa ?? 2500;
  const closeMs = options.closeMs ?? 80;
  const preSeconds = 0.8;
  const postSeconds = 0.7;
  const closeSeconds = closeMs / 1000;
  const total = preSeconds + closeSeconds + postSeconds;
  const n = Math.round(total * fs);
  const engine = new ToneholeBore({ fs, oversampling: options.oversampling ?? 2 });
  engine.setFingering(note);
  const out = new Float64Array(n);
  const registers = [];
  let cur = note;
  const closeStartSample = Math.round(preSeconds * fs);
  const closeEndSample = Math.round((preSeconds + closeSeconds) * fs);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const want = (t >= preSeconds && t < preSeconds + closeSeconds) ? 0 : note;
    if (want !== cur) { engine.setFingering(want); cur = want; }
    const st = engine.step(mouthPa);
    out[i] = st.p;
    registers.push(st.register);
  }
  // Minimum RMS across the close interval proves the vibration never stopped.
  const win = Math.max(1, Math.round(0.01 * fs));
  let minRms = Infinity;
  for (let s = closeStartSample; s + win <= closeEndSample; s += win) {
    minRms = Math.min(minRms, rms(out.subarray(s, s + win)));
  }
  const before = rms(out.subarray(Math.max(0, closeStartSample - win * 20), closeStartSample));
  const after = rms(out.subarray(closeEndSample, Math.min(n, closeEndSample + win * 20)));
  return {
    pressure: out,
    registers,
    closeMs,
    minRmsDuringClose: minRms,
    rmsBefore: before,
    rmsAfter: after,
    vibrationSurvived: minRms > 200,
  };
}
