/* ── fingerprint.js ──────────────────────────────────────────────────
   Deterministic blob renderer shared by recorder.js, umap.html,
   gallery.html, and admin.html. Canvas 2D only — no external deps.

   Animation phases (durations configurable via FP_CFG_DEFAULTS):
     FORMING   (0 → formingMs)           blobs grow from 0, drift outward
     SETTLING  (formingMs → +settlingMs)  blobs lerp to fixed resting positions
     RESTED    (after settling)           stationary — gentle BREATHE only
     SHRINK    (external trigger)         scale + alpha → 0 over ~1450ms
   ─────────────────────────────────────────────────────────────────── */

const FP_CFG_DEFAULTS = {
  positionSpread:           0.55,  // 0 = tight cluster, 1 = spread to canvas edge
  orbitSpread:              0.80,  // orbit radius scale per-blob value (0 = no orbit)
  breathinessSizeScale:     1.0,
  darknessSizeScale:        1.0,
  softnessSizeScale:        1.0,
  pitchLownessSizeScale:    1.0,
  slownessSizeScale:        1.0,   // solid dark-grey dot
  pitchSteadinessSizeScale: 1.0,   // solid light-grey dot
  sensorySizeScale:         1.0,   // pale-pink background bloom
  tabooSizeScale:           1.0,   // dark wine blob
  identitySizeScale:        1.0,   // white-gold anchor blob
  unspeakableSizeScale:     1.0,   // near-black peripheral blob
  accentDotCount:           3,     // large accent dots (0 = disabled)
  accentDotMaxSize:         28,    // px — max radius of a large accent dot
  particleBase:             5,     // minimum sparkle particle count (duration adds up to 15 more)
  particleFantasyScale:     0.8,   // how much the `fantasy` variable multiplies particle count (0 = ignore)
  satelliteMax:             5,     // cap on satellite orb count (breathiness drives 2–max)
  formingMs:                2500,  // FORMING phase duration
  settlingMs:               2000,  // SETTLING phase duration
  breatheStrength:          1.0,   // BREATHE multiplier (0 = frozen, 2 = strong)
  maskInner:                55,    // % — fully visible up to this radius
  maskOuter:                92,    // % — fades to transparent by this radius
  maskShape:                'circle', // 'circle' (radial vignette) or 'rect' (rounded-rectangle vignette, fills more of the cell)
  blendMode:                'screen', // 'screen' for dark bg, 'multiply' for light bg
  showSemanticLabels:       false, // overlay tag names on semantic blobs
  semanticLabelColor:       '#ffffff',
  semanticLabelThreshold:   0.5,   // min raw param value to draw a label (0 = always show)
  semanticLabelFontScale:   1.0,   // multiplier on base canvas label font size
};

class FingerprintRenderer {
  constructor(canvas, params, config = {}) {
    this._canvas = canvas;
    this._ctx    = canvas.getContext('2d');
    this._p      = params;
    this._cfg    = Object.assign({}, FP_CFG_DEFAULTS, config);
    this._raf    = null;
    this._startTime   = null;
    this._shrinking   = false;
    this._shrinkStart = null;
    this._onDone      = null;
    this._loop = this._loop.bind(this);

    // Soft edge — replaces hard rectangular canvas clip with a fade
    const mi = this._cfg.maskInner, mo = this._cfg.maskOuter;
    if (this._cfg.maskShape === 'rect') {
      // Rounded-rectangle vignette: intersect a horizontal + vertical feather.
      // Feathered bands overlap to soft, rounded corners while filling far more
      // of the cell than the inscribed circle of the radial mask.
      const fade = Math.min(40, Math.max(8, (100 - mo) + 6));
      const gx = `linear-gradient(to right,  transparent 0%, black ${fade}%, black ${100 - fade}%, transparent 100%)`;
      const gy = `linear-gradient(to bottom, transparent 0%, black ${fade}%, black ${100 - fade}%, transparent 100%)`;
      canvas.style.maskImage = `${gx}, ${gy}`;
      canvas.style.webkitMaskImage = `${gx}, ${gy}`;
      canvas.style.maskComposite = 'intersect';
      canvas.style.webkitMaskComposite = 'source-in';
    } else {
      const mask = `radial-gradient(ellipse 50% 50% at 50% 50%, black ${mi}%, transparent ${mo}%)`;
      canvas.style.maskImage = mask;
      canvas.style.webkitMaskImage = mask;
    }

    this._buildBlobs();
    this._buildParticles();
  }

  /* Mulberry32-variant seeded PRNG — deterministic from string seed */
  _rng(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = Math.imul(31, h) + seed.charCodeAt(i) | 0;
    let s = h >>> 0;
    return () => {
      s = Math.imul(s ^ s >>> 15, s | 1);
      s ^= s + Math.imul(s ^ s >>> 7, s | 61);
      return ((s ^ s >>> 14) >>> 0) / 0xffffffff;
    };
  }

  _buildBlobs() {
    const p   = this._p;
    const cfg = this._cfg;
    const w   = this._canvas.width;
    const h   = this._canvas.height;
    const str = String(p.seed);

    // Slightly smaller R so blobs have room before reaching the mask fade zone
    const R = Math.min(w, h) * (0.30 + p.amplitude * 0.12);

    const tendMod = 1 - p.tenderness * 0.40;

    // orbit radius: scales with the blob's own value so high-value blobs orbit wider
    const oR = (val, base) => R * (base + val * 0.45 * cfg.orbitSpread);

    // Per-composition saturation: tenderness → pastel, taboo → vivid
    const satAdj = (p.tenderness - 0.5) * 0.65 - Math.max(0, p.taboo - 0.45) * 0.55;

    this._blobs = [
      { // breathiness — pleasure pink
        _tag: 'breathiness', _rawValue: p.breathiness,
        color:      this._saturate('#FF2D8E', satAdj),
        radius:     R * (0.28 + p.breathiness * 1.12) * cfg.breathinessSizeScale,
        falloffMid: 0.26 + p.breathiness * 0.22,
        orbitR:     oR(p.breathiness, 0.12),
        orbitAngle: 0,
        orbitSpeed: 0.22 + (1 - p.slowness) * 0.18,
        breathFreq: 0.40 + p.slowness * 0.30,
        wobble:     (1 - p.pitchSteadiness) * 0.10 * cfg.breatheStrength,
        opacity:    (0.06 + p.breathiness * 0.84) * tendMod,
      },
      { // darkness — curiosity purple
        _tag: 'darkness', _rawValue: p.darkness,
        color:      this._saturate('#8A2BE2', satAdj),
        radius:     R * (0.22 + p.darkness * 1.18) * cfg.darknessSizeScale,
        falloffMid: 0.26 + p.darkness * 0.22,
        orbitR:     oR(p.darkness, 0.10),
        orbitAngle: Math.PI * 0.67,
        orbitSpeed: 0.18 + (1 - p.slowness) * 0.14,
        breathFreq: 0.35 + p.slowness * 0.25,
        wobble:     (1 - p.pitchSteadiness) * 0.08 * cfg.breatheStrength,
        opacity:    (0.05 + p.darkness * 0.85) * tendMod,
      },
      { // softness — amber (inverted: high softness = smaller/fainter)
        _tag: 'softness', _rawValue: p.softness,
        color:      this._saturate('#FFAE00', satAdj),
        radius:     R * (0.20 + (1 - p.softness) * 0.90) * cfg.softnessSizeScale,
        falloffMid: 0.26 + (1 - p.softness) * 0.22,
        orbitR:     oR(1 - p.softness, 0.09),
        orbitAngle: Math.PI * 1.33,
        orbitSpeed: 0.28 + (1 - p.slowness) * 0.20,
        breathFreq: 0.50 + p.slowness * 0.40,
        wobble:     (1 - p.pitchSteadiness) * 0.08 * cfg.breatheStrength,
        opacity:    (0.05 + (1 - p.softness) * 0.82) * tendMod,
      },
      { // pitchLowness — rose
        _tag: 'pitch lowness', _rawValue: p.pitchLowness,
        color:      this._saturate('#FF5070', satAdj),
        radius:     R * (0.24 + p.pitchLowness * 1.06) * cfg.pitchLownessSizeScale,
        falloffMid: 0.26 + p.pitchLowness * 0.22,
        orbitR:     oR(p.pitchLowness, 0.09),
        orbitAngle: Math.PI * 1.85,
        orbitSpeed: 0.15 + (1 - p.slowness) * 0.12,
        breathFreq: 0.30 + p.slowness * 0.20,
        wobble:     (1 - p.pitchSteadiness) * 0.12 * cfg.breatheStrength,
        opacity:    (0.05 + p.pitchLowness * 0.82) * tendMod,
        offsetY:    R * 0.08 * p.pitchLowness,
      },
    ];

    // Semantic blobs — only appear when the score is meaningfully above neutral (0.5)
    const tabooStr    = Math.max(0, (p.taboo       - 0.5) * 2);
    const unspStr     = Math.max(0, (p.unspeakable - 0.5) * 2);
    const sensoryStr  = Math.max(0, (p.sensory     - 0.4) * 1.67);
    const identityStr = Math.max(0, (p.identity    - 0.5) * 2);

    this._semanticBlobs = [];

    // Background wash — dominant acoustic blob color fills the canvas softly
    const blobValues = [p.breathiness, p.darkness, 1 - p.softness, p.pitchLowness];
    const maxVal = Math.max(...blobValues);
    if (maxVal > 0.65) {
      const bgColors = ['#FF2D8E', '#8A2BE2', '#FFAE00', '#FF5070'];
      const maxIdx   = blobValues.indexOf(maxVal);
      this._semanticBlobs.push({
        color: bgColors[maxIdx], _drawFirst: true,
        radius:     R * (1.40 + maxVal * 0.60),
        orbitR:     R * 0.02,
        orbitAngle: 0,
        orbitSpeed: 0.03,
        breathFreq: 0.10,
        wobble:     0.01 * cfg.breatheStrength,
        opacity:    maxVal * 0.10,
        restX: 0, restY: 0,
      });
    }

    // Sensory — soft pale-pink bloom drawn BEHIND everything else
    // Always added (even at 0 strength) so its label can appear when showSemanticLabels is on.
    this._semanticBlobs.push({
      color: '#FF8FBF', _drawFirst: true,
      _tag: 'sensory', _rawValue: p.sensory, _labelOffsetY: -20,
      radius:     R * (1.20 + sensoryStr * 0.80) * cfg.sensorySizeScale,
      orbitR:     R * 0.04,
      orbitAngle: 0,
      orbitSpeed: 0.05,
      breathFreq: 0.15,
      wobble:     0.02 * cfg.breatheStrength,
      opacity:    sensoryStr * 0.16,
      restX: 0, restY: 0,
    });

    // Taboo — dark wine at edge
    // Always added so its label position is stable regardless of score.
    this._semanticBlobs.push({
      color: '#6B003A', _tag: 'taboo', _rawValue: p.taboo,
      radius:     R * tabooStr * 0.85 * cfg.tabooSizeScale,
      orbitR:     R * 0.12,
      orbitAngle: Math.PI * 0.4,
      orbitSpeed: 0.10,
      breathFreq: 0.25,
      wobble:     0.04 * cfg.breatheStrength,
      opacity:    0.30 + tabooStr * 0.40,
    });

    // Identity — white-gold anchor at center
    this._semanticBlobs.push({
      color: '#FFE599', _tag: 'identity', _rawValue: p.identity, _labelOffsetY: 20,
      radius:     R * identityStr * 0.40 * cfg.identitySizeScale,
      orbitR:     R * 0.03,
      orbitAngle: 0,
      orbitSpeed: 0.06,
      breathFreq: 0.35,
      wobble:     0.03 * cfg.breatheStrength,
      opacity:    0.55 + identityStr * 0.30,
      restX: 0, restY: 0,
    });

    // Unspeakable — near-black at periphery
    this._semanticBlobs.push({
      color: '#0D0010', _tag: 'unspeakable', _rawValue: p.unspeakable,
      radius:     R * unspStr * 0.65 * cfg.unspeakableSizeScale,
      orbitR:     R * 0.10,
      orbitAngle: Math.PI * 1.6,
      orbitSpeed: 0.08,
      breathFreq: 0.20,
      wobble:     0.03 * cfg.breatheStrength,
      opacity:    0.55 + unspStr * 0.30,
    });

    // Relational — warm coral: bridges breathiness (pink) and darkness (purple)
    const relStr = Math.max(0, (p.relational - 0.4) * 1.67);
    this._semanticBlobs.push({
      color: '#FF7055', _tag: 'relational', _rawValue: p.relational,
      radius:     R * (0.12 + relStr * 0.50),
      orbitR:     R * 0.06, orbitAngle: Math.PI * 0.9, orbitSpeed: 0.09,
      breathFreq: 0.28, wobble: 0.03 * cfg.breatheStrength,
      opacity:    0.20 + relStr * 0.45,
    });

    // Tenderness — soft rose: pastel, gentle
    const tendStr = Math.max(0, (p.tenderness - 0.4) * 1.67);
    this._semanticBlobs.push({
      color: '#FFAAD4', _tag: 'tenderness', _rawValue: p.tenderness, _labelOffsetY: -16,
      radius:     R * (0.10 + tendStr * 0.55),
      orbitR:     R * 0.05, orbitAngle: Math.PI * 1.2, orbitSpeed: 0.07,
      breathFreq: 0.20, wobble: 0.02 * cfg.breatheStrength,
      opacity:    0.18 + tendStr * 0.40,
    });

    // Fantasy — electric purple: distinct from darkness (#8A2BE2), brighter
    const fantStr = Math.max(0, (p.fantasy - 0.4) * 1.67);
    this._semanticBlobs.push({
      color: '#CC44FF', _tag: 'fantasy', _rawValue: p.fantasy,
      radius:     R * (0.10 + fantStr * 0.60),
      orbitR:     R * 0.08, orbitAngle: Math.PI * 0.25, orbitSpeed: 0.15,
      breathFreq: 0.45, wobble: 0.05 * cfg.breatheStrength,
      opacity:    0.22 + fantStr * 0.48,
    });

    // Longing — deep blue: yearning, distance
    const longStr = Math.max(0, (p.longing - 0.4) * 1.67);
    this._semanticBlobs.push({
      color: '#4466EE', _tag: 'longing', _rawValue: p.longing, _labelOffsetY: 16,
      radius:     R * (0.10 + longStr * 0.55),
      orbitR:     R * 0.07, orbitAngle: Math.PI * 1.5, orbitSpeed: 0.11,
      breathFreq: 0.22, wobble: 0.03 * cfg.breatheStrength,
      opacity:    0.22 + longStr * 0.45,
    });

    // Fixed resting positions — wider spread driven by positionSpread config
    const restRng = this._rng(str + '_rest');
    for (const blob of this._blobs) {
      const a = restRng() * Math.PI * 2;
      const d = R * (0.15 + restRng() * cfg.positionSpread * 0.70);
      blob.restX = Math.cos(a) * d;
      blob.restY = Math.sin(a) * d * (1 + p.longing * 0.55);
    }

    // relational: pull darkness blob toward breathiness blob
    if (p.relational > 0.5) {
      const t = (p.relational - 0.5) * 2;
      this._blobs[1].restX += (this._blobs[0].restX - this._blobs[1].restX) * t * 0.45;
      this._blobs[1].restY += (this._blobs[0].restY - this._blobs[1].restY) * t * 0.45;
    }

    // Semantic blob resting positions (skip those with pre-set restX/Y)
    const sRestRng = this._rng(str + '_srest');
    for (const blob of this._semanticBlobs) {
      if (blob.restX != null) continue;
      const a = sRestRng() * Math.PI * 2;
      const d = R * (0.38 + sRestRng() * 0.42);
      blob.restX = Math.cos(a) * d;
      blob.restY = Math.sin(a) * d;
    }

    // Staggered shrink timings
    const shrinkRng = this._rng(str + '_shrink');
    for (const b of this._blobs) {
      b.shrinkDelay = shrinkRng() * 280;
      b.shrinkDur   = 480 + shrinkRng() * 380;
    }
    for (const b of this._semanticBlobs) {
      b.shrinkDelay = shrinkRng() * 320;
      b.shrinkDur   = 420 + shrinkRng() * 300;
    }

    // Satellite orbs — count from breathiness, capped by config
    const nSat   = Math.min(cfg.satelliteMax, Math.round(2 + p.breathiness * 3));
    const satRng = this._rng(str + '_sat');
    const satShrinkRng = this._rng(str + '_satshrink');
    this._satellites = Array.from({ length: nSat }, (_, i) => {
      const angle = satRng() * Math.PI * 2;
      const dist  = R * (0.55 + satRng() * 0.55);
      return {
        color:       ['#FF2D8E', '#8A2BE2', '#FFAE00', '#FF5070'][i % 4],
        radius:      R * (0.09 + satRng() * 0.11),
        x:           Math.cos(angle) * dist,
        y:           Math.sin(angle) * dist,
        restX:       Math.cos(angle) * dist * 0.58,
        restY:       Math.sin(angle) * dist * 0.58 * (1 + p.longing * 0.55),
        orbitSpeed:  0.08 + satRng() * 0.12,
        orbitAngle:  angle,
        opacity:     0.22 + p.breathiness * 0.25,
        shrinkDelay: satShrinkRng() * 200,
        shrinkDur:   360 + satShrinkRng() * 280,
      };
    });

    // Solid (non-gradient) dots — pitchSteadiness (light grey) and slowness (dark grey).
    // These represent the two acoustic components not assigned a colored gradient blob.
    const sdRng = this._rng(str + '_solid');
    const sdShrinkRng = this._rng(str + '_solidShrink');
    const sdA0 = sdRng() * Math.PI * 2, sdD0 = R * (0.18 + sdRng() * cfg.positionSpread * 0.65);
    const sdOA0 = sdRng() * Math.PI * 2, sdOS0 = 0.05 + sdRng() * 0.05;
    const sdA1 = sdRng() * Math.PI * 2, sdD1 = R * (0.18 + sdRng() * cfg.positionSpread * 0.65);
    const sdOA1 = sdRng() * Math.PI * 2, sdOS1 = 0.04 + sdRng() * 0.04;
    this._solidDots = [
      {
        _tag: 'pitch steadiness', _rawValue: p.pitchSteadiness, _labelOffsetY: -14,
        color:      '#c8c8c8',                               // light grey — pitchSteadiness
        radius:     R * (0.055 + p.pitchSteadiness * 0.105) * cfg.pitchSteadinessSizeScale,
        orbitR:     R * 0.055, orbitAngle: sdOA0, orbitSpeed: sdOS0,
        breathFreq: 0.42 + p.slowness * 0.22,
        wobble:     0.028 * cfg.breatheStrength,
        opacity:    0.72 + p.pitchSteadiness * 0.22,
        restX:      Math.cos(sdA0) * sdD0, restY: Math.sin(sdA0) * sdD0,
        shrinkDelay: sdShrinkRng() * 280, shrinkDur: 400 + sdShrinkRng() * 320,
      },
      {
        _tag: 'slowness', _rawValue: p.slowness, _labelOffsetY: 14,
        color:      '#4a4a60',                               // dark grey — slowness
        radius:     R * (0.070 + p.slowness * 0.12) * cfg.slownessSizeScale,
        orbitR:     R * 0.040, orbitAngle: sdOA1, orbitSpeed: sdOS1,
        breathFreq: 0.28 + p.slowness * 0.18,
        wobble:     0.022 * cfg.breatheStrength,
        opacity:    0.88,
        restX:      Math.cos(sdA1) * sdD1, restY: Math.sin(sdA1) * sdD1,
        shrinkDelay: sdShrinkRng() * 280, shrinkDur: 400 + sdShrinkRng() * 320,
      },
    ];
  }

  _buildParticles() {
    const p   = this._p;
    const cfg = this._cfg;
    const R   = Math.min(this._canvas.width, this._canvas.height) * 0.36;

    // Tiny sparkle particles — base count + duration bonus, scaled by fantasy
    const base = Math.round(cfg.particleBase + Math.min(p.duration / 10, 1) * 15);
    const n   = Math.round(base * (1 + p.fantasy * cfg.particleFantasyScale));
    const rng = this._rng(String(p.seed) + '_p');
    const COLORS = this._cfg.blendMode === 'multiply'
      ? ['#FF2D8E', '#8A2BE2', '#FFAE00', '#FF5070', '#CC44AA']
      : ['#FF2D8E', '#8A2BE2', '#FFAE00', '#FF5070', '#ffffff'];
    const shrinkRng2 = this._rng(String(p.seed) + '_shrink2');
    this._particles = Array.from({ length: n }, () => {
      const angle = rng() * Math.PI * 2;
      const dist  = R * (0.28 + rng() * 0.72);
      return {
        x:          Math.cos(angle) * dist,
        y:          Math.sin(angle) * dist,
        r:          1.5 + rng() * 2.5,
        color:      COLORS[Math.floor(rng() * COLORS.length)],
        delay:      rng() * 2.0,
        twinkle:    0.5 + rng() * 0.5,
        shrinkDelay: shrinkRng2() * 350,
        shrinkDur:   280 + shrinkRng2() * 220,
      };
    });

    // Large accent dots — drawn as mini-blobs at fixed scatter positions
    const ACCENT_COLORS = ['#FF2D8E', '#8A2BE2', '#FFAE00', '#FF5070', '#FF8FBF'];
    const acRng      = this._rng(String(p.seed) + '_accent');
    const acShrinkRng = this._rng(String(p.seed) + '_acShrink');
    this._accentDots = Array.from({ length: cfg.accentDotCount }, () => {
      const angle = acRng() * Math.PI * 2;
      const dist  = R * (0.18 + acRng() * 0.68);
      return {
        color:      ACCENT_COLORS[Math.floor(acRng() * ACCENT_COLORS.length)],
        radius:     8 + acRng() * cfg.accentDotMaxSize,
        orbitR:     0,
        orbitAngle: 0,
        orbitSpeed: 0,
        breathFreq: 0.3 + acRng() * 0.4,
        wobble:     (0.04 + acRng() * 0.06) * cfg.breatheStrength,
        opacity:    0.50 + acRng() * 0.35,
        restX:      Math.cos(angle) * dist,
        restY:      Math.sin(angle) * dist,
        shrinkDelay: acShrinkRng() * 350,
        shrinkDur:   280 + acShrinkRng() * 220,
      };
    });
  }

  start() {
    this._startTime = null;
    this._shrinking = false;
    this._raf = requestAnimationFrame(this._loop);
  }

  shrink(onDone) {
    this._shrinking   = true;
    this._shrinkStart = performance.now();
    this._onDone      = onDone;
  }

  stop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
  }

  /* Per-element shrink factor: 1 → 0 at its own pace */
  _sf(el, shrinkMs) {
    if (shrinkMs === null) return 1;
    const t = Math.max(0, (shrinkMs - el.shrinkDelay) / el.shrinkDur);
    return Math.max(0, 1 - t);
  }

  _loop(ts) {
    if (!this._startTime) this._startTime = ts;
    const elapsed = (ts - this._startTime) / 1000;
    const canvas  = this._canvas;
    const ctx     = this._ctx;
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const cfg = this._cfg;

    const formingSec  = cfg.formingMs  / 1000;
    const settlingMs  = cfg.settlingMs / 1000;

    // FORMING phase
    const forming  = Math.min(1, elapsed / formingSec);
    const formEase = 1 - Math.pow(1 - forming, 3);

    // SETTLING phase
    const rawSettle  = elapsed > formingSec ? Math.min(1, (elapsed - formingSec) / settlingMs) : 0;
    const settleEase = rawSettle < 0.5
      ? 2 * rawSettle * rawSettle
      : 1 - Math.pow(-2 * rawSettle + 2, 2) / 2;

    // BREATHE — only after fully settled
    const breatheAmt = Math.max(0, Math.min(1, (elapsed - formingSec - settlingMs) / 1.0));

    // SHRINK — per-element staggered; finish after 1450ms total
    let shrinkMs = null;
    if (this._shrinking && this._shrinkStart !== null) {
      shrinkMs = ts - this._shrinkStart;
      if (shrinkMs >= 1450) { this.stop(); if (this._onDone) this._onDone(); return; }
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(cx, cy);

    // Draw order: background blobs → main blobs → satellites → foreground semantics → accent dots → solid dots → particles → speculars
    for (const b of this._semanticBlobs) {
      if (b._drawFirst) this._drawBlob(ctx, b, elapsed, formEase, settleEase, breatheAmt, shrinkMs);
    }
    for (const b of this._blobs)      this._drawBlob(ctx, b, elapsed, formEase, settleEase, breatheAmt, shrinkMs);
    for (const s of this._satellites) this._drawSatellite(ctx, s, elapsed, formEase, settleEase, shrinkMs);
    for (const b of this._semanticBlobs) {
      if (!b._drawFirst) this._drawBlob(ctx, b, elapsed, formEase, settleEase, breatheAmt, shrinkMs);
    }
    for (const d of this._accentDots) this._drawBlob(ctx, d, elapsed, formEase, settleEase, breatheAmt, shrinkMs);
    for (const d of this._solidDots)  this._drawSolidDot(ctx, d, elapsed, formEase, settleEase, breatheAmt, shrinkMs);
    for (const part of this._particles) {
      if (elapsed < part.delay) continue;
      const pAlpha = Math.min(1, (elapsed - part.delay) / 1.0) * formEase;
      this._drawParticle(ctx, part, elapsed, pAlpha, shrinkMs);
    }
    if (this._cfg.blendMode !== 'multiply') {
      for (const b of this._blobs) this._drawSpecular(ctx, b, elapsed, formEase, settleEase, shrinkMs);
    }
    if (this._cfg.showSemanticLabels) {
      for (const b of this._blobs)         this._drawSemanticLabel(ctx, b, elapsed, settleEase, shrinkMs);
      for (const b of this._semanticBlobs) this._drawSemanticLabel(ctx, b, elapsed, settleEase, shrinkMs);
      for (const d of this._solidDots)     this._drawSemanticLabel(ctx, d, elapsed, settleEase, shrinkMs);
    }

    ctx.restore();
    this._raf = requestAnimationFrame(this._loop);
  }

  _drawSemanticLabel(ctx, blob, t, settleEase, shrinkMs) {
    if (!blob._tag || settleEase <= 0) return;
    if (blob._rawValue != null && blob._rawValue < this._cfg.semanticLabelThreshold) return;
    const sf = this._sf(blob, shrinkMs);
    if (sf <= 0) return;
    const orbitX = Math.cos(t * (blob.orbitSpeed || 0.1) + (blob.orbitAngle || 0)) * (blob.orbitR || 0);
    const orbitY = Math.sin(t * (blob.orbitSpeed || 0.1) * 0.71 + (blob.orbitAngle || 0)) * (blob.orbitR || 0) * 0.75;
    const ox = (orbitX * (1 - settleEase) + (blob.restX ?? 0) * settleEase) * sf;
    const oy = (orbitY * (1 - settleEase) + (blob.restY ?? 0) * settleEase) * sf + (blob._labelOffsetY ?? 0);
    const R = Math.min(this._canvas.width, this._canvas.height) * 0.5;
    const fontSize = Math.max(8, Math.round(R * 0.05 * this._cfg.semanticLabelFontScale));
    const label = blob._rawValue != null
      ? `${blob._tag} ${blob._rawValue.toFixed(2)}`
      : blob._tag;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = settleEase * sf * 0.90;
    ctx.font = `500 ${fontSize}px 'IBM Plex Mono','SF Mono',ui-monospace,monospace`;
    ctx.letterSpacing = '0.05em';
    ctx.fillStyle = this._cfg.semanticLabelColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, ox, oy);
    ctx.restore();
  }

  _drawBlob(ctx, blob, t, formEase, settleEase, breatheAmt, shrinkMs) {
    const sf = this._sf(blob, shrinkMs);
    if (sf <= 0) return;

    const orbitX = Math.cos(t * (blob.orbitSpeed || 0.1) + (blob.orbitAngle || 0)) * (blob.orbitR || 0);
    const orbitY = Math.sin(t * (blob.orbitSpeed || 0.1) * 0.71 + (blob.orbitAngle || 0)) * (blob.orbitR || 0) * 0.75 + (blob.offsetY || 0);
    const rx = blob.restX ?? 0;
    const ry = blob.restY ?? 0;
    const ox = (orbitX * (1 - settleEase) + rx * settleEase) * sf;
    const oy = (orbitY * (1 - settleEase) + ry * settleEase) * sf;

    const breathe = 1 + Math.sin(t * (blob.breathFreq || 0.4) * 2.1) * (blob.wobble || 0.05) * breatheAmt;
    const r = blob.radius * formEase * breathe * sf;
    if (r <= 0) return;

    const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, r);
    g.addColorStop(0,                        this._rgba(blob.color, blob.opacity * 0.90 * sf));
    g.addColorStop(blob.falloffMid ?? 0.45,  this._rgba(blob.color, blob.opacity * 0.52 * sf));
    g.addColorStop(1,                        this._rgba(blob.color, 0));
    ctx.globalCompositeOperation = this._cfg.blendMode;
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(ox, oy, r, 0, Math.PI * 2); ctx.fill();
  }

  _drawSatellite(ctx, sat, t, formEase, settleEase, shrinkMs) {
    const sf = this._sf(sat, shrinkMs);
    if (sf <= 0) return;

    const ox_orb = sat.x * formEase + Math.cos(sat.orbitAngle + t * sat.orbitSpeed) * sat.radius * 0.4;
    const oy_orb = sat.y * formEase + Math.sin(sat.orbitAngle + t * sat.orbitSpeed) * sat.radius * 0.4;
    const ox = (ox_orb * (1 - settleEase) + sat.restX * settleEase) * sf;
    const oy = (oy_orb * (1 - settleEase) + sat.restY * settleEase) * sf;
    const r  = sat.radius * formEase * sf;
    if (r <= 0) return;
    const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, r);
    g.addColorStop(0, this._rgba(sat.color, sat.opacity * sf));
    g.addColorStop(1, this._rgba(sat.color, 0));
    ctx.globalCompositeOperation = this._cfg.blendMode;
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(ox, oy, r, 0, Math.PI * 2); ctx.fill();
  }

  _drawParticle(ctx, part, t, alpha, shrinkMs) {
    const sf = this._sf(part, shrinkMs);
    if (sf <= 0) return;
    const twinkle = 0.5 + 0.5 * Math.sin(t * part.twinkle * 3.1 + part.x);
    const px = part.x * sf, py = part.y * sf;
    const g = ctx.createRadialGradient(px, py, 0, px, py, part.r * 2.5);
    g.addColorStop(0,   this._rgba(part.color, alpha * 0.90 * sf));
    g.addColorStop(0.5, this._rgba(part.color, alpha * 0.50 * twinkle * sf));
    g.addColorStop(1,   this._rgba(part.color, 0));
    ctx.globalCompositeOperation = this._cfg.blendMode;
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(px, py, part.r * 2.5, 0, Math.PI * 2); ctx.fill();
  }

  _drawSolidDot(ctx, dot, t, formEase, settleEase, breatheAmt, shrinkMs) {
    const sf = this._sf(dot, shrinkMs);
    if (sf <= 0) return;
    const orbitX = Math.cos(t * dot.orbitSpeed + dot.orbitAngle) * dot.orbitR;
    const orbitY = Math.sin(t * dot.orbitSpeed * 0.71 + dot.orbitAngle) * dot.orbitR * 0.75;
    const ox = (orbitX * (1 - settleEase) + dot.restX * settleEase) * sf;
    const oy = (orbitY * (1 - settleEase) + dot.restY * settleEase) * sf;
    const breathe = 1 + Math.sin(t * dot.breathFreq * 2.1) * dot.wobble * breatheAmt;
    const r = dot.radius * formEase * breathe * sf;
    if (r <= 0) return;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = this._rgba(dot.color, dot.opacity * sf);
    ctx.beginPath();
    ctx.arc(ox, oy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawSpecular(ctx, blob, t, formEase, settleEase, shrinkMs) {
    const sf = this._sf(blob, shrinkMs);
    if (sf <= 0) return;
    const orbitX = Math.cos(t * (blob.orbitSpeed || 0.1) + (blob.orbitAngle || 0)) * (blob.orbitR || 0);
    const orbitY = Math.sin(t * (blob.orbitSpeed || 0.1) * 0.71 + (blob.orbitAngle || 0)) * (blob.orbitR || 0) * 0.75;
    const ox = (orbitX * (1 - settleEase) + (blob.restX ?? 0) * settleEase) * sf;
    const oy = (orbitY * (1 - settleEase) + (blob.restY ?? 0) * settleEase) * sf;
    const bR = blob.radius * formEase * sf;
    const sx = ox - bR * 0.20, sy = oy - bR * 0.22;
    const r  = bR * 0.12;
    if (r <= 0) return;
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
    g.addColorStop(0, `rgba(255,255,255,${(0.72 * sf).toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalCompositeOperation = this._cfg.blendMode;
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
  }

  _saturate(hex, amount) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    const lum = r * 0.299 + g * 0.587 + b * 0.114;
    const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
    const amp = amount >= 0 ? 1 - amount : 1 + (-amount) * 0.9;
    return '#' + [r, g, b].map(c => clamp(lum + (c - lum) * amp).toString(16).padStart(2, '0')).join('');
  }

  _rgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
  }
}

/* ── Build params from a stored whisper record ───────────────────── */
function buildFingerprintParams(record) {
  const c = record.sensuality?.components ?? {};
  const f = record.features ?? {};
  const s = record.llm?.semantics ?? {};
  return {
    breathiness:     c.breathiness     ?? 0.5,
    darkness:        c.darkness        ?? 0.5,
    softness:        c.softness        ?? 0.5,
    slowness:        c.slowness        ?? 0.5,
    pitchLowness:    c.pitchLowness    ?? 0.5,
    pitchSteadiness: c.pitchSteadiness ?? 0.5,
    amplitude:       Math.min(1, (f.amplitude ?? 0.3) * 3),
    duration:        Math.min(30, f.duration  ?? 5),
    sensory:         s.sensory      ?? 0.5,
    relational:      s.relational   ?? 0.5,
    taboo:           s.taboo        ?? 0.5,
    tenderness:      s.tenderness   ?? 0.5,
    fantasy:         s.fantasy      ?? 0.5,
    identity:        s.identity     ?? 0.5,
    longing:         s.longing      ?? 0.5,
    unspeakable:     s.unspeakable  ?? 0.5,
    seed:            record.id || 'default',
  };
}

/* ── Build renderer config from server /config response ─────────── */
function buildFingerprintConfig(serverConfig) {
  const c = serverConfig || {};
  const d = FP_CFG_DEFAULTS;
  return {
    positionSpread:           c.fp_positionSpread           ?? d.positionSpread,
    orbitSpread:              c.fp_orbitSpread              ?? d.orbitSpread,
    breathinessSizeScale:     c.fp_breathinessSizeScale     ?? d.breathinessSizeScale,
    darknessSizeScale:        c.fp_darknessSizeScale        ?? d.darknessSizeScale,
    softnessSizeScale:        c.fp_softnessSizeScale        ?? d.softnessSizeScale,
    pitchLownessSizeScale:    c.fp_pitchLownessSizeScale    ?? d.pitchLownessSizeScale,
    slownessSizeScale:        c.fp_slownessSizeScale        ?? d.slownessSizeScale,
    pitchSteadinessSizeScale: c.fp_pitchSteadinessSizeScale ?? d.pitchSteadinessSizeScale,
    sensorySizeScale:         c.fp_sensorySizeScale         ?? d.sensorySizeScale,
    tabooSizeScale:           c.fp_tabooSizeScale           ?? d.tabooSizeScale,
    identitySizeScale:        c.fp_identitySizeScale        ?? d.identitySizeScale,
    unspeakableSizeScale:     c.fp_unspeakableSizeScale     ?? d.unspeakableSizeScale,
    accentDotCount:           c.fp_accentDotCount           ?? d.accentDotCount,
    accentDotMaxSize:         c.fp_accentDotMaxSize         ?? d.accentDotMaxSize,
    particleBase:             c.fp_particleBase             ?? d.particleBase,
    particleFantasyScale:     c.fp_particleFantasyScale     ?? d.particleFantasyScale,
    satelliteMax:             c.fp_satelliteMax             ?? d.satelliteMax,
    formingMs:                c.fp_formingMs                ?? d.formingMs,
    settlingMs:               c.fp_settlingMs               ?? d.settlingMs,
    breatheStrength:          c.fp_breatheStrength          ?? d.breatheStrength,
    maskInner:                c.fp_maskInner                ?? d.maskInner,
    maskOuter:                c.fp_maskOuter                ?? d.maskOuter,
    maskShape:                c.fp_maskShape                ?? d.maskShape,
    blendMode:                c.blendMode                   ?? d.blendMode,
    showSemanticLabels:       c.fp_showSemanticLabels       ?? d.showSemanticLabels,
    semanticLabelColor:       c.fp_semanticLabelColor       ?? d.semanticLabelColor,
    semanticLabelThreshold:   c.fp_semanticLabelThreshold   ?? d.semanticLabelThreshold,
    semanticLabelFontScale:   c.fp_semanticLabelFontScale   ?? d.semanticLabelFontScale,
  };
}
