# CLAUDE.md — Whisper project

Art installation backend. Visitors submit a spicy fantasy or message from their phone; it is synthesised into a whisper sound effect, analysed for sensory qualities, and placed as an entry in a shared field that others can explore.

## Key architectural decisions

**No npm packages in the core server.** `server.js` uses only Node built-ins (`http`, `fs/promises`, `path`, `dgram`, `child_process`, `crypto`, `url`). Playwright is in `node_modules` for testing only — don't install additional runtime dependencies.

**Hybrid OSC/HTTP.** Processing polls `GET /whispers` directly every ~3s rather than relying solely on OSC push. OSC is still sent on save (`/whisper/saved`) and on live frames (`/whisper/live`), but Processing doesn't depend on it for its archive view.

**Whisper generation is a new pipeline step (TBD).** After receiving the message text, the server (or Python subprocess) generates a whisper audio file before running Praat/librosa analysis. Generation method is undecided — local TTS library or an API call. The rest of the pipeline (sensuality index, UMAP, storage) is unchanged. Don't await generation before sending the HTTP response.

**Python analysis is background, non-blocking.** `runPythonAnalysis()` spawns Python after the HTTP response is already sent. The record is saved first, then patched in-place when Python finishes (usually within 5–30s). Python now receives the *generated* whisper audio path, not a user recording. Never await Python before responding to Max/browser.

**Generated audio stored to recordings/.** The Python step writes the synthesised whisper file to `recordings/{id}-generated.wav`. The Python script uses `librosa.load()` which handles wav/ogg/mp4 via ffmpeg.

## File map

```
server.js           Main HTTP server — routes, OSC, file I/O, spawn Python
public/
  index.html        Mobile message submission UI
  recorder.js       Text input + submission flow; live SI meter may be removed or repurposed
  recorder.css      Mobile styles — dark/light card aesthetic, brand colors
  admin.html        Admin dashboard — single-file, self-contained JS + CSS
  umap.html         Field map — primary mobile exploration interface; pure-JS PCA/t-SNE, no CDN
analysis/
  analyze.py        Python: [TBD] whisper generation + Praat (parselmouth) + librosa
                    (analyses generated audio, not user voice)
  requirements.txt  librosa, praat-parselmouth, numpy, soundfile
Processing/Whisper/Whisper.pde   Processing sketch
Max/WhisperRecord.maxpat         Max patch
data/config.json    Persisted config (oscHost, oscPort, audioInputMode)
data/whispers/      One JSON per entry
data/whispers.jsonl Append-only archive
recordings/         Generated whisper audio files
```

## Sensuality Index

Computed in `computeSensualityIndex(features)` in `server.js`. Six components, each normalised to [0,1]:

| Component | Formula | Prefers |
|-----------|---------|---------|
| breathiness | `normInv(hnr, 0, 25)` or `norm(noisiness, 0, 1)` | low HNR or high ZCR |
| darkness | `normInv(spectralCentroid, 500, 4000)` or `normInv(brightness, 0, 1)` | low centroid |
| softness | `normInv(amplitude, 0.02, 0.6)` | quiet |
| slowness | `normInv(speechRate, 2, 6)` | slow syllable rate |
| pitchLowness | `normInv(f0Mean, 80, 300)` | low pitch |
| pitchSteadiness | `normInv(f0Range, 20, 200)` | narrow pitch range |

Weights: breathiness 0.30, darkness 0.20, softness 0.15, slowness 0.15, pitchLowness 0.10, pitchSteadiness 0.10. Renormalise if any component is missing — mark `partial: true` when totalWeight < 0.95.

Praat/librosa features take priority over browser approximations when both are available. The formula tries Praat first, falls back to browser ZCR/amplitude.

## Web Audio live analysis (recorder.js)

**Likely to change** — if the input becomes text-only, the live mic meter below may be removed or repurposed.

`animateMeter()` runs on `requestAnimationFrame` during recording:
1. `analyser.getFloatTimeDomainData(timeData)` → `analyzeSamples()` → `{amplitude, noisiness, tremble}`
2. `analyser.getFloatFrequencyData(freqData)` → `computeSpectralCentroid()` → darkness
3. `computeLiveSI(amplitude, noisiness, centroidHz)` → EMA-smoothed bar heights in `#liveSI`
4. `updateLiveAura(amplitude)` → scales the ring
5. `postLiveFeatures(latestFeatures)` → throttled POST to `/osc/live` every 120ms

The `analyser.fftSize` is 2048. `freqData` is `Float32Array(1024)` (frequencyBinCount = fftSize/2). Both are read each frame — no separate FFT needed, the AnalyserNode does it internally.

## Admin dashboard (admin.html)

Fully self-contained — no external scripts. Key functions:

- `renderWhispers()` rebuilds `list.innerHTML` from scratch on every fetch (every 5s). Always calls `drawnAudio.clear()` before rebuilding — canvas elements are destroyed by innerHTML replacement.
- `toggle(id)` expands/collapses a whisper entry. Checks `drawnAudio.has(id)` before firing `drawAudioVisuals()`.
- `drawAudioVisuals()` decodes the audio with the Web Audio API, then runs `drawWaveform()` (amplitude envelope) and `drawSpectrogram()` (custom FFT=512/HOP=128, 0–5kHz, log-mag, purple→cyan colormap).

The spectrogram bug pattern to avoid: if `drawnAudio` is not cleared before rebuilding the DOM, re-opening an already-seen entry will skip drawing because the ID is still in the Set but the canvas is now a fresh blank element.

## Field map (umap.html)

Pure JS, no CDN. Algorithm auto-selects:
- `n < 8`: PCA only (power iteration, 2 components)
- `n >= 8`: t-SNE-like layout initialised from PCA, 350 iterations with momentum

Feature vector per entry: 14 dimensions — 6 acoustic + 8 semantic. Missing values default to 0.5. Entries with no components at all are excluded.

**6 acoustic** (from `sensuality.components`): `breathiness, darkness, softness, slowness, pitchLowness, pitchSteadiness`

**8 semantic** (from `llm.semantics`, scored by dolphin-mistral): `sensory, relational, taboo, tenderness, fantasy, identity, longing, unspeakable`

Entries without Ollama data default all semantic scores to 0.5 and cluster by acoustic features only.

## OSC (dgram UDP)

Sent from `server.js` via `sendOsc()` which encodes a minimal OSC bundle manually (no library). Target defaults to `127.0.0.1:12000`. Configurable via `PATCH /config` or env vars.

OSC messages:
- `/whisper/live` — amplitude, noisiness, tremble (live, every 120ms max)
- `/whisper/saved` — id, transcript, intensity, texture, motion, amplitude, brightness, tremble (on save)

## Storage pattern

```javascript
// Write order on POST /whispers:
// 1. Receive message text from browser
// 2. Build record with message + placeholder features
// 3. computeSensualityIndex(features)  →  record.sensuality  (partial at this stage)
// 4. Write data/whispers/{id}.json
// 5. Append to data/whispers.jsonl
// 6. Send HTTP 200 with the record
// 7. Background: runPythonAnalysis(message) →
//    1.5. [TBD] Generate whisper audio → write recordings/{id}-generated.wav
//         then Praat/librosa on generated audio → patch JSON with real features
```

## Brand colors (recorder.css)

```
--pleasure:  #FF2D8E   pink  (breathiness in live-si)
--curiosity: #8A2BE2   purple (darkness in live-si)
--energy:    #FFAE00   amber (softness in live-si)
--tech:      #141018   near-black
--paper:     #F3F2F0   off-white
```

Admin uses its own dark palette (--bg: #0a0a0f, --accent: #7b6fff).

## Routes

| Method | Path | Handler |
|--------|------|---------|
| GET | `/` or `/recorder` | serve `public/index.html` |
| GET | `/admin` | serve `public/admin.html` |
| GET | `/umap` | serve `public/umap.html` |
| GET | `/public/*` | static file from `public/` |
| GET | `/health` | JSON status |
| GET | `/config` | current config JSON |
| PATCH | `/config` | update oscHost/oscPort/audioInputMode |
| GET | `/whispers` | list all whispers newest-first |
| POST | `/whispers` | save new whisper |
| DELETE | `/whispers/:id` | delete whisper + audio |
| POST | `/whispers/:id/analyze` | re-run Python pipeline (transcription + acoustics + Ollama) on existing entry |
| POST | `/whispers/:id/generate` | (re)generate ElevenLabs voice for existing entry |
| GET | `/recordings/:filename` | stream audio file |
| POST | `/osc/live` | relay live features via OSC |

## Python subprocess

`runPythonAnalysis(audioFilePath)` in `server.js` spawns `python analysis/analyze.py <path>`. 60s timeout. Reads JSON from stdout. On success, patches the whisper's stored JSON. On any failure (Python not found, import error, timeout) it silently returns null — the record stays with browser-only features.

The script outputs all features it can compute, wrapping each block in try/except. It never crashes the whole script for one missing feature.

## What to avoid

- Don't add npm runtime dependencies to `server.js`
- Don't await Python analysis or whisper generation before sending the HTTP response (latency would be 5–30s+)
- Don't clear `drawnAudio` without also scheduling redraws for currently-expanded items
- Don't use `list.innerHTML` on a single item — the whole list is always rebuilt from `whisperData`
- The Processing sketch polls `/whispers`; don't break its JSON shape (`whispers` array, `sensuality.score`, `features.*`)

## Open questions / TBD

| Item | Status |
|------|--------|
| Whisper generation method | TBD — local TTS + pitch-shift lib, or external API (ElevenLabs, Google TTS, etc.) |
| Input modality | TBD — typed text, or voice recorded → transcribed → then generate whisper? |
| Phone field navigation | TBD — screen-as-joystick, tap-to-navigate, or device motion/gyroscope |
