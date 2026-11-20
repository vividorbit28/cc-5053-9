// AudioWorklet host for the physical tone-hole core. The DSP lives in
// ../core/tonehole-bore.js and is the same code used by the Node tests and
// offline measurements. Open/closed holes are real shunt-scattering
// junctions, not delay-length shortcuts. Parameter updates arrive on the
// message port; invalid input is reported as a fault rather than hidden.

import { ToneholeBore, REGISTER_DEFAULT } from '../core/tonehole-bore.js';
import { predictedFrequencyForMask, DEFAULT_CONFIG } from '../core/reed-bore.js';

class ToneholeBoreProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions ?? {};
    this.fs = sampleRate;
    this.cfg = opts.config ?? DEFAULT_CONFIG;
    this.model = new ToneholeBore({
      fs: this.fs,
      config: this.cfg,
      oversampling: 2,
      register: opts.register ?? REGISTER_DEFAULT,
    });
    this.model.setFingeringMask(opts.mask ?? this.model.holeMask);
    this.mouth = 0;
    this.target = 0;
    this.rampSamples = Math.max(1, Math.round(this.fs * 0.004));
    this.rampLeft = 0;
    this.rampStep = 0;
    this.meterInterval = Math.max(64, Math.round(this.fs / 60));
    this.meterCounter = 0;
    this.meterPeak = 0;
    this.meterPressure = 0;
    this.meterFlow = 0;
    this.meterFlowPeak = 0;
    this.meterFlowSum = 0;
    this.meterFlowMin = 0;
    this.meterFrames = 0;
    this.lastFaultSent = null;
    this.lastClampKey = null;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') {
        this.reportFault('bad-message');
        return;
      }
      try {
        switch (msg.type) {
          case 'blow':
            this.setTarget(Number(msg.pressure));
            break;
          case 'mask':
            this.model.setFingeringMask(msg.mask);
            this.postCents();
            break;
          case 'openCount':
            this.model.setFingering(msg.openCount);
            this.postCents();
            break;
          case 'reset':
            this.model.reset();
            this.mouth = 0;
            this.target = 0;
            this.model.toAudio(0);
            this.post({ type: 'reset-done', fault: null });
            break;
          case 'stop':
            this.setTarget(0);
            break;
          default:
            break;
        }
      } catch (err) {
        this.reportFault('message: ' + (err?.message ?? String(err)));
      }
    };
  }

  setTarget(pressure) {
    if (!Number.isFinite(pressure)) {
      this.reportFault('invalid-blow');
      return;
    }
    const clamped = Math.max(0, Math.min(pressure, this.cfg.maxMouthPressure));
    if (clamped !== pressure) {
      const key = `${pressure}>${clamped}`;
      if (key !== this.lastClampKey) {
        this.lastClampKey = key;
        this.post({ type: 'clamped', requested: pressure, applied: clamped });
      }
    } else {
      this.lastClampKey = null;
    }
    this.target = clamped;
    this.rampLeft = this.rampSamples;
    this.rampStep = (this.target - this.mouth) / this.rampSamples;
  }

  postCents() {
    const f = predictedFrequencyForMask(this.model.holeMask, this.cfg);
    this.post({
      type: 'geometry',
      openCount: this.model.openCount,
      speakingLength: this.model.speakingLength,
      predictedHz: f,
      delaySamples: this.model.delayA,
      register: this.model.lastState.register,
    });
  }

  post(msg) {
    this.port.postMessage(msg);
  }

  reportFault(fault) {
    this.post({ type: 'fault', fault });
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const left = out[0];
    const right = out.length > 1 ? out[1] : null;
    const n = left.length;

    for (let i = 0; i < n; i++) {
      if (this.rampLeft > 0) {
        this.mouth += this.rampStep;
        this.rampLeft--;
        if (this.rampLeft === 0) this.mouth = this.target;
      } else {
        this.mouth = this.target;
      }
      const st = this.model.step(this.mouth);
      const audio = this.model.toAudio(st.p);
      left[i] = audio;
      if (right) right[i] = audio;
      const a = Math.abs(audio);
      if (a > this.meterPeak) this.meterPeak = a;
      const ap = Math.abs(st.p);
      if (ap > this.meterPressure) this.meterPressure = ap;
      this.meterFlow = st.flow;
      if (Math.abs(st.flow) > this.meterFlowPeak) this.meterFlowPeak = Math.abs(st.flow);
      this.meterFlowSum += st.flow;
      if (st.flow < this.meterFlowMin) this.meterFlowMin = st.flow;
      this.meterFrames++;

      if (st.fault && st.fault !== this.lastFaultSent) {
        this.lastFaultSent = st.fault;
        this.reportFault(st.fault);
      }
    }

    this.meterCounter += n;
    if (this.meterCounter >= this.meterInterval) {
      this.meterCounter = 0;
      this.post({
        type: 'meter',
        peak: this.meterPeak,
        p: this.meterPressure,
        flow: this.meterFlow,
        flowPeak: this.meterFlowPeak,
        flowMean: this.meterFrames ? this.meterFlowSum / this.meterFrames : 0,
        flowMin: this.meterFlowMin,
        gap: this.model.gap,
        mouth: this.mouth,
        delaySamples: this.model.delayA,
        pPlus: this.model.lastState.pPlus,
        pMinus: this.model.lastState.pMinus,
        openCount: this.model.openCount,
        openness: this.model.lastState.openness,
        register: this.model.lastState.register,
        modeLo: this.model.lastState.modeLo,
        modeHi: this.model.lastState.modeHi,
        predictedHz: predictedFrequencyForMask(this.model.holeMask, this.cfg),
      });
      this.meterPeak = 0;
      this.meterPressure = 0;
      this.meterFlowPeak = 0;
      this.meterFlowSum = 0;
      this.meterFlowMin = 0;
      this.meterFrames = 0;
    }
    return true;
  }
}

registerProcessor('tonehole-bore', ToneholeBoreProcessor);
