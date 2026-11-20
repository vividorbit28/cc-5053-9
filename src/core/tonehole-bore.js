// Tonehole bore: a *bidirectional* travelling-wave model in which an open
// tone hole is a real shunt-scattering junction that changes the bore's
// propagation/reflection conditions, plus a two-mode register layer that
// tracks acoustic-register bistability.
//
// Why a second engine alongside ReedBore
// --------------------------------------
// ReedBore stores one forward wave and models a fingering by shortening the
// round-trip delay. That cannot represent what an open hole physically does:
// a shunt admittance at a fixed spatial position that (a) reflects part of
// the outgoing wave straight back to the reed and (b) transmits the rest to
// the bell. This engine keeps the full geometric length and splits the guide
// once, at the active hole, into two physical segments.
//
// Single-active-junction topology
// -------------------------------
// A well-vented woodwind is dominated by its most mouth-ward open hole; the
// holes beyond it only fix where that junction sits. So exactly ONE junction
// scatters. The guide is:
//   segment A = reed <-> active hole  (the speaking reflector)
//   segment B = active hole <-> bell (the transmitted tail)
// each a pair of one-way fractional delay lines (rA/lA, rB/lB). With all
// holes closed there is no junction; rA/lA simply span reed <-> bell and the
// bell terminates the loop. Either way the speaking round trip is the sum of
// the two one-way lines, 2*delayA. Controlled experiments show the sounding
// pitch depends only on this total round-trip time, not on how many segments
// or interpolators it is split across.
//
// Delay bookkeeping
// -----------------
// Each substep reads every arriving wave and computes every junction/bell
// output before any buffer is pushed (read-then-write, the same ordering
// ReedBore uses for its single line): a value pushed this substep is
// readable exactly `delay` substeps later. Each line therefore carries the
// geometric one-way time directly, with ReedBore's reed phase trim and
// reflection-lowpass group delay split half into each direction. The
// open-hole terminator uses the hole end correction, the all-closed
// terminator the bell correction; they are different physical lengths. All
// four buffers are sized for the largest one-way target so a retuned segment
// can never alias its circular read index.
//
// The register layer
// ------------------
// A single cylindrical guide with one nonlinear reed locks onto one modal
// frequency; real woodwinds reach an upper register because the bore's higher
// eigenmodes compete for the reed's energy and the winner depends on history
// (hysteresis). We represent that competition with two coupled Van der Pol
// modes at the low- and high-register frequencies. Their growth rates are
// driven by mouth pressure and tilted by hole openness; each mode saturates
// itself and suppresses the other, so two attractors coexist over a range of
// the control and the up/down transition points differ. The modes are an
// *observation/control* layer: they label the current register but never
// alter the bore wave, which always stays the reed+waveguide loop.

import {
  DEFAULT_CONFIG,
  effectiveLength,
  holePositions,
  bellEndCorrection,
  holeEndCorrection,
} from './reed-bore.js';

const TWO_PI = Math.PI * 2;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// One travelling-wave segment. push() writes at the reed-side end, read()
// returns the wave that arrives after exactly `delay` internal samples
// (4-point Lagrange for fractional delays). Circular, no allocation per step.
class WaveSegment {
  constructor(delaySamples) {
    this.cap = Math.ceil(Math.max(1, delaySamples)) + 8;
    this.buf = new Float64Array(this.cap);
    this.wi = 0;
    this.delay = Math.max(0.2, delaySamples);
  }
  setDelay(d) { this.delay = Math.max(0.2, d); }
  push(x) {
    this.buf[this.wi] = x;
    this.wi = (this.wi + 1) % this.cap;
  }
  // Value pushed `delay` substeps ago. wi points one past the newest sample,
  // so the delayed slot is wi - delay.
  read(delay = this.delay) {
    const pos = this.wi - delay;
    const size = this.cap;
    const base = Math.floor(pos);
    const f = pos - base;
    const at = (i) => this.buf[((i % size) + size) % size];
    const xm1 = at(base - 1), x0 = at(base), x1 = at(base + 1), x2 = at(base + 2);
    return xm1 * (-f * (f - 1) * (f - 2) / 6) +
      x0 * ((f + 1) * (f - 1) * (f - 2) / 2) +
      x1 * (-(f + 1) * f * (f - 2) / 2) +
      x2 * ((f + 1) * f * (f - 1) / 6);
  }
  clear() { this.buf.fill(0); this.wi = 0; }
}

// One competing register mode: a polar (constant-frequency) resonator whose
// pole radius is set each substep. r > 1 grows (the reed supplies energy),
// r < 1 decays (passive losses). Self- and cross-saturation live in the
// engine, which is where the bistability is tuned.
class RegisterMode {
  constructor(fsInt, hz) {
    this.w = TWO_PI * hz / fsInt;
    this.cosw = Math.cos(this.w);
    this.sinw = Math.sin(this.w);
    this.x = 1e-7;
    this.y = 0;
  }
  setFrequencyHz(fsInt, hz) {
    this.w = TWO_PI * hz / fsInt;
    this.cosw = Math.cos(this.w);
    this.sinw = Math.sin(this.w);
  }
  step(r) {
    const rr = clamp(r, 0.1, 1.0025);
    const x = this.x, y = this.y;
    this.x = rr * (x * this.cosw - y * this.sinw);
    this.y = rr * (x * this.sinw + y * this.cosw);
    return this.x;
  }
  reset() { this.x = 1e-7; this.y = 0; }
  get amplitude() { return Math.abs(this.x); }
}

export const REGISTER_DEFAULT = Object.freeze({
  // Maximum normalised shunt admittance Yh/Z0 of the active open tone hole.
  // A well-vented woodwind hole behaves almost like a pressure-release
  // termination: in the strong-admittance limit the junction reflects nearly
  // the whole wave and the speaking pitch converges to the geometric
  // quarter-wave frequency (measured within a few cents). gamma=25 gives
  // rH = gamma/(2+gamma) ~= 0.93 while staying numerically well behaved.
  holeGamma: 25.0,
  // Van der Pol growth coefficient per kPa of mouth pressure.
  pressureGrowth: 6.0e-4,
  // Linear loss each substep (the bore's passive damping).
  lossLo: 2.0e-4,
  lossHi: 2.4e-4,
  // Cubic self-saturation (amplitude limiting of each mode).
  selfSat: 2.5e-4,
  // Cross-suppression: the competing mode's squared amplitude. Stronger than
  // self-saturation so the two modes do not simply ring together — one wins.
  crossSat: 3.5e-4,
  // Persistent broadband seed (normalised) so a suppressed mode stays
  // excitable; this is the numerical noise floor from which it can regrow.
  noiseSeed: 4.0e-5,
  // Upper register is the (modeRatio)-th eigenmode of the speaking length.
  // A closed-open cylindrical bore has odd harmonics; the first overblown
  // register uses the 3rd.
  upperModeRatio: 3,
});

// The tone-hole engine shares ReedBore's reed profile. Earlier prototypes
// used a softer (larger-gap) reed to survive a strong shunt, but with the
// single-active-junction architecture below the standard reed sustains
// every fingering, and reusing it keeps the two engines' level and pitch
// conventions identical. The export remains for callers that want to
// override individual reed parameters.
export const TONEHOLE_REED = Object.freeze({ ...DEFAULT_CONFIG.reed });

export class ToneholeBore {
  constructor(options = {}) {
    this.cfg = options.config ?? DEFAULT_CONFIG;
    // The tonehole engine uses its own reed profile but shares every other
    // bore/output parameter with the reference config.
    this.reedCfg = { ...TONEHOLE_REED, ...(options.reed ?? {}) };
    this.regCfg = { ...REGISTER_DEFAULT, ...(options.register ?? {}) };
    this.fs = options.fs ?? 48000;
    this.os = Math.max(1, Math.round(options.oversampling ?? this.cfg.oversampling));
    this.fsInt = this.fs * this.os;
    this.dt = 1 / this.fsInt;

    this.z0 = this.cfg.airDensity * this.cfg.speedOfSound /
      (Math.PI * this.cfg.boreRadius * this.cfg.boreRadius);

    this.holeCount = this.cfg.holeCount;
    this.holePositionsM = holePositions(this.cfg);

    // Fingering identity (contiguous open count) and its geometric length.
    // Initialised before the first delay computation below.
    this.openCount = 0;
    this.holeMask = new Array(this.holeCount).fill(false);
    this.speakingLength = effectiveLength(0, this.cfg);

    // Geometry: reed->each-hole and reed->bell one-way times. Buffers are
    // never resized; fingering only retimes the two physical segments and
    // moves the single active junction.
    this._buildBaseGeometry();

    // Two physical segments, each a bidirectional pair of delay lines.
    // A = reed <-> active hole (the speaking reflector); B = active hole
    // <-> bell (the transmitted tail). With all holes closed, A spans the
    // whole guide and B is bypassed. Every buffer is sized from the largest
    // geometric one-way target (the all-closed reed->bell time): a segment
    // may be retuned up to that delay at some fingering, and a circular
    // buffer shorter than its own delay would alias the read index.
    const maxOneWay = this.pathOneWayTarget[0];
    this.rA = new WaveSegment(maxOneWay);
    this.lA = new WaveSegment(maxOneWay);
    this.rB = new WaveSegment(maxOneWay);
    this.lB = new WaveSegment(maxOneWay);
    this.bellState = 0;

    // Per-hole glided openness in [0,1]; contiguous run from the bell.
    this.openness = new Float64Array(this.holeCount);
    this.openTarget = new Float64Array(this.holeCount);
    this.glideCoef = 1 - Math.exp(-this.dt / this.cfg.fingeringGlideSeconds);
    // Glided effective openness of the single active junction in [0,1].
    this.junctionOpenness = 0;

    // Register competition modes, seeded at the all-closed frequencies.
    this.modeLo = new RegisterMode(this.fsInt, this._lowFreq());
    this.modeHi = new RegisterMode(this.fsInt, this._lowFreq() * this.regCfg.upperModeRatio);
    this.tick = 0;

    // Reed state.
    this.gap = this.reedCfg.restGap;
    this.gapVel = 0;
    this.p = 0;

    // Shared output DC blocker.
    this.audioDcX = 0;
    this.audioDcY = 0;

    this.fault = null;
    this.clamped = false;
    this.steps = 0;

    this.lastState = {
      p: 0, pPlus: 0, pMinus: 0, flow: 0, gap: this.gap, gapTarget: this.reedCfg.restGap,
      deltaP: 0, audio: 0, mouth: 0, openCount: 0, delaySamples: 0, fault: null,
      register: 'low', modeLo: 0, modeHi: 0, openness: 0,
    };

    this._applySegmentDelays();
  }

  // Geometric reed->terminator one-way times for every fingering. The
  // reed-side reference plane already includes the mouthpiece correction;
  // an open-hole terminator adds the hole end correction and the bell
  // terminator the bell correction. The reed phase trim and reflection
  // lowpass group delay use the same convention as ReedBore so both engines
  // map length to pitch identically.
  _buildBaseGeometry() {
    const cfg = this.cfg;
    const lpPhase = cfg.reflectionLowpass <= 0 ? 0 :
      2 * cfg.reflectionLowpass / (1 + cfg.reflectionLowpass);
    const reedTrim = cfg.reedPhaseTrim ? cfg.reedEndPhaseDelaySeconds * this.fsInt : 0;
    // One-way phase budget removed from every speaking path (the round trip
    // removes the full trim and lowpass lag, so each direction removes half).
    this.phaseTrimOneWay = reedTrim / 2 + lpPhase / 2;

    const mp = cfg.mouthpieceEndCorrection;
    // Reference-plane distance from the reed for each hole and the bell.
    this.holeOneWay = this.holePositionsM.map((lenM) =>
      (lenM + mp) / cfg.speedOfSound * this.fsInt);
    const bellOneWay = (cfg.boreLengthClosed +
      bellEndCorrection(cfg) + mp) / cfg.speedOfSound * this.fsInt;
    const holeEndOneWay = holeEndCorrection(cfg) /
      cfg.speedOfSound * this.fsInt;

    // Target reed->terminator one-way time for every fingering. With n>0
    // open holes the terminator is hole (holeCount-n); with n=0 it is the
    // bell. These match ReedBore's effectiveLength round trips exactly.
    this.pathOneWayTarget = new Float64Array(this.holeCount + 1);
    for (let n = 1; n <= this.holeCount; n++) {
      const termIndex = this.holeCount - n;
      this.pathOneWayTarget[n] =
        this.holeOneWay[termIndex] + holeEndOneWay - this.phaseTrimOneWay;
    }
    this.pathOneWayTarget[0] = bellOneWay - this.phaseTrimOneWay;
  }

  // Segment delays for the current fingering. The guide is always a pair of
  // one-way lines (rA reed->terminator, lA terminator->reed) each carrying
  // the same one-way time, so the speaking round trip is 2*delayA whether
  // the terminator is the bell (all closed) or the active open hole. With a
  // hole open the junction also feeds the transmitted tail B (active hole
  // ->bell). Buffers are sized for the largest one-way target, never the
  // round trip, because each physical direction has its own line.
  _applySegmentDelays() {
    const n = this.openCount;
    const aOne = this.pathOneWayTarget[n];
    this.delayA = Math.max(0.2, aOne);
    this.rA?.setDelay(this.delayA);
    this.lA?.setDelay(this.delayA);
    const bellOne = this.pathOneWayTarget[0];
    this.delayB = Math.max(0.2, bellOne - aOne);
    this.rB?.setDelay(this.delayB);
    this.lB?.setDelay(this.delayB);
    this.lastState.delaySamples = this.delayA;
  }

  _lowFreq() {
    return this.cfg.speedOfSound / (4 * this.speakingLength);
  }
  _highFreq() {
    return this._lowFreq() * this.regCfg.upperModeRatio;
  }

  reset() {
    for (const seg of [this.rA, this.lA, this.rB, this.lB]) seg.clear();
    this.bellState = 0;
    this.junctionOpenness = 0;
    this.openness.fill(0);
    this.openTarget.fill(0);
    this.gap = this.reedCfg.restGap;
    this.gapVel = 0;
    this.p = 0;
    this.audioDcX = 0;
    this.audioDcY = 0;
    this.modeLo.reset();
    this.modeHi.reset();
    this.fault = null;
    this.clamped = false;
    this.steps = 0;
    this.tick = 0;
  }

  // Fingering expressed as a hole mask; contiguous open holes from the bell
  // is the intended mapping, exactly as in ReedBore.
  setFingeringMask(mask) {
    const count = this.holeCount;
    const next = new Array(count).fill(false);
    for (let i = 0; i < count; i++) next[i] = Boolean(mask?.[i]);
    this.holeMask = next;
    let n = 0;
    for (let i = count - 1; i >= 0; i--) {
      if (!next[i]) break;
      n++;
    }
    this.openCount = n;
    this.speakingLength = effectiveLength(n, this.cfg);
    for (let i = 0; i < count; i++) this.openTarget[i] = next[i] ? 1 : 0;
    // Recompute the junction-compensated segment delays for this fingering.
    this._applySegmentDelays();
    this.modeLo.setFrequencyHz(this.fsInt, this._lowFreq());
    this.modeHi.setFrequencyHz(this.fsInt, this._highFreq());
  }

  setFingering(openCount) {
    const n = clamp(Math.round(openCount), 0, this.holeCount);
    const mask = new Array(this.holeCount).fill(false);
    for (let i = this.holeCount - n; i < this.holeCount; i++) mask[i] = true;
    this.setFingeringMask(mask);
  }

  // Continuous boundary control: directly set the glided openness of one
  // hole. Lets a caller sweep the shunt admittance instead of stepping a
  // mask. Values outside [0,1] are clamped, not faulted.
  setHoleOpenness(index, value) {
    const i = clamp(Math.round(index), 0, this.holeCount - 1);
    this.openTarget[i] = clamp(value, 0, 1);
  }

  substep(blow) {
    const cfg = this.cfg;
    const reed = this.reedCfg;
    const rc = this.regCfg;
    this.tick++;

    // Glide every hole openness toward its target. This is the continuous
    // boundary parameter: an 8 ms one-pole, matching ReedBore's fingering
    // glide, so hole changes never click. The single active junction (the
    // most mouth-ward open hole) takes the glided openness of that hole.
    let active = -1;
    for (let i = 0; i < this.holeCount; i++) {
      const o = this.openness[i];
      const t = this.openTarget[i];
      const ng = o + (t - o) * this.glideCoef;
      this.openness[i] = Math.abs(t - ng) < 1e-5 ? t : ng;
      if (this.openness[i] > 1e-4) active = i;
    }
    const g = active < 0 ? 0 : this.openness[active];
    this.junctionOpenness = g;
    const n = this.openCount;

    // --- Propagation, read-then-write (the same ordering as ReedBore). ---
    // Every arriving wave is read before any buffer is pushed, so a segment
    // returns the value pushed exactly `delay` substeps ago.
    const rIn = this.rA.read();
    const bReed = this.lA.read();

    // `bReed` is the left-going wave arriving at the reed this substep (the
    // reed's pMinus). With all closed it is the prior bell reflection; with
    // a hole open it is the prior junction reflection. Either way it was
    // committed to lA on an earlier substep and is read here before writes.
    let back;
    this.closedLoop = (n === 0 || g <= 1e-6);
    if (this.closedLoop) {
      // All closed: rA/lA span the whole guide, so the bell terminates the
      // speaking line directly with no junction in the loop. Its reflection
      // is pushed into lA and reaches the reed one one-way delay later.
      this.bellState = cfg.reflectionLowpass * this.bellState + rIn;
      const lToReed = -cfg.bellReflection * (1 - cfg.reflectionLowpass) * this.bellState;
      this.lA.push(lToReed);
      back = bReed;
    } else {
      // One active shunt junction between the speaking segment A and the
      // transmitted tail B. Each direction is its own delay line, so the
      // reed->hole->reed round trip is 2*delayA. Pressure junction with
      // shunt admittance gh*Z0:
      //   pJ = 2(r+ + l-)/(2 + gh);  r+out = pJ - l-;  l-out = pJ - r+
      const rAtBell = this.rB.read();
      const lTailIn = this.lB.read();
      this.bellState = cfg.reflectionLowpass * this.bellState + rAtBell;
      const bellReturn = -cfg.bellReflection * (1 - cfg.reflectionLowpass) * this.bellState;
      const gh = rc.holeGamma * g;
      const pJ = 2 * (rIn + lTailIn) / (2 + gh);
      const rToBell = pJ - lTailIn;
      const lToReed = pJ - rIn;
      this.lB.push(bellReturn);
      this.rB.push(rToBell);
      this.lA.push(lToReed);
      back = bReed;
    }

    // --- Register competition (Van der Pol pair). ---
    // The two polar modes represent the low (bell) and high (hole) acoustic
    // registers. Openness tilts growth from low to high; both stay viable in
    // the middle of the range, which is what makes the up/down transition
    // thresholds differ (hysteresis). They are an observation layer: they
    // label the current register but never alter the bore wave, which always
    // remains the reed+waveguide loop computed above.
    const mu = rc.pressureGrowth * (blow / 1000);
    const muLo = mu * (1.0 - 0.9 * g) - rc.lossLo;
    const muHi = mu * (0.35 + 0.85 * g) - rc.lossHi;
    const A = this.modeLo.x * this.modeLo.x;
    const B = this.modeHi.x * this.modeHi.x;
    const rLo = 1 + muLo - rc.selfSat * A - rc.crossSat * B;
    const rHi = 1 + muHi - rc.selfSat * B - rc.crossSat * A;
    this.modeLo.step(rLo);
    this.modeHi.step(rHi);
    const seed = pseudoNoise(this.tick) * rc.noiseSeed;
    this.modeLo.x += seed;
    this.modeHi.x += seed * 0.8;
    this.highWins = this.modeHi.amplitude > this.modeLo.amplitude;

    // --- Reed valve, identical implicit scheme to ReedBore. ---
    const deltaP = blow - this.p;
    const gapTarget = clamp(
      reed.restGap - reed.compliance * deltaP, 0,
      reed.restGap * reed.maxGapFactor);
    const w0 = TWO_PI * reed.resonanceHz;
    const acc = w0 * w0 * (gapTarget - this.gap) -
      2 * reed.dampingRatio * w0 * this.gapVel;
    this.gapVel = clamp(this.gapVel + acc * this.dt, -reed.maxVelocity, reed.maxVelocity);
    this.gap = clamp(this.gap + this.gapVel * this.dt, 0,
      reed.restGap * reed.maxGapFactor);
    const gapEff = Math.max(this.gap, reed.leakage);
    const vScale = reed.dischargeCoeff * reed.width * gapEff *
      Math.sqrt(2 / cfg.airDensity);
    const eps = reed.lowPressureSmooth;
    const flowAt = (dp) => {
      const a = Math.abs(dp);
      const q = Math.sign(dp) * vScale * a / Math.sqrt(a + eps);
      return clamp(flushDenormal(q), -cfg.maxValveFlow, cfg.maxValveFlow);
    };
    const dFlowAt = (dp) => {
      const a = Math.abs(dp);
      return vScale * (a + 2 * eps) / (2 * Math.pow(a + eps, 1.5));
    };
    let pPlus = back + this.z0 * flowAt(blow - (this.p + back));
    for (let it = 0; it < 3; it++) {
      const dp = blow - (pPlus + back);
      const f = pPlus - back - this.z0 * flowAt(dp);
      const df = 1 + this.z0 * dFlowAt(dp);
      pPlus -= f / df;
    }
    const flow = flowAt(blow - (pPlus + back));
    const p = pPlus + back;
    this.p = p;

    if (!Number.isFinite(pPlus) || !Number.isFinite(p) || !Number.isFinite(this.gap) ||
        Math.abs(p) > cfg.maxBorePressure || Math.abs(pPlus) > cfg.maxBorePressure) {
      this.reset();
      this.fault = 'numerical-overflow';
      this.lastState.fault = this.fault;
      this.lastState.audio = 0;
      return;
    }

    // Inject the outgoing wave into the speaking segment's reed end.
    this.rA.push(pPlus);

    const st = this.lastState;
    st.p = p;
    st.pPlus = pPlus;
    st.pMinus = back;
    st.flow = flow;
    st.gap = this.gap;
    st.gapTarget = gapTarget;
    st.deltaP = deltaP;
    st.mouth = blow;
    st.openCount = this.openCount;
    st.delaySamples = this.delayA;
    st.register = this.highWins ? 'high' : 'low';
    st.modeLo = this.modeLo.amplitude;
    st.modeHi = this.modeHi.amplitude;
    st.openness = g;
    st.fault = this.fault;
  }

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

  // Same shared output stage as ReedBore so the two engines are level-matched.
  toAudio(pressure) {
    const x = pressure;
    const y = x - this.audioDcX + this.cfg.audio.dcPole * this.audioDcY;
    this.audioDcX = x;
    this.audioDcY = y;
    return Math.tanh(y * this.cfg.audio.gain * 2.0) *
      (this.cfg.audio.saturation / Math.tanh(2.0));
  }

  // Current register label and the two mode amplitudes, for the UI and the
  // offline hysteresis measurements.
  registerState() {
    return {
      register: this.lastState.register,
      modeLo: this.modeLo.amplitude,
      modeHi: this.modeHi.amplitude,
      openness: this.lastState.openness,
    };
  }
}

// Deterministic, zero-allocation pseudo-noise in roughly [-1, 1], used only
// as the mode-competition noise floor. Not cryptographic.
function pseudoNoise(i) {
  const z = Math.sin(i * 12.9898) * 43758.5453;
  return (z - Math.floor(z)) * 2 - 1;
}

function flushDenormal(x) {
  return Math.abs(x) < 1e-30 ? 0 : x;
}
