import {
  ReedBore, DEFAULT_CONFIG, predictedFrequency, predictedFrequencyForMask,
  effectiveLength, maskEffectiveLength, FINGERING_STEPS,
} from '/src/core/reed-bore.js';
import {
  zeroCrossingFrequency, fundamental, rms, peak, timeToFraction, decayFit,
  spectrum, envelope,
} from '/src/core/analysis.js';

const $ = (id) => document.getElementById(id);
const state = {
  ctx: null,
  node: null,
  model: null,
  started: false,
  mask: new Array(DEFAULT_CONFIG.holeCount).fill(false),
  mouth: 0,
  holdTimer: null,
  scripts: [],
  meters: { mouth: 0, p: 0, peak: 0, delaySamples: 0 },
  traces: { mouth: [], pressure: [], audio: [] },
  fault: null,
  lastFingerCount: 0,
};

const scopes = {
  mouth: { el: $('mouth-scope'), data: [], color: '#c9a45c', min: 0, max: 5000 },
  pressure: { el: $('pressure-scope'), data: [], color: '#7fa8a0', min: -4500, max: 4500 },
  audio: { el: $('audio-scope'), data: [], color: '#e6d7b8', min: -1, max: 1 },
};

function fmtPa(pa) {
  return `${Math.round(pa)} Pa`;
}

function status(text, ok = false) {
  const chip = $('audio-status');
  chip.textContent = 'audio: ' + text;
  chip.classList.toggle('ok', ok);
}

function showFault(message, detail) {
  state.fault = message;
  const chip = $('fault-chip');
  chip.hidden = false;
  chip.textContent = 'fault: ' + message;
  const box = $('fault-box');
  box.hidden = false;
  box.replaceChildren();
  const text = document.createElement('span');
  text.textContent = `${message}${detail ? ' — ' + detail : ''}. The core has been reset; ` +
    'check the input and restart the breath.';
  const ack = document.createElement('button');
  ack.type = 'button';
  ack.textContent = 'Acknowledge';
  ack.addEventListener('click', () => {
    box.hidden = true;
    chip.hidden = true;
    state.fault = null;
    post({ type: 'reset' });
  });
  box.append(text, ack);
}

function clearFault() {
  state.fault = null;
  $('fault-chip').hidden = true;
  $('fault-box').hidden = true;
}

function post(message, transfer) {
  if (state.node) state.node.port.postMessage(message, transfer ?? []);
}

// Add event listeners directly instead of assigning `onmessage`: assigning
// would replace the AudioWorkletNode's internal handler, so the node would
// never expose the fault/reset sequence the panel needs to react to.
function attachPort(node) {
  node.port.addEventListener('message', onWorkletMessage);
  node.port.start();
}

// ---------------------------------------------------------------- audio
async function startAudio() {
  if (state.started) return;
  try {
    state.ctx = new AudioContext({ latencyHint: 'interactive' });
    await state.ctx.audioWorklet.addModule('/src/worklet/reed-bore-worklet.js');
    state.node = new AudioWorkletNode(state.ctx, 'reed-bore', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { config: DEFAULT_CONFIG, mask: state.mask },
    });
    if (typeof window !== 'undefined') window.__reedLab = { state, post };
    // Small output trim only; all nonlinearity is inside the core.
    const trim = state.ctx.createGain();
    trim.gain.value = 0.9;
    state.node.connect(trim).connect(state.ctx.destination);
    attachPort(state.node);
    state.node.onprocessorerror = () => showFault('worklet-crash', 'processor error event');
    await state.ctx.resume();
    state.started = true;
    status(`running · ${(state.ctx.sampleRate / 1000).toFixed(1)} kHz`, true);
    $('audio-start').disabled = true;
    $('audio-stop').disabled = false;
    post({ type: 'mask', mask: state.mask });
    updateGeometry();
  } catch (err) {
    status('failed: ' + (err?.message ?? err));
    showFault('audio-start-failed', err?.message ?? String(err));
  }
}

async function stopAudio() {
  if (state.holdTimer) { clearInterval(state.holdTimer); state.holdTimer = null; }
  if (state.scripts.length) state.scripts.forEach(clearTimeout);
  state.scripts = [];
  setBlowUi(0);
  post({ type: 'stop' });
  if (state.ctx) await state.ctx.close();
  state.ctx = null;
  state.node = null;
  state.started = false;
  status('stopped');
  $('audio-start').disabled = false;
  $('audio-stop').disabled = true;
}

function onWorkletMessage(event) {
  const msg = event.data;
  if (!msg) return;
  switch (msg.type) {
    case 'meter':
      state.meters = { ...state.meters, ...msg };
      updateReadout(msg);
      pushScopes(msg);
      break;
    case 'fault':
      showFault(msg.fault, '');
      status('fault', false);
      break;
    case 'clamped':
      status(`clamped ${Math.round(msg.requested)} → ${Math.round(msg.applied)} Pa`, true);
      break;
    case 'geometry':
      updateGeometry(msg);
      break;
    case 'reset-done':
      // The core is clean again, but the UI keeps the notice until the
      // performer acknowledges it. A fault that hides itself is easy to
      // miss and looks like the instrument silently recovered.
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------ controls
function setBlowUi(pa) {
  state.mouth = pa;
  $('blow').value = String(pa);
  $('blow-val').textContent = fmtPa(pa);
  if (state.node) post({ type: 'blow', pressure: pa });
}

function wireControls() {
  $('blow').addEventListener('input', (e) => setBlowUi(Number(e.target.value)));

  const onButton = $('blow-on');
  const startHold = async () => {
    if (!state.started) await startAudio();
    setBlowUi(Number($('blow').value) || 2500);
    onButton.setAttribute('aria-pressed', 'true');
  };
  const endHold = () => {
    onButton.setAttribute('aria-pressed', 'false');
    setBlowUi(0);
  };
  onButton.addEventListener('pointerdown', (e) => { e.preventDefault(); startHold(); });
  onButton.addEventListener('pointerup', endHold);
  onButton.addEventListener('pointerleave', endHold);
  onButton.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); startHold(); }
  });
  onButton.addEventListener('keyup', (e) => {
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); endHold(); }
  });

  $('blow-hold-tone').addEventListener('click', async () => {
    if (!state.started) await startAudio();
    setBlowUi(3000);
  });
  $('blow-off').addEventListener('click', () => setBlowUi(0));

  $('audio-start').addEventListener('click', startAudio);
  $('audio-stop').addEventListener('click', stopAudio);
  $('reset').addEventListener('click', () => {
    if (!state.started) return;
    setBlowUi(0);
    post({ type: 'reset' });
    clearFault();
    clearScopes();
  });

  $('fingering').addEventListener('input', (e) => {
    const n = Number(e.target.value);
    setFingerCount(n);
  });

  $('play-demo').addEventListener('click', playScriptedPhrase);

  $('lab-run').addEventListener('click', runLab);
  $('lab-view-json').addEventListener('click', showMeasurementsJson);
  $('lab-play-demo').addEventListener('click', playRenderedDemo);

  const trajButtons = {
    'traj-ramp': 'ramp',
    'traj-step': 'step',
    'traj-crit': 'critical',
    'traj-hold': 'hold',
  };
  for (const [id, kind] of Object.entries(trajButtons)) {
    $(id).addEventListener('click', () => runTrajectory(kind));
  }

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === 'KeyM') {
      e.preventDefault();
      (async () => {
        if (!state.started) await startAudio();
        setBlowUi(3000);
      })();
    }
    if (e.code === 'KeyS') { e.preventDefault(); setBlowUi(0); }
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 0 && n <= 8) { e.preventDefault(); setFingerCount(n); }
  });
}

function setFingerCount(n) {
  const count = DEFAULT_CONFIG.holeCount;
  const clamped = Math.max(0, Math.min(count, Math.round(n)));
  state.mask = new Array(count).fill(false);
  for (let i = count - clamped; i < count; i++) state.mask[i] = true;
  state.lastFingerCount = clamped;
  renderFingerRow();
  $('fingering').value = String(clamped);
  $('fingering-val').textContent = FINGERING_STEPS[clamped].name;
  if (state.node) post({ type: 'mask', mask: state.mask });
  updateGeometry();
}

function renderPresetButtons() {
  const box = $('finger-presets');
  box.replaceChildren();
  for (const step of FINGERING_STEPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = step.name;
    b.addEventListener('click', () => setFingerCount(step.openCount));
    box.append(b);
  }
}

function renderFingerRow() {
  const row = $('finger-row');
  row.replaceChildren();
  // Display from mouth end (left) to bell end (right); open holes are the
  // bell-side run, which is why the last cells light up first.
  for (let i = 0; i < state.mask.length; i++) {
    const cell = document.createElement('span');
    cell.className = 'hole' + (state.mask[i] ? ' open' : '');
    cell.textContent = String(i + 1);
    cell.title = `hole ${i + 1} ${state.mask[i] ? 'open' : 'closed'}`;
    row.append(cell);
  }
}

function updateGeometry(msg) {
  const mask = msg?.mask ?? state.mask;
  const length = msg?.lengthM ?? maskEffectiveLength(state.mask);
  const predicted = msg?.predictedHz ?? predictedFrequencyForMask(state.mask);
  const count = msg?.openCount ?? state.lastFingerCount;
  $('r-pitch').textContent = predicted.toFixed(1) + ' Hz';
  $('r-length')?.replaceChildren(document.createTextNode((length * 1000).toFixed(1) + ' mm'));
  $('finger-hint').textContent =
    `Speaking length ${(length * 1000).toFixed(1)} mm; all-closed fundamental is the reference. ` +
    'The delay glides when this changes.';
}

// -------------------------------------------------------------- scopes
function pushScopes(msg) {
  const push = (scope, v) => {
    scope.data.push(v);
    if (scope.data.length > 240) scope.data.shift();
  };
  // The meter is post-process: show the instantaneous last sample of each
  // signal (peak-held values are in the readout). This is a live scope, so
  // it draws the waveform's motion rather than a static bar.
  // Meter values are peak envelopes computed inside the worklet over the
  // previous window. Plotting raw instantaneous samples at 60 Hz would
  // alias a 280 Hz tone into noise, so the scope deliberately shows the
  // envelope and its captions say so.
  push(scopes.mouth, msg.mouth ?? 0);
  push(scopes.pressure, msg.p ?? 0);
  push(scopes.audio, msg.peak ?? 0);
  for (const scope of Object.values(scopes)) drawScope(scope);
}

function drawScope(scope) {
  const canvas = scope.el;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.strokeStyle = '#2a241b';
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
  const data = scope.data;
  if (data.length < 2) return;
  const y = (v) => {
    const t = (v - scope.min) / (scope.max - scope.min);
    return h - Math.max(0, Math.min(1, t)) * (h - 4) - 2;
  };
  g.strokeStyle = scope.color;
  g.lineWidth = 1.6;
  g.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1)) * w;
    if (i === 0) g.moveTo(x, y(data[i])); else g.lineTo(x, y(data[i]));
  }
  g.stroke();
}

function clearScopes() {
  for (const scope of Object.values(scopes)) { scope.data = []; drawScope(scope); }
}

function updateReadout(msg) {
  $('r-mouth').textContent = fmtPa(msg.mouth ?? 0);
  $('r-p').textContent = fmtPa(msg.p ?? 0);
  // Mean over the meter window is the net air movement; the minimum shows
  // how far the returning bore wave pushes air back into the mouth.
  const mean = (msg.flowMean ?? 0) * 1e6;
  const min = (msg.flowMin ?? 0) * 1e6;
  $('r-flow').textContent = `${mean >= 0 ? '+' : ''}${mean.toFixed(1)} mL/s (min ${min.toFixed(1)})`;
  $('r-gap').textContent = ((msg.gap ?? 0) * 1e6).toFixed(0) + ' µm';
  $('r-delay').textContent = msg.delaySamples
    ? `${msg.delaySamples.toFixed(1)} samples` : '—';
}

// --------------------------------------------------------- demo phrase
function playScriptedPhrase() {
  if (!state.started) { startAudio().then(playScriptedPhrase); return; }
  if (state.scripts.length) state.scripts.forEach(clearTimeout);
  state.scripts = [];
  setFingerCount(0);
  const at = (ms, fn) => state.scripts.push(setTimeout(fn, ms));
  at(0, () => setBlowUi(1200));
  at(420, () => setFingerCount(2));
  at(760, () => setFingerCount(4));
  at(1100, () => setBlowUi(2800));
  at(1500, () => setFingerCount(6));
  at(1900, () => setFingerCount(8));
  at(2400, () => setBlowUi(900));
  at(2900, () => setBlowUi(0));
  at(3400, () => setFingerCount(0));
}

// -------------------------------------------------------------- lab
const labState = { running: false, measurements: null };

async function runLab() {
  if (labState.running) return;
  labState.running = true;
  $('lab-run').disabled = true;
  $('lab-status').classList.remove('error');
  $('lab-status').textContent = 'rendering…';
  try {
    await new Promise((r) => setTimeout(r, 20));
    const results = await computeMeasurements();
    labState.measurements = results;
    renderPitchTable(results.pitchTable);
    renderThreshold(results.criticalRegion);
    $('lab-status').textContent =
      `done · ${results.pitchTable.length} fingerings · threshold ` +
      `${results.criticalRegion.firstSustained?.mouthPa ?? '—'} Pa · ` +
      `numerical spread ${results.numericsSpreadCents.toFixed(2)} cents`;
  } catch (err) {
    $('lab-status').classList.add('error');
    $('lab-status').textContent = 'failed: ' + (err?.message ?? err);
    showFault('lab-failed', err?.message ?? String(err));
  } finally {
    labState.running = false;
    $('lab-run').disabled = false;
  }
}

function renderOffline(mouthAt, seconds, openCount = 0) {
  const model = new ReedBore({ fs: 48000, config: DEFAULT_CONFIG, oversampling: 2 });
  model.setFingeringImmediate(openCount);
  const n = Math.round(seconds * 48000);
  const samples = new Float32Array(n);
  const pressure = new Float32Array(n);
  const mouth = new Float32Array(n);
  const trace = [];
  const every = 240;
  let fault = null;
  for (let i = 0; i < n; i++) {
    const t = i / 48000;
    const st = model.step(mouthAt(t));
    samples[i] = model.toAudio(st.p);
    pressure[i] = st.p;
    mouth[i] = st.mouth;
    if (st.fault) fault = st.fault;
    if (i % every === 0) {
      trace.push({ t, mouth: st.mouth, p: st.p, flow: st.flow, gap: st.gap, audio: samples[i] });
    }
  }
  return { model, samples, pressure, mouth, trace, fault };
}

function measureSteady(model, samples, pressure, mouth, openCount) {
  const a = Math.round(0.3 * 48000), b = Math.round(1.2 * 48000);
  const seg = samples.subarray(a, b);
  const arr = Float64Array.from(seg);
  const zc = zeroCrossingFrequency(arr, 48000, { skip: 1 });
  const fftR = fundamental(arr, 48000, { minHz: 60, maxHz: 2500 });
  return {
    openCount,
    measuredHz: zc.hz,
    fftHz: fftR.hz,
    predictedHz: predictedFrequency(openCount),
    peakBorePa: peak(pressure.subarray(a, b)),
    peakAudio: peak(seg),
  };
}

async function computeMeasurements() {
  const pitchTable = [];
  for (const step of FINGERING_STEPS) {
    const r = renderOffline(() => 3000, 1.4, step.openCount);
    const m = measureSteady(r.model, r.samples, r.pressure, r.mouth, step.openCount);
    pitchTable.push({
      ...m, name: step.name,
      acousticLengthM: effectiveLength(step.openCount),
      centsError: 1200 * Math.log2(m.measuredHz / m.predictedHz),
    });
    await tick();
  }

  const numerics = [];
  for (const os of [1, 2, 4]) {
    for (const interp of ['linear', 'cubic']) {
      const model = new ReedBore({ fs: 48000, config: DEFAULT_CONFIG, oversampling: os });
      model.setInterpolation(interp);
      model.setFingeringImmediate(0);
      const n = Math.round(1.2 * 48000);
      const buf = new Float32Array(n);
      const pbuf = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const st = model.step(3000);
        buf[i] = st.p; pbuf[i] = st.p;
      }
      const zc = zeroCrossingFrequency(Float64Array.from(buf.subarray(Math.round(0.3 * 48000))), 48000, { skip: 1 });
      numerics.push({ os, interp, hz: zc.hz, cents: 1200 * Math.log2(zc.hz / pitchTable[0].predictedHz) });
      await tick();
    }
  }
  const numericsSpreadCents = Math.max(...numerics.map((n) => n.cents)) -
    Math.min(...numerics.map((n) => n.cents));

  const criticalPoints = [];
  for (let p = 600; p <= 1500; p += 50) {
    const r = renderOffline(() => p, 1.5);
    const seg = r.samples.subarray(Math.round(0.6 * 48000));
    const mean = r.pressure.subarray(Math.round(0.6 * 48000));
    const zc = zeroCrossingFrequency(Float64Array.from(mean), 48000, { skip: 1 });
    criticalPoints.push({ mouthPa: p, rmsAudio: rms(seg), hz: zc.hz });
    await tick();
  }
  const firstSustained = criticalPoints.find((c) => c.rmsAudio > 0.002 && c.hz > 100) ?? null;

  // attack and release
  const stepR = renderOffline((t) => (t >= 0.25 && t < 1.75 ? 3000 : 0), 2.6);
  const attack50 = timeToFraction(stepR.samples, 48000, 0.5, { startS: 0.25 });
  const release = decayFit(stepR.samples, 48000, 1.75);
  const finalPressure = Math.abs(stepR.pressure[stepR.pressure.length - 1]);

  return {
    pitchTable, numerics, numericsSpreadCents, criticalRegion: { points: criticalPoints, firstSustained },
    attack50, release, finalPressure,
  };
}

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

function renderPitchTable(rows) {
  const div = $('pitch-table');
  const table = document.createElement('table');
  table.innerHTML = `<thead><tr><th>open</th><th>length</th><th>expected</th><th>measured</th><th>cents</th></tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.openCount}</td><td>${(r.acousticLengthM * 1000).toFixed(1)} mm</td>` +
      `<td>${r.predictedHz.toFixed(1)}</td><td>${r.measuredHz.toFixed(1)}</td>` +
      `<td>${r.centsError.toFixed(1)}</td>`;
    tbody.append(tr);
  }
  table.append(tbody);
  div.replaceChildren(table);

  const canvas = $('pitch-canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 400, h = 180;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const maxH = Math.max(...rows.map((r) => r.predictedHz)) * 1.08;
  const y = (hz) => h - 20 - (hz / maxH) * (h - 40);
  const x = (i) => 30 + (i / (rows.length - 1)) * (w - 45);
  g.strokeStyle = '#3a3227'; g.beginPath();
  for (let i = 0; i < rows.length; i++) {
    if (i === 0) g.moveTo(x(i), y(rows[i].predictedHz)); else g.lineTo(x(i), y(rows[i].predictedHz));
  }
  g.lineWidth = 1.2; g.stroke();
  g.fillStyle = '#c9a45c';
  for (let i = 0; i < rows.length; i++) {
    g.beginPath(); g.arc(x(i), y(rows[i].predictedHz), 2.4, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = '#e6d7b8';
  for (let i = 0; i < rows.length; i++) {
    g.beginPath(); g.arc(x(i), y(rows[i].measuredHz), 2.6, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = '#a89c88'; g.font = '11px ui-sans-serif, system-ui';
  g.fillText('gold = geometric, cream = measured', 30, 14);
  g.fillText('all closed', 30, h - 6);
  g.fillText('all open', w - 60, h - 6);
}

function renderThreshold(region) {
  const div = $('threshold-summary');
  const peakRow = region.points.reduce((a, b) => (b.rmsAudio > a.rmsAudio ? b : a), region.points[0]);
  div.innerHTML = `<div>first sustained: <strong>${region.firstSustained ? region.firstSustained.mouthPa + ' Pa' : 'not reached'}</strong></div>` +
    `<div>loudest point: ${peakRow.mouthPa} Pa → RMS ${peakRow.rmsAudio.toFixed(3)}</div>` +
    `<div>pitch at threshold: ${region.firstSustained ? region.firstSustained.hz.toFixed(1) + ' Hz' : '—'}</div>`;

  const canvas = $('threshold-canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 400, h = 180;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const pts = region.points;
  const maxRms = Math.max(...pts.map((p) => p.rmsAudio), 0.01);
  const x = (i) => 34 + (i / (pts.length - 1)) * (w - 44);
  const y = (v) => h - 22 - (v / maxRms) * (h - 40);
  g.strokeStyle = '#7fa8a0'; g.lineWidth = 1.8; g.beginPath();
  pts.forEach((p, i) => { if (i === 0) g.moveTo(x(i), y(p.rmsAudio)); else g.lineTo(x(i), y(p.rmsAudio)); });
  g.stroke();
  g.fillStyle = '#a89c88'; g.font = '11px ui-sans-serif, system-ui';
  g.fillText(`${pts[0].mouthPa} Pa`, 4, h - 6);
  g.fillText(`${pts.at(-1).mouthPa} Pa`, w - 50, h - 6);
  if (region.firstSustained) {
    const i = pts.indexOf(region.firstSustained);
    g.fillStyle = '#c9a45c';
    g.beginPath(); g.arc(x(i), y(region.firstSustained.rmsAudio), 3, 0, Math.PI * 2); g.fill();
    g.fillText('first sustained', x(i) + 6, y(region.firstSustained.rmsAudio) - 6);
  }
}

async function playRenderedDemo() {
  // The committed WAV is rendered offline by `npm run offline`; playing it
  // is a convenience for comparison, not the instrument's sound path.
  try {
    const res = await fetch('/out/demo-phrase.wav');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const bytes = await res.arrayBuffer();
    if (!state.ctx) await startAudio();
    const buffer = await state.ctx.decodeAudioData(bytes);
    const src = state.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(state.ctx.destination);
    src.start();
    $('lab-status').textContent = 'playing out/demo-phrase.wav (offline render)';
  } catch (err) {
    $('lab-status').classList.add('error');
    $('lab-status').textContent = 'demo phrase missing — run `npm run offline` first.';
  }
}

async function showMeasurementsJson() {
  try {
    const res = await fetch('/out/measurements.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const win = window.open('', '_blank');
    win.document.body.style.cssText = 'background:#14120f;color:#ede6d8;font:13px ui-monospace,monospace;padding:20px;white-space:pre-wrap';
    win.document.body.textContent = text;
  } catch (err) {
    $('lab-status').classList.add('error');
    $('lab-status').textContent = 'measurements.json missing — run `npm run offline` first.';
  }
}

// ------------------------------------------------------ trajectories
async function runTrajectory(kind) {
  const defs = {
    ramp: {
      caption: 'Slow rise: pressure ramps over 1.2 s to 3 kPa, holds, then releases. ' +
        'Watch the reed start to move, then the loop lock in.',
      seconds: 2.6,
      mouth: (t) => (t < 1.9 ? 3000 * Math.min(1, t / 1.2) : 0),
      hold: [0.2, 1.8],
    },
    step: {
      caption: 'Abrupt step to 3 kPa at 0.1 s, release at 1.3 s. The attack transient is ' +
        'the loop starting from rest, not a fixed envelope.',
      seconds: 2.2,
      mouth: (t) => (t >= 0.1 && t < 1.3 ? 3000 : 0),
      hold: [0.35, 1.25],
    },
    critical: {
      caption: 'Near threshold: 1.0 kPa. The loop is just above the oscillation threshold; ' +
        'small pressure changes still change its amplitude strongly.',
      seconds: 1.8,
      mouth: (t) => (t >= 0.1 && t < 1.5 ? 1000 : 0),
      hold: [0.6, 1.45],
    },
    hold: {
      caption: 'Just above threshold with a release: 980 Pa for 0.7 s, then 0 Pa. ' +
        'Shows what the bore stores and how the tail decays.',
      seconds: 2.2,
      mouth: (t) => (t >= 0.1 && t < 0.8 ? 980 : 0),
      hold: [0.35, 0.78],
    },
  };
  const def = defs[kind];
  $('traj-caption').textContent = def.caption;
  $('traj-readout').textContent = 'rendering…';
  await tick();
  const r = renderOffline(def.mouth, def.seconds);
  plotTrajectory(r, def);
  // Use the loudest 0.2 s window rather than guessed times: a slow ramp
  // reaches full amplitude at a different moment than a step.
  const win = Math.round(0.2 * 48000);
  let bestStart = 0;
  let bestLevel = -1;
  for (let s = 0; s + win <= r.samples.length; s += 4800) {
    const level = rms(r.samples, s, s + win);
    if (level > bestLevel) { bestLevel = level; bestStart = s; }
  }
  const a = bestStart / 48000;
  const b = (bestStart + win) / 48000;
  const seg = r.samples.subarray(bestStart, bestStart + win);
  const pseg = r.pressure.subarray(bestStart, bestStart + win);
  const tonal = rms(seg) > 0.002;
  const zc = zeroCrossingFrequency(Float64Array.from(pseg), 48000, { skip: 1 });
  const spec = spectrum(seg, 48000, { windowSize: 8192 });
  drawSpectrum($('traj-spec'), spec);
  $('traj-spec-caption').textContent = tonal
    ? `Spectrum of ${a.toFixed(2)}–${b.toFixed(2)} s. Fundamental ${zc.hz.toFixed(1)} Hz; ` +
      'partials are produced by the loop.'
    : 'No sustained oscillation in this window; the spectrum is transient energy only.';
  $('traj-readout').innerHTML =
    `<div>loudest 0.2 s window: ${a.toFixed(2)}–${b.toFixed(2)} s</div>` +
    `<div>window RMS: ${rms(seg).toFixed(4)}</div>` +
    `<div>peak bore pressure: ${peak(pseg).toFixed(0)} Pa</div>` +
    `<div>oscillation: ${tonal ? zc.hz.toFixed(1) + ' Hz' : 'none (below threshold)'}</div>` +
    `<div>final bore pressure: ${r.pressure[r.pressure.length - 1].toFixed(3)} Pa</div>` +
    `<div>fault: ${r.fault ?? 'none'}</div>`;
  playBuffer(r.samples);
}

function plotTrajectory(r, def) {
  const canvas = $('traj-plot');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 600, h = 220;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const pad = 30;
  const n = r.trace.length;
  const maxP = Math.max(...r.trace.map((d) => Math.abs(d.p)), 1);
  const maxM = Math.max(...r.trace.map((d) => d.mouth), 1);
  const x = (i) => pad + (i / (n - 1)) * (w - pad - 8);
  const yp = (v) => h / 2 - (v / maxP) * (h / 2 - 14);
  const ym = (v) => h - 12 - (v / maxM) * (h / 2 - 18);
  g.strokeStyle = '#2a241b'; g.beginPath(); g.moveTo(pad, h / 2); g.lineTo(w - 8, h / 2); g.stroke();
  g.strokeStyle = '#c9a45c'; g.lineWidth = 1.4; g.beginPath();
  r.trace.forEach((d, i) => { if (i === 0) g.moveTo(x(i), ym(d.mouth)); else g.lineTo(x(i), ym(d.mouth)); });
  g.stroke();
  g.strokeStyle = '#7fa8a0'; g.lineWidth = 1.2; g.beginPath();
  r.trace.forEach((d, i) => { if (i === 0) g.moveTo(x(i), yp(d.p)); else g.lineTo(x(i), yp(d.p)); });
  g.stroke();
  g.fillStyle = '#a89c88'; g.font = '11px ui-sans-serif, system-ui';
  g.fillText('gold: mouth pressure', pad, 14);
  g.fillText('teal: bore pressure at reed', pad + 160, 14);
}

function drawSpectrum(canvas, spec) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 600, h = 140;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const bins = spec.bins;
  const maxBin = Math.min(bins.length, Math.round(4000 / spec.binHz));
  let max = 0;
  for (let i = 0; i < maxBin; i++) max = Math.max(max, bins[i]);
  if (max <= 0) return;
  g.strokeStyle = '#e6d7b8'; g.lineWidth = 1; g.beginPath();
  for (let i = 0; i < maxBin; i++) {
    const x = (i / maxBin) * (w - 8) + 4;
    const y = h - 8 - (bins[i] / max) * (h - 20);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  g.fillStyle = '#a89c88'; g.font = '11px ui-sans-serif, system-ui';
  const tick = (hz) => {
    const x = (hz / 4000) * (w - 8) + 4;
    g.fillText(hz + '', x - 8, h - 1);
  };
  tick(0); tick(1000); tick(2000); tick(3000); tick(4000);
}

function playBuffer(samples) {
  if (!state.ctx) {
    status('rendered offline (start audio to listen)', true);
    return;
  }
  const buf = state.ctx.createBuffer(1, samples.length, 48000);
  buf.copyToChannel(samples, 0);
  const src = state.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(state.ctx.destination);
  src.start();
}

// -------------------------------------------------------------- boot
function boot() {
  wireControls();
  renderFingerRow();
  renderPresetButtons();
  setFingerCount(0);
  status('not started');
  $('audio-stop').disabled = true;
  const ro = new ResizeObserver(() => {
    for (const scope of Object.values(scopes)) drawScope(scope);
  });
  for (const scope of Object.values(scopes)) ro.observe(scope.el);
}

boot();
