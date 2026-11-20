// Tone-hole performance lab UI. Drives the physical ToneholeBore engine and
// the PerformanceRecorder / parallel-state machinery in src/core/performance.js.
// The main panel (app.js) keeps the original ReedBore instrument; this module
// owns the separate "Tone-hole performance lab" section and its own audio
// context so the two never fight over one AudioWorkletNode.
import {
  PerformanceRecorder, runDistinguishingFragment, runCloseRestore,
} from '/src/core/performance.js';
import { rms } from '/src/core/analysis.js';

const $ = (id) => document.getElementById(id);
const FS = 48000;

const lab = {
  ctx: null,
  node: null,
  started: false,
  recorder: new PerformanceRecorder({ fs: FS }),
};

function setStatus(text, ok = false) {
  const el = $('th-status');
  el.textContent = text;
  el.classList.toggle('error', !ok);
}

async function startTonehole() {
  if (lab.started) return;
  try {
    lab.ctx = new AudioContext({ latencyHint: 'interactive' });
    await lab.ctx.audioWorklet.addModule('/src/worklet/tonehole-bore-worklet.js');
    lab.node = new AudioWorkletNode(lab.ctx, 'tonehole-bore', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { mask: new Array(8).fill(false) },
    });
    const trim = lab.ctx.createGain();
    trim.gain.value = 0.9;
    lab.node.connect(trim).connect(lab.ctx.destination);
    lab.node.port.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg?.type === 'fault') setStatus('fault: ' + msg.fault, false);
    });
    lab.node.port.start();
    await lab.ctx.resume();
    lab.started = true;
    $('th-start').disabled = true;
    $('th-stop').disabled = false;
    setStatus('running · physical tone-hole engine', true);
    sendFinger();
    sendBlow();
  } catch (err) {
    setStatus('failed: ' + (err?.message ?? String(err)), false);
  }
}

async function stopTonehole() {
  if (!lab.started) return;
  post({ type: 'stop' });
  await lab.ctx.close();
  lab.ctx = null;
  lab.node = null;
  lab.started = false;
  $('th-start').disabled = false;
  $('th-stop').disabled = true;
  setStatus('stopped');
}

function post(msg) {
  if (lab.node) lab.node.port.postMessage(msg);
}
function sendBlow() {
  const p = Number($('th-blow').value);
  $('th-blow-val').textContent = p + ' Pa';
  post({ type: 'blow', pressure: p });
}
function sendFinger() {
  const n = Number($('th-finger').value);
  $('th-finger-val').textContent = String(n);
  const mask = new Array(8).fill(false);
  for (let i = 8 - n; i < 8; i++) mask[i] = true;
  post({ type: 'mask', mask });
}

// --- R4: record a fixed phrase and replay it forward / reversed --------
function phraseTrajectory() {
  // A legato phrase across three fingerings at a frame rate of 200 Hz, with
  // one breath dip so the recording contains both pressure and finger motion.
  const frameRate = lab.recorder.frameRate;
  const seconds = 1.8;
  const frames = [];
  for (let i = 0; i < seconds * frameRate; i++) {
    const t = i / frameRate;
    let openCount = 2;
    if (t >= 0.6 && t < 1.2) openCount = 4;
    else if (t >= 1.2) openCount = 6;
    const mouthPa = (t >= 0.9 && t < 1.05) ? 300 : 2500;
    frames.push({ mouthPa, openCount });
  }
  return frames;
}

function playBuffer(ctx, samples) {
  const buf = ctx.createBuffer(1, samples.length, FS);
  buf.copyToChannel(Float32Array.from(samples), 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}

function record() {
  const frames = lab.recorder.record(phraseTrajectory());
  const withPitch = frames.filter((f) => f.frequencyHz !== null).length;
  $('perf-record-out').innerHTML =
    `<div>recorded <strong>${frames.length}</strong> frames, ${withPitch} with measured pitch</div>` +
    `<div>fingering blocks: ${[...new Set(frames.map((f) => f.openCount))].join(' → ')}</div>`;
}

async function replay(reverse) {
  if (!lab.started) await startTonehole();
  const result = lab.recorder.replay({ reverseFingering: reverse });
  if (lab.ctx) playBuffer(lab.ctx, result.audio);
  const fingers = [...new Set(result.frames.map((f) => f.openCount))];
  const pitched = result.frames.filter((f) => f.frequencyHz !== null);
  const meanHz = pitched.length
    ? pitched.reduce((s, f) => s + f.frequencyHz, 0) / pitched.length : 0;
  $('perf-record-out').innerHTML =
    `<div>${reverse ? 'reversed fingering' : 'forward'} replay · finger order ${fingers.join(' → ')}</div>` +
    `<div>mean measured frequency <strong>${meanHz.toFixed(1)} Hz</strong> over ${pitched.length} pitched frames</div>`;
}

// --- R6/R7: distinguishing fragment ------------------------------------
function runFragment() {
  const dipSeconds = Number($('frag-dip').value) / 1000;
  const r = runDistinguishingFragment({ fs: FS, dipSeconds });
  const d = r.divergence;
  $('frag-out').innerHTML =
    `<div>dip <strong>${(dipSeconds * 1000).toFixed(0)} ms</strong></div>` +
    `<div>peak history-vs-restart difference: <strong>${Math.round(d.peakDifferencePa)} Pa</strong></div>` +
    `<div>settled RMS each: ${Math.round(d.settledRms)} Pa (reconverged: ${d.peakDifferencePa < 5 ? 'yes' : 'after a transient'})</div>`;
  plotFragment(r);
}

function plotFragment(r) {
  const canvas = $('frag-canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 600, h = 180;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  // Plot an envelope around the recovery instant for both engines.
  const { dipEndSample, fs } = r.fragment;
  const span = Math.round(0.12 * fs);
  const win = Math.round(0.002 * fs);
  const ptsH = [], ptsR = [];
  for (let s = dipEndSample - Math.round(0.02 * fs); s < dipEndSample + span; s += win) {
    ptsH.push(rms(r.history.subarray(s, s + win)));
    ptsR.push(rms(r.restart.subarray(s, s + win)));
  }
  const maxV = Math.max(...ptsH, ...ptsR, 1);
  const x = (i) => 24 + (i / (ptsH.length - 1)) * (w - 32);
  const y = (v) => h - 16 - (v / maxV) * (h - 32);
  const draw = (pts, color) => {
    g.strokeStyle = color; g.lineWidth = 1.6; g.beginPath();
    pts.forEach((v, i) => { if (i === 0) g.moveTo(x(i), y(v)); else g.lineTo(x(i), y(v)); });
    g.stroke();
  };
  draw(ptsH, '#7fa8a0');
  draw(ptsR, '#c9a45c');
  g.fillStyle = '#a89c88'; g.font = '11px ui-sans-serif, system-ui';
  g.fillText('teal: history kept   gold: restarted from seed', 24, 14);
}

// --- R5: close-restore acceptance --------------------------------------
function runCloseRestoreUi() {
  const closeMs = Number($('cr-ms').value);
  const r = runCloseRestore({ fs: FS, closeMs });
  $('cr-out').innerHTML =
    `<div>close <strong>${r.closeMs} ms</strong> · vibration survived: <strong>${r.vibrationSurvived}</strong></div>` +
    `<div>min RMS during close: ${Math.round(r.minRmsDuringClose)} Pa · RMS before ${Math.round(r.rmsBefore)} / after ${Math.round(r.rmsAfter)}</div>`;
}

export function bootToneholeLab() {
  $('th-start').addEventListener('click', startTonehole);
  $('th-stop').addEventListener('click', stopTonehole);
  $('th-stop').disabled = true;
  $('th-blow').addEventListener('input', sendBlow);
  $('th-finger').addEventListener('input', sendFinger);
  $('perf-record').addEventListener('click', record);
  $('perf-replay').addEventListener('click', () => replay(false));
  $('perf-replay-reverse').addEventListener('click', () => replay(true));
  $('frag-dip').addEventListener('input', (e) => {
    $('frag-dip-val').textContent = e.target.value + ' ms';
  });
  $('frag-run').addEventListener('click', runFragment);
  $('cr-ms').addEventListener('input', (e) => {
    $('cr-ms-val').textContent = e.target.value + ' ms';
  });
  $('cr-run').addEventListener('click', runCloseRestoreUi);
}
