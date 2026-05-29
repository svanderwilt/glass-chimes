# Glass Chimes

A site for Mom's stained-glass wind chimes.

## What's here right now

Two pages, both static.

**1. Interactive wind chime (`index.html`).** Seven stained-glass panels hang
from a wooden bar. Hover, drag, or tap them to make them ring. The audio is
synthesised tubular-bell tones — they sound bell-like rather than sine-wavey
because they include the inharmonic upper partials a real chime produces, but
they are not yet Mom's actual chimes.

**2. Photo → pattern designer (`convert.html`).** Drop a photo. The pipeline
converts it to a stained-glass cutting pattern with a user-set panel-count
budget so the result is actually buildable. Runs entirely in the browser —
photos never leave the device. SVG output is scaleable to any physical
template size. **Tap any panel to remove it** — the largest adjacent panel
grows to fill the space, and there's a one-step undo if you regret it.

Files:
- `index.html`, `styles.css`, `chimes.js` — the chime page
- `convert.html`, `convert.css`, `convert.js` — the pattern designer
- `render.yaml` — Render Blueprint for one-click static-site deploy

## Run it locally

No build step. Just open `index.html` in a browser, or for a proper local
server (so the Web Audio API behaves identically to production):

```sh
cd ~/Projects/glass-chimes
python3 -m http.server 8000
# then http://localhost:8000
```

## Deploy to Render

1. `git init` in this directory, commit, push to a GitHub repo.
2. In Render, **New +** → **Blueprint** → pick the repo. Render reads
   `render.yaml` and provisions a static site.
3. Custom domain in the Render dashboard once it's live.

## Design choices worth flagging

- **Pentatonic scale (C5/D5/E5/G5/A5/C6/D6).** Any combination of these
  notes sounds musical, so dragging across all seven still resolves to
  something pleasant — no two notes can land on a tritone.
- **Tubular-bell synthesis, not a tone generator.** Each strike layers
  four sine partials at the real-world inharmonic ratios of a tubular
  bell (1.00 / 2.76 / 5.40 / 8.93). That's what makes it sound like a
  chime rather than a doorbell.
- **No external audio dependencies.** Whole thing is one HTML, one JS,
  one CSS. Render serves it as a static site for free.
- **Touch parity.** Pointer Events cover mouse, pen, and finger.
  `touch-action: none` on the chime area lets the JS own drag gestures
  instead of the browser trying to scroll.

## Known gaps and next steps

### 1. Real audio (the biggest one)
The synthesised tones are a *placeholder*. To make this convincing for
buyers, record Mom's chimes:
- One ~3 s clip per chime tube, recorded close-up in a quiet room
- 44.1 kHz / 16-bit WAV → convert to MP3 or AAC for the web
- Drop into `audio/` and switch `ringFreq()` for an `AudioBufferSource`
  loader. Then the visualised chime is the chime you hear.

### 2. Real Mom's-chime visuals
The on-screen chimes are abstract stained-glass panels. Replace with
SVG traces or photos of Mom's actual pieces:
- A photo per chime (transparent PNG over the wooden bar) is the
  fastest path
- A hand-drawn SVG per piece looks better and scales sharply on
  retina but takes more time

### 3. Photo → pattern designer — v0 shipped (algorithm details)

Built as a client-side pipeline in `convert.js`. No backend, no upload.
Stages, in order:

1. **Resize** to ~520 px on the long edge (processing resolution; output
   SVG is resolution-independent).
2. **Box blur** N passes (smoothing slider, default 3). Wipes noise/JPEG
   artefacts so the quantizer doesn't produce speckled clusters.
3. **CIELAB conversion**. K-means in LAB rather than RGB so cluster
   boundaries align with how the eye sees colour differences.
4. **K-means quantization** with k-means++ seeding. K = colour slider
   (default 8). Converges in <20 iterations on typical images.
5. **Connected components** (two-pass, 4-connectivity, union-find). One
   region per contiguous block of pixels in the same colour cluster.
6. **Merge to budget.** Repeatedly merge the smallest region into the
   neighbour it shares the longest border with, until total region count
   ≤ panel budget. This is what makes the result *buildable* — without
   it the algorithm produces hundreds of tiny shards.
7. **Moore-neighbour contour tracing.** One closed polygon per region.
   Inner holes are dropped (glass panels don't have holes).
8. **Ramer-Douglas-Peucker simplification.** Aggressively drops vertices
   below the tolerance slider so the cutting template has straight runs
   instead of pixel-stepped edges.
9. **Per-polygon average colour** is recomputed from the original (not
   the quantized) image so panels look natural, not posterized.
10. **SVG render** — `<polygon>` per panel, fill = average colour, stroke
    = black "leading," 1.4 px line weight. Output is downloadable.

Known v0 gaps:
- Polygons can self-intersect or share boundary segments imperfectly
  when the contour tracer hits awkward pixel arrangements. SVG renders
  it fine; cutting it might require touch-up.
- No Stripe / purchase flow yet. The output is just a download.
- Smaller regions don't get a "minimum cuttable area" guarantee — a
  panel could come out at e.g. 0.5 cm² when scaled, which is physically
  hard to cut. Worth adding a minimum-area constraint to the merge step
  once Mom uses it on real images.

### 4. Storefront
Stripe Checkout + a small admin email flow is enough to start. Shopify
later only if Mom wants to manage inventory herself.

## Browser support notes

- Web Audio: all modern browsers. iOS Safari requires a user gesture
  before audio can play — the first hover/tap unlocks it, handled in
  `ensureAudio()`.
- Pointer Events: universal on iOS 13+, Android, all desktop browsers.
- SVG inline styling: universal.

No build step, no dependencies, no framework lock-in.
