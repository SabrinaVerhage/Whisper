import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (Node built-ins only — no dotenv package).
// Reads KEY=value lines from .env at startup. Real process.env vars always win,
// so systemd/shell-exported values override the file on the VPS.
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(path.join(__dirname, ".env"));

const DATA_DIR = path.join(__dirname, "data");
const WHISPERS_DIR = path.join(DATA_DIR, "whispers");
const RECORDINGS_DIR = path.join(__dirname, "recordings");
const PUBLIC_DIR = path.join(__dirname, "public");
const JSONL_PATH = path.join(DATA_DIR, "whispers.jsonl");
// CONFIG_PATH defaults to data/config.json inside the repo, but can be pointed
// OUTSIDE the repo via WHISPER_CONFIG_PATH so git operations can never touch it.
// Recommended on a VPS: WHISPER_CONFIG_PATH=/etc/whisper/config.json
const CONFIG_PATH = process.env.WHISPER_CONFIG_PATH
  ? path.resolve(process.env.WHISPER_CONFIG_PATH)
  : path.join(DATA_DIR, "config.json");
const CONFIG_EXAMPLE_PATH = path.join(DATA_DIR, "config.json.example");
const MAX_BODY_BYTES = 25 * 1024 * 1024;

let config = {
  port: Number(process.env.PORT || 3000),
};

function json(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end(body);
}

function text(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(body);
}

function sendFile(response, filePath, contentType) {
  return readFile(filePath).then((content) => {
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": content.length,
      "Cache-Control": "no-store",
    });
    response.end(content);
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readJson(request) {
  const body = await readBody(request);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

async function ensureStorage() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(WHISPERS_DIR, { recursive: true });
  await mkdir(RECORDINGS_DIR, { recursive: true });
}

async function loadConfig() {
  // The committed example supplies DEFAULTS and any NEW keys added in later
  // releases. The live config (CONFIG_PATH, gitignored) holds the operator's
  // saved values and ALWAYS wins for keys it already has — so a `git pull` that
  // adds a new setting is picked up, but never overwrites what you've set.
  let example = {};
  try { example = JSON.parse(await readFile(CONFIG_EXAMPLE_PATH, 'utf8')); } catch {}

  let saved = {};
  const savedExisted = existsSync(CONFIG_PATH);
  if (savedExisted) {
    try {
      saved = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error(`Failed to parse config at ${CONFIG_PATH}:`, err.message);
    }
  }

  const merged = { ...example, ...saved };   // saved overrides example
  Object.assign(config, merged);
  console.log(`Config loaded from ${CONFIG_PATH}`);

  // Persist the merged result so config.json gains new example keys and exists
  // on first boot. Existing saved values are untouched (they already won above).
  if (!savedExisted || JSON.stringify(merged) !== JSON.stringify(saved)) {
    await saveConfig();
  }
}

async function saveConfig() {
  const { port, ...saveable } = config;
  try {
    await writeFile(CONFIG_PATH, JSON.stringify(saveable, null, 2), 'utf8');
    console.log(`Config saved to ${CONFIG_PATH}`);
  } catch (err) {
    console.error(`Failed to save config to ${CONFIG_PATH}:`, err.message);
  }
}

function makeId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
  return `whisper_${stamp}_${crypto.randomBytes(3).toString("hex")}`;
}

function localInterpretation({ features = {}, transcript = "", tags = [] }) {
  const brightness = numberOr(features.brightness, 0);
  const breath = numberOr(features.breath ?? features.breathiness ?? features.amplitude, 0);
  const tremble = numberOr(features.tremble, 0);
  const noisiness = numberOr(features.noisiness, brightness);

  const intensity = breath > 0.72 ? "near" : breath > 0.34 ? "soft" : "distant";
  const texture = noisiness > 0.58 ? "grain" : brightness > 0.42 ? "glass" : "mist";
  const motion = tremble > 0.52 ? "shivering" : breath > 0.55 ? "expanding" : "drifting";
  const palette = brightness > 0.5 ? ["pearl", "cyan", "coral"] : ["moss", "amber", "ivory"];

  return {
    intensity,
    texture,
    motion,
    palette,
    prompt: [transcript || "wordless whisper", texture, motion, ...tags].filter(Boolean).join(", "),
  };
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function saveAudio(id, audioBase64, audioMime = "audio/wav") {
  if (!audioBase64) return null;

  const extension = audioMime.includes("mpeg")
    ? "mp3"
    : audioMime.includes("ogg")
      ? "ogg"
      : audioMime.includes("webm")
        ? "webm"
        : "wav";
  const audioFile = path.join(RECORDINGS_DIR, `${id}.${extension}`);
  await writeFile(audioFile, Buffer.from(audioBase64, "base64"));
  return path.relative(__dirname, audioFile).replaceAll("\\", "/");
}

function normalizeAudioFile(audioFile) {
  if (!audioFile) return null;
  const normalized = `${audioFile}`.replaceAll("\\", "/");
  if (path.isAbsolute(normalized)) return normalized;
  return normalized.replace(/^\/+/, "");
}

function analyzeBrowserFeatures(payload) {
  const features = payload.features || {};
  const samples = Array.isArray(payload.analysisSamples) ? payload.analysisSamples : [];
  if (!samples.length) return features;

  let sum = 0;
  let peak = 0;
  let crossings = 0;
  let previous = samples[0] || 0;
  const blockSize = Math.max(16, Math.floor(samples.length / 24));
  const blockRms = [];

  for (let index = 0; index < samples.length; index += 1) {
    const value = Number(samples[index]) || 0;
    const abs = Math.abs(value);
    sum += value * value;
    peak = Math.max(peak, abs);
    if ((previous < 0 && value >= 0) || (previous >= 0 && value < 0)) crossings += 1;
    previous = value;
  }

  for (let index = 0; index < samples.length; index += blockSize) {
    const block = samples.slice(index, index + blockSize);
    const blockEnergy = Math.sqrt(block.reduce((total, value) => total + value * value, 0) / Math.max(1, block.length));
    blockRms.push(blockEnergy);
  }

  const rms = Math.sqrt(sum / samples.length);
  const meanBlock = blockRms.reduce((total, value) => total + value, 0) / Math.max(1, blockRms.length);
  const variance = blockRms.reduce((total, value) => total + (value - meanBlock) ** 2, 0) / Math.max(1, blockRms.length);
  const tremble = Math.min(1, Math.sqrt(variance) / Math.max(0.001, meanBlock) / 2.5);
  const noisiness = Math.min(1, (crossings / samples.length) * 18);

  return {
    ...features,
    amplitude: roundFeature(features.amplitude ?? rms),
    peak: roundFeature(features.peak ?? peak),
    noisiness: roundFeature(features.noisiness ?? noisiness),
    tremble: roundFeature(features.tremble ?? tremble),
    duration: roundFeature(features.duration ?? payload.duration ?? 0),
  };
}

function roundFeature(value) {
  return Math.round(numberOr(value, 0) * 10000) / 10000;
}

function generateWsprCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(4))
    .map(b => chars[b % chars.length])
    .join('');
}

function computeFieldPosition(features, sensuality) {
  if (sensuality && sensuality.components) {
    const c = sensuality.components;
    // X: breathiness + darkness (airy + warm)
    const xRaw = (c.breathiness || 0) * 0.55 + (c.darkness || 0) * 0.45;
    // Y: softness + slowness (soft + slow = higher Y value)
    const yRaw = (c.softness || 0) * 0.55 + (c.slowness || 0) * 0.45;
    return {
      x: roundFeature(12 + xRaw * 76),
      y: roundFeature(12 + yRaw * 76),
    };
  }
  // Fallback: use basic browser features
  const noisiness = numberOr(features.noisiness, 0.5);
  const amplitude = numberOr(features.amplitude, 0.3);
  return {
    x: roundFeature(12 + noisiness * 76),
    y: roundFeature(12 + (1 - amplitude) * 76),
  };
}

function computeSensualityIndex(features) {
  const f = features || {};

  function clamp(v) { return Math.max(0, Math.min(1, v)); }
  function norm(v, lo, hi)    { return v != null && Number.isFinite(+v) ? clamp((+v - lo) / (hi - lo)) : null; }
  function normInv(v, lo, hi) { return v != null && Number.isFinite(+v) ? clamp((hi - +v) / (hi - lo)) : null; }

  // Prefer Praat/librosa features when available; fall back to browser approximations.
  // breathiness: HNR from Praat (low dB = breathy). ZCR is a rough fallback.
  const breathiness = f.hnr != null
    ? normInv(f.hnr, 0, 25)
    : norm(f.noisiness, 0, 1);
  // darkness: spectral centroid in Hz from librosa. brightness (0-1 from Max) as fallback.
  const darkness = f.spectralCentroid != null
    ? normInv(f.spectralCentroid, 500, 4000)
    : normInv(f.brightness, 0, 1);

  const raw = {
    breathiness,
    darkness,
    softness:        normInv(f.amplitude, 0.02, 0.6),
    slowness:        normInv(f.speechRate, 2, 6),
    pitchLowness:    normInv(f.f0Mean, 80, 300),
    pitchSteadiness: normInv(f.f0Range, 20, 200),
  };

  const WEIGHTS = {
    breathiness: 0.30, darkness: 0.20, softness: 0.15,
    slowness: 0.15, pitchLowness: 0.10, pitchSteadiness: 0.10,
  };

  let weightedSum = 0;
  let totalWeight = 0;
  const components = {};

  for (const [k, v] of Object.entries(raw)) {
    if (v !== null) {
      components[k] = roundFeature(v);
      weightedSum += WEIGHTS[k] * v;
      totalWeight += WEIGHTS[k];
    }
  }

  if (totalWeight === 0) return null;

  return {
    score: roundFeature(weightedSum / totalWeight),
    components,
    partial: totalWeight < 0.95,
  };
}

async function runUmapPosition(whisperId) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, "analysis", "umap_position.py");
    const proc = spawn("python", [scriptPath, whisperId, WHISPERS_DIR]);
    let stdout = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    const timer = setTimeout(() => { proc.kill(); resolve(null); }, 15_000);
    proc.on("close", () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout.trim());
        resolve(result.error ? null : result);
      } catch { resolve(null); }
    });
    proc.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

function runPythonAnalysis(audioFilePath, { extraArgs = [], timeoutMs = 60_000 } = {}) {
  // On Windows "python" may not exist in PATH — try "py" (launcher) then "python3" as fallbacks.
  const pythonCmds = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];

  function tryCmd(cmds) {
    return new Promise((resolve) => {
      if (!cmds.length) { console.error("[analyze.py] no python command found — tried python, py, python3"); resolve(null); return; }
      const [cmd, ...rest] = cmds;
      const scriptPath = path.join(__dirname, "analysis", "analyze.py");
      const proc = spawn(cmd, [scriptPath, audioFilePath, ...extraArgs]);
      let stdout = "", stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += chunk; });
      proc.stderr.on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => { proc.kill(); console.error("[analyze.py] timeout — killed"); resolve(null); }, timeoutMs);
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (stderr.trim()) console.error(`[analyze.py stderr]`, stderr.trim());
        if (code !== 0) { resolve(null); return; }
        try {
          const result = JSON.parse(stdout.trim());
          if (result.error) { console.error("[analyze.py]", result.error); resolve(null); return; }
          resolve(result);
        } catch { resolve(null); }
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        if (err.code === "ENOENT") {
          // This python command doesn't exist — try the next one
          resolve(tryCmd(rest));
        } else {
          console.error(`[analyze.py] spawn error (${cmd}):`, err.message);
          resolve(null);
        }
      });
    });
  }

  return tryCmd(pythonCmds);
}

const OLLAMA_MODEL = "dolphin-mistral";

const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY  || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const ELEVENLABS_MODEL    = "eleven_v3";
const OLLAMA_PROMPT = (transcript) => `You are part of an anonymous art installation where visitors whisper their intimate desires, secrets, and longings. Respond with a JSON object only — no markdown, no code fences, no explanation before or after.

Required keys:
"rephrased": 1–2 sentences. Don't restate what was said — approach it sideways. Find the sensation, the pressure, the edge underneath it. Something you'd overhear through a wall and half-understand. Fragments are fine. Never explain, never moralize.
"semantics": scores from 0.0 (absent) to 1.0 (dominant) for each dimension:
  "sensory": body sensations — what they want to feel, taste, touch
  "relational": power dynamics, surrender, being seen, taken, worshipped
  "taboo": things they would never say outside this installation
  "tenderness": closeness, being held, vulnerability, softness
  "fantasy": specific scenarios, settings, roles, situations
  "identity": who they want to be in the moment, not just what they want
  "longing": missing someone, wanting what they cannot have
  "unspeakable": incomplete desires, half-sentences, things they struggle to finish saying
"affect": performance parameters for the whisper sound that will be generated — each 0.0–1.0:
  "breathiness": how much air and breath — drives shhh/haa sounds
  "warmth": tenderness and heat — drives mmm/ahh sounds
  "energy": density of sound events — 0=sparse silence, 1=full and active
  "tension": tightness vs openness in the body — drives nnn vs open vowels
  "playfulness": lightness, hint of irony or play
  "tempo": pace — 0=very slow with long pauses, 1=quick urgent rhythm

Transcript: ${transcript}`;

function callOllama(transcript) {
  const body = JSON.stringify({ model: OLLAMA_MODEL, prompt: OLLAMA_PROMPT(transcript), stream: false });
  return new Promise((resolve) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port: 11434, path: "/api/generate", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try {
            const raw = JSON.parse(data).response?.trim();
            if (!raw) { resolve(null); return; }
            const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
            const parsed = JSON.parse(cleaned);
            const rephrased = typeof parsed.rephrased === "string" ? parsed.rephrased.trim() : null;
            const semantics = parsed.semantics && typeof parsed.semantics === "object" ? parsed.semantics : null;
            const affect    = parsed.affect    && typeof parsed.affect    === "object" ? parsed.affect    : null;
            resolve((rephrased || semantics) ? { rephrased, semantics, affect } : null);
          } catch { resolve(null); }
        });
      }
    );
    const t = setTimeout(() => { req.destroy(); resolve(null); }, 30_000);
    req.on("error", () => { clearTimeout(t); resolve(null); });
    req.on("close", () => clearTimeout(t));
    req.write(body);
    req.end();
  });
}

function generateVocalScore(affect = {}) {
  const clamp = (v, d) => Math.min(1, Math.max(0, Number(affect[v] ?? d)));
  const breathiness = clamp("breathiness", 0.5);
  const warmth      = clamp("warmth",      0.5);
  const energy      = clamp("energy",      0.4);
  const tension     = clamp("tension",     0.3);
  const playfulness = clamp("playfulness", 0.3);
  const tempo       = clamp("tempo",       0.4);

  const pick  = arr => arr[Math.floor(Math.random() * arr.length)];
  const pause = () => tempo < 0.35 ? " ... " : "... ";

  const airy  = ["shhhh", "ffhhh", "hhh",  "haaa"];
  const hums  = ["mmm",   "hmm",   "mhm",  "hmmm"];
  const tense = ["nnn",   "mmm",   "mhm"];
  const vocal = ["ahh",   "ohh",   "ahhh"];

  const events = [];
  if (breathiness > 0.55) events.push("haaa");

  const count = Math.round(3 + energy * 5);
  for (let i = 0; i < count; i++) {
    const r = Math.random();
    if      (r < breathiness * 0.45)       events.push(pick(airy));
    else if (r < tension * 0.3 + 0.2)      events.push(pick(tense));
    else if (r < warmth * 0.5 + 0.35)      events.push(pick(vocal));
    else                                    events.push(pick(hums));
  }

  if (playfulness > 0.55) events.push("mhm");
  if (warmth      > 0.60) events.push("mmm");
  if (breathiness > 0.45) events.push("shhhh");

  return "[whispering] " + events.join(pause());
}

function callElevenLabs(vocalScore, outputPath) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.warn("[elevenlabs] ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID not set — skipping");
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const body = JSON.stringify({
      text:     vocalScore,
      model_id: ELEVENLABS_MODEL,
      voice_settings: { stability: 0.35, similarity_boost: 0.75, style: 0.65, use_speaker_boost: true },
    });
    const req = httpsRequest(
      { hostname: "api.elevenlabs.io",
        path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
        method: "POST",
        headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json",
                   "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          console.error(`[elevenlabs] HTTP ${res.statusCode}`);
          resolve(null); return;
        }
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", async () => {
          try {
            await writeFile(outputPath, Buffer.concat(chunks));
            resolve(outputPath);
          } catch (e) { console.error("[elevenlabs] write error:", e.message); resolve(null); }
        });
      }
    );
    req.on("error", e => { console.error("[elevenlabs] error:", e.message); resolve(null); });
    req.setTimeout(30_000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

async function saveWhisper(payload, { waitForAnalysis = false } = {}) {
  await ensureStorage();

  const id = payload.id || makeId();
  const savedAudioFile = await saveAudio(id, payload.audioBase64, payload.audioMime);
  const audioFile = savedAudioFile || normalizeAudioFile(payload.audioFile);
  const features = analyzeBrowserFeatures(payload);
  const sensuality = computeSensualityIndex(features);
  const wspr = generateWsprCode();
  const fieldPosition = computeFieldPosition(features, sensuality);

  const record = {
    id,
    createdAt: new Date().toISOString(),
    source: payload.source || "browser",
    transcript: payload.transcript || "",
    features,
    tags: payload.tags || [],
    audioFile,
    audioMime: payload.audioMime || null,
    llm: payload.llm || null,
    sensuality,
    interpretation: payload.interpretation || localInterpretation({ ...payload, features }),
    notes: payload.notes || "",
    wspr,
    fieldPosition,
  };

  const recordPath = path.join(WHISPERS_DIR, `${id}.json`);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await writeFile(JSONL_PATH, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });


  if (audioFile) {
    const fullAudioPath = path.isAbsolute(audioFile)
      ? audioFile
      : path.join(__dirname, audioFile);

    if (waitForAnalysis) {
      // Phase 1 (sync, fast): whisperize + acoustic features only — no Whisper transcription.
      // Runs in ~5s so the HTTP response gets whisperizedFile quickly.
      const extra = await Promise.race([
        runPythonAnalysis(fullAudioPath, { extraArgs: ['--skip-transcription'], timeoutMs: 25_000 }),
        new Promise(resolve => setTimeout(() => resolve(null), 25000)),
      ]);
      if (extra) {
        const { whisperizedFile, ...acousticFeatures } = extra;
        record.features = { ...record.features, ...acousticFeatures };
        record.sensuality = computeSensualityIndex(record.features);
        record.fieldPosition = computeFieldPosition(record.features, record.sensuality);
        if (whisperizedFile) record.whisperizedFile = whisperizedFile;
        await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
        console.log(`[analyze] ${id} — HNR: ${extra.hnr ?? "—"}, F0: ${extra.f0Mean ?? "—"} Hz, whisperized: ${whisperizedFile ? "yes" : "no"}`);

        // UMAP positioning
        const umapPos = await runUmapPosition(id);
        if (umapPos) {
          record.fieldPosition = { x: umapPos.x, y: umapPos.y, method: umapPos.method };
          await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
          console.log(`[umap] ${id} → (${umapPos.x}, ${umapPos.y}) [${umapPos.method}, n=${umapPos.n ?? "?"}]`);
        }
      }

      // Phase 2 (background, slow): full run with Whisper transcription → patches transcript + triggers Ollama.
      runPythonAnalysis(fullAudioPath, { timeoutMs: 120_000 }).then(async (fullExtra) => {
        if (!fullExtra?.transcript) return;
        try {
          const r = JSON.parse(await readFile(recordPath, "utf8"));
          r.transcript = fullExtra.transcript;
          if (fullExtra.transcriptLanguage) r.transcriptLanguage = fullExtra.transcriptLanguage;
          await writeFile(recordPath, `${JSON.stringify(r, null, 2)}\n`, "utf8");
          console.log(`[transcribe] ${id} → "${fullExtra.transcript.slice(0, 60)}"`);
          const ollamaResult = await callOllama(r.transcript);
          if (ollamaResult) {
            r.llm = { ...(r.llm || {}), ...ollamaResult, model: OLLAMA_MODEL };
            await writeFile(recordPath, `${JSON.stringify(r, null, 2)}\n`, "utf8");
            console.log(`[ollama] ${id} → "${(ollamaResult.rephrased || "").slice(0, 60)}"`);
            if (ollamaResult.affect) {
              const vocalScore = generateVocalScore(ollamaResult.affect);
              const genPath    = path.join(RECORDINGS_DIR, `${id}-generated.mp3`);
              const genResult  = await callElevenLabs(vocalScore, genPath);
              if (genResult) {
                r.generatedWhisperFile = `recordings/${id}-generated.mp3`;
                r.vocalScore           = vocalScore;
                await writeFile(recordPath, `${JSON.stringify(r, null, 2)}\n`, "utf8");
                console.log(`[elevenlabs] ${id} — "${vocalScore.slice(0, 70)}"`);
              }
            }
          }
        } catch {}
      }).catch(() => {});
    } else {
      // Background: async after HTTP response is already sent.
      runPythonAnalysis(fullAudioPath).then(async (extra) => {
        if (!extra) return;
        try {
          const existing = JSON.parse(await readFile(recordPath, "utf8"));
          const { transcript: pyTranscript, transcriptLanguage, whisperizedFile, ...acousticFeatures } = extra;
          existing.features = { ...existing.features, ...acousticFeatures };
          if (pyTranscript) { existing.transcript = pyTranscript; existing.transcriptLanguage = transcriptLanguage; }
          existing.sensuality = computeSensualityIndex(existing.features);
          existing.fieldPosition = computeFieldPosition(existing.features, existing.sensuality);
          if (whisperizedFile) existing.whisperizedFile = whisperizedFile;
          await writeFile(recordPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
          console.log(`[analyze] updated ${id} — HNR: ${extra.hnr ?? "—"}, F0: ${extra.f0Mean ?? "—"} Hz, transcript: "${pyTranscript?.slice(0, 40) ?? "—"}"`);

          // UMAP positioning
          const umapPos = await runUmapPosition(id);
          if (umapPos) {
            existing.fieldPosition = { x: umapPos.x, y: umapPos.y, method: umapPos.method };
            await writeFile(recordPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
          }
          // Ollama rephrasing
          if (existing.transcript) {
            const ollamaResult = await callOllama(existing.transcript);
            if (ollamaResult) {
              existing.llm = { ...(existing.llm || {}), ...ollamaResult, model: OLLAMA_MODEL };
              await writeFile(recordPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
              console.log(`[ollama] ${id} → "${(ollamaResult.rephrased || "").slice(0, 60)}"`);
              if (ollamaResult.affect) {
                const vocalScore = generateVocalScore(ollamaResult.affect);
                const genPath    = path.join(RECORDINGS_DIR, `${id}-generated.mp3`);
                const genResult  = await callElevenLabs(vocalScore, genPath);
                if (genResult) {
                  existing.generatedWhisperFile = `recordings/${id}-generated.mp3`;
                  existing.vocalScore           = vocalScore;
                  await writeFile(recordPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
                  console.log(`[elevenlabs] ${id} — "${vocalScore.slice(0, 70)}"`);
                }
              }
            }
          }
        } catch {}
      }).catch(() => {});
    }
  }

  return record;
}


async function listWhispers() {
  await ensureStorage();
  const files = await readdir(WHISPERS_DIR);
  const records = [];
  for (const file of files.filter((name) => name.endsWith(".json")).sort().reverse()) {
    const content = await readFile(path.join(WHISPERS_DIR, file), "utf8");
    records.push(JSON.parse(content));
  }
  return records;
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { ok: true, port: config.port });
    return;
  }

  if (request.method === "GET" && url.pathname === "/whispers") {
    json(response, 200, { whispers: await listWhispers() });
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/whispers/")) {
    const id = path.basename(url.pathname);
    const recordPath = path.join(WHISPERS_DIR, `${id}.json`);
    if (!existsSync(recordPath)) {
      json(response, 404, { error: "Whisper not found." });
      return;
    }
    json(response, 200, JSON.parse(await readFile(recordPath, "utf8")));
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/recordings/")) {
    const filename = path.basename(url.pathname);
    const filePath = path.join(RECORDINGS_DIR, filename);
    if (!existsSync(filePath)) { text(response, 404, "Not found"); return; }
    const ext = path.extname(filename).toLowerCase();
    const mime = ext === ".mp3" ? "audio/mpeg" : ext === ".ogg" ? "audio/ogg" : ext === ".webm" ? "audio/webm" : "audio/wav";
    await sendFile(response, filePath, mime);
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/whispers/")) {
    const id = path.basename(url.pathname);
    const recordPath = path.join(WHISPERS_DIR, `${id}.json`);
    if (!existsSync(recordPath)) {
      json(response, 404, { error: "Whisper not found." });
      return;
    }
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    await unlink(recordPath);
    if (record.audioFile) {
      const audioPath = path.isAbsolute(record.audioFile)
        ? record.audioFile
        : path.join(__dirname, record.audioFile);
      try { await unlink(audioPath); } catch {}
    }
    json(response, 200, { deleted: id });
    return;
  }

  if (request.method === "POST" && url.pathname === "/whispers") {
    const payload = await readJson(request);
    const sync = url.searchParams.get("sync") === "1";
    const record = await saveWhisper(payload, { waitForAnalysis: sync });
    json(response, 201, record);
    return;
  }

  // POST /whispers/:id/generate — (re)generate ElevenLabs audio for an existing entry.
  // Reruns Ollama if the record has no llm.affect. Always overwrites the generated mp3.
  if (request.method === "POST" && /^\/whispers\/[^/]+\/generate$/.test(url.pathname)) {
    const id = url.pathname.split("/")[2];
    const recordPath = path.join(WHISPERS_DIR, `${id}.json`);
    if (!existsSync(recordPath)) { json(response, 404, { error: "Whisper not found." }); return; }

    let r = JSON.parse(await readFile(recordPath, "utf8"));

    // If no transcript we can't run Ollama — still try generate with existing affect if any.
    if (!r.llm?.affect && r.transcript) {
      const ollamaResult = await callOllama(r.transcript);
      if (ollamaResult) {
        r.llm = { ...(r.llm || {}), ...ollamaResult, model: OLLAMA_MODEL };
        await writeFile(recordPath, `${JSON.stringify(r, null, 2)}\n`, "utf8");
        console.log(`[ollama] ${id} → "${(ollamaResult.rephrased || "").slice(0, 60)}"`);
      }
    }

    if (!r.llm?.affect) {
      json(response, 422, { error: "No affect data — Ollama must succeed first (is it running with dolphin-mistral?)" });
      return;
    }

    const vocalScore = generateVocalScore(r.llm.affect);
    const genPath    = path.join(RECORDINGS_DIR, `${id}-generated.mp3`);
    const genResult  = await callElevenLabs(vocalScore, genPath);
    if (!genResult) {
      json(response, 502, { error: "ElevenLabs call failed — check server logs for HTTP status." });
      return;
    }

    r.generatedWhisperFile = `recordings/${id}-generated.mp3`;
    r.vocalScore           = vocalScore;
    await writeFile(recordPath, `${JSON.stringify(r, null, 2)}\n`, "utf8");
    console.log(`[elevenlabs] ${id} regenerated — "${vocalScore.slice(0, 70)}"`);
    json(response, 200, r);
    return;
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/recorder")) {
    await sendFile(response, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin.html")) {
    await sendFile(response, path.join(PUBLIC_DIR, "admin.html"), "text/html; charset=utf-8");
    return;
  }

  if (request.method === "GET" && (url.pathname === "/umap" || url.pathname === "/umap.html")) {
    await sendFile(response, path.join(PUBLIC_DIR, "umap.html"), "text/html; charset=utf-8");
    return;
  }

  if (request.method === "GET" && (url.pathname === "/gallery" || url.pathname === "/gallery.html")) {
    await sendFile(response, path.join(PUBLIC_DIR, "gallery.html"), "text/html; charset=utf-8");
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/public/")) {
    const requestedPath = path.normalize(url.pathname.replace(/^\/public\//, ""));
    const filePath = path.join(PUBLIC_DIR, requestedPath);
    if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
      text(response, 404, "Not found");
      return;
    }
    const contentType = filePath.endsWith(".css")
      ? "text/css; charset=utf-8"
      : filePath.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "application/octet-stream";
    await sendFile(response, filePath, contentType);
    return;
  }

  if (request.method === "GET" && url.pathname === "/config") {
    json(response, 200, config);
    return;
  }

  if (request.method === "PATCH" && url.pathname === "/config") {
    try {
      const body = JSON.parse(await readBody(request));
      const allowed = [
        'oscHost', 'oscPort', 'audioInputMode',
        'galleryRows', 'galleryCols', 'galleryTheme',
        'galleryParadeInterval', 'galleryMaxWhispers', 'galleryFontScale',
        'fp_positionSpread', 'fp_orbitSpread',
        'fp_breathinessSizeScale', 'fp_darknessSizeScale',
        'fp_softnessSizeScale', 'fp_pitchLownessSizeScale',
        'fp_accentDotCount', 'fp_accentDotMaxSize',
        'fp_particleBase', 'fp_particleFantasyScale', 'fp_satelliteMax',
        'fp_formingMs', 'fp_settlingMs', 'fp_breatheStrength',
        'fp_maskInner', 'fp_maskOuter', 'fp_showSemanticLabels',
      ];
      for (const k of allowed) {
        if (body[k] !== undefined) config[k] = body[k];
      }
      await saveConfig();
    } catch {}
    json(response, 200, config);
    return;
  }

  text(response, 404, "Not found");
}

// ── WebSocket presence layer ──────────────────────────────────────────────

const wsSessions = new Map(); // id → { socket, type, name, color, x, y, nearbyAt }
const WS_COLORS = ['#FF2D8E', '#8A2BE2', '#C060E0', '#FF8A2B', '#FF5070', '#FFAE00'];
let wsColorIndex = 0;

let wsWhisperCache = null;
let wsWhisperCacheAt = 0;
async function listWhispersCached() {
  const now = Date.now();
  if (wsWhisperCache && now - wsWhisperCacheAt < 4000) return wsWhisperCache;
  wsWhisperCache = await listWhispers();
  wsWhisperCacheAt = now;
  return wsWhisperCache;
}

function wsSend(socket, text) {
  if (!socket || socket.destroyed) return;
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  try { socket.write(Buffer.concat([header, payload])); } catch {}
}

function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return false; }
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return true;
}

function wsParseFrames(socket, onMessage) {
  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let payLen = buf[1] & 0x7f;
      let offset = 2;
      if (payLen === 126) {
        if (buf.length < 4) break;
        payLen = buf.readUInt16BE(2); offset = 4;
      } else if (payLen === 127) {
        if (buf.length < 10) break;
        payLen = Number(buf.readBigUInt64BE(2)); offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + payLen) break;
      const mask = masked ? buf.slice(offset, offset + 4) : null;
      offset += maskLen;
      const payload = Buffer.from(buf.slice(offset, offset + payLen));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.slice(offset + payLen);
      if (opcode === 8) { socket.end(); break; }
      if (opcode === 9) { try { socket.write(Buffer.from([0x8a, payload.length, ...payload])); } catch {} continue; }
      if (opcode === 1) onMessage(payload.toString('utf8'));
    }
  });
}

function broadcastViewers() {
  const viewers = [];
  for (const [id, s] of wsSessions) {
    if (s.type === 'phone') viewers.push({ id, name: s.name, color: s.color, x: s.x, y: s.y });
  }
  const msg = JSON.stringify({ type: 'viewers', viewers });
  for (const s of wsSessions.values()) {
    if (s.type === 'display') wsSend(s.socket, msg);
  }
}

async function sendNearby(sessionId) {
  const session = wsSessions.get(sessionId);
  if (!session || session.type !== 'phone') return;
  const now = Date.now();
  if (now - (session.nearbyAt || 0) < 300) return;
  session.nearbyAt = now;
  const { x, y } = session;
  const all = await listWhispersCached();
  const RADIUS = 0.18;
  const nearby = all
    .filter(w => {
      const fp = w.fieldPosition;
      if (!fp) return false;
      const dx = (fp.x ?? 50) / 100 - x;
      const dy = (fp.y ?? 50) / 100 - y;
      return Math.sqrt(dx * dx + dy * dy) < RADIUS;
    })
    .slice(0, 8)
    .map(w => {
      const comps = w.sensuality?.components || {};
      const acousticTags = Object.entries(comps).sort(([, a], [, b]) => b - a).slice(0, 2).map(([k]) => k);
      const sem = w.llm?.semantics || {};
      const semTop = Object.entries(sem).sort(([, a], [, b]) => b - a)[0];
      const tags = semTop && semTop[1] >= 0.5
        ? [acousticTags[0], semTop[0]].filter(Boolean)
        : acousticTags;
      return {
        id: w.id,
        transcript: (w.llm?.rephrased || w.transcript || '').slice(0, 80),
        score: w.sensuality?.score ?? 0,
        tags: tags.slice(0, 2),
      };
    });
  wsSend(session.socket, JSON.stringify({ type: 'nearby', whispers: nearby }));
}

function handleWsMessage(sessionId, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const session = wsSessions.get(sessionId);
  if (!session) return;
  if (msg.type === 'join') {
    session.x = Math.max(0, Math.min(1, (msg.whisperX ?? 50) / 100));
    session.y = Math.max(0, Math.min(1, (msg.whisperY ?? 50) / 100));
    broadcastViewers();
    sendNearby(sessionId).catch(() => {});
  } else if (msg.type === 'move') {
    session.x = Math.max(0, Math.min(1, Number(msg.x) || 0));
    session.y = Math.max(0, Math.min(1, Number(msg.y) || 0));
    broadcastViewers();
    sendNearby(sessionId).catch(() => {});
  }
}

export const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error(error);
    json(response, 500, { error: error.message || "Internal server error." });
  });
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!wsHandshake(req, socket)) return;

  const id = crypto.randomBytes(8).toString('hex');
  const type = url.searchParams.get('type') === 'phone' ? 'phone' : 'display';
  const color = WS_COLORS[wsColorIndex % WS_COLORS.length];
  wsColorIndex++;
  const phoneCount = [...wsSessions.values()].filter(s => s.type === 'phone').length;
  const name = type === 'phone'
    ? (phoneCount === 0 ? 'you' : `guest·${String(phoneCount + 1).padStart(2, '0')}`)
    : 'display';

  wsSessions.set(id, { socket, type, name, color, x: 0.5, y: 0.5, nearbyAt: 0 });
  wsParseFrames(socket, raw => handleWsMessage(id, raw));

  socket.on('close', () => { wsSessions.delete(id); broadcastViewers(); });
  socket.on('error', () => { wsSessions.delete(id); });

  if (type === 'display') broadcastViewers();
});

export async function startServer(options = {}) {
  config = { port: Number(options.port || process.env.PORT || config.port) };
  await ensureStorage();
  await loadConfig();
  return new Promise((resolve) => {
    server.listen(config.port, () => {
      console.log(`Whisper backend listening on http://127.0.0.1:${config.port}`);
      resolve(server);
    });
  });
}

export function stopServer() {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
