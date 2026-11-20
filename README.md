# Reed–bore lab

A blown single-reed instrument (clarinet-like) whose sound is produced by a
nonlinear reed valve coupled to a travelling-wave bore. The reed and the tube
are solved together at audio rate: there is no note→sine mapping and no
recorded long tone anywhere in the path.

- `src/core/reed-bore.js` — the model. Used verbatim by the browser worklet,
  by the offline scripts, and by the tests.
- `src/core/tonehole-bore.js` — a second, *bidirectional* engine in which an
  open hole is a real shunt-scattering junction rather than a delay shortcut.
- `src/core/performance.js` — recording/reverse replay and the parallel
  history-vs-restart acoustic states used by the tone-hole lab.
- `src/core/analysis.js` — FFT, pitch estimators, envelope, decay fit, delay
  budget. Also shared.
- `src/worklet/reed-bore-worklet.js` — AudioWorklet host. The realtime sound.
- `src/worklet/tonehole-bore-worklet.js` — AudioWorklet host for the physical
  tone-hole engine.
- `public/` — playing panel + measurement lab.
- `scripts/offline-measure.js` — renders WAV/JSON with the same core.
- `scripts/tonehole-measure.js` — tone-hole pitch, register hysteresis,
  parallel-state and close-restore measurements.
- `out/` — committed measurement output (`npm run offline`).
- `tests/core.test.js` — physics and numerical-behaviour tests.
- `tests/tonehole-bore.test.js`, `tests/performance.test.js` — tone-hole
  engine and performance-layer tests.

## Run it

```bash
npm start                  # static server -> http://localhost:8080/
npm test                   # core, tone-hole and performance tests (node --test)
npm run offline            # regenerate out/measurements.json and the WAVs
npm run offline:tonehole   # regenerate out/tonehole/ (pitch, hysteresis, parallel states)
```

No dependencies are required; Node ≥ 18. Use Chrome/Edge/Firefox/Safari with
AudioWorklet. The UI needs a user gesture for audio: press **Start audio**.
Then drag **Breath pressure**, hold **Blow (hold)**, or press `M` to blow and
`S` to stop. `0`–`8` select how many holes are open from the bell, or use the
preset buttons. Everything you hear is `ReedBore.step()` -> `toAudio()`.

## The playing panel

- **Breath pressure** is continuous mouth pressure in Pa. The core clamps to
  0–5000 Pa and the status line reports clamping; invalid values are reported
  as a fault instead of being discarded.
- **Fingering** changes the effective speaking length. The delay is glided over
  ~8 ms to avoid a click; the label ("4 open") is only a UI label. The sound is
  always produced by the loop.
- **Readouts**: mouth pressure, bore pressure at the reed, valve flow (mean
  over the meter window and its most negative value — negative means air is
  flowing back from the bore into the mouth), reed gap,
  delay in samples, and the *geometric* expected pitch. The lab reports the
  *measured* pitch next to it.
- **Scopes** show mouth pressure and the peak envelope of bore pressure and
  audio per 16 ms window. They are envelopes, not raw samples: sampling a
  280 Hz waveform at 60 Hz would only produce aliasing.
- **Faults** (invalid input, numerical overflow) are latched, shown in a
  banner, and the core is reset. The banner stays until acknowledged.
- **Play scripted phrase** runs a short legato/hold/release sequence through
  the same message path as the controls.
- **Measurement lab** renders offline in the tab using the same core and
  computes pitch per fingering, numerical spread, threshold sweep, attack and
  release. **Delivery trajectories** render a slow rise, a step, and two
  near-threshold cases, plotting internal state and the spectrum, and play the
  render once through a Web Audio buffer.

## Model

State variables per sample:

| symbol | meaning |
|---|---|
| `gap`, `gapVel` | reed opening (m) and velocity, 2nd-order mechanics |
| `line[]` | forward travelling pressure wave in the bore (Pa) |
| `reflState` | bell reflection lowpass state |
| `audioDcX/Y` | shared output DC blocker |

Loop, evaluated every internal sample:

```
b   = -bellReflection * (1-a) * LP_a( line[n - D] )       // bell return
gap'' = w0^2 (gapTarget - gap) - 2 ζ w0 gap'              // reed
gapTarget = clamp(restGap - compliance (P0 - p), 0, restGap)
q(dp)     = sign(dp) * Cd * width * gap * sqrt(2/rho) * |dp|/sqrt(|dp|+eps)
p+ = b + Z0 q(P0 - p)          // solved implicitly, Newton, 3 iters
p  = p+ + b
line[n] = p+
```

Consequences worth noting:

- **Self-oscillation is emergent.** The loop is stable with no blowing and
  starts oscillating only above a pressure threshold. The threshold and the
  amplitude growth are measured, not scripted.
- **The valve is bidirectional.** When a returning bore wave lifts `p` above
  the mouth pressure, air flows back. A check valve would rectify this and
  trap DC pressure in the bore; the tail tests show the difference.
- **The orifice law is smoothed near zero pressure difference**
  (`lowPressureSmooth = 30 Pa`, i.e. `|dp|/sqrt(|dp|+ε)` instead of
  `sqrt(|dp|)`). A true square-root law has unbounded conductance at `dp = 0`;
  in a sampled loop that produced a spurious Nyquist-rate limit cycle with the
  valve closed. The smoothed law is linear in that tiny region and matches
  `sqrt|dp|` above a few tens of Pa.
- **The junction is implicit.** Solving `p+ = b + Z0 q(P0 - p+ - b)` with
  Newton removes the one-sample algebraic delay that otherwise allowed a
  Nyquist oscillation. The reed itself is updated explicitly (2nd order,
  oversampled), which is fine because its resonance is far below Nyquist.
- **The bell is a lossy pressure-release reflection.** The one-pole has dc
  gain `1-a` (< 1) and its phase delay is added back into the tube delay. A
  unity-gain series lowpass would leave the loop marginally stable.
- **Fractional delay** uses 4-point Lagrange interpolation; `linear` is also
  selectable. Both are tested across oversampling 1×/2×/4×.
- **Two levels of guard**: the model clamps its own states and reports an
  overflow fault after resetting; the UI latches and displays that fault.

Parameters live in `DEFAULT_CONFIG` in `src/core/reed-bore.js`, all in SI.
Reed: rest gap 0.5 mm, static compliance 0.18 µm/Pa, reed resonance 2.8 kHz,
damping ratio 0.5, discharge coefficient 0.6. Bore: 4.5 mm radius, 300 mm
closed length, 8 tone holes, c = 343 m/s, 2× oversampling.

## Physical tone-hole engine (`ToneholeBore`)

`ReedBore` stores one forward wave and models a fingering by shortening its
delay. `ToneholeBore` models what an open hole physically does: a shunt
admittance at a fixed spatial position that reflects part of the outgoing wave
back to the reed and transmits the rest toward the bell.

### Single-active-junction topology

A well-vented woodwind is dominated by its most mouth-ward open hole; the holes
beyond it only fix where that junction sits. So exactly **one** junction
scatters, splitting the guide into two physical segments:

- segment A = reed ↔ active hole, the speaking reflector (a pair of one-way
  delay lines `rA`/`lA`);
- segment B = active hole ↔ bell, the transmitted tail (`rB`/`lB`).

With all holes closed there is no junction; `rA`/`lA` span reed ↔ bell and the
bell terminates the loop. Either way the speaking round trip is the two one-way
lines, `2·delayA`. The pressure junction with normalised shunt admittance
`gh·Z0` is

```
pJ    = 2 (r+ + l-) / (2 + gh)
r+out = pJ - l-          (toward the bell)
l-out = pJ - r+          (back to the reed)
```

A well-vented open hole behaves almost like a pressure-release termination;
`holeGamma = 25` gives a junction reflection `gamma/(2+gamma) ≈ 0.93` and lands
the pitch within a few cents of the geometric quarter-wave target.

Every substep reads all arriving waves before any buffer is pushed
(read-then-write, the same ordering as `ReedBore`), so a segment returns the
value pushed exactly `delay` substeps earlier. Each line carries the geometric
one-way time with the reed/lowpass phase trims split half into each direction.
All four buffers are sized for the largest one-way target so a retuned segment
can never alias its circular read index. The same implicit reed valve and
output stage as `ReedBore` are reused, so the two engines are level-matched.

Measured at 2500 Pa (`out/tonehole/pitch.json`), all nine fingerings sound
within **−5.3 … −9.2 cents** of `c/(4L_eff)` with no numerical faults.

### How the requirements are met

- **R1 — fingering changes the reflection/propagation conditions.** Opening a
  hole inserts a real shunt junction and moves it geometrically; it is not a
  delay-length edit. The delay lines are retuned in place (only the read head
  moves, never the buffer) and the admittance glides over ~8 ms, so the wave
  already in the bore is retained and re-scattered at the new junction.
- **R2 — register return-threshold hysteresis at constant pressure.** Two
  coupled Van der Pol modes (low and the 3rd eigenmode) compete; mouth pressure
  drives their growth and hole openness tilts which wins. They are an
  observation layer — they label the register but never alter the bore wave. At
  constant pressure the up-switch occurs near openness 0.525 and the down-switch
  near 0.225–0.25, a hysteresis width of ~0.28–0.30
  (`out/tonehole/hysteresis.json`). The same fingering therefore returns on a
  different threshold than it left.
- **R3 — continuous boundary control and two parallel acoustic states.**
  `setHoleOpenness(index, value)` sweeps a shunt admittance continuously, and
  `ParallelStates` runs two engines on identical input that differ only in
  whether the stored bore wave is kept. Fingering changes never reset the
  engine: `setDelay` plus the admittance glide preserve the in-bore waveform.
- **R4 — record and reverse-fingering replay.** `PerformanceRecorder` samples
  breath pressure, fingering and the model's *measured* audio frequency, then
  replays. Reverse replay keeps the pressure/timing order and plays the
  fingering sequence backwards.
- **R5 — brief close-restore acceptance.** `runCloseRestore` holds an open-hole
  note, briefly closes the holes and restores them with no reset. The vibration
  never stops (minimum RMS during the close stays above ~2400 Pa vs a sub-50 Pa
  noise floor) and the note returns at the same pitch
  (`out/tonehole/close-restore.json`); the register layer can still transition
  on the openness history.
- **R6 — restart vs history after a near-silent transition.** With the
  fingering fixed, the breath dips to a near-silent level then recovers. The
  history engine keeps its in-bore wave; the restart engine is cleared at the
  dip and regrows from the seed. They are bit-identical in steady state and
  separate only in the recovery transient.
- **R7 — the shortest distinguishing fragment is built in.** A dip **shorter
  than the ~100 ms bore decay** leaves residual energy only in the history
  engine. A 10 ms dip already gives a ~234 Pa peak separation (a 4 ms dip gives
  ~720 Pa); dips past ~50 ms let both bores empty and the distinction vanishes
  (`out/tonehole/parallel.json`, with `fragment-history.wav` /
  `fragment-restart.wav`). Run it from the tone-hole lab's "Run distinguishing
  fragment" button.

## What it does and does not model

Modelled: reed mechanics and valve nonlinearity, travelling-wave bore with
fractional delay, lossy bell reflection, eight steps of speaking length via
open holes, continuous mouth pressure, DC blocking and soft saturation in the
shared output stage.

Not modelled: a real tonehole lattice (a mask with a closed hole between two
open ones is only approximate; the intended mapping is contiguous open holes
from the bell), register holes, cross-fingerings, reed-mouthpiece cavity modes,
reed asymmetry, turbulence noise, embouchure and tongue articulation, and
wall losses beyond the single reflection pole. This is a sound-design model.
It is explicitly not a reproduction of any specific instrument.

## Measured behaviour

`npm run offline` writes `out/measurements.json` and WAVs. With the default
config (2× oversampling):

| quantity | result |
|---|---|
| pitch vs geometric `c/(4L_eff)`, 9 fingerings | −1.25 … −1.99 cents |
| numerical spread, os 1×/2×/4× × linear/cubic | ≈ 2.3 cents |
| static oscillation threshold (step, 1.5 s hold) | 1000 Pa (sustained) |
| audible onset on a 1.2 s ramp | 1525 Pa (see below) |
| envelope 10 %→90 % after a 3 kPa step | ≈ 29 ms (loop build-up, after the jump's own click) |
| 50 % level after a step | ≈ 9 ms |
| audio tail τ after release | ≈ 100 ms (fit r² ≈ 0.99999) |
| bore pressure 20 ms after release | ≈ 0.2 Pa |
| bore pressure 100 ms after release | ≈ 1e−8 Pa (below float noise floor) |
| residual pressure at 2.9 s | ~1e−28 Pa, reed at rest, zero flow |

Thresholds need care because they answer different questions:

- **Static threshold** ≈ 1000 Pa. Holding pressure at or above it for a second
  lets the loop grow from the noise floor and it locks into a tone; below it
  the loop decays.
- **Audible onset on a ramp** is later, and depends on the ramp speed:
  2400 Pa for a 0.15 s ramp, 2200 Pa for 0.3 s, 1800 Pa for 0.6 s, 1525 Pa
  for 1.2 s (`rampSpeed` in `measurements.json`). Above threshold the loop
  amplitude grows at a finite rate; a fast ramp spends too little time at
  each pressure for the tone to become audible. This is a property of the
  growth dynamics, not a second threshold.
- Below the threshold the output is a broadband valve trickle of tens of Pa
  RMS, not silence. That is real behaviour of this model, and the lab reports
  it instead of gating it to zero.

`measurements.json` keeps all of these (`criticalRegion.points`,
`ramp.onsetThreshold`, `rampSpeed`).

## Why measured pitch differs from `c/(4L)` — and what was done about it

`c/(4L_eff)` is not the whole story even for an ideal bore. Three terms were
separated:

1. **End corrections.** An open end adds `0.613 r` of acoustic length; an open
   tonehole adds `0.5 r_hole`; the mouthpiece/reed cavity adds 4.4 mm. These
   are geometric, in `effectiveLength()`, and account for the bulk of the
   difference between a naive `c/(4×0.30)` and reality.
2. **Fractional delay and interpolation.** The bore length is not an integer
   number of samples. The loop period is `D + frac` samples with `frac`
   realised by Lagrange interpolation. At 280 Hz this contributes a few
   thousandths of a sample; across 1×/2×/4× oversampling the measured pitch
   spread is ≈ 2.3 cents, so it is not the main term but it is visible and
   documented here.
3. **The reed end is not a pressure antinode.** A rigid wall gives a reflection
   with zero phase; a reed that admits flow gives a small, roughly constant
   phase lag. Measured by sweeping the delay trim until measured pitch matched
   the geometric prediction at every fingering, it is **22 µs** (about 2.2° of
   reflection phase at 280 Hz). This appears in the model as
   `reedEndPhaseDelaySeconds` and is subtracted from the bore delay, so the
   mapping from length to pitch is physical rather than a per-note tuning
   table. The lowpass reflection also has a phase delay of
   `2a/(1+a)` samples, added back for the same reason.

After these corrections, measured pitch is within 2 cents of `c/(4L_eff)` for
all nine fingerings, and the residual 2-cent trend (slightly flat as holes
open) is reported rather than tuned away. A sweep of the trim parameter and
the per-oversampling residuals are in `out/measurements.json` (`delayBudget`
and `numerics`).

Pitch still depends on blowing pressure: −23 cents at 1.2 kPa, −1 cent at
3 kPa, +4 cents at 4.2 kPa, +22 cents at 4.8 kPa (`pressurePitch` in
`measurements.json`). That is the reed moving the loop phase as its amplitude
changes, i.e. a real model behaviour; it is reported, not compensated.

## Files in `out/`

| file | contents |
|---|---|
| `measurements.json` | pitch table, numerics, threshold sweep, step/attack, tail snapshots, delay budget |
| `traces.json` | decimated internal state for the delivery trajectory |
| `ramp.wav` | slow rise to 3 kPa, hold, release |
| `step.wav` | 3 kPa step on/off |
| `critical-{900,1000,1100,1200}.wav` | near-threshold cases |
| `fingerings.wav` | nine 0.5 s notes, one per open-hole count |
| `demo-phrase.wav` | 4.2 s legato phrase, continuous breath with fingering changes |

## Reproducing

```bash
npm test                 # 23 tests, no browser required
npm run offline          # ReedBore measurements + WAVs
npm run offline:tonehole # ToneholeBore pitch/hysteresis/parallel-state output
npm start                # then open http://localhost:8080/
```

The committed `out/` was produced by the same core; rerunning is deterministic
for a given Node/float environment. The browser lab recomputes the same
metrics in-page, so the panel and the committed JSON can be compared directly.
