/* ── WebGL shader source ────────────────────────────────────────── */
const VERT_SRC = `
attribute vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`.trim();

const FRAG_SRC = `
precision highp float;
uniform vec2  u_resolution;
uniform float u_time;
uniform float u_amplitude;
uniform float u_speed;

void main() {
  vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / u_resolution.y;
  float t    = u_time * u_speed;
  float freq = (0.06 + u_amplitude * 0.18) * (0.5 + 0.5 * sin(t * 0.15));

  // Blob 1 — pink, drifts slowly top-left / bottom-right
  vec2 p = uv + vec2(sin(t * 0.07) * 0.20, cos(t * 0.05) * 0.13);
  p.x += sin(p.y * 1.8 + t / 2.2) * freq;
  p.y += cos(p.x * 0.9 - t / 3.1) * freq;
  float w1 = smoothstep(1.0, 0.0, length(p) * 1.15);

  // Blob 2 — purple, drifts opposite corner
  p = uv + vec2(cos(t * 0.11 + 1.0) * 0.22, sin(t * 0.08) * 0.15);
  p.x -= sin(p.y * 2.4 - t / 1.9) * freq;
  p.y += cos(p.x * 1.1 + t / 2.7) * freq;
  float w2 = smoothstep(1.0, 0.0, length(p) * 1.25);

  // Blob 3 — amber, slow wander
  p = uv + vec2(sin(t * 0.06 + 2.0) * 0.18, cos(t * 0.10 + 0.5) * 0.20);
  p.x += cos(p.y * 1.4 + t / 3.8) * freq;
  p.y -= sin(p.x * 0.8 + t / 2.2) * freq;
  float w3 = smoothstep(1.0, 0.0, length(p) * 1.35);

  // Blob 4 — rose blush, subtle accent
  p = uv + vec2(cos(t * 0.09 + 3.1) * 0.25, sin(t * 0.06 + 1.8) * 0.17);
  p.x += sin(p.y * 3.1 - t / 1.7) * freq * 0.60;
  p.y -= cos(p.x * 1.3 - t / 2.9) * freq * 0.60;
  float w4 = smoothstep(1.0, 0.0, length(p) * 1.50);

  vec3 paper  = vec3(0.953, 0.949, 0.941);
  vec3 pink   = vec3(1.000, 0.176, 0.557);
  vec3 purple = vec3(0.416, 0.106, 0.604);
  vec3 amber  = vec3(1.000, 0.682, 0.000);
  vec3 rose   = vec3(0.980, 0.800, 0.870);

  vec3 col = paper;
  col = mix(col, pink,   w1 * 0.52);
  col = mix(col, purple, w2 * 0.44);
  col = mix(col, amber,  w3 * 0.36);
  col = mix(col, rose,   w4 * 0.30);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`.trim();

/* ── shader state ───────────────────────────────────────────────── */
let gl = null, shaderProgram = null;
const shaderUniforms = {};
let shaderAmplitude = 0;
let shaderSpeed     = 0.10;
let shaderT0        = null;
let shaderRafId     = null;

/* ── global state ───────────────────────────────────────────────── */
let currentScreen = 'splash';
let draft = null;   // { levels[], duration, blob }
let enc   = null;   // { id, wspr, fieldX, fieldY, sensuality, levels, duration }

let recordedLevels   = [];
let lastLevelAt      = 0;
let fieldStopper     = null;
let liveSISmooth     = 0;
let recordingStartedAt = 0;
let recordPressedAt  = 0;
const MIN_RECORD_MS  = 1200;
let latestFeatures   = { amplitude: 0, noisiness: 0, tremble: 0, duration: 0 };
let analysisSamples  = [], recentAmplitudes = [];
let livePostAt       = 0;
let isRecording      = false;

let stream, recorder, chunks = [], audioContext, analyser, source, timeData, freqData;
let animationId, currentBlob, currentMime = 'audio/webm';
let _ac = null;
let cachedStream = null;

/* ── persistent circle state ────────────────────────────────────── */
let circleBuilt = false;

/* ── field navigation (joystick + WS) ──────────────────────────── */
let fieldWs       = null;
let lensX         = 0.5, lensY = 0.5;
let joystickVx    = 0, joystickVy = 0;
let joystickActive = false;
let fieldNavTimer  = null;
let joystickAbort    = null;
let dragHandleAbort  = null;

/* ── Fingerprint state ──────────────────────────────────────────── */
let currentFingerprint    = null;
let lastFingerprintParams = null;
let _recorderFpCfg        = {};

const DIM_COLORS_PHONE = {
  breathiness: '#FF2D8E', darkness: '#9055D4', slowness: '#C060E0',
  softness: '#FF8A2B', pitchLowness: '#FF5070', pitchSteadiness: '#FFAE00',
};

/* ── smoothed SI inputs (pre-smoothed to reduce jitter) ─────────── */
const siInputSmooth = { breathiness: 0.5, darkness: 0.5, softness: 0.5 };

/* ── WebGL init ─────────────────────────────────────────────────── */
function initShader() {
  const canvas = document.getElementById('shaderCanvas');
  if (!canvas) return;
  gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) return;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('[shader]', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  const vert = compile(gl.VERTEX_SHADER, VERT_SRC);
  const frag = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vert || !frag) { gl = null; return; }

  shaderProgram = gl.createProgram();
  gl.attachShader(shaderProgram, vert);
  gl.attachShader(shaderProgram, frag);
  gl.linkProgram(shaderProgram);
  if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
    console.warn('[shader link]', gl.getProgramInfoLog(shaderProgram));
    gl = null; return;
  }
  gl.useProgram(shaderProgram);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(shaderProgram, 'aPosition');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  shaderUniforms.resolution = gl.getUniformLocation(shaderProgram, 'u_resolution');
  shaderUniforms.time       = gl.getUniformLocation(shaderProgram, 'u_time');
  shaderUniforms.amplitude  = gl.getUniformLocation(shaderProgram, 'u_amplitude');
  shaderUniforms.speed      = gl.getUniformLocation(shaderProgram, 'u_speed');
}

function resizeShader() {
  const canvas = document.getElementById('shaderCanvas');
  if (!canvas || !gl) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.offsetWidth  * dpr);
  const h = Math.round(canvas.offsetHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
  }
}

function renderShader(ts) {
  if (!gl || !shaderProgram) return;
  if (shaderT0 === null) shaderT0 = ts;
  const t = (ts - shaderT0) / 1000;
  const canvas = document.getElementById('shaderCanvas');
  gl.useProgram(shaderProgram);
  gl.uniform2f(shaderUniforms.resolution, canvas.width, canvas.height);
  gl.uniform1f(shaderUniforms.time, t);
  gl.uniform1f(shaderUniforms.amplitude, shaderAmplitude);
  gl.uniform1f(shaderUniforms.speed, shaderSpeed);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function shaderLoop(ts) {
  resizeShader();
  renderShader(ts);
  shaderRafId = requestAnimationFrame(shaderLoop);
}

/* ── AudioContext helper ────────────────────────────────────────── */
function getAC() {
  if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)();
  if (_ac.state === 'suspended') _ac.resume();
  return _ac;
}

/* ── AuraField component ────────────────────────────────────────── */
function createAuraField(el) {
  if (el.dataset.built) return;
  el.dataset.built = '1';

  const preset = el.dataset.preset || 'flow';
  const rect   = el.getBoundingClientRect();
  const w      = rect.width  || parseFloat(el.style.width)  || 300;
  const h      = rect.height || parseFloat(el.style.height) || 300;
  const dim    = Math.max(w, h);

  const blobs = preset === 'flow' ? [
    ['#FF2D8E', 1.35, 'flowA', '7s',  '0s',    0.82],
    ['#8A2BE2', 1.15, 'flowB', '9s',  '-3s',   0.75],
    ['#FFAE00', 1.25, 'flowC', '11s', '-1.5s', 0.70],
  ] : [
    ['#FF2D8E', 1.25, 'auraA', '8s',  '0s',  0.80],
    ['#8A2BE2', 1.05, 'auraB', '10s', '-4s', 0.72],
    ['#FFAE00', 1.15, 'auraC', '12s', '-2s', 0.68],
  ];

  blobs.forEach(([color, factor, kf, dur, delay, opacity]) => {
    const blob = document.createElement('div');
    const sz   = dim * factor;
    Object.assign(blob.style, {
      position:      'absolute',
      left:          '50%',
      top:           '50%',
      width:         sz + 'px',
      height:        sz + 'px',
      borderRadius:  '50%',
      background:    `radial-gradient(circle at 38% 38%, ${color} 0%, transparent 68%)`,
      mixBlendMode:  'multiply',
      opacity:       opacity,
      animation:     `${kf} ${dur} ease-in-out ${delay} infinite alternate`,
      transform:     'translate(-50%,-50%)',
      willChange:    'transform',
      pointerEvents: 'none',
    });
    el.appendChild(blob);
  });

  const uid = 'g' + Math.random().toString(36).slice(2, 8);
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  Object.assign(svg.style, {
    position:      'absolute',
    inset:         '0',
    width:         '100%',
    height:        '100%',
    mixBlendMode:  'soft-light',
    opacity:       '0.50',
    pointerEvents: 'none',
  });
  svg.innerHTML = `
    <filter id="${uid}">
      <feTurbulence type="fractalNoise" baseFrequency="0.72" numOctaves="4" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
    <rect width="100%" height="100%" filter="url(#${uid})"/>
  `;
  el.appendChild(svg);
}

/* ── Persistent circle helpers ──────────────────────────────────── */
function setCircle({ x, y, size, opacity, bg, transition, instant = false }) {
  const el = document.getElementById('persistentCircle');
  if (!el) return;
  if (instant) {
    el.style.transition = 'none';
    el.getBoundingClientRect(); // force reflow so transition: none takes effect
  } else if (transition) {
    el.style.transition = transition;
  }
  if (x    != null) el.style.left    = x + '%';
  if (y    != null) el.style.top     = y + '%';
  if (size != null) {
    el.style.width  = size + 'px';
    el.style.height = size + 'px';
  }
  if (opacity != null) el.style.opacity = String(opacity);
  if (bg      != null) el.style.background = bg;
}

function circleAddClass(cls) {
  const el = document.getElementById('persistentCircle');
  if (!el) return;
  el.className = cls ? 'circle--' + cls : '';
}

function buildCircleAura() {
  if (circleBuilt) return;
  circleBuilt = true;
  const aura = document.getElementById('persistentCircleAura');
  if (!aura) return;
  delete aura.dataset.built;
  aura.innerHTML = '';
  // createAuraField falls back to 300 when it can't measure (circle is still tiny)
  // blobs sized ~405px at creation, clipped by overflow:hidden as circle grows
  createAuraField(aura);
}

/* ── Screen state machine ───────────────────────────────────────── */
const SCREENS = ['splash', 'record', 'analyzing', 'field'];

const SCREEN_SPEED = {
  splash:    0.10,
  record:    0.18,
  analyzing: 0.20,
  field:     0.08,
};

function showScreen(id) {
  // Reset animations for elements about to be shown
  document.querySelectorAll('#screen-' + id + ' .anim-in')
    .forEach(el => el.classList.remove('animated'));

  SCREENS.forEach(s => {
    document.getElementById('screen-' + s)
      .classList.toggle('screen--active', s === id);
  });
  currentScreen = id;

  // Stagger text entrance animations
  setTimeout(() => {
    document.querySelectorAll('#screen-' + id + ' .anim-in').forEach((el, i) => {
      setTimeout(() => el.classList.add('animated'), i * 80);
    });
  }, 60);

  // Persistent circle: grow in when entering record screen
  if (id === 'record') {
    buildCircleAura();
    // Reset bg to paper in case it was black (dot state from previous session)
    setCircle({ x: 50, y: 50, size: 40, opacity: 0, bg: 'var(--paper)', instant: true });
    // Double rAF ensures the layout settles before the transition fires
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setCircle({
        size: 292, opacity: 1,
        transition: [
          'width 0.65s cubic-bezier(0.34,1.56,0.64,1)',
          'height 0.65s cubic-bezier(0.34,1.56,0.64,1)',
          'left 0.65s cubic-bezier(0.4,0,0.2,1)',
          'top 0.65s cubic-bezier(0.4,0,0.2,1)',
          'opacity 0.4s ease',
          'background 0.4s ease',
          'box-shadow 0.4s ease',
        ].join(', '),
      });
      circleAddClass('breathing');
      const auraEl = document.getElementById('persistentCircleAura');
      if (auraEl) auraEl.style.opacity = '1';
    }));
  }

  // Update shader speed (recording overrides live in animateMeter)
  if (!isRecording) {
    shaderSpeed = SCREEN_SPEED[id] ?? 0.10;
    shaderAmplitude = 0;
  }

  if (id === 'analyzing') startAnalyzing();
  if (id === 'field')     renderFieldScreen();
}

/* ── Web Audio synthesis ────────────────────────────────────────── */
function makeNoise(ctx, sec = 2) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
  const d   = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function playWhisper({ duration = 4, levels = [], audioUrl = null, onProgress, onEnd }) {
  if (audioUrl) {
    let src = null, raf, stopped = false;
    const ctx = getAC();
    fetch(audioUrl)
      .then(r => r.arrayBuffer())
      .then(buf => ctx.decodeAudioData(buf))
      .then(decoded => {
        if (stopped) return;
        src = ctx.createBufferSource();
        src.buffer = decoded;
        src.connect(ctx.destination);
        const t0  = ctx.currentTime + 0.02;
        const dur = decoded.duration;
        src.start(t0);
        const tick = () => {
          if (stopped) return;
          const p = Math.min(1, (ctx.currentTime - t0) / dur);
          onProgress && onProgress(p);
          if (p >= 1) { onEnd && onEnd(); return; }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        src.onended = () => {
          if (!stopped) { stopped = true; cancelAnimationFrame(raf); onEnd && onEnd(); }
        };
      })
      .catch(() => {
        if (!stopped) playWhisper({ duration, levels, onProgress, onEnd });
      });
    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      try { src && src.stop(); } catch {}
      onEnd && onEnd();
    };
  }

  const ctx = getAC();
  const t0  = ctx.currentTime + 0.02;

  const src  = ctx.createBufferSource(); src.buffer = makeNoise(ctx); src.loop = true;
  const hp   = ctx.createBiquadFilter(); hp.type = 'highpass';  hp.frequency.value = 380;
  const bp   = ctx.createBiquadFilter(); bp.type = 'bandpass';  bp.frequency.value = 1500; bp.Q.value = 1.1;
  const peak = ctx.createBiquadFilter(); peak.type = 'peaking'; peak.frequency.value = 2400; peak.gain.value = 6; peak.Q.value = 0.8;
  const env    = ctx.createGain(); env.gain.value = 0.0001;
  const master = ctx.createGain(); master.gain.value = 0.9;
  src.connect(hp); hp.connect(bp); bp.connect(peak); peak.connect(env); env.connect(master); master.connect(ctx.destination);

  const lfo     = ctx.createOscillator(); lfo.frequency.value = 0.6;
  const lfoGain = ctx.createGain(); lfoGain.gain.value = 520;
  lfo.connect(lfoGain); lfoGain.connect(bp.frequency); lfo.start(t0);

  let t = t0, i = 0;
  env.gain.setValueAtTime(0.0001, t0);
  while (t < t0 + duration) {
    const lv  = levels.length ? levels[i % levels.length] : 0.4 + Math.random() * 0.5;
    const amp = 0.05 + lv * 0.9;
    const syl = 0.10 + Math.random() * 0.16;
    const gap = 0.02 + Math.random() * 0.10;
    env.gain.setValueAtTime(Math.max(0.0001, env.gain.value), t);
    env.gain.linearRampToValueAtTime(amp, t + syl * 0.4);
    env.gain.linearRampToValueAtTime(0.02, t + syl);
    t += syl + gap; i++;
  }
  env.gain.linearRampToValueAtTime(0.0001, t0 + duration);
  src.start(t0); src.stop(t0 + duration + 0.05);

  let raf, stopped = false;
  const tick = () => {
    if (stopped) return;
    const p = Math.min(1, (ctx.currentTime - t0) / duration);
    onProgress && onProgress(p);
    if (p >= 1) { onEnd && onEnd(); return; }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  src.onended = () => {
    if (!stopped) { stopped = true; cancelAnimationFrame(raf); onEnd && onEnd(); }
  };
  return () => {
    stopped = true; cancelAnimationFrame(raf);
    try { src.stop(); } catch (e) {}
    try { lfo.stop(); } catch (e) {}
    onEnd && onEnd();
  };
}

/* ── genLevels ──────────────────────────────────────────────────── */
function genLevels(sec) {
  const n = Math.max(20, Math.round(sec * 9));
  const a = []; let v = 0.4;
  for (let i = 0; i < n; i++) {
    v = Math.max(0.08, Math.min(1, v + (Math.random() - 0.5) * 0.55));
    a.push(v);
  }
  return a;
}

/* ── Live aura reactivity ───────────────────────────────────────── */
function updateLiveAura(level) {
  const pcEl = document.getElementById('persistentCircle');
  if (!pcEl) return;
  pcEl.style.transform = `translate(-50%, -50%) scale(${1 + level * 0.12})`;
}

/* ── Live sensuality score ──────────────────────────────────────── */
function computeSpectralCentroid() {
  if (!freqData || !audioContext) return 2000;
  analyser.getFloatFrequencyData(freqData);
  const binHz = (audioContext.sampleRate / 2) / freqData.length;
  let wSum = 0, total = 0;
  for (let i = 1; i < freqData.length; i++) {
    const hz = i * binHz;
    if (hz > 6000) break;
    if (freqData[i] < -90) continue;
    const mag = Math.pow(10, freqData[i] / 20);
    wSum  += hz * mag;
    total += mag;
  }
  return total > 1e-6 ? wSum / total : 2000;
}

function computeSmoothedLiveSI(amplitude, noisiness, centroidHz) {
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  const EMA_IN = 0.10;
  siInputSmooth.breathiness += EMA_IN * (clamp01(noisiness)                       - siInputSmooth.breathiness);
  siInputSmooth.darkness    += EMA_IN * (clamp01((4000 - centroidHz) / 3500)      - siInputSmooth.darkness);
  siInputSmooth.softness    += EMA_IN * (clamp01((0.6  - amplitude)  / 0.58)      - siInputSmooth.softness);
  return siInputSmooth.breathiness * 0.45 + siInputSmooth.darkness * 0.30 + siInputSmooth.softness * 0.25;
}

function updateLiveSIScore(score) {
  const EMA = 0.05;
  liveSISmooth += EMA * (score - liveSISmooth);
  const pct  = Math.round(liveSISmooth * 100);
  const num  = document.getElementById('siScoreNumber');
  const fill = document.getElementById('siScoreFill');
  if (num)  num.textContent  = pct;
  if (fill) fill.style.width = pct + '%';
}

/* ── Recording logic ────────────────────────────────────────────── */
function chooseMimeType() {
  const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return opts.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone access requires HTTPS.');
  }
  // Reuse cached stream from early permission request
  stream = cachedStream ?? await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
  });
  cachedStream = null;

  currentBlob      = null;
  chunks           = [];
  analysisSamples  = [];
  recentAmplitudes = [];
  recordedLevels   = [];
  lastLevelAt      = 0;
  liveSISmooth     = 0;
  latestFeatures   = { amplitude: 0, noisiness: 0, tremble: 0, duration: 0 };
  // Reset input smoothers
  siInputSmooth.breathiness = 0.5;
  siInputSmooth.darkness    = 0.5;
  siInputSmooth.softness    = 0.5;

  audioContext = new AudioContext();
  analyser     = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  timeData = new Float32Array(analyser.fftSize);
  freqData = new Float32Array(analyser.frequencyBinCount);
  source   = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  currentMime = chooseMimeType();
  recorder    = new MediaRecorder(stream, currentMime ? { mimeType: currentMime } : undefined);
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = onRecordingStopped;

  recordingStartedAt = performance.now();
  recorder.start();
  isRecording = true;

  document.getElementById('recIndicator').classList.add('visible');
  document.getElementById('backButton').style.visibility = 'hidden';
  document.getElementById('recordCtaHeadline').textContent = 'whispering…';
  document.getElementById('recordCtaSub').textContent      = 'release to stop';
  document.getElementById('liveSIScore')?.classList.add('recording');

  // Remove breathing animation; spring circle back from press, then let amplitude own transform
  circleAddClass('');
  const pcElStart = document.getElementById('persistentCircle');
  if (pcElStart) {
    pcElStart.style.transition = 'transform 0.45s cubic-bezier(0.34,1.56,0.64,1)';
    pcElStart.style.transform  = 'translate(-50%, -50%) scale(1.0)';
    setTimeout(() => { pcElStart.style.transition = ''; }, 450);
  }

  animateMeter();
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  isRecording = false;
  document.getElementById('recIndicator').classList.remove('visible');
  document.getElementById('backButton').style.visibility = '';
  document.getElementById('liveSIScore')?.classList.remove('recording');
}

function abortRecording() {
  if (recorder && recorder.state !== 'inactive') {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.stop();
  }
  stopStream();
  isRecording = false;
  recordedLevels = [];
  chunks = [];
  document.getElementById('recIndicator').classList.remove('visible');
  document.getElementById('backButton').style.visibility = '';
  document.getElementById('recordCtaHeadline').textContent = 'hold to whisper';
  document.getElementById('recordCtaSub').textContent = 'press and hold the circle';
  document.getElementById('liveSIScore')?.classList.remove('recording');
  // Restore circle to breathing state
  updateLiveAura(0);
  circleAddClass('breathing');
  const auraEl = document.getElementById('persistentCircleAura');
  if (auraEl) auraEl.style.opacity = '1';
}

function showRecordHint() {
  const sub = document.getElementById('recordCtaSub');
  sub.textContent = 'hold a little longer…';
  setTimeout(() => {
    if (currentScreen === 'record' && !isRecording) {
      sub.textContent = 'press and hold the circle';
    }
  }, 2000);
}

function onRecordingStopped() {
  currentBlob = new Blob(chunks, { type: currentMime || 'audio/webm' });
  const dur   = Math.max(2, Math.round((performance.now() - recordingStartedAt) / 1000));
  draft = {
    levels:   recordedLevels.length ? [...recordedLevels] : genLevels(dur),
    duration: dur,
    blob:     currentBlob,
  };
  stopStream();

  const pcEl = document.getElementById('persistentCircle');
  if (pcEl) pcEl.style.transform = 'translate(-50%, -50%)'; // reset amplitude scale

  // Hide aura
  const auraEl = document.getElementById('persistentCircleAura');
  if (auraEl) auraEl.style.opacity = '0';

  // Shrink circle to black dot
  circleAddClass('');
  setCircle({
    size: 16,
    bg: '#141018',
    transition: [
      'width 0.45s cubic-bezier(0.4,0,0.6,1)',
      'height 0.45s cubic-bezier(0.4,0,0.6,1)',
      'background 0.3s ease',
      'left 0.65s cubic-bezier(0.4,0,0.2,1)',
      'top 0.65s cubic-bezier(0.4,0,0.2,1)',
      'opacity 0.35s ease',
      'box-shadow 0.4s ease',
    ].join(', '),
  });

  // Transition to analyzing screen (screens cross-fade; circle continues shrinking above)
  showScreen('analyzing');

  // After shrink completes, start blinking
  setTimeout(() => { circleAddClass('analyzing'); }, 500);
}

function stopStream() {
  cancelAnimationFrame(animationId);
  if (stream)       stream.getTracks().forEach(t => t.stop());
  if (audioContext) audioContext.close().catch(() => {});
}

function animateMeter() {
  analyser.getFloatTimeDomainData(timeData);
  const samples  = Array.from(timeData);
  const features = analyzeSamples(samples);
  latestFeatures = { ...features, duration: (performance.now() - recordingStartedAt) / 1000 };

  analysisSamples.push(...downsample(samples, 32));
  if (analysisSamples.length > 4096) analysisSamples = analysisSamples.slice(-4096);

  const now = performance.now();
  if (now - lastLevelAt > 105) {
    recordedLevels.push(features.amplitude);
    lastLevelAt = now;
  }

  document.getElementById('recTimer').textContent = formatTime(latestFeatures.duration);
  updateLiveAura(features.amplitude);

  const centroidHz = computeSpectralCentroid();
  updateLiveSIScore(computeSmoothedLiveSI(features.amplitude, features.noisiness, centroidHz));

  // Drive shader: speed ramps with voice amplitude
  shaderAmplitude = features.amplitude;
  shaderSpeed     = 0.25 + features.amplitude * 1.2;

  postLiveFeatures(latestFeatures);
  animationId = requestAnimationFrame(animateMeter);
}

/* ── Audio analysis ─────────────────────────────────────────────── */
function analyzeSamples(samples) {
  let sum = 0, peak = 0, crossings = 0;
  let previous = samples[0] || 0;
  for (const sample of samples) {
    const abs = Math.abs(sample);
    sum  += sample * sample;
    peak  = Math.max(peak, abs);
    if ((previous < 0 && sample >= 0) || (previous >= 0 && sample < 0)) crossings++;
    previous = sample;
  }
  const amplitude = Math.sqrt(sum / samples.length);
  recentAmplitudes.push(amplitude);
  if (recentAmplitudes.length > 36) recentAmplitudes.shift();
  const mean     = recentAmplitudes.reduce((a, v) => a + v, 0) / Math.max(1, recentAmplitudes.length);
  const variance = recentAmplitudes.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, recentAmplitudes.length);
  return {
    amplitude: round(amplitude),
    peak:      round(peak),
    noisiness: round(Math.min(1, (crossings / samples.length) * 18)),
    tremble:   round(Math.min(1, Math.sqrt(variance) / Math.max(0.001, mean) / 2.5)),
  };
}

function downsample(samples, count) {
  const step = Math.max(1, Math.floor(samples.length / count));
  const result = [];
  for (let i = 0; i < samples.length; i += step) {
    result.push(round(samples[i]));
    if (result.length >= count) break;
  }
  return result;
}

function postLiveFeatures(features) {
  const now = performance.now();
  if (now - livePostAt < 120) return;
  livePostAt = now;
  fetch('/osc/live', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(features),
  }).catch(() => {});
}

/* ── Analyzing screen ───────────────────────────────────────────── */
async function startAnalyzing() {
  // Rough fingerprint for immediate visual feedback while server processes
  const roughParams = buildRoughFingerprintParams(latestFeatures, draft);
  startFingerprintOnCanvas(roughParams);

  const headline = document.getElementById('analyzingHeadline');
  if (headline) headline.innerHTML = 'generating your<br>unique fingerprint';

  let record = null;
  try {
    record = await saveWhisperToServer();
    const fp = record.fieldPosition || {};
    enc = {
      id:              record.id,
      wspr:            record.wspr || '????',
      fieldX:          fp.x != null ? fp.x : 50,
      fieldY:          fp.y != null ? fp.y : 50,
      sensuality:      record.sensuality ? Math.round(record.sensuality.score * 100) : null,
      levels:          draft ? draft.levels : [],
      duration:        draft ? draft.duration : 4,
      whisperizedFile:      record.whisperizedFile      || null,
      generatedWhisperFile: record.generatedWhisperFile || null,
    };
    lastFingerprintParams = buildFingerprintParams(record);
  } catch (err) {
    console.warn('Server save failed, using fallback:', err.message);
    const h = clientHash(draft);
    enc = {
      id:         null,
      wspr:       clientCode(h),
      fieldX:     8 + (h % 84),
      fieldY:     8 + ((h >>> 9) % 84),
      sensuality: null,
      levels:     draft ? draft.levels : [],
      duration:   draft ? draft.duration : 4,
    };
    lastFingerprintParams = roughParams;
  }

  // Restart with the REAL deterministic params (whisper ID as seed) so the
  // fingerprint here is identical to every subsequent replay of this whisper.
  startFingerprintOnCanvas(lastFingerprintParams);

  // Wait for form (2500ms) + settle (2000ms) + rested display (1500ms) = 6000ms
  // so the user always sees the fully settled fingerprint before the shrink.
  await new Promise(r => setTimeout(r, 6000));

  // Slide dot to field position while fingerprint shrinks
  circleAddClass('');
  setCircle({
    x: enc.fieldX,
    y: enc.fieldY,
    transition: [
      'left 0.75s cubic-bezier(0.4,0,0.2,1)',
      'top 0.75s cubic-bezier(0.4,0,0.2,1)',
      'width 0.4s ease',
      'height 0.4s ease',
      'opacity 0.35s ease',
      'background 0.4s ease',
      'box-shadow 0.4s ease',
    ].join(', '),
  });

  // Shrink fingerprint into dot, then transition to field
  const afterShrink = () => {
    stopFingerprintOnCanvas();
    showScreen('field');
    setTimeout(() => {
      const fieldDot = document.querySelector('.field-dot');
      if (fieldDot) fieldDot.style.opacity = '1';
      setCircle({ opacity: 0, transition: 'opacity 0.35s ease' });
    }, 780);
  };

  if (currentFingerprint) {
    currentFingerprint.shrink(afterShrink);
  } else {
    afterShrink();
  }
}

function buildRoughFingerprintParams(features, draftData) {
  const amp     = features?.amplitude ?? 0.3;
  const noisy   = features?.noisiness ?? 0.4;
  const tremble = features?.tremble   ?? 0.2;
  const dur     = draftData?.duration ?? 4;
  return {
    breathiness:     Math.min(1, noisy),
    darkness:        0.35 + tremble * 0.35,
    softness:        Math.max(0, 1 - amp * 3.5),
    slowness:        0.5,
    pitchLowness:    0.4 + amp * 0.3,
    pitchSteadiness: Math.max(0, 1 - tremble * 2),
    amplitude:       Math.min(1, amp * 3),
    duration:        Math.min(30, dur),
    seed:            String(draftData?.duration ?? Date.now()).slice(-6),
    // semantic defaults — neutral until server responds with real values
    sensory: 0.5, relational: 0.5, taboo: 0.5, tenderness: 0.5,
    fantasy: 0.5, identity: 0.5,  longing: 0.5, unspeakable: 0.5,
  };
}

function startFingerprintOnCanvas(params) {
  const fpCanvas = document.getElementById('fingerprintCanvas');
  if (!fpCanvas) return;
  const shell = document.querySelector('.app-shell');
  const dpr   = Math.min(window.devicePixelRatio || 1, 2);
  const sw    = shell?.offsetWidth  || 390;
  const sh    = shell?.offsetHeight || 844;
  fpCanvas.width        = Math.round(sw * dpr);
  fpCanvas.height       = Math.round(sh * dpr);
  fpCanvas.style.width  = sw + 'px';
  fpCanvas.style.height = sh + 'px';
  fpCanvas.hidden = false;
  if (currentFingerprint) currentFingerprint.stop();
  currentFingerprint = new FingerprintRenderer(fpCanvas, params, _recorderFpCfg);
  currentFingerprint.start();
}

function stopFingerprintOnCanvas() {
  if (currentFingerprint) { currentFingerprint.stop(); currentFingerprint = null; }
  const fpCanvas = document.getElementById('fingerprintCanvas');
  if (fpCanvas) fpCanvas.hidden = true;
  const headline = document.getElementById('analyzingHeadline');
  if (headline) headline.innerHTML = 'listening to<br>your whisper…';
}

function replayFingerprint() {
  if (!lastFingerprintParams) return;
  const screen = document.getElementById('screen-field');
  if (!screen) return;

  document.querySelector('.fp-replay-canvas')?.remove();

  const canvas = document.createElement('canvas');
  canvas.className = 'fp-replay-canvas';
  const shell = document.querySelector('.app-shell');
  const dpr   = Math.min(window.devicePixelRatio || 1, 2);
  const sw    = shell?.offsetWidth  || 390;
  const sh    = shell?.offsetHeight || 844;
  canvas.width        = Math.round(sw * dpr);
  canvas.height       = Math.round(sh * dpr);
  canvas.style.width  = sw + 'px';
  canvas.style.height = sh + 'px';
  screen.appendChild(canvas);

  // Hide replay button while animation is playing
  const replayBtn = document.getElementById('replayButton');
  if (replayBtn) replayBtn.hidden = true;

  if (currentFingerprint) currentFingerprint.stop();
  currentFingerprint = new FingerprintRenderer(canvas, lastFingerprintParams, _recorderFpCfg);
  currentFingerprint.start();

  // 7500ms: form(2500) + settle(2000) + rested view(3000) before shrink
  setTimeout(() => {
    if (!currentFingerprint) return;
    currentFingerprint.shrink(() => {
      canvas.remove();
      currentFingerprint = null;
      if (replayBtn) replayBtn.hidden = false;
    });
  }, 7500);
}

function clientHash(draftData) {
  let h = 2166136261 >>> 0;
  (draftData?.levels || []).forEach(v => {
    h ^= Math.floor(v * 255); h = Math.imul(h, 16777619) >>> 0;
  });
  h ^= Math.floor((draftData?.duration || 0) * 131);
  return Math.imul(h, 16777619) >>> 0;
}

function clientCode(h) {
  const raw = (h.toString(36).toUpperCase() + '0000').replace(/[^A-Z0-9]/g, '');
  return raw.slice(0, 4);
}

/* ── Server save ────────────────────────────────────────────────── */
async function saveWhisperToServer() {
  if (!draft || !draft.blob) throw new Error('No draft');
  const payload = {
    source:          'browser',
    transcript:      '',
    audioMime:       draft.blob.type || 'audio/webm',
    audioBase64:     await blobToBase64(draft.blob),
    features:        latestFeatures,
    analysisSamples,
  };
  const res = await fetch('/whispers?sync=1', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Server save failed: ' + res.status);
  return res.json();
}

/* ── Field screen ───────────────────────────────────────────────── */
function renderFieldScreen() {
  if (!enc) return;

  document.getElementById('fieldConfirmState').hidden = false;
  document.getElementById('fieldReceiptState').hidden = true;
  document.getElementById('fieldTopLabels').hidden    = true;
  // Ensure card is never stuck off-screen from a previous confirm animation
  document.querySelector('.field-overlay-card')?.classList.remove('card--hidden');

  renderFieldDot(enc.fieldX, enc.fieldY, enc.wspr, enc.sensuality);
}

function renderFieldDot(x, y, wspr, sensuality) {
  const overlay = document.getElementById('fieldMapOverlay');
  overlay.querySelectorAll(
    '.field-crosshair-v, .field-crosshair-h, .field-dot, .field-dot-label'
  ).forEach(e => e.remove());

  const vline = document.createElement('div');
  vline.className = 'field-crosshair-v';
  vline.style.left = x + '%';
  overlay.appendChild(vline);

  const hline = document.createElement('div');
  hline.className = 'field-crosshair-h';
  hline.style.top = y + '%';
  overlay.appendChild(hline);

  const dot = document.createElement('div');
  dot.className  = 'field-dot';
  dot.style.left = x + '%';
  dot.style.top  = y + '%';
  const playSpan = document.createElement('span');
  playSpan.className = 'field-dot-play';
  playSpan.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24"><path d="M8 5l11 7-11 7V5z" fill="#fff"/></svg>`;
  dot.appendChild(playSpan);
  overlay.appendChild(dot);

  const label = document.createElement('div');
  label.className = 'field-dot-label';
  label.style.left = x + '%';
  label.style.top  = y + '%';
  const siPart = sensuality !== null ? ` · ${sensuality}%` : '';
  label.textContent = `WSPR·${wspr}${siPart}`;
  label.style.transform = x > 55
    ? 'translate(calc(-100% - 14px), -50%)'
    : 'translate(14px, -50%)';
  overlay.appendChild(label);
}

function confirmWhisper() {
  const dot = document.querySelector('.field-dot');
  if (dot) dot.classList.add('field-dot--center');

  document.querySelectorAll('.field-crosshair-h, .field-crosshair-v')
    .forEach(el => { el.style.opacity = '0'; el.style.transition = 'opacity 0.4s'; });

  const card = document.querySelector('.field-overlay-card');
  card.classList.add('card--hidden');

  setTimeout(() => {
    document.getElementById('fieldConfirmState').hidden = true;
    document.getElementById('fieldReceiptState').hidden = false;
    document.getElementById('fieldTopLabels').hidden    = false;

    document.getElementById('fieldCode').textContent = enc.wspr;
    document.getElementById('fieldSensualityLabel').textContent =
      enc.sensuality !== null ? `${enc.sensuality}% sensuality` : '';
    document.getElementById('emailInputRow').hidden = false;
    document.getElementById('emailSent').hidden     = true;
    document.getElementById('emailInput').value     = '';
    initFieldNav(enc);

    card.classList.remove('card--hidden');

    // Animate top labels in
    document.querySelectorAll('#fieldTopLabels .anim-in').forEach((el, i) => {
      el.classList.remove('animated');
      setTimeout(() => el.classList.add('animated'), i * 80 + 30);
    });
  }, 280);

  shaderSpeed     = 0.04;
  shaderAmplitude = 0;

  setTimeout(() => {
    if (dot) dot.addEventListener('click', toggleFieldPlay);
  }, 650);
}

async function retryWhisper() {
  if (fieldStopper) { fieldStopper(); fieldStopper = null; }
  stopFingerprintOnCanvas();
  cleanupFieldNav();

  // Delete previous whisper in background
  if (enc && enc.id) {
    fetch('/whispers/' + enc.id, { method: 'DELETE' }).catch(() => {});
  }

  // Reset persistent circle for re-entry
  setCircle({ size: 0, opacity: 0, instant: true });
  circleBuilt = false;
  const auraEl = document.getElementById('persistentCircleAura');
  if (auraEl) {
    auraEl.style.opacity = '0';
    delete auraEl.dataset.built;
    auraEl.innerHTML = '';
  }

  draft = null;
  enc   = null;
  recordedLevels = [];
  liveSISmooth   = 0;

  showScreen('record');

  // Request mic (user gesture still active from retry button click)
  try {
    cachedStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    document.getElementById('recordCtaSub').textContent =
      'Microphone access needed — check browser settings';
  }
}

function setFieldPlayIcon(playing) {
  const el = document.querySelector('.field-dot-play');
  if (!el) return;
  el.innerHTML = playing
    ? `<svg width="22" height="22" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1.5" fill="#fff"/><rect x="14" y="5" width="4" height="14" rx="1.5" fill="#fff"/></svg>`
    : `<svg width="22" height="22" viewBox="0 0 24 24"><path d="M8 5l11 7-11 7V5z" fill="#fff"/></svg>`;
}

function toggleFieldPlay() {
  // Tap feedback: quick shrink-and-spring on the dot
  const dot = document.querySelector('.field-dot--center');
  if (dot) {
    dot.style.transform = 'scale(0.86)';
    setTimeout(() => { if (dot) dot.style.transform = 'scale(1)'; }, 110);
  }
  if (fieldStopper) {
    fieldStopper(); fieldStopper = null;
    setFieldPlayIcon(false);
    return;
  }
  setFieldPlayIcon(true);
  replayFingerprint();
  const audioUrl = enc.generatedWhisperFile ? '/' + enc.generatedWhisperFile
                 : enc.whisperizedFile      ? '/' + enc.whisperizedFile
                 : null;
  fieldStopper = playWhisper({
    duration: enc.duration,
    levels:   enc.levels,
    audioUrl,
    onEnd:    () => { fieldStopper = null; setFieldPlayIcon(false); },
  });
}

/* ── Field navigation ───────────────────────────────────────────── */
function initFieldNav(encData) {
  lensX = Math.max(0, Math.min(1, (encData.fieldX ?? 50) / 100));
  lensY = Math.max(0, Math.min(1, (encData.fieldY ?? 50) / 100));

  document.getElementById('fieldNav').hidden = false;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  fieldWs = new WebSocket(`${proto}//${location.host}/ws?type=phone`);

  fieldWs.onopen = () => {
    fieldWs.send(JSON.stringify({
      type: 'join',
      whisperX: encData.fieldX ?? 50,
      whisperY: encData.fieldY ?? 50,
    }));
  };
  fieldWs.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'nearby') renderNearbyWhispers(msg.whispers || []);
    } catch {}
  };
  fieldWs.onerror  = () => {};
  fieldWs.onclose  = () => {};

  clearInterval(fieldNavTimer);
  fieldNavTimer = setInterval(sendLensPosition, 80);

  wireJoystick();
  wireDragHandle();
}

function cleanupFieldNav() {
  clearInterval(fieldNavTimer);
  fieldNavTimer = null;
  joystickActive = false;
  joystickVx = 0; joystickVy = 0;
  if (joystickAbort)   { joystickAbort.abort();   joystickAbort   = null; }
  if (dragHandleAbort) { dragHandleAbort.abort(); dragHandleAbort = null; }
  if (fieldWs) {
    try { fieldWs.close(); } catch {}
    fieldWs = null;
  }
  const fieldNav = document.getElementById('fieldNav');
  if (fieldNav) fieldNav.hidden = true;
  const pt = document.getElementById('passingThrough');
  if (pt) pt.hidden = true;
  const card = document.querySelector('.field-overlay-card');
  if (card) { card.classList.remove('collapsed'); card.style.transform = ''; }
  if (currentFingerprint) { currentFingerprint.stop(); currentFingerprint = null; }
  document.querySelector('.fp-replay-canvas')?.remove();
}

function sendLensPosition() {
  if (!fieldWs || fieldWs.readyState !== WebSocket.OPEN) return;
  if (joystickActive) {
    lensX = Math.max(0, Math.min(1, lensX + joystickVx * 0.008));
    lensY = Math.max(0, Math.min(1, lensY + joystickVy * 0.008));
  }
  fieldWs.send(JSON.stringify({ type: 'move', x: lensX, y: lensY }));
}

function wireJoystick() {
  const outer = document.getElementById('joystickOuter');
  const knob  = document.getElementById('joystickKnob');
  if (!outer || !knob) return;

  if (joystickAbort) joystickAbort.abort();
  joystickAbort = new AbortController();
  const { signal } = joystickAbort;

  const MAX_D = 58; // max displacement from center in px

  function getOffset(e) {
    const rect  = outer.getBoundingClientRect();
    const cx    = rect.left + rect.width  / 2;
    const cy    = rect.top  + rect.height / 2;
    const touch = e.touches ? e.touches[0] : e;
    let dx = touch.clientX - cx, dy = touch.clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > MAX_D) { dx = dx / dist * MAX_D; dy = dy / dist * MAX_D; }
    return { dx, dy, vx: dx / MAX_D, vy: dy / MAX_D };
  }

  function onStart(e) { e.preventDefault(); joystickActive = true; knob.classList.add('dragging'); }
  function onMove(e) {
    e.preventDefault();
    if (!joystickActive) return;
    const { dx, dy, vx, vy } = getOffset(e);
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    joystickVx = vx; joystickVy = vy;
  }
  function onEnd(e) {
    e.preventDefault();
    joystickActive = false; joystickVx = 0; joystickVy = 0;
    knob.classList.remove('dragging');
    knob.style.transform = 'translate(-50%, -50%)';
  }

  outer.addEventListener('touchstart',  onStart, { passive: false, signal });
  outer.addEventListener('touchmove',   onMove,  { passive: false, signal });
  outer.addEventListener('touchend',    onEnd,   { passive: false, signal });
  outer.addEventListener('touchcancel', onEnd,   { passive: false, signal });
  outer.addEventListener('mousedown',  onStart, { signal });
  window.addEventListener('mousemove', e => { if (joystickActive) onMove(e); }, { signal });
  window.addEventListener('mouseup',   e => { if (joystickActive) onEnd(e); }, { signal });
}

function wireDragHandle() {
  const card   = document.querySelector('.field-overlay-card');
  const handle = document.getElementById('cardDragHandle');
  if (!card || !handle) return;

  if (dragHandleAbort) dragHandleAbort.abort();
  dragHandleAbort = new AbortController();
  const { signal } = dragHandleAbort;

  let startY = null, startTranslateY = 0, dragging = false, didDrag = false;

  function getTranslateY() {
    const m = new DOMMatrix(getComputedStyle(card).transform);
    return m.m42;
  }

  function getCollapsedY() {
    return card.offsetHeight - 64;
  }

  function toggle() {
    card.style.transform = '';
    card.classList.toggle('collapsed');
  }

  function onStart(e) {
    startY = (e.touches ? e.touches[0] : e).clientY;
    startTranslateY = getTranslateY();
    dragging = true;
    didDrag  = false;
    card.style.transition = 'none';
  }

  function onMove(e) {
    if (!dragging) return;
    const dy = (e.touches ? e.touches[0] : e).clientY - startY;
    if (Math.abs(dy) > 6) didDrag = true;
    if (!didDrag) return;
    e.preventDefault();
    const raw = Math.max(0, startTranslateY + dy);
    card.style.transform = `translateY(${raw}px)`;
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;
    card.style.transition = '';
    if (!didDrag) {
      // Pure tap — toggle without needing to drag
      toggle();
      return;
    }
    const currentY = getTranslateY();
    const threshold = 40;
    const isCollapsed = card.classList.contains('collapsed');
    if (isCollapsed ? currentY < getCollapsedY() - threshold : currentY > threshold) {
      card.classList.toggle('collapsed');
    }
    card.style.transform = '';
  }

  handle.addEventListener('touchstart',  onStart, { passive: true, signal });
  window.addEventListener('touchmove',   onMove,  { passive: false, signal });
  window.addEventListener('touchend',    onEnd,   { signal });
  handle.addEventListener('mousedown',   onStart, { signal });
  window.addEventListener('mousemove',   onMove,  { signal });
  window.addEventListener('mouseup',     onEnd,   { signal });

  const replay = document.getElementById('replayButton');
  if (replay) replay.addEventListener('click', () => replayFingerprint(), { signal });
}

function renderNearbyWhispers(whispers) {
  const pt   = document.getElementById('passingThrough');
  const list = document.getElementById('ptList');
  if (!pt || !list) return;
  if (!whispers.length) { pt.hidden = true; return; }
  pt.hidden = false;
  list.innerHTML = whispers.map(w => {
    const color = DIM_COLORS_PHONE[w.tags?.[0]] || '#9055D4';
    const pct   = Math.round((w.score || 0) * 100);
    const text  = (w.transcript || '…').replace(/"/g, '');
    const tags  = (w.tags || []).join(' · ');
    return `<li class="pt-item">
      <span class="pt-dim-dot" style="background:${color}"></span>
      <div class="pt-body">
        <span class="pt-quote">"${text}"</span>
        <div class="pt-tags">${tags}</div>
      </div>
      <span class="pt-score">${pct}%</span>
    </li>`;
  }).join('');
}

/* ── Utilities ──────────────────────────────────────────────────── */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function formatTime(seconds = 0) {
  const s  = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function round(v) { return Math.round(v * 10000) / 10000; }

/* ── Event wiring ───────────────────────────────────────────────── */

// Splash → Record: show record screen and immediately request mic
document.getElementById('beginButton').addEventListener('click', async () => {
  getAC();
  showScreen('record');
  try {
    cachedStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    document.getElementById('recordCtaSub').textContent =
      'Microphone access needed — check browser settings';
  }
});

// Record → Splash (back)
document.getElementById('backButton').addEventListener('click', () => {
  if (isRecording) abortRecording();
  // Dismiss circle
  circleAddClass('');
  setCircle({
    size: 0, opacity: 0,
    transition: 'width 0.35s ease, height 0.35s ease, opacity 0.3s ease, left 0.65s cubic-bezier(0.4,0,0.2,1), top 0.65s cubic-bezier(0.4,0,0.2,1), background 0.4s ease, box-shadow 0.4s ease',
  });
  circleBuilt = false;
  const auraEl = document.getElementById('persistentCircleAura');
  if (auraEl) auraEl.style.opacity = '0';
  showScreen('splash');
});

// Record — hold-to-record
const auraButton = document.getElementById('auraButton');

auraButton.addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  if (isRecording || currentScreen !== 'record') return;
  recordPressedAt = performance.now();
  auraButton.classList.add('btn--pressed');
  // Press feedback: circle shrinks on contact
  const pcElPress = document.getElementById('persistentCircle');
  if (pcElPress) {
    pcElPress.style.transition = 'transform 0.10s ease-in';
    pcElPress.style.transform  = 'translate(-50%, -50%) scale(0.94)';
  }
  try {
    await startRecording();
  } catch (err) {
    auraButton.classList.remove('btn--pressed');
    document.getElementById('recordCtaSub').textContent =
      err.message || 'Microphone access failed.';
    // Restore circle on failure
    if (pcElPress) {
      pcElPress.style.transition = 'transform 0.3s ease-out';
      pcElPress.style.transform  = 'translate(-50%, -50%)';
    }
  }
});

function onRecordRelease(e) {
  auraButton.classList.remove('btn--pressed');
  if (!isRecording) return;
  const held = performance.now() - recordingStartedAt;
  if (held < MIN_RECORD_MS) {
    abortRecording();
    showRecordHint();
    return;
  }
  stopRecording();
}

auraButton.addEventListener('pointerup',     onRecordRelease);
auraButton.addEventListener('pointercancel', onRecordRelease);
auraButton.addEventListener('contextmenu', e => e.preventDefault());

// Field — confirm / retry
document.getElementById('confirmButton').addEventListener('click', confirmWhisper);
document.getElementById('retryButton').addEventListener('click', retryWhisper);

// Field — restart
document.getElementById('restartButton').addEventListener('click', () => {
  if (fieldStopper) { fieldStopper(); fieldStopper = null; }
  stopFingerprintOnCanvas();
  cleanupFieldNav();
  // Circle is already faded out (handed off to field-dot and then hidden)
  circleBuilt = false;
  draft = null;
  enc   = null;
  recordedLevels = [];
  liveSISmooth   = 0;
  showScreen('splash');
});

// Field — email
document.getElementById('emailSendButton').addEventListener('click', () => {
  const email = document.getElementById('emailInput').value;
  if (!email.includes('@')) return;
  document.getElementById('emailInputRow').hidden = true;
  document.getElementById('emailSent').hidden     = false;
  document.getElementById('emailSentText').textContent =
    `Sent to ${email}. Keep it somewhere safe.`;
});

/* ── Boot ───────────────────────────────────────────────────────── */
// Fetch fingerprint config non-blocking — available before any fingerprint appears
(async () => {
  try { const c = await fetch('/config').then(r => r.json()); _recorderFpCfg = buildFingerprintConfig(c); } catch {}
})();

initShader();
resizeShader();
window.addEventListener('resize', resizeShader);
shaderRafId = requestAnimationFrame(shaderLoop);
showScreen('splash');
