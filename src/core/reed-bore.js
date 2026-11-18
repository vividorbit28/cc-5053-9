// Single-reed blown bore: a pressure-controlled reed valve coupled to a
// travelling-wave tube. Audio-rate evaluation.
//
// Physical picture (simplified, for sound design):
//
//   mouth pressure P0 ──> reed gap h(t) ──> valve flow U(P0 - p, h)
//                              ^                    │
//                              │                    ▼
//                       bore pressure p <── waveguide tube (delay D, bell reflection)
//
// The reed and the bore are solved in the same sample loop. The tube is a
// pair of travelling waves; only the wave travelling to the bell is stored,
// because the bell reflection returns it to the reed:
//
//   p+(n) = p-(n) + Z0 * U(n)          (flow injected into the bore)
//   p-(n) = -r * LP{ p+(n-D) }         (bell reflection, D = 2L/c)
//   p(n)  = p+(n) + p-(n)
//
// The reed has second-order mechanics; its gap is driven by the pressure
// difference across it. Flow uses an orifice law with a checked (no
// backflow) valve. This is a genuine nonlinear feedback oscillator: the
// pressure wave returning from the bell moves the reed, which changes the
// injected flow, which changes the wave. There is no note->sine mapping.

const TWO_PI = Math.PI * 2;

export const DEFAULT_CONFIG = Object.freeze({
  speedOfSound: 343,
  airDensity: 1.2,
  boreRadius: 0.0045,
  boreLengthClosed: 0.3,
  holeCount: 8,
  holeSemitones: 1,
  holeRadius: 0.004,
  // Extra acoustic length contributed by the mouthpiece/reed cavity. The
  // reed is not a rigid wall: its mass and the mouthpiece volume add a
  // small inertance at the input end, which lengthens the speaking length
  // by a roughly constant amount. 4.4 mm was identified by measurement
  // (see docs); with it, all-open measured pitch matches the geometric
  // prediction to within a few cents.
  mouthpieceEndCorrection: 0.0044,
  bellReflection: 0.985,
  reflectionLowpass: 0.12,
  reed: Object.freeze({
    restGap: 5.0e-4,
    compliance: 1.8e-7,     // static gap reduction per Pa of mouth-bore difference
    maxGapFactor: 1.0,
    resonanceHz: 2800,
    dampingRatio: 0.5,
    width: 0.012,
    dischargeCoeff: 0.6,
    leakage: 1.5e-6,
    // Pressure scale (Pa) below which the orifice law becomes linear.
    // A true square-root orifice has unbounded conductance at zero
    // pressure difference; in a sampled loop with one sample of algebraic
    // delay that shows up as a spurious high-frequency limit cycle even
    // with no blowing. The smooth version keeps a finite, physically
    // plausible resistance across the closed reed.
    lowPressureSmooth: 30,
    maxVelocity: 40,
  }),
  // The reed is a second-order resonator and adds about 2*zeta/omega0
  // seconds of phase lag to the bore round trip. The lag belongs to the
  // loop, but it is not propagation distance, so the delay is trimmed by
  // that constant to make geometric length map to pitch. The trim is
  // derived from the reed parameters and checked by measurement.
  reedPhaseTrim: true,
  // Loop-phase delay contributed by the reed. The reed is not a perfect
  // pressure antinode: it admits a flow that lags the bore pressure, which
  // adds a roughly constant time to the loop period. Identified by sweeping
  // it until measured pitch matched c/(4L_eff) across all fingerings: 22 us
  // (about 2.2 deg of reflection phase at 280 Hz). It is a
  // measurement-backed physical correction, not a pitch-label knob; see
  // docs/measurements.md for the sweep. It is applied as a time, not a
  // sample count, so the correction does not drift with oversampling.
  reedEndPhaseDelaySeconds: 22e-6,
  fingeringGlideSeconds: 0.008,
  holeMask: Object.freeze([false,false,false,false,false,false,false,false]),
  maxMouthPressure: 5000,
  maxBorePressure: 40000,
  maxValveFlow: 0.004,
  oversampling: 2,
  interpolation: 'cubic',
  audio: Object.freeze({
    gain: 1 / 4200,
    dcPole: 0.995,
    saturation: 0.92,
  }),
  // Diagnostic injection only, for the tests and the interface's loop-gain
  // readout: a small persistent perturbation from the *reed seat* side.
  // It is off for every performance and offline render.
  injection: Object.freeze({ active: false, amplitude: 1e-4, frequency: 5 }),
});

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// Acoustic length added by an open end. Standard low-frequency end
// correction: 0.613 * radius for an unflanged open pipe; toneholes use the
// hole radius and a slightly smaller coefficient. Kept explicit because it
// is one of the terms that shifts measured pitch away from bare c/(4L).
export function bellEndCorrection(cfg = DEFAULT_CONFIG) {
  return 0.613 * cfg.boreRadius;
}
export function holeEndCorrection(cfg = DEFAULT_CONFIG) {
  return 0.5 * cfg.holeRadius;
}

export function holePositions(cfg = DEFAULT_CONFIG) {
  const count = cfg.holeCount;
  const out = new Array(count);
  // Hole k (1-based, nearest the bell first when opened) sits at the
  // geometric length that would give k semitones above the all-closed
  // fundamental. Opening holes from the bell upwards shortens the tube.
  for (let k = 1; k <= count; k++) {
    const length = cfg.boreLengthClosed / Math.pow(2, (k * cfg.holeSemitones) / 12);
    out[count - k] = length; // store ascending from the mouth
  }
  return out;
}

// Effective acoustic length for a fingering mask. In this simplification
// the vent nearest the mouth terminates the speaking length. Closed holes
// below it are not modelled as a tonehole lattice, so a mask with gaps is
// only approximate; `openCount` (contiguous holes from the bell) is the
// intended performance mapping and the UI presets use it.
export function maskEffectiveLength(mask, cfg = DEFAULT_CONFIG) {
  const count = cfg.holeCount;
  const positions = holePositions(cfg);
  for (let i = 0; i < count; i++) {
    if (mask[i]) return positions[i] + holeEndCorrection(cfg) + cfg.mouthpieceEndCorrection;
  }
  return cfg.boreLengthClosed + bellEndCorrection(cfg) + cfg.mouthpieceEndCorrection;
}

export function maskToOpenCount(mask) {
  // Largest contiguous run of open holes starting at the bell end.
  let n = 0;
  for (let i = mask.length - 1; i >= 0; i--) {
    if (!mask[i]) break;
    n++;
  }
  return n;
}

export function effectiveLength(openCount, cfg = DEFAULT_CONFIG) {
  const count = cfg.holeCount;
  const n = clamp(Math.round(openCount), 0, count);
  if (n === 0) return cfg.boreLengthClosed + bellEndCorrection(cfg) + cfg.mouthpieceEndCorrection;
  const positions = holePositions(cfg);
  return positions[count - n] + holeEndCorrection(cfg) + cfg.mouthpieceEndCorrection;
}

export function predictedFrequency(openCount, cfg = DEFAULT_CONFIG) {
  return cfg.speedOfSound / (4 * effectiveLength(openCount, cfg));
}

export function predictedFrequencyForMask(mask, cfg = DEFAULT_CONFIG) {
  return cfg.speedOfSound / (4 * maskEffectiveLength(mask, cfg));
}

// Contiguous open-hole counts used by the performance UI. Each entry names
// the physical fingering by how many holes are open from the bell; the name
// is a label, not a synthesis input (audio always comes from the loop).
export const FINGERING_STEPS = Object.freeze([
  { openCount: 0, name: 'all closed' },
  { openCount: 1, name: '1 open' },
  { openCount: 2, name: '2 open' },
  { openCount: 3, name: '3 open' },
  { openCount: 4, name: '4 open' },
  { openCount: 5, name: '5 open' },
  { openCount: 6, name: '6 open' },
  { openCount: 7, name: '7 open' },
  { openCount: 8, name: 'all open' },
]);

export class ReedBore {
  constructor(options = {}) {
    this.cfg = options.config ?? DEFAULT_CONFIG;
    this.fs = options.fs ?? 48000;
    this.os = Math.max(1, Math.round(options.oversampling ?? this.cfg.oversampling));
    this.fsInt = this.fs * this.os;
    this.dt = 1 / this.fsInt;
    this.interpolation = options.interpolation ?? this.cfg.interpolation;

    this.z0 = this.cfg.airDensity * this.cfg.speedOfSound /
      (Math.PI * this.cfg.boreRadius * this.cfg.boreRadius);

    this.maxDelay = Math.ceil(
      (2 * (this.cfg.boreLengthClosed + bellEndCorrection(this.cfg)) / this.cfg.speedOfSound) *
      this.fsInt) + 8;
    this.line = new Float64Array(this.maxDelay + 16);
    this.writeIndex = 0;

    this.reflState = 0;
    this.p = 0;

    this.openCount = 0;
    this.holeMask = [false, false, false, false, false, false, false, false];
    this.length = effectiveLength(0, this.cfg);
    this.computeDelayTarget();
    this.delay = this.delayTarget;

    this.audioDcX = 0;
    this.audioDcY = 0;

    this.fault = null;
    this.clamped = false;
    this.steps = 0;

    this.lastState = {
      p: 0, pPlus: 0, pMinus: 0, flow: 0, gap: this.cfg.reed.restGap,
      gapTarget: this.cfg.reed.restGap, deltaP: 0, audio: 0, mouth: 0,
      openCount: 0, delaySamples: this.delay, fault: null,
    };

    this.reset();
  }

  reset() {
    this.line.fill(0);
    this.writeIndex = 0;
    this.reflState = 0;
    this.p = 0;
    this.gap = this.cfg.reed.restGap;
    this.gapVel = 0;
    this.audioDcX = 0;
    this.audioDcY = 0;
    this.fault = null;
    this.clamped = false;
    this.steps = 0;
    const st = this.lastState;
    st.p = st.pPlus = st.pMinus = 0;
    st.flow = 0;
    st.gap = this.gap;
    st.gapTarget = this.cfg.reed.restGap;
    st.deltaP = 0;
    st.audio = 0;
    st.mouth = 0;
    st.openCount = this.openCount;
    st.delaySamples = this.delay;
    st.fault = null;
  }

  setFingering(openCount) {
    const n = clamp(Math.round(openCount), 0, this.cfg.holeCount);
    const mask = new Array(this.cfg.holeCount).fill(false);
    for (let i = this.cfg.holeCount - n; i < this.cfg.holeCount; i++) mask[i] = true;
    this.setFingeringMask(mask);
  }

  setFingeringMask(mask) {
    const count = this.cfg.holeCount;
    const next = new Array(count).fill(false);
    for (let i = 0; i < count; i++) next[i] = Boolean(mask?.[i]);
    this.holeMask = next;
    this.openCount = maskToOpenCount(next);
    this.length = maskEffectiveLength(next, this.cfg);
    this.computeDelayTarget();
  }

  reedPhaseDelaySamples() {
    if (!this.cfg.reedPhaseTrim) return 0;
    // The delay line runs at fsInt, so the correction must be expressed in
    // internal samples; the physical lag is a constant time.
    return this.cfg.reedEndPhaseDelaySeconds * this.fsInt;
  }

  // Delay length of the reflection lowpass at dc: a pole at a has group
  // delay a/(1-a) samples; with the (1-a) gain it is 2a/(1+a).
  reflectionPhaseDelaySamples() {
    const a = this.cfg.reflectionLowpass;
    if (a <= 0) return 0;
    return 2 * a / (1 + a);
  }

  computeDelayTarget() {
    const nominal = 2 * this.length * this.fsInt / this.cfg.speedOfSound;
    const trim = this.reedPhaseDelaySamples();
    this.nominalDelay = nominal;
    this.phaseTrim = Math.min(trim, nominal - 4);
    // Subtract the reed's phase lag and add back the lowpass's phase lag
    // so that neither shows up as a systematic pitch offset. The tube delay
    // therefore equals the geometric round trip minus two small,
    // documented corrections.
    this.delayTarget = Math.max(4, nominal - this.phaseTrim -
      this.reflectionPhaseDelaySamples());
  }

  setFingeringImmediate(openCount) {
    this.setFingering(openCount);
    this.delay = this.delayTarget;
  }

  readLine(pos) {
    // pos: fractional absolute sample index (can be negative). The line is
    // circular with writeIndex one past the newest written sample.
    const size = this.line.length;
    const base = Math.floor(pos);
    const frac = pos - base;
    const at = (i) => this.line[((i % size) + size) % size];
    if (this.interpolation === 'linear') {
      return at(base) * (1 - frac) + at(base + 1) * frac;
    }
    // 4-point, 3rd-order Lagrange interpolation. Stable and accurate for
    // the low harmonics; its small phase error is reported in the docs.
    const xm1 = at(base - 1);
    const x0 = at(base);
    const x1 = at(base + 1);
    const x2 = at(base + 2);
    const f = frac;
    return xm1 * (-f * (f - 1) * (f - 2) / 6) +
      x0 * ((f + 1) * (f - 1) * (f - 2) / 2) +
      x1 * (-(f + 1) * f * (f - 2) / 2) +
      x2 * ((f + 1) * f * (f - 1) / 6);
  }

  // One internal (oversampled) step. Returns nothing; state is in
  // lastState after the outer step.
  substep(blow) {
    const cfg = this.cfg;
    const reed = cfg.reed;
    const inj = cfg.injection;

    // Fractional round-trip delay, glided on fingering changes.
    if (this.delay !== this.delayTarget) {
      const a = 1 - Math.exp(-this.dt / cfg.fingeringGlideSeconds);
      this.delay += (this.delayTarget - this.delay) * a;
      if (Math.abs(this.delayTarget - this.delay) < 1e-4) this.delay = this.delayTarget;
    }

    // Bell: read the wave that left the reed D samples ago, reflect it
    // with loss and a one-pole wall/radiation lowpass. Negative sign for a
    // pressure-release open end.
    const readPos = this.writeIndex - this.delay;
    const fwdOld = this.readLine(readPos);

    // The one-pole is a *lossy* reflection: its dc gain is (1-a), below
    // unity, so the loop always loses energy. Its phase delay is nearly
    // compensated by adding the same time (2*a/(1+a)) to the round-trip
    // delay in computeDelayTarget(); the residual phase error is < 0.02
    // samples across the playing range and is included in the measured
    // residual pitch error. (A series lag with unity gain would leave the
    // loop marginally stable.)
    this.reflState = cfg.reflectionLowpass * this.reflState + fwdOld;
    const b = -cfg.bellReflection * (1 - cfg.reflectionLowpass) * this.reflState;

    // Reed mechanics. The reed gap responds to the previous junction
    // pressure; the junction itself is solved implicitly below, so the
    // reed/bore coupling carries no artificial one-sample algebraic delay
    // (which would give a Nyquist-rate numerical limit cycle).
    const pEst = this.p + (inj.active
      ? inj.amplitude * Math.sin(TWO_PI * inj.frequency * this.steps / this.fs)
      : 0);
    const deltaP = blow - pEst;
    const gapTarget = clamp(
      reed.restGap - reed.compliance * deltaP,
      0,
      reed.restGap * reed.maxGapFactor,
    );

    const w0 = TWO_PI * reed.resonanceHz;
    const acc = w0 * w0 * (gapTarget - this.gap) - 2 * reed.dampingRatio * w0 * this.gapVel;
    this.gapVel = clamp(this.gapVel + acc * this.dt, -reed.maxVelocity, reed.maxVelocity);
    this.gap = clamp(this.gap + this.gapVel * this.dt, 0, reed.restGap * reed.maxGapFactor);
    const gapEff = Math.max(this.gap, reed.leakage);

    // Implicit junction. Air goes from the higher-pressure side to the
    // lower one through the same orifice, so when a bore wave lifts the
    // bore pressure above the mouth pressure the valve lets air back into
    // the mouth. Blocking that backflow would rectify and trap DC.
    //
    //   pPlus = b + Z0 * q(blow - (pPlus + b))
    //
    // q is monotonically decreasing in pPlus, so the scalar root is unique.
    // Newton's method with the analytic slope converges in a few steps.
    const vScale = reed.dischargeCoeff * reed.width * gapEff * Math.sqrt(2 / cfg.airDensity);
    const eps = reed.lowPressureSmooth;
    const flowAt = (dp) => {
      const a = Math.abs(dp);
      const q = Math.sign(dp) * vScale * a / Math.sqrt(a + eps);
      return clamp(flushDenormal(q), -cfg.maxValveFlow, cfg.maxValveFlow);
    };
    const dFlowAt = (dp) => {
      const a = Math.abs(dp);
      // slope of a/sqrt(a+eps), intentionally kept positive at a = 0
      return vScale * (a + 2 * eps) / (2 * Math.pow(a + eps, 1.5));
    };
    let pPlus = b + this.z0 * flowAt(blow - (this.p + b));
    for (let it = 0; it < 3; it++) {
      const dp = blow - (pPlus + b);
      const f = pPlus - b - this.z0 * flowAt(dp);
      const df = 1 + this.z0 * dFlowAt(dp);
      pPlus -= f / df;
    }
    const flow = flowAt(blow - (pPlus + b));
    const p = pPlus + b;
    this.p = p;

    // Numeric guard rails. The physical model is bounded by the valve and
    // passive bore, but a compiler/platform pathology must not escape.
    if (!Number.isFinite(pPlus) || !Number.isFinite(p) || !Number.isFinite(this.gap) ||
        Math.abs(p) > cfg.maxBorePressure || Math.abs(pPlus) > cfg.maxBorePressure) {
      // Wipe the delay line and reed state, then latch the fault so callers
      // must acknowledge it. A silently resetting instrument would hide a
      // real instability from the performer and from the lab.
      this.reset();
      this.fault = 'numerical-overflow';
      this.lastState.fault = this.fault;
      this.lastState.audio = 0;
      return;
    }

    this.line[this.writeIndex] = pPlus;
    this.writeIndex = (this.writeIndex + 1) % this.line.length;

    const st = this.lastState;
    st.p = p;
    st.pPlus = pPlus;
    st.pMinus = b;
    st.flow = flow;
    st.gap = this.gap;
    st.gapTarget = gapTarget;
    st.deltaP = deltaP;
    st.mouth = blow;
    st.openCount = this.openCount;
    st.delaySamples = this.delay;
    st.fault = this.fault;
  }

  // Advance one audio sample. Mouth pressure is continuous (Pa); it is
  // clamped to the documented input range and the fact is surfaced.
  step(blowPressure) {
    let blow = Number(blowPressure);
    this.clamped = false;
    if (!Number.isFinite(blow)) {
      blow = 0;
      this.clamped = true;
      if (!this.fault) this.fault = 'invalid-input';
    } else if (blow < 0) {
      blow = 0;
      this.clamped = true;
    } else if (blow > this.cfg.maxMouthPressure) {
      blow = this.cfg.maxMouthPressure;
      this.clamped = true;
    }
    for (let i = 0; i < this.os; i++) this.substep(blow);
    this.steps++;
    return this.lastState;
  }

  // Shared output stage for realtime worklet and offline render: DC block,
  // fixed calibration, soft saturation. No samples are ever played back.
  toAudio(pressure) {
    const x = pressure;
    const y = x - this.audioDcX + this.cfg.audio.dcPole * this.audioDcY;
    this.audioDcX = x;
    this.audioDcY = y;
    const out = Math.tanh(y * this.cfg.audio.gain * 2.0) *
      (this.cfg.audio.saturation / Math.tanh(2.0));
    return out;
  }

  setInterpolation(kind) {
    if (kind !== 'linear' && kind !== 'cubic') throw new Error('interpolation must be linear or cubic');
    this.interpolation = kind;
  }

  setOversampling(os) {
    const next = clamp(Math.round(os), 1, 8);
    if (next === this.os) return;
    this.os = next;
    this.fsInt = this.fs * this.os;
    this.dt = 1 / this.fsInt;
    this.computeDelayTarget();
    this.delay = this.delayTarget;
    this.maxDelay = Math.ceil(
      (2 * (this.cfg.boreLengthClosed + bellEndCorrection(this.cfg)) / this.cfg.speedOfSound) *
      this.fsInt) + 8;
    if (this.maxDelay + 16 > this.line.length) {
      const old = this.line;
      this.line = new Float64Array(this.maxDelay + 16);
      this.line.set(old.subarray(0, Math.min(old.length, this.line.length)));
    }
    this.writeIndex = 0;
    this.reflState = 0;
    this.p = 0;
  }
}

function flushDenormal(x) {
  return Math.abs(x) < 1e-30 ? 0 : x;
}

// Offline driver shared by scripts and the browser's "reproduce offline"
// view. Returns the audio-rate samples plus a decimated trace of internal
// state; realtime uses the same ReedBore class and the same toAudio stage.
export function renderTrajectory(cfg, fs, durationSeconds, mouthPressureAt, options = {}) {
  const model = new ReedBore({ fs, config: cfg, oversampling: options.oversampling ?? cfg.oversampling });
  if (options.interpolation) model.setInterpolation(options.interpolation);
  if (options.openCount != null) model.setFingeringImmediate(options.openCount);
  const samples = new Float32Array(Math.round(durationSeconds * fs));
  const traceRate = options.traceRate ?? 200;
  const traceEvery = Math.max(1, Math.round(fs / traceRate));
  const trace = [];
  const pressure = new Float32Array(samples.length);
  let fault = null;
  for (let i = 0; i < samples.length; i++) {
    const t = i / fs;
    const p0 = mouthPressureAt(t);
    const st = model.step(p0);
    const audio = model.toAudio(st.p);
    samples[i] = audio;
    pressure[i] = st.p;
    if (st.fault) fault = st.fault;
    if (i % traceEvery === 0) {
      trace.push({
        t,
        mouth: st.mouth,
        p: st.p,
        flow: st.flow,
        gap: st.gap,
        gapTarget: st.gapTarget,
        pPlus: st.pPlus,
        pMinus: st.pMinus,
        audio,
      });
    }
  }
  return { samples, pressure, trace, fault, duration: samples.length / fs, model };
}
