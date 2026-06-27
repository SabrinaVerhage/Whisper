# Whisper

Art installation backend. Visitors record a voice message from their phone — a secret, a desire, a confession. The recording is transformed into a generative whisper sound effect driven by the emotional content of the message, analysed for sensory qualities, and released as an entry into a shared field that others can explore.

The TTS never receives the original words. Instead, the message is classified into affective dimensions (breathiness, warmth, tension, energy…) that drive a procedural vocal score — a sequence of non-linguistic sounds (`mmm… shhhh… haaa…`) — which ElevenLabs renders in a chosen whispering voice. The content is discarded; only the mood survives.

## Pipeline

```
Phone (microphone)
       │
       ▼
POST /whispers  ──────────────────────────────────────▶  instant HTTP 200
       │
       ├── Phase 1 (~5s, awaited before response)
       │       Python --skip-transcription
       │       ├─ LPC whisperize  →  recordings/{id}-whisperized.wav
       │       └─ Praat + librosa  →  HNR, F0, spectral centroid, speech rate
       │               patch JSON  →  data/whispers/{id}.json
       │
       └── Phase 2 (background, ~30–120s)
               Python (full)
               ├─ Whisper ASR  →  transcript
               Ollama / dolphin-mistral
               ├─ rephrased  →  intimate restatement of original words
               ├─ semantics  →  8 thematic scores (sensory, taboo, longing…)
               └─ affect     →  6 performance parameters (breathiness, warmth…)
                       │
                       ▼
               generateVocalScore(affect)
               →  "[whispering] haaa ... mmm ... shhhh ... ahh ... mmm"
                       │
                       ▼
               ElevenLabs TTS (eleven_v3, Ellen voice)
               →  recordings/{id}-generated.mp3
                       │
                       patch JSON  →  generatedWhisperFile, vocalScore
```

The mobile play button uses the ElevenLabs file when available, falls back to the LPC-whisperized recording, then to synthesis if neither is ready.

## Setup

### 1. Node server

```bash
npm start
```

Server starts at `http://127.0.0.1:3000`.

To activate ElevenLabs, pass your API key and voice ID as environment variables:

```powershell
$env:ELEVENLABS_API_KEY  = "sk-..."
$env:ELEVENLABS_VOICE_ID = "..."   # Ellen's voice ID from elevenlabs.io/voice-library
node server.js
```

To find Ellen's voice ID, list your available voices:

```powershell
Invoke-RestMethod -Uri "https://api.elevenlabs.io/v1/voices" `
  -Headers @{"xi-api-key"="sk-..."} | ConvertTo-Json -Depth 3
```

### 2. Python analysis

Runs as a background subprocess after each whisper save. Requires Python 3.9+, ffmpeg in PATH, and a CUDA-capable GPU (falls back to CPU for ASR).

```bash
pip install -r analysis/requirements.txt
```

Dependencies: `librosa`, `praat-parselmouth`, `numpy`, `soundfile`, `openai-whisper`, `scipy`

Whisper ASR model (`small`) downloads on first run (~460 MB) and is cached in `~/.cache/whisper`.

### 3. Ollama (LLM classification)

```bash
winget install Ollama.Ollama   # or download from ollama.com
ollama pull dolphin-mistral
```

Ollama runs as a background service on `localhost:11434`. dolphin-mistral is an uncensored model that classifies content without content filters. To use a different model, change `OLLAMA_MODEL` in `server.js`.

## Pages

| URL | Description |
|-----|-------------|
| `/` or `/recorder` | Mobile voice recording + field exploration UI |
| `/admin` | Admin dashboard — list, inspect, delete entries; shows all three audio players per entry |
| `/umap` | Whisper Atlas — full field map with PCA/t-SNE layout, multiplayer cursor lenses, fingerprint on hover |
| `/gallery` | Gallery display — full-screen grid of all whisper fingerprints, intended for projection or ambient display |

## Mobile testing — HTTPS required

`getUserMedia` is blocked by browsers on non-HTTPS non-localhost connections. Use Tailscale:

```bash
tailscale serve 3000
```

## Affect dimensions

After transcription, Ollama classifies each message into six performance parameters that drive the vocal score generator. These are stored in `llm.affect`.

| Dimension | Effect on vocal score |
|-----------|----------------------|
| `breathiness` | More `shhh`, `fff`, `haa` tokens |
| `warmth` | More `mmm`, `ahh`, `ohh` tokens |
| `energy` | Density of sound events (3–8 tokens) |
| `tension` | More `nnn` / tight sounds vs open vowels |
| `playfulness` | Adds a `mhm` or rising inflection |
| `tempo` | Pause length between tokens (long = slow) |

## Semantic dimensions

Ollama also scores each message across 8 thematic dimensions (stored in `llm.semantics`). These feed into the field map alongside acoustic components — whispers are positioned in a 14-dimensional space (6 acoustic + 8 semantic).

| Dimension | What it captures |
|-----------|-----------------|
| `sensory` | Body sensations — what they want to feel, taste, touch |
| `relational` | Power dynamics, surrender, being seen, taken, worshipped |
| `taboo` | Things they would never say outside this installation |
| `tenderness` | Closeness, being held, vulnerability, softness |
| `fantasy` | Specific scenarios, settings, roles, situations |
| `identity` | Who they want to be in the moment, not just what they want |
| `longing` | Missing someone, wanting what they cannot have |
| `unspeakable` | Incomplete desires, half-sentences, things they struggle to finish saying |

## Sensuality Index

Each whisper gets a composite score (0–1) from six perceptual components derived from Praat and librosa analysis of the original recording:

| Component | Source | What it measures |
|-----------|--------|-----------------|
| breathiness | Praat HNR | Low HNR = more noise relative to harmonics |
| darkness | librosa spectral centroid | Low centroid = warmer, darker timbre |
| softness | browser RMS amplitude | Low amplitude = quieter |
| slowness | librosa syllable peaks | Low speech rate = slower delivery |
| pitchLowness | Praat F0 mean | Lower fundamental frequency |
| pitchSteadiness | Praat F0 range | Narrow pitch range = steadier voice |

Weights: breathiness 0.30 · darkness 0.20 · softness 0.15 · slowness 0.15 · pitchLowness 0.10 · pitchSteadiness 0.10. Renormalises when features are missing (`partial: true`).

## Data format

```json
{
  "id": "whisper_20260627_143200_b3afea",
  "createdAt": "2026-06-27T14:32:00.000Z",
  "source": "browser",
  "transcript": "Hello, I want to fuck your butt.",
  "audioFile": "recordings/whisper_20260627_143200_b3afea.webm",
  "whisperizedFile": "recordings/whisper_20260627_143200_b3afea-whisperized.wav",
  "generatedWhisperFile": "recordings/whisper_20260627_143200_b3afea-generated.mp3",
  "vocalScore": "[whispering] haaa ... shhhh ... mmm ... ahh ... mhm ... mmm ... shhhh",
  "llm": {
    "rephrased": "I want to fuck your butt.",
    "semantics": {
      "sensory": 0.9, "relational": 0.6, "taboo": 0.85, "tenderness": 0.2,
      "fantasy": 0.4, "identity": 0.3, "longing": 0.1, "unspeakable": 0.1
    },
    "affect": {
      "breathiness": 0.8, "warmth": 0.5, "energy": 0.6,
      "tension": 0.3, "playfulness": 0.55, "tempo": 0.45
    },
    "model": "dolphin-mistral"
  },
  "features": {
    "amplitude": 0.18, "noisiness": 0.34, "tremble": 0.09,
    "hnr": 8.4, "f0Mean": 192.3, "f0Range": 45.1,
    "spectralCentroid": 1840.2, "speechRate": 3.1
  },
  "sensuality": {
    "score": 0.61,
    "components": {
      "breathiness": 0.66, "darkness": 0.72, "softness": 0.80,
      "pitchLowness": 0.48, "pitchSteadiness": 0.71
    },
    "partial": false
  },
  "fieldPosition": { "x": 42.3, "y": 67.1 }
}
```

## Whisper fingerprint

Every whisper generates a unique generative blob animation — its *fingerprint* — driven entirely by the stored acoustic and semantic data. Fully deterministic: the same record always produces the same composition.

The fingerprint appears on the mobile **analyzing screen**, when tapping the **play dot** on the field screen, via the **▶ replay fingerprint** button, in the **Whisper Atlas** on hover, and in the **Gallery** as a full-screen grid.

Rendering lives in `public/fingerprint.js` — one shared class, no dependencies.

### Animation phases

| Phase | Timing | What happens |
|-------|--------|-------------|
| **FORMING** | 0 → `formingMs` (default 2 500 ms) | Blobs grow from zero, drift outward from center |
| **SETTLING** | `formingMs` → `+settlingMs` (default 2 000 ms) | Blobs lerp to their fixed resting positions |
| **RESTED** | After settling | Stationary — gentle **BREATHE** pulse only (the fingerprint) |
| **SHRINK** | External trigger | Scale + alpha → 0 over ~1 450 ms with per-element stagger |

### Blob layers (draw order)

1. **Background wash** — when any acoustic value exceeds 0.65 the dominant-color blob produces a large near-transparent fill behind everything, setting the composition's color mood
2. **Sensory semantic blob** — soft pale-pink bloom, drawn before acoustic blobs when `sensory > 0.4`
3. **4 acoustic blobs** — one per sensuality component, each with its own color, size, orbit radius, and breathing frequency

   | Blob | Color | Driven by |
   |------|-------|-----------|
   | breathiness | `#FF2D8E` pink | `breathiness` value |
   | darkness | `#8A2BE2` purple | `darkness` value |
   | softness | `#FFAE00` amber | inverted `softness` (high softness → smaller) |
   | pitchLowness | `#FF5070` rose | `pitchLowness` value |

4. **Satellite orbs** — small orbiting spheres. Count = `Math.round(2 + breathiness × 3)`, capped at `satelliteMax` (default 5)
5. **Conditional semantic blobs** — appear only when their score is meaningfully above 0.5: taboo (dark wine), identity (white-gold), unspeakable (near-black)
6. **Large accent dots** — 3 fixed-position colored circles (8–36 px radius) that give the composition its hard highlights
7. **Sparkle particles** — tiny twinkling dots (1.5–4 px). Count = (`particleBase` + up to 15 from audio `duration`) × `(1 + fantasy × particleFantasyScale)`. Both the floor and the fantasy multiplier are configurable.
8. **Specular highlights** — white glint on each main blob

**Edge fade**: a CSS `radial-gradient` mask is applied to the canvas element so blobs that extend beyond the rectangular boundary dissolve in a soft circle rather than hard-clipping.

### Fingerprint config (Admin → Fingerprint card)

All settings are persisted in `data/config.json` with an `fp_` prefix and sent to every page via `GET /config`.

| Field | Default | Description |
|-------|---------|-------------|
| `fp_positionSpread` | 0.55 | Rest-position spread — 0 tight cluster → 1 fills canvas |
| `fp_orbitSpread` | 0.80 | Orbit radius multiplier per blob value |
| `fp_breathinessSizeScale` | 1.0 | Size multiplier for the breathiness blob |
| `fp_darknessSizeScale` | 1.0 | Size multiplier for the darkness blob |
| `fp_softnessSizeScale` | 1.0 | Size multiplier for the softness blob |
| `fp_pitchLownessSizeScale` | 1.0 | Size multiplier for the pitchLowness blob |
| `fp_accentDotCount` | 3 | Number of large accent dots (0 = disabled) |
| `fp_accentDotMaxSize` | 28 | Maximum radius of an accent dot in px |
| `fp_particleBase` | 5 | Minimum sparkle particle count (duration adds up to 15 more on top) |
| `fp_particleFantasyScale` | 0.8 | How much `fantasy` multiplies particle count (0 = ignore variable) |
| `fp_satelliteMax` | 5 | Cap on satellite orb count (breathiness drives 2 → max) |
| `fp_formingMs` | 2 500 | FORMING phase duration in ms |
| `fp_settlingMs` | 2 000 | SETTLING phase duration in ms |
| `fp_breatheStrength` | 1.0 | BREATHE pulse multiplier (0 = frozen, 2 = strong) |
| `fp_maskInner` | 55 | % radius where the circular edge fade begins |
| `fp_maskOuter` | 92 | % radius where the circular edge fade reaches transparent |

The admin **Fingerprint** card shows a live 160 × 160 px preview that updates as you move any control, before saving.

## Gallery display

`/gallery` shows all whisper fingerprints as a full-screen animated grid, designed for projection or as an ambient screen at the installation venue.

- **Grid**: configurable rows × columns (default 8 × 4), scales to fill any screen
- **Animation**: fingerprints appear one by one in a staggered wave, then cycle through a rolling re-bloom sequence — each cell forms, settles, breathes, shrinks, and re-forms on a loop
- **Themes**: dark (`#06010f`) or light (`#ede8f2` warm cream-lavender)
- **Labels**: WSPR code and the LLM-rephrased phrase below each fingerprint

Gallery and fingerprint settings are controlled from the **Admin** sidebar cards and persisted to `data/config.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `galleryCols` | 8 | Number of columns |
| `galleryRows` | 4 | Number of rows |
| `galleryTheme` | `dark` | `dark` or `light` |
| `galleryParadeInterval` | 10 000 ms | Pause between re-blooms |
| `galleryMaxWhispers` | 32 | Maximum entries shown |

## WebSocket multiplayer

A lightweight WebSocket layer in `server.js` connects phones and the Atlas in real time. Phones send joystick position updates; the Atlas renders a live lens circle per connected phone showing which part of the field they are exploring.

## File structure

```
server.js                  Node HTTP server (no npm runtime dependencies)
public/
  index.html               Mobile recording + field UI
  recorder.js              Recording flow, submission, fingerprint, joystick, field playback
  recorder.css             Mobile styles
  fingerprint.js           Shared deterministic blob renderer
  admin.html               Admin dashboard (original + LPC whisperized + ElevenLabs players)
  umap.html                Whisper Atlas — PCA/t-SNE field, multiplayer lenses
  gallery.html             Gallery display — fingerprint grid for projection / ambient display
analysis/
  analyze.py               Python: LPC whisperize, Praat, librosa, Whisper ASR
  requirements.txt         librosa, praat-parselmouth, numpy, soundfile, openai-whisper, scipy
data/
  config.json              Persisted settings (OSC + gallery display + fingerprint config)
  whispers/                Per-entry JSON records
  whispers.jsonl           Append-only archive
recordings/                {id}.webm  +  {id}-whisperized.wav  +  {id}-generated.mp3
```

## API

| Method | Path | Description |
|--------|------|-------------|
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Mobile UI |
| GET | `/admin` | Admin dashboard |
| GET | `/umap` | Whisper Atlas |
| GET | `/gallery` | Gallery display |
| GET | `/health` | Status JSON |
| GET | `/whispers` | List all whispers newest-first |
| POST | `/whispers` | Save a new whisper (add `?sync=1` to await phase 1 analysis) |
| DELETE | `/whispers/:id` | Delete entry + audio files |
| GET | `/recordings/:filename` | Stream audio |
| GET | `/config` | Current config (OSC + gallery settings) |
| PATCH | `/config` | Update OSC settings, gallery settings (`galleryRows`, `galleryCols`, `galleryTheme`, `galleryParadeInterval`, `galleryMaxWhispers`), and fingerprint settings (`fp_positionSpread`, `fp_orbitSpread`, `fp_*SizeScale`, `fp_accentDot*`, `fp_formingMs`, `fp_settlingMs`, `fp_breatheStrength`, `fp_maskInner`, `fp_maskOuter`) |
| POST | `/osc/live` | Relay live features via OSC |
