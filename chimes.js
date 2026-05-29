// Stained-glass chimes interactive demo.
//
// Two concerns live here:
//   1. Audio synthesis — a small tubular-bell voice built on the Web Audio API.
//      Each chime plays a fundamental plus the inharmonic upper partials a
//      real tubular bell produces, which is what makes a chime sound metallic
//      rather than flute-like. Swap this out for real recorded samples of
//      Mom's chimes once those exist; the API surface is `ring(index, velocity)`.
//   2. Pointer interaction — a single Pointer Events handler covers mouse,
//      pen, and touch. Hover gives a soft strike, click/tap a medium strike,
//      and a drag through multiple chimes rings each one in succession with
//      a velocity proportional to drag speed.

// ---------- Chime config ----------

// Pentatonic scale, rooted at C5. Pentatonic = no two adjacent notes will
// ever clash, so any drag pattern sounds musical rather than random.
const CHIMES = [
  { freq: 523.25, label: 'C5', palette: ['#7a1a1a', '#c41e3a', '#f25e6e'] }, // crimson
  { freq: 587.33, label: 'D5', palette: ['#7a3a00', '#d97400', '#f8b25e'] }, // honey amber
  { freq: 659.25, label: 'E5', palette: ['#6b5500', '#d6b832', '#f1dc7a'] }, // citrine
  { freq: 783.99, label: 'G5', palette: ['#1f4a25', '#3d8a45', '#80c878'] }, // emerald
  { freq: 880.00, label: 'A5', palette: ['#13315c', '#2d5da7', '#7dabe6'] }, // cobalt
  { freq: 1046.5, label: 'C6', palette: ['#3d1e5a', '#7b3f99', '#b78fd6'] }, // amethyst
  { freq: 1174.7, label: 'D6', palette: ['#5c1738', '#b03a6b', '#e89bbf'] }, // rose
];

// Inharmonic partial ratios of a tubular bell, taken from acoustics
// literature: a real chime is not a simple harmonic stack. Including a few
// of these is what separates "chime" from "sine wave."
const PARTIALS = [
  { mult: 1.00, amp: 1.00, decay: 3.5 },
  { mult: 2.76, amp: 0.55, decay: 2.5 },
  { mult: 5.40, amp: 0.25, decay: 1.6 },
  { mult: 8.93, amp: 0.10, decay: 0.9 },
];

// ---------- Audio engine ----------

let audioCtx = null;
let masterGain = null;
let reverbDelay = null;
let muted = false;

/** Lazily create the AudioContext on first user gesture. Browsers (esp. iOS
 *  Safari) only allow audio after a user-initiated event. */
function ensureAudio() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  audioCtx = new Ctx();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.6;

  // Cheap, no-IR reverb: a delay line with feedback into a low-pass. Gives
  // a sense of space without bundling an impulse response file.
  reverbDelay = audioCtx.createDelay(1.0);
  reverbDelay.delayTime.value = 0.08;
  const reverbFeedback = audioCtx.createGain();
  reverbFeedback.gain.value = 0.4;
  const reverbDamp = audioCtx.createBiquadFilter();
  reverbDamp.type = 'lowpass';
  reverbDamp.frequency.value = 3500;
  reverbDelay.connect(reverbDamp);
  reverbDamp.connect(reverbFeedback);
  reverbFeedback.connect(reverbDelay);

  const wetGain = audioCtx.createGain();
  wetGain.gain.value = 0.25;
  reverbDamp.connect(wetGain);
  wetGain.connect(audioCtx.destination);

  masterGain.connect(audioCtx.destination);
  masterGain.connect(reverbDelay);

  return audioCtx;
}

/** Play a chime at the given frequency. `velocity` 0..1 scales loudness and
 *  decay length so a soft hover sounds different from a hard strike. */
function ringFreq(freq, velocity = 1) {
  if (muted) return;
  const ctx = ensureAudio();
  if (ctx.state === 'suspended') ctx.resume();
  const now = ctx.currentTime;
  velocity = Math.max(0.05, Math.min(1, velocity));

  for (const p of PARTIALS) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq * p.mult;

    const env = ctx.createGain();
    const peak = 0.22 * p.amp * velocity;
    const decay = p.decay * (0.5 + 0.5 * velocity);

    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(peak, now + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0008, now + decay);

    osc.connect(env);
    env.connect(masterGain);

    osc.start(now);
    osc.stop(now + decay + 0.05);
  }
}

function ring(index, velocity = 1) {
  const c = CHIMES[index];
  if (!c) return;
  ringFreq(c.freq, velocity);
  triggerSwing(index, velocity);
}

// ---------- SVG construction ----------

/** Build a single stained-glass chime panel as inline SVG. Three coloured
 *  segments stacked vertically with black leading between them, plus a
 *  white-ish highlight on the left side that sells the "lit from behind"
 *  look. Returns the chime's outer DOM node. */
function buildChimeNode(chime, index) {
  const wrapper = document.createElement('div');
  wrapper.className = 'chime';
  wrapper.dataset.index = String(index);

  const cord = document.createElement('span');
  cord.className = 'cord';
  wrapper.appendChild(cord);

  const W = 70, H = 250;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Top loop (lead came shape that joins to the cord above)
  const loop = document.createElementNS(svgNS, 'path');
  loop.setAttribute('d',
    `M${W/2 - 6},6 a6,6 0 1,1 12,0 a6,6 0 1,1 -12,0 Z`);
  loop.setAttribute('fill', 'none');
  loop.setAttribute('stroke', '#1a0f08');
  loop.setAttribute('stroke-width', '2');
  svg.appendChild(loop);

  // Three stacked panels with a slight pointed bottom for visual interest
  const panelTop = 18;
  const panelBot = H - 10;
  const panelHeight = (panelBot - panelTop) / 3;
  for (let i = 0; i < 3; i++) {
    const y0 = panelTop + i * panelHeight;
    const y1 = y0 + panelHeight;
    const isBottom = i === 2;

    // Gradient per panel, defined inline so each chime is self-contained
    const gradId = `g${index}_${i}`;
    const defs = document.createElementNS(svgNS, 'defs');
    const grad = document.createElementNS(svgNS, 'linearGradient');
    grad.setAttribute('id', gradId);
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '1'); grad.setAttribute('y2', '1');
    const stops = [
      { off: '0%',  col: chime.palette[2] },
      { off: '50%', col: chime.palette[1] },
      { off: '100%', col: chime.palette[0] },
    ];
    for (const s of stops) {
      const st = document.createElementNS(svgNS, 'stop');
      st.setAttribute('offset', s.off);
      st.setAttribute('stop-color', s.col);
      grad.appendChild(st);
    }
    defs.appendChild(grad);
    svg.appendChild(defs);

    const path = document.createElementNS(svgNS, 'path');
    const d = isBottom
      ? `M2,${y0} L${W-2},${y0} L${W-2},${y1 - 18} L${W/2},${y1} L2,${y1 - 18} Z`
      : `M2,${y0} L${W-2},${y0} L${W-2},${y1} L2,${y1} Z`;
    path.setAttribute('d', d);
    path.setAttribute('fill', `url(#${gradId})`);
    path.setAttribute('stroke', '#1a0f08');
    path.setAttribute('stroke-width', '2.4');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);

    // Inner highlight band on the left to fake refracted light
    const hi = document.createElementNS(svgNS, 'path');
    hi.setAttribute('class', 'panel-highlight');
    hi.setAttribute('d',
      `M6,${y0 + 4} Q${W/2 - 10},${y0 + 8} 14,${y1 - 6}`);
    hi.setAttribute('fill', 'none');
    hi.setAttribute('stroke', 'rgba(255,255,255,0.55)');
    hi.setAttribute('stroke-width', '5');
    hi.setAttribute('stroke-linecap', 'round');
    svg.appendChild(hi);
  }

  wrapper.appendChild(svg);
  return wrapper;
}

// ---------- Animation ----------

/** Swing the chime via a small JS-driven animation. We don't use a CSS
 *  keyframe so we can re-trigger mid-swing without the "restart the
 *  animation" reflow trick — and so peak angle scales smoothly with
 *  velocity. */
const swingState = new Map(); // index → { rafId, peakDeg, startedAt, durMs }

function triggerSwing(index, velocity = 1) {
  const el = document.querySelector(`.chime[data-index="${index}"]`);
  if (!el) return;
  cancelSwing(index);

  const peakDeg = (8 + 22 * velocity) * (Math.random() < 0.5 ? -1 : 1);
  const durMs = 1400 + 1400 * velocity;
  const startedAt = performance.now();

  el.classList.add('struck');

  const step = (now) => {
    const t = (now - startedAt) / durMs;
    if (t >= 1) {
      el.style.transform = '';
      el.classList.remove('struck');
      swingState.delete(index);
      return;
    }
    // Damped sine: A * exp(-kt) * sin(2π f t). Pleasant decay shape.
    const f = 1.8;       // Hz
    const k = 3.2;       // damping
    const angle = peakDeg * Math.exp(-k * t) * Math.cos(2 * Math.PI * f * t);
    el.style.transform = `rotate(${angle.toFixed(2)}deg)`;
    swingState.set(index, { ...swingState.get(index), rafId: requestAnimationFrame(step) });
  };
  swingState.set(index, { peakDeg, startedAt, durMs, rafId: requestAnimationFrame(step) });
}

function cancelSwing(index) {
  const s = swingState.get(index);
  if (s?.rafId) cancelAnimationFrame(s.rafId);
  swingState.delete(index);
}

// ---------- Interaction ----------

const chimeArea = document.getElementById('chime-area');
const chimesRow = document.getElementById('chimes');

CHIMES.forEach((c, i) => chimesRow.appendChild(buildChimeNode(c, i)));

// Pointer tracking: we record the last chime under the cursor and the time,
// so when the pointer crosses into a new chime we can compute the speed and
// turn it into a velocity for the strike.
let pointerDown = false;
let pointerLast = null; // { x, y, t, index }
const DRAG_RETRIGGER_MS = 220; // can re-ring the same chime if you linger
const HOVER_RETRIGGER_MS = 600;

function chimeIndexFromEvent(e) {
  const target = (e.target instanceof Element) ? e.target.closest('.chime') : null;
  return target ? Number(target.dataset.index) : -1;
}

function speedToVelocity(speedPxPerSec) {
  // Map ~200 px/s → 0.35, ~1500 px/s → 1.0.
  const v = (speedPxPerSec - 100) / 1400;
  return Math.max(0.1, Math.min(1, v));
}

function handlePointerEnter(e, isDrag) {
  const idx = chimeIndexFromEvent(e);
  if (idx < 0) return;
  const now = performance.now();
  let velocity;
  if (pointerLast && pointerLast.index === idx) {
    const sinceMs = now - pointerLast.t;
    const minMs = isDrag ? DRAG_RETRIGGER_MS : HOVER_RETRIGGER_MS;
    if (sinceMs < minMs) {
      pointerLast = { x: e.clientX, y: e.clientY, t: now, index: idx };
      return;
    }
  }
  if (pointerLast) {
    const dx = e.clientX - pointerLast.x;
    const dy = e.clientY - pointerLast.y;
    const dt = Math.max(8, now - pointerLast.t);
    const speed = Math.hypot(dx, dy) / (dt / 1000);
    velocity = speedToVelocity(speed);
  } else {
    velocity = isDrag ? 0.6 : 0.3;
  }
  if (isDrag) velocity = Math.min(1, velocity + 0.2);
  ring(idx, velocity);
  pointerLast = { x: e.clientX, y: e.clientY, t: now, index: idx };
}

chimeArea.addEventListener('pointermove', (e) => {
  // Only react when the pointer is over a chime; pointerLast.index changes
  // when we cross into a new one.
  const idx = chimeIndexFromEvent(e);
  if (idx === -1) {
    pointerLast = pointerLast ? { ...pointerLast, x: e.clientX, y: e.clientY, t: performance.now(), index: -1 } : null;
    return;
  }
  // Crossing into a new chime, OR same chime but enough time has passed to
  // retrigger — handlePointerEnter sorts that out.
  if (!pointerLast || pointerLast.index !== idx || pointerDown) {
    handlePointerEnter(e, pointerDown);
  }
});

chimeArea.addEventListener('pointerdown', (e) => {
  pointerDown = true;
  e.target.setPointerCapture?.(e.pointerId);
  const idx = chimeIndexFromEvent(e);
  if (idx >= 0) {
    ring(idx, 0.85);
    const el = e.target.closest('.chime');
    el?.classList.add('user-driven');
    pointerLast = { x: e.clientX, y: e.clientY, t: performance.now(), index: idx };
  }
});

chimeArea.addEventListener('pointerup', (e) => {
  pointerDown = false;
  document.querySelectorAll('.chime.user-driven').forEach(el => el.classList.remove('user-driven'));
});

chimeArea.addEventListener('pointerleave', () => {
  pointerDown = false;
  pointerLast = null;
});

// Keyboard play for accessibility — number keys 1..7 ring the chimes.
window.addEventListener('keydown', (e) => {
  if (e.key >= '1' && e.key <= String(CHIMES.length)) {
    const i = Number(e.key) - 1;
    ring(i, 0.7);
  }
});

// Mute toggle
const muteBtn = document.getElementById('muteBtn');
const iconSound = muteBtn.querySelector('.icon-sound');
const iconMute  = muteBtn.querySelector('.icon-mute');
muteBtn.addEventListener('click', () => {
  muted = !muted;
  iconSound.hidden = muted;
  iconMute.hidden = !muted;
  muteBtn.setAttribute('aria-label', muted ? 'Unmute audio' : 'Mute audio');
});

// Gentle ambient breeze — occasionally nudges a random chime so the page
// doesn't feel inert if no one's interacting. Quiet so it doesn't get
// annoying.
setInterval(() => {
  if (document.hidden || muted) return;
  if (Math.random() < 0.35) {
    const idx = Math.floor(Math.random() * CHIMES.length);
    ring(idx, 0.18);
  }
}, 6500);
