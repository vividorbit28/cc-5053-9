// Measurement helpers shared by offline scripts, tests and the browser lab.

export function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('fft length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = uRe + vRe; im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe; im[i + j + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

export function hannWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  return w;
}

// Windowed spectrum of a signal segment.
export function spectrum(samples, sampleRate, { windowSize = 16384 } = {}) {
  const n = Math.min(windowSize, 1 << Math.floor(Math.log2(samples.length)));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const w = hannWindow(n);
  const offset = Math.max(0, samples.length - n);
  for (let i = 0; i < n; i++) re[i] = samples[offset + i] * w[i];
  fft(re, im);
  const bins = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) bins[i] = Math.hypot(re[i], im[i]);
  return { bins, binHz: sampleRate / n, windowSize: n, offset };
}

export function parabolicPeak(bins, index) {
  const y0 = bins[index - 1], y1 = bins[index], y2 = bins[index + 1];
  const denom = y0 - 2 * y1 + y2;
  if (!Number.isFinite(denom) || denom === 0) return index;
  return index + 0.5 * (y0 - y2) / denom;
}

export function fundamental(samples, sampleRate, options = {}) {
  const { bins, binHz } = spectrum(samples, sampleRate, options);
  const minBin = Math.max(1, Math.floor((options.minHz ?? 60) / binHz));
  const maxBin = Math.min(bins.length - 2, Math.ceil((options.maxHz ?? 4000) / binHz));
  let best = -1, bestVal = -Infinity;
  for (let i = minBin; i <= maxBin; i++) {
    const v = bins[i];
    const prominence = v / (bins[i - 1] + bins[i + 1] + 1e-12);
    const score = v * Math.min(prominence, 8);
    if (score > bestVal) { bestVal = score; best = i; }
  }
  if (best < 1) return { hz: 0, bin: 0, bins };
  const refined = parabolicPeak(bins, best);
  const hz = refined * binHz;
  // Harmonic confirmation: sum energy at 2f and 3f; if they dominate the
  // raw peak (e.g. a strong 2nd harmonic), prefer the subharmonic.
  const at = (f) => {
    const i = Math.round(f / binHz);
    if (i < 0 || i >= bins.length) return 0;
    return Math.max(bins[i - 1] ?? 0, bins[i], bins[i + 1] ?? 0);
  };
  const half = at(hz / 2), full = at(hz), twice = at(hz * 2);
  let corrected = hz;
  if (half > full * 1.8 && half > twice * 1.2) corrected = hz / 2;
  return { hz: corrected, bin: refined, bins, binHz };
}

export function zeroCrossingFrequency(samples, sampleRate, { skip = 0 } = {}) {
  let prev = 0, crossings = 0, first = -1, last = -1;
  const start = Math.max(1, Math.floor(skip));
  for (let i = start; i < samples.length; i++) {
    const cur = samples[i];
    if (prev < 0 && cur >= 0) {
      const t = i + (prev === cur ? 0 : -prev / (cur - prev));
      if (first < 0) first = t;
      last = t;
      crossings++;
    }
    prev = cur;
  }
  if (crossings < 1 || last === first) return { hz: 0, crossings };
  return { hz: (crossings - 1) * sampleRate / (last - first), crossings };
}

export function rms(samples, start = 0, end = samples.length) {
  let s = 0;
  for (let i = start; i < end; i++) s += samples[i] * samples[i];
  return Math.sqrt(s / Math.max(1, end - start));
}

export function peak(samples, start = 0, end = samples.length) {
  let p = 0;
  for (let i = start; i < end; i++) p = Math.max(p, Math.abs(samples[i]));
  return p;
}

// Envelope follower (one-pole peak with decay). Used to find attack and
// decay times without assuming periodicity.
export function envelope(samples, sampleRate, { attackMs = 1, releaseMs = 30 } = {}) {
  const aAtt = Math.exp(-1 / (sampleRate * attackMs / 1000));
  const aRel = Math.exp(-1 / (sampleRate * releaseMs / 1000));
  const env = new Float64Array(samples.length);
  let e = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = Math.abs(samples[i]);
    e = x > e ? aAtt * e + (1 - aAtt) * x : aRel * e + (1 - aRel) * x;
    env[i] = e;
  }
  return env;
}

// Time (s) for the envelope to reach `frac` of its steady-state peak after
// the initial transient, or null if it never does.
export function timeToFraction(samples, sampleRate, frac = 0.5, { startS = 0, envOptions } = {}) {
  const env = envelope(samples, sampleRate, envOptions);
  const start = Math.floor(startS * sampleRate);
  let max = 0;
  for (let i = start; i < env.length; i++) max = Math.max(max, env[i]);
  if (max <= 0) return null;
  const target = frac * max;
  for (let i = start; i < env.length; i++) if (env[i] >= target) return i / sampleRate;
  return null;
}

// Post-blow tail: fit exponential decay of the envelope to quantify how
// the stored energy leaves the bore, and report residual state.
export function decayFit(samples, sampleRate, startS, { minLevel = 1e-5 } = {}) {
  const env = envelope(samples, sampleRate, { releaseMs: 100 });
  const start = Math.floor(startS * sampleRate);
  let max = 0;
  for (let i = start; i < env.length; i++) max = Math.max(max, env[i]);
  if (max <= 0) return { tau: 0, r2: 0, samples: 0 };
  const xs = [], ys = [];
  for (let i = start; i < env.length; i++) {
    if (env[i] < max * minLevel) continue;
    xs.push(i / sampleRate);
    ys.push(Math.log(env[i]));
  }
  if (xs.length < 8) return { tau: 0, r2: 0, samples: xs.length };
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { tau: slope < 0 ? -1 / slope : 0, r2, samples: n };
}

// Systematic phase budget for the round trip at a measured frequency.
// Returns each term in samples at the internal rate, plus the effective
// geometric round trip. The point is to account for measured vs predicted
// pitch rather than to hide the difference.
export function delayBudget(model, measuredHz) {
  const cfg = model.cfg;
  const fsInt = model.fsInt;
  const geometric = 2 * model.length / cfg.speedOfSound;
  const geomSamples = geometric * fsInt;
  const w = 2 * Math.PI * measuredHz / fsInt;
  // 4-point Lagrange phase delay error (fractional part only).
  const frac = geomSamples - Math.floor(geomSamples);
  const lagPhase = (() => {
    // phase of interpolator at frequency w for fractional delay frac
    const f = frac;
    const h = [
      -f * (f - 1) * (f - 2) / 6,
      (f + 1) * (f - 1) * (f - 2) / 2,
      -(f + 1) * f * (f - 2) / 2,
      (f + 1) * f * (f - 1) / 6,
    ];
    let re = 0, im = 0;
    // taps are at offsets -1,0,1,2 relative to floor(pos)
    for (let j = 0; j < 4; j++) {
      const phi = -w * (j - 1);
      re += h[j] * Math.cos(phi);
      im += h[j] * Math.sin(phi);
    }
    const phase = Math.atan2(im, re);
    return -phase / w; // delay in samples at the signal frequency
  })();
  // one-pole lowpass phase delay
  const a = cfg.reflectionLowpass;
  const lpPhase = Math.atan2(a * Math.sin(w), 1 - a * Math.cos(w));
  const lpSamples = -lpPhase / w;
  const extraSamples = geomSamples - Math.floor(geomSamples) + lagPhase + lpSamples;
  return {
    geometricSeconds: geometric,
    geometricSamples: geomSamples,
    fractionalPart: frac,
    lagrangeSamples: lagPhase,
    reflectionLowpassSamples: lpSamples,
    reedPhaseSamples: 'nonlinear, measured empirically',
    totalSamples: Math.floor(geomSamples) + extraSamples,
    predictedHzFromBudget: fsInt / (2 * (Math.floor(geomSamples) + extraSamples)),
  };
}
