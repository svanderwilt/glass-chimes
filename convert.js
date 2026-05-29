// Photo → stained-glass pattern converter.
//
// Pipeline (top-down):
//   1. Load and resize image to a working resolution (~500px on the long edge).
//   2. Smooth: edge-preserving downsample blur to wipe noise/JPEG artefacts
//      without losing big colour boundaries.
//   3. Quantize: convert RGB → CIELAB, k-means cluster pixels into N glass
//      colours. LAB is perceptually uniform so the cluster boundaries land
//      where the human eye sees them.
//   4. Connected components: contiguous pixels of the same cluster become
//      one region. Two-pass labeling with union-find.
//   5. Merge to budget: while we have more regions than the user's panel
//      budget, repeatedly merge the smallest region into its largest
//      neighbour. Stops when count ≤ budget. Each region keeps the average
//      original colour of its pixels.
//   6. Trace boundaries: Moore-neighbour contour following gives one closed
//      polygon per region.
//   7. Simplify: Ramer-Douglas-Peucker drops vertices below tolerance, so
//      a 400-point wavy edge collapses to ~10 straight segments — which is
//      what real cut glass looks like.
//   8. Render SVG: filled polygons with a black "leading" stroke between
//      them. Output is scaleable to any physical size for the cutting
//      template.
//
// Everything runs client-side. No upload, no API.

// ---------- DOM ----------

const dropzone        = document.getElementById('dropzone');
const fileInput       = document.getElementById('fileInput');
const controls        = document.getElementById('controls');
const results         = document.getElementById('results');
const progressBox     = document.getElementById('progress');
const progressFill    = document.getElementById('progressFill');
const progressText    = document.getElementById('progressText');
const originalCanvas  = document.getElementById('originalCanvas');
const patternHolder   = document.getElementById('patternHolder');
const patternMeta     = document.getElementById('patternMeta');
const regenBtn        = document.getElementById('regenBtn');
const flattenBtn      = document.getElementById('flattenBtn');
const undoBtn         = document.getElementById('undoBtn');
const downloadBtn     = document.getElementById('downloadBtn');
const resetBtn        = document.getElementById('resetBtn');
const editHint        = document.getElementById('editHint');
const panelCountEl    = document.getElementById('panelCount');
const colorCountEl    = document.getElementById('colorCount');
const smoothingEl     = document.getElementById('smoothing');
const simplifyEl      = document.getElementById('simplify');
const panelCountValue = document.getElementById('panelCountValue');
const colorCountValue = document.getElementById('colorCountValue');
const smoothingValue  = document.getElementById('smoothingValue');
const simplifyValue   = document.getElementById('simplifyValue');

let loadedImage = null;    // HTMLImageElement
let currentSvg  = null;    // last rendered SVG element

/** Persistent state across regenerate → click-to-remove → render cycles.
 *  Kept separate from `loadedImage` so a manual merge doesn't have to
 *  re-run k-means; only the polygon trace + render stages re-run after an
 *  edit. The whole thing is replaced on Regenerate.
 *
 *  Shape: { regionMap: Int32Array, w: number, h: number,
 *           imageData: ImageData, simplifyTolerance: number } | null
 */
let currentState = null;

/** One-step undo snapshot of `regionMap` taken just before a click-merge.
 *  Null when there's nothing to undo (e.g. immediately after Regenerate). */
let undoSnapshot = null;

/** Re-entrancy guard. The render path is async and any click during it
 *  could race with the in-flight DOM swap; ignore further clicks until
 *  the current one finishes. */
let busy = false;

/** When true, tapping a panel triggers a flood-fill merge of every
 *  connected panel within `FLATTEN_DELTA_E` of the tapped panel's average
 *  colour. Off by default — taps still remove a single panel. Toggled via
 *  the "🪄 Flatten" button. */
let flattenMode = false;

/** Threshold for the flatten flood-fill, in CIE Lab ΔE. Smaller = stricter
 *  match, larger = greedier merging. 26 is roughly the boundary between
 *  "obviously different colours" and "noticeably different shades of the
 *  same colour" and is a good default for things like skies, grass, and
 *  bokeh backgrounds. */
const FLATTEN_DELTA_E = 26;

// ---------- File handling ----------

// The dropzone-inner element is a <label for="fileInput">, so taps already
// open the picker via the label-for relationship. Adding another click
// handler on the dropzone that called fileInput.click() would double-fire
// on iOS Safari and could swallow the change event after a photo was
// picked — so we don't. The label handles taps; we only wire change + drop.
fileInput.addEventListener('change', e => {
  const f = e.target.files?.[0];
  if (f) loadFile(f);
});

['dragenter', 'dragover'].forEach(evt =>
  dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(evt =>
  dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', e => {
  const f = e.dataTransfer.files?.[0];
  if (f) loadFile(f);
});

function loadFile(file) {
  // iOS sometimes hands us files with an empty `type` (notably HEIC from
  // the Photos picker on some iOS versions). Only reject when we have a
  // type AND it's clearly non-image; otherwise let the browser try to
  // decode and rely on `img.onerror` to flag genuine failures.
  if (file.type && !file.type.startsWith('image/')) {
    alert('That doesn’t look like an image. Pick a JPG, PNG, or HEIC.');
    return;
  }

  // Show a loading indicator immediately so the user sees something
  // happen between picking a photo and the pipeline kicking off. Big
  // phone photos can take a beat to decode.
  progressBox.hidden = false;
  setProgress(1, 'Reading photo…');

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    URL.revokeObjectURL(url);
    loadedImage = img;
    dropzone.hidden = true;
    controls.hidden = false;
    results.hidden = false;
    regenerate();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    progressBox.hidden = true;
    alert('Could not read that image. If it’s a HEIC from your iPhone, try ' +
          'sharing it as a JPG (Share → Options → Most Compatible) and ' +
          'picking that.');
  };
  img.src = url;
}

// ---------- Live label updates ----------

for (const [el, valEl, suffix] of [
  [panelCountEl, panelCountValue, ''],
  [colorCountEl, colorCountValue, ''],
  [smoothingEl,  smoothingValue,  ''],
  [simplifyEl,   simplifyValue,   ''],
]) {
  el.addEventListener('input', () => {
    valEl.textContent = el.value + suffix;
  });
}

regenBtn.addEventListener('click', () => regenerate());
undoBtn.addEventListener('click', () => undoLastMerge());
flattenBtn.addEventListener('click', () => {
  flattenMode = !flattenMode;
  flattenBtn.setAttribute('aria-pressed', String(flattenMode));
  editHint.textContent = flattenMode
    ? 'Flatten on: tap a panel and similar-coloured connected panels are absorbed into it.'
    : 'Tap any panel to remove it — the largest adjacent panel grows to fill the space.';
});
resetBtn.addEventListener('click', () => {
  loadedImage = null;
  currentSvg = null;
  currentState = null;
  undoSnapshot = null;
  dropzone.hidden = false;
  controls.hidden = true;
  results.hidden = true;
  fileInput.value = '';
  undoBtn.disabled = true;
});

downloadBtn.addEventListener('click', downloadSvg);

// ---------- Pipeline orchestrator ----------

async function regenerate() {
  if (busy || !loadedImage) return;
  busy = true;
  try {
    await runFullPipeline();
  } finally {
    busy = false;
  }
}

async function runFullPipeline() {

  const opts = {
    panelCount:        Number(panelCountEl.value),
    colorCount:        Number(colorCountEl.value),
    smoothingPasses:   Number(smoothingEl.value),
    simplifyTolerance: Number(simplifyEl.value),
    maxDim:            520,
  };

  downloadBtn.disabled = true;
  progressBox.hidden = false;

  try {
    await setProgress(2, 'Preparing image…');
    const { ctx, width, height } = await prepareImage(loadedImage, opts.maxDim);
    drawCanvas(originalCanvas, ctx.canvas);

    await setProgress(12, 'Smoothing…');
    let imageData = ctx.getImageData(0, 0, width, height);
    for (let i = 0; i < opts.smoothingPasses; i++) {
      imageData = boxBlur(imageData, width, height);
    }

    await setProgress(28, 'Choosing glass colours…');
    const lab = rgbaToLab(imageData);
    const { labels, centroids } = await kmeansLab(lab, opts.colorCount, 18);

    await setProgress(50, 'Finding contiguous regions…');
    const { regionMap, regionCount } = connectedComponents(labels, width, height);

    await setProgress(64, `Merging to ${opts.panelCount} panels (started with ${regionCount})…`);
    mergeToBudget(regionMap, width, height, opts.panelCount);

    // Stash everything the click-to-remove path needs so it can run a
    // fresh trace + render without redoing the expensive cluster steps.
    currentState = {
      regionMap, w: width, h: height, imageData,
      simplifyTolerance: opts.simplifyTolerance,
      colorCount: opts.colorCount,
    };
    undoSnapshot = null;
    undoBtn.disabled = true;

    await renderFromState(78);

    await setProgress(100, 'Done.');
    setTimeout(() => { progressBox.hidden = true; }, 350);

  } catch (err) {
    console.error(err);
    progressText.textContent = 'Something went wrong — check the console.';
  }
}

function setProgress(pct, msg) {
  progressFill.style.width = pct + '%';
  progressText.textContent = msg;
  // Yield to the browser so the progress bar paints between stages.
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

// ---------- Render-from-state ----------

/** Trace → simplify → colour → SVG → wire click handler. Runs both at the
 *  end of `regenerate()` and after every click-to-remove edit. Cheap
 *  compared to k-means/connected-components, so we can call it any time
 *  the regionMap changes. */
async function renderFromState(startPct = 78) {
  if (!currentState) return;
  const { regionMap, w, h, imageData, simplifyTolerance } = currentState;

  await setProgress(startPct, 'Tracing panel outlines…');
  const polygons = tracePolygons(regionMap, w, h);

  await setProgress(Math.min(99, startPct + 10), 'Simplifying edges…');
  for (const p of polygons) {
    p.points = rdp(p.points, simplifyTolerance);
  }

  await setProgress(Math.min(99, startPct + 16), 'Painting each panel…');
  assignAverageColors(polygons, regionMap, imageData, w);

  await setProgress(Math.min(99, startPct + 20), 'Rendering SVG…');
  const svg = renderSvg(polygons, w, h);
  patternHolder.innerHTML = '';
  patternHolder.appendChild(svg);
  currentSvg = svg;

  // Single delegated handler — `data-region-id` is the panel's region id
  // in the current regionMap. Clicking absorbs it into its largest
  // adjacent neighbour.
  svg.addEventListener('click', handleSvgClick);

  patternMeta.textContent =
    `${polygons.length} panels · ${currentState.colorCount} colour palette`;
  downloadBtn.disabled = false;
}

function handleSvgClick(e) {
  const t = e.target;
  if (!(t instanceof SVGElement)) return;
  const idAttr = t.getAttribute('data-region-id');
  if (idAttr === null) return;
  manualMerge(Number(idAttr));
}

// ---------- Manual merge (click to remove a panel) ----------

/** Absorb the clicked region into the neighbour it shares the longest
 *  pixel border with. Snapshots the regionMap first so undo can put it
 *  back. Re-renders. */
async function manualMerge(regionId) {
  if (busy || !currentState) return;
  if (flattenMode) {
    await floodMerge(regionId);
  } else {
    await removeSinglePanel(regionId);
  }
}

async function removeSinglePanel(regionId) {
  const { regionMap, w, h } = currentState;
  const neighbour = longestBorderNeighbour(regionMap, w, h, regionId);
  if (neighbour < 0) return;          // isolated region — nothing to do

  busy = true;
  try {
    // Snapshot before mutating so we can undo.
    undoSnapshot = new Int32Array(regionMap);
    undoBtn.disabled = false;

    // Re-label every pixel of the removed region.
    for (let i = 0; i < regionMap.length; i++) {
      if (regionMap[i] === regionId) regionMap[i] = neighbour;
    }

    progressBox.hidden = false;
    await renderFromState(60);
    setTimeout(() => { progressBox.hidden = true; }, 200);
  } finally {
    busy = false;
  }
}

/** Flatten flood-fill. Walks the region-adjacency graph from the clicked
 *  panel outward; every neighbour whose average colour is within ΔE of the
 *  anchor (in CIE Lab) gets absorbed into the anchor, and we expand from
 *  it too. Behaves like a paint-bucket fill in panel space — great for
 *  collapsing speckled skies, blurry backgrounds, or shadow gradients
 *  into a single panel.
 *
 *  Anchor colour is sampled from the original (smoothed-input) image so
 *  the threshold is comparable across panels even after earlier merges. */
async function floodMerge(seedId) {
  const { regionMap, w, h, imageData } = currentState;

  busy = true;
  progressBox.hidden = false;
  setProgress(20, 'Finding similar panels…');

  try {
    const { labOf, adjacency } = buildRegionGraph(regionMap, w, h, imageData);
    const anchorLab = labOf.get(seedId);
    if (!anchorLab) return;

    // BFS from the seed; only enqueue and absorb neighbours within the
    // colour threshold. Neighbours outside the threshold are still marked
    // visited so we don't tunnel across them.
    const toAbsorb = new Set();
    const visited  = new Set([seedId]);
    const queue    = [seedId];
    while (queue.length) {
      const cur = queue.shift();
      const neigh = adjacency.get(cur);
      if (!neigh) continue;
      for (const nb of neigh) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        const lab = labOf.get(nb);
        if (!lab) continue;
        if (labDistance(anchorLab, lab) < FLATTEN_DELTA_E) {
          toAbsorb.add(nb);
          queue.push(nb);
        }
      }
    }

    if (toAbsorb.size === 0) {
      // No similar neighbours — nothing to do. Hide progress and bail.
      progressBox.hidden = true;
      return;
    }

    await setProgress(50, `Merging ${toAbsorb.size} panel${toAbsorb.size === 1 ? '' : 's'} into one…`);

    // Snapshot before mutating so the user can undo.
    undoSnapshot = new Int32Array(regionMap);
    undoBtn.disabled = false;

    // Re-label absorbed regions to the seed's id.
    for (let i = 0; i < regionMap.length; i++) {
      if (toAbsorb.has(regionMap[i])) regionMap[i] = seedId;
    }

    await renderFromState(70);
    setTimeout(() => { progressBox.hidden = true; }, 200);
  } finally {
    busy = false;
  }
}

/** Build per-region average CIE Lab colour + 4-neighbour adjacency in one
 *  pass over the region map. Used by `floodMerge`; we rebuild each time
 *  because previous merges change the topology. */
function buildRegionGraph(regionMap, w, h, imageData) {
  // Accumulate average colour in linearised RGB space (we'll convert to
  // Lab at the end). Using LinearRGB averages is more faithful than
  // averaging sRGB byte values directly when regions span a brightness
  // range.
  const sums = new Map();    // id -> [rLin, gLin, bLin]
  const counts = new Map();  // id -> pixel count
  const data = imageData.data;
  const srgbToLinear = c => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };

  for (let i = 0; i < regionMap.length; i++) {
    const id = regionMap[i];
    const j = i * 4;
    const r = srgbToLinear(data[j]);
    const g = srgbToLinear(data[j + 1]);
    const b = srgbToLinear(data[j + 2]);
    let s = sums.get(id);
    if (!s) { s = [0, 0, 0]; sums.set(id, s); }
    s[0] += r; s[1] += g; s[2] += b;
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  const labOf = new Map();
  for (const [id, s] of sums) {
    const n = counts.get(id);
    labOf.set(id, linearRgbToLab(s[0] / n, s[1] / n, s[2] / n));
  }

  // 4-neighbour adjacency. Scan right + down edges only; each pair gets
  // both directions added at once so we never duplicate work.
  const adjacency = new Map();
  const addEdge = (a, b) => {
    if (a === b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x < w - 1) addEdge(regionMap[i], regionMap[i + 1]);
      if (y < h - 1) addEdge(regionMap[i], regionMap[i + w]);
    }
  }
  return { labOf, adjacency };
}

/** Linear-light RGB → CIE XYZ → CIELAB. Single-pixel variant of the
 *  pipeline used by `rgbaToLab` during quantization. */
function linearRgbToLab(r, g, b) {
  let X = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  let Y =  r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  let Z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Euclidean distance in Lab — that's CIE76 ΔE. Cheaper than ΔE2000 and
 *  plenty good for telling "obviously similar" from "obviously different"
 *  for our flatten threshold. */
function labDistance(a, b) {
  const dL = a[0] - b[0], dA = a[1] - b[1], dB = a[2] - b[2];
  return Math.sqrt(dL * dL + dA * dA + dB * dB);
}

/** Single pass over the region map collecting how many pixels of border
 *  the target region shares with each neighbour. Returns the neighbour
 *  with the largest shared border, or -1 if the region has no neighbours
 *  (e.g. it covers the whole image). */
function longestBorderNeighbour(regionMap, w, h, target) {
  const tally = new Map();
  const bump = (n) => tally.set(n, (tally.get(n) || 0) + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (regionMap[i] !== target) continue;
      if (x > 0)     { const n = regionMap[i - 1]; if (n !== target) bump(n); }
      if (x < w - 1) { const n = regionMap[i + 1]; if (n !== target) bump(n); }
      if (y > 0)     { const n = regionMap[i - w]; if (n !== target) bump(n); }
      if (y < h - 1) { const n = regionMap[i + w]; if (n !== target) bump(n); }
    }
  }
  let best = -1, bestCount = -1;
  for (const [n, c] of tally) {
    if (c > bestCount) { bestCount = c; best = n; }
  }
  return best;
}

async function undoLastMerge() {
  if (busy || !currentState || !undoSnapshot) return;
  busy = true;
  try {
    currentState.regionMap = undoSnapshot;
    undoSnapshot = null;
    undoBtn.disabled = true;
    progressBox.hidden = false;
    await renderFromState(60);
    setTimeout(() => { progressBox.hidden = true; }, 200);
  } finally {
    busy = false;
  }
}

// ---------- Image prep ----------

async function prepareImage(img, maxDim) {
  const ratio = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const width  = Math.max(64, Math.round(img.naturalWidth  * ratio));
  const height = Math.max(64, Math.round(img.naturalHeight * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);
  return { ctx, width, height };
}

function drawCanvas(target, source) {
  target.width = source.width;
  target.height = source.height;
  target.getContext('2d').drawImage(source, 0, 0);
}

// ---------- Smoothing ----------

/** Single-pass 3×3 box blur. Cheap; chain N passes for a wider effective
 *  radius. We don't need bilateral fidelity — quantization will collapse
 *  small colour differences anyway, the blur just stops noise from
 *  producing speckled regions. */
function boxBlur(imageData, w, h) {
  const src = imageData.data;
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = (yy * w + xx) * 4;
          r += src[j]; g += src[j + 1]; b += src[j + 2];
          n++;
        }
      }
      const i = (y * w + x) * 4;
      out[i]     = r / n;
      out[i + 1] = g / n;
      out[i + 2] = b / n;
      out[i + 3] = 255;
    }
  }
  return new ImageData(out, w, h);
}

// ---------- Colour space ----------

/** sRGB byte channels → linear-light → CIE XYZ → CIELAB. The constant table
 *  is the standard D65 transform. */
function rgbaToLab(imageData) {
  const src = imageData.data;
  const n = src.length / 4;
  const lab = new Float32Array(n * 3);

  for (let i = 0; i < n; i++) {
    let r = src[i * 4]     / 255;
    let g = src[i * 4 + 1] / 255;
    let b = src[i * 4 + 2] / 255;
    r = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
    g = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
    b = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);

    let X = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
    let Y =  r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
    let Z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;

    const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
    const fx = f(X), fy = f(Y), fz = f(Z);

    lab[i * 3]     = 116 * fy - 16;        // L: 0..100
    lab[i * 3 + 1] = 500 * (fx - fy);      // a: ~ -128..127
    lab[i * 3 + 2] = 200 * (fy - fz);      // b: ~ -128..127
  }
  return lab;
}

// ---------- K-means in LAB ----------

/** k-means++ init + Lloyd iterations. Returns per-pixel label and the final
 *  cluster centroids in LAB. We yield to the UI thread between iterations
 *  so the progress bar stays responsive on big images. */
async function kmeansLab(lab, k, maxIter) {
  const n = lab.length / 3;
  const centroids = new Float32Array(k * 3);

  // k-means++ seeding for better convergence than random.
  const firstIdx = Math.floor(Math.random() * n);
  centroids[0] = lab[firstIdx * 3];
  centroids[1] = lab[firstIdx * 3 + 1];
  centroids[2] = lab[firstIdx * 3 + 2];

  const minSqDist = new Float32Array(n).fill(Infinity);

  for (let c = 1; c < k; c++) {
    // Update min sq dist with the latest centroid
    const cx = centroids[(c - 1) * 3];
    const cy = centroids[(c - 1) * 3 + 1];
    const cz = centroids[(c - 1) * 3 + 2];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const dx = lab[i * 3]     - cx;
      const dy = lab[i * 3 + 1] - cy;
      const dz = lab[i * 3 + 2] - cz;
      const d = dx*dx + dy*dy + dz*dz;
      if (d < minSqDist[i]) minSqDist[i] = d;
      total += minSqDist[i];
    }
    // Weighted choice
    let r = Math.random() * total;
    let chosen = n - 1;
    for (let i = 0; i < n; i++) {
      r -= minSqDist[i];
      if (r <= 0) { chosen = i; break; }
    }
    centroids[c * 3]     = lab[chosen * 3];
    centroids[c * 3 + 1] = lab[chosen * 3 + 1];
    centroids[c * 3 + 2] = lab[chosen * 3 + 2];
  }

  const labels = new Uint8Array(n);
  const sums   = new Float32Array(k * 3);
  const counts = new Uint32Array(k);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = 0;
    sums.fill(0); counts.fill(0);

    for (let i = 0; i < n; i++) {
      const px = lab[i * 3], py = lab[i * 3 + 1], pz = lab[i * 3 + 2];
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dx = px - centroids[c * 3];
        const dy = py - centroids[c * 3 + 1];
        const dz = pz - centroids[c * 3 + 2];
        const d = dx*dx + dy*dy + dz*dz;
        if (d < bestD) { bestD = d; best = c; }
      }
      if (labels[i] !== best) { changed++; labels[i] = best; }
      sums[best * 3]     += px;
      sums[best * 3 + 1] += py;
      sums[best * 3 + 2] += pz;
      counts[best]++;
    }

    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        centroids[c * 3]     = sums[c * 3]     / counts[c];
        centroids[c * 3 + 1] = sums[c * 3 + 1] / counts[c];
        centroids[c * 3 + 2] = sums[c * 3 + 2] / counts[c];
      }
    }

    if (changed / n < 0.001) break;     // converged
    if (iter % 4 === 3) await new Promise(r => setTimeout(r, 0));
  }

  return { labels, centroids };
}

// ---------- Connected components ----------

/** Two-pass 4-connectivity labeling with union-find. Output is a label
 *  array (one int per pixel) and the count of distinct regions. */
function connectedComponents(labels, w, h) {
  const out = new Int32Array(labels.length).fill(-1);
  const parents = [];

  const find = x => {
    let r = x;
    while (parents[r] !== r) r = parents[r];
    while (parents[x] !== r) { const nx = parents[x]; parents[x] = r; x = nx; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parents[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  let next = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = labels[i];
      const upLabel   = y > 0 ? labels[i - w] : -1;
      const leftLabel = x > 0 ? labels[i - 1] : -1;
      const upMatches   = upLabel   === c;
      const leftMatches = leftLabel === c;

      if (upMatches && leftMatches) {
        out[i] = out[i - w];
        union(out[i - w], out[i - 1]);
      } else if (upMatches) {
        out[i] = out[i - w];
      } else if (leftMatches) {
        out[i] = out[i - 1];
      } else {
        out[i] = next;
        parents.push(next);
        next++;
      }
    }
  }

  // Compact root labels to a contiguous 0..(regionCount-1) range.
  const remap = new Int32Array(next).fill(-1);
  let regionCount = 0;
  for (let i = 0; i < out.length; i++) {
    const root = find(out[i]);
    if (remap[root] === -1) remap[root] = regionCount++;
    out[i] = remap[root];
  }

  return { regionMap: out, regionCount };
}

// ---------- Merge to budget ----------

/** Repeatedly merge the smallest region into the neighbour it shares the
 *  longest border with, stopping when total region count ≤ budget.
 *  Mutates regionMap in place; returns the final region count. */
function mergeToBudget(regionMap, w, h, budget) {
  // Build initial region stats.
  const sizes = [];
  const neighbours = [];      // Set of neighbour region ids
  const borderLength = [];    // Map<neighbourId, sharedPixelCount>

  let count = 0;
  for (let i = 0; i < regionMap.length; i++) {
    const id = regionMap[i];
    if (id >= count) {
      for (let j = count; j <= id; j++) {
        sizes.push(0);
        neighbours.push(new Set());
        borderLength.push(new Map());
      }
      count = id + 1;
    }
    sizes[id]++;
  }

  // Collect neighbour graph by scanning right/down edges only (each pair
  // touched exactly twice — once for each direction — but we dedupe).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = regionMap[i];
      if (x + 1 < w) {
        const b = regionMap[i + 1];
        if (a !== b) { addBorder(a, b); addBorder(b, a); }
      }
      if (y + 1 < h) {
        const b = regionMap[i + w];
        if (a !== b) { addBorder(a, b); addBorder(b, a); }
      }
    }
  }
  function addBorder(a, b) {
    neighbours[a].add(b);
    borderLength[a].set(b, (borderLength[a].get(b) || 0) + 1);
  }

  // Alive set so we can iterate just the regions still present.
  const alive = new Set();
  for (let i = 0; i < count; i++) alive.add(i);

  let activeCount = count;
  while (activeCount > budget) {
    // Find smallest alive region.
    let smallest = -1, smallestSize = Infinity;
    for (const id of alive) {
      if (sizes[id] < smallestSize) { smallestSize = sizes[id]; smallest = id; }
    }
    if (smallest < 0) break;

    // Find its biggest-border neighbour.
    let best = -1, bestBorder = -1;
    for (const nb of neighbours[smallest]) {
      const bl = borderLength[smallest].get(nb) || 0;
      if (bl > bestBorder) { bestBorder = bl; best = nb; }
    }
    if (best < 0) {
      // Orphaned region (shouldn't happen unless image is single pixel
      // wide); drop it and move on.
      alive.delete(smallest);
      activeCount--;
      continue;
    }

    // Merge smallest → best.
    sizes[best] += sizes[smallest];
    sizes[smallest] = 0;

    // Re-route neighbour bookkeeping
    for (const nb of neighbours[smallest]) {
      if (nb === best) continue;
      const sharedFromSmall = borderLength[smallest].get(nb) || 0;
      borderLength[best].set(nb, (borderLength[best].get(nb) || 0) + sharedFromSmall);
      neighbours[best].add(nb);
      neighbours[nb].delete(smallest);
      neighbours[nb].add(best);
      const fromNbBack = borderLength[nb].get(smallest) || 0;
      borderLength[nb].set(best, (borderLength[nb].get(best) || 0) + fromNbBack);
      borderLength[nb].delete(smallest);
    }
    neighbours[best].delete(smallest);
    borderLength[best].delete(smallest);
    neighbours[smallest] = new Set();
    borderLength[smallest] = new Map();
    alive.delete(smallest);
    activeCount--;

    // Re-label the pixels. To avoid scanning the whole image each merge, we
    // could keep a lazy parent map; for now we just record the rename and
    // batch-apply at the end via a flat lookup.
    renamePending.set(smallest, best);
  }

  // Resolve chained renames and apply.
  const finalId = new Int32Array(count);
  for (let i = 0; i < count; i++) finalId[i] = i;
  for (let i = count - 1; i >= 0; i--) {
    if (renamePending.has(i)) {
      let target = renamePending.get(i);
      while (renamePending.has(target)) target = renamePending.get(target);
      finalId[i] = target;
    } else if (finalId[i] === i && !alive.has(i)) {
      // shouldn't happen, but keep safe
      finalId[i] = i;
    }
  }
  for (let i = 0; i < regionMap.length; i++) {
    regionMap[i] = finalId[regionMap[i]];
  }

  // Compact final ids to 0..N-1 so downstream code is happy.
  const compact = new Map();
  let outId = 0;
  for (let i = 0; i < regionMap.length; i++) {
    const id = regionMap[i];
    if (!compact.has(id)) compact.set(id, outId++);
    regionMap[i] = compact.get(id);
  }
  renamePending.clear();
  return outId;
}
const renamePending = new Map();

// ---------- Polygon tracing ----------

/** For each region, find a starting boundary pixel and walk its outer
 *  contour clockwise (Moore-neighbour). Returns one polygon per region
 *  with `id` and `points` (array of [x, y]). Inner holes are ignored —
 *  glass panels don't have holes, and this simplification keeps the
 *  cutting template clean. */
function tracePolygons(regionMap, w, h) {
  const regionCount = (function () {
    let m = -1;
    for (let i = 0; i < regionMap.length; i++) if (regionMap[i] > m) m = regionMap[i];
    return m + 1;
  })();

  // Find each region's top-left-most pixel; that's a guaranteed boundary
  // starting point and gives a deterministic trace direction.
  const starts = new Int32Array(regionCount).fill(-1);
  for (let i = 0; i < regionMap.length; i++) {
    if (starts[regionMap[i]] === -1) starts[regionMap[i]] = i;
  }

  const polygons = [];

  // 8-connected neighbour offsets in clockwise order starting from due-right.
  const NB_DX = [ 1, 1, 0, -1, -1, -1, 0, 1];
  const NB_DY = [ 0, 1, 1,  1,  0, -1, -1, -1];

  const labelAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? -1 : regionMap[y * w + x];

  for (let r = 0; r < regionCount; r++) {
    const startIdx = starts[r];
    if (startIdx < 0) continue;
    const sx = startIdx % w;
    const sy = (startIdx - sx) / w;

    const points = [];
    let cx = sx, cy = sy;
    let prevDir = 6; // started from "above", so we entered going down — first scan begins from there
    const maxSteps = w * h * 4; // safety cap
    let step = 0;

    while (step++ < maxSteps) {
      points.push([cx, cy]);
      // Look for the next boundary pixel of this region, scanning CW from
      // the slot just counter-clockwise of where we entered.
      let found = false;
      const startScan = (prevDir + 6) % 8;
      for (let i = 0; i < 8; i++) {
        const d = (startScan + i) % 8;
        const nx = cx + NB_DX[d], ny = cy + NB_DY[d];
        if (labelAt(nx, ny) === r) {
          cx = nx; cy = ny;
          prevDir = d;
          found = true;
          break;
        }
      }
      if (!found) break;                 // isolated pixel
      if (cx === sx && cy === sy && points.length > 1) break; // closed
    }

    // Convert pixel centres → corner coordinates by snapping to integer
    // grid. SVG renders polygons at vertex coords; using the grid means
    // adjacent regions share exactly the same lead-line.
    polygons.push({ id: r, points });
  }
  return polygons;
}

// ---------- Ramer-Douglas-Peucker ----------

function rdp(points, tol) {
  if (points.length < 4) return points;
  // Closed polygon: split at the two furthest-apart vertices to anchor.
  // Without that, RDP would otherwise wreck closed shapes.
  let i0 = 0, i1 = 0, maxD = -1;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[i][0] - points[j][0];
      const dy = points[i][1] - points[j][1];
      const d = dx*dx + dy*dy;
      if (d > maxD) { maxD = d; i0 = i; i1 = j; }
    }
    // Don't make this O(N²) on huge polygons.
    if (points.length > 80) break;
  }
  if (i0 > i1) [i0, i1] = [i1, i0];
  const half1 = points.slice(i0, i1 + 1);
  const half2 = [...points.slice(i1), ...points.slice(0, i0 + 1)];
  const r1 = rdpSegment(half1, tol);
  const r2 = rdpSegment(half2, tol);
  // Dedupe junction points.
  const out = [...r1.slice(0, -1), ...r2.slice(0, -1)];
  return out.length >= 3 ? out : points;
}

function rdpSegment(pts, tol) {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tol) return [a, b];
  const left  = rdpSegment(pts.slice(0, idx + 1), tol);
  const right = rdpSegment(pts.slice(idx),        tol);
  return [...left.slice(0, -1), ...right];
}

function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

// ---------- Average colour per polygon ----------

/** Walk the region map once, summing original RGB per region id; each
 *  polygon then gets the mean. Using the smoothed image data here would
 *  bias colours toward the cluster centres, which can look posterized;
 *  we want the recovered average. */
function assignAverageColors(polygons, regionMap, imageData, w) {
  const idToIdx = new Map();
  polygons.forEach((p, i) => idToIdx.set(p.id, i));

  const sums = new Float64Array(polygons.length * 3);
  const counts = new Uint32Array(polygons.length);
  const data = imageData.data;

  for (let i = 0; i < regionMap.length; i++) {
    const idx = idToIdx.get(regionMap[i]);
    if (idx === undefined) continue;
    sums[idx * 3]     += data[i * 4];
    sums[idx * 3 + 1] += data[i * 4 + 1];
    sums[idx * 3 + 2] += data[i * 4 + 2];
    counts[idx]++;
  }
  for (let i = 0; i < polygons.length; i++) {
    if (counts[i] === 0) { polygons[i].color = '#cccccc'; continue; }
    const r = Math.round(sums[i * 3]     / counts[i]);
    const g = Math.round(sums[i * 3 + 1] / counts[i]);
    const b = Math.round(sums[i * 3 + 2] / counts[i]);
    polygons[i].color = `rgb(${r},${g},${b})`;
  }
}

// ---------- SVG output ----------

function renderSvg(polygons, w, h) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('xmlns', svgNS);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // White background so transparent areas don't show through against the
  // page; Mom can ignore this layer when cutting.
  const bg = document.createElementNS(svgNS, 'rect');
  bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
  bg.setAttribute('width', String(w)); bg.setAttribute('height', String(h));
  bg.setAttribute('fill', '#ffffff');
  svg.appendChild(bg);

  for (const poly of polygons) {
    if (poly.points.length < 3) continue;
    const path = document.createElementNS(svgNS, 'polygon');
    const ptsAttr = poly.points
      .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
      .join(' ');
    path.setAttribute('points', ptsAttr);
    path.setAttribute('fill', poly.color);
    path.setAttribute('stroke', '#111');
    path.setAttribute('stroke-width', '1.4');
    path.setAttribute('stroke-linejoin', 'round');
    // Tag with the region id so the click handler can identify which
    // panel was tapped without us having to maintain a separate map.
    path.setAttribute('data-region-id', String(poly.id));
    svg.appendChild(path);
  }
  return svg;
}

// ---------- Download ----------

function downloadSvg() {
  if (!currentSvg) return;
  const serializer = new XMLSerializer();
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
              serializer.serializeToString(currentSvg);
  const blob = new Blob([xml], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `stained-glass-pattern-${Date.now()}.svg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
