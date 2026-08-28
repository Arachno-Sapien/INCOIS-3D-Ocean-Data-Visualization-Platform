# 🌊 INCOIS 3D Ocean Data Visualization Platform

<div align="center">

![INCOIS Ocean3D](https://img.shields.io/badge/INCOIS-OCEAN3D-63e6be?style=for-the-badge&labelColor=03101a)
![Three.js](https://img.shields.io/badge/Three.js-v0.160.0-black?style=for-the-badge&logo=three.js)
![Vanilla JS](https://img.shields.io/badge/Vanilla-ES%20Modules-f7df1e?style=for-the-badge&logo=javascript&logoColor=black)
![Argo GDAC](https://img.shields.io/badge/Argo%20GDAC-real%20data-63e6be?style=for-the-badge&labelColor=03101a)
![No Build Step](https://img.shields.io/badge/No%20Build%20Step-Open%20%26%20Run-4ade80?style=for-the-badge)

**A browser-based 3D ocean visualization system for the Indian National Centre for Ocean Information Services (INCOIS). Co-visualizes depth-resolved model fields with real in-situ instrument observations in one interactive scene.**

[Run it](#-running-locally) · [Real Argo data](#-real-argo-data) · [Derived layers](#-derived-layers-isosurface-d26-and-tchp) · [Export](#-export-with-provenance) · [Connect a live feed](#-connecting-a-real-dataset-or-a-live-feed) · [Disaster management](#-disaster-management-from-visualisation-to-decision-support)

</div>

---

## 📸 Overview

The app opens on an **overview globe** where you pick the model domain or an
instrument, then flies into a depth-resolved volume of the **northern Indian
Ocean (55°E–95°E, 10°S–25°N, 0–2000 m)** carrying:

- **Ocean model fields** — temperature, salinity, currents, chlorophyll — as sea
  surface, depth-slice and vertical cross-section planes through the water column
- **Isosurfaces** — the depth of any threshold as a shaded relief, with **D26**
  (26 °C isotherm) as a preset
- **Derived cyclone heat (TCHP)** — computed from the temperature volume
- **Current vector glyphs** — direction and magnitude, with a stated reference
- **Argo floats** — real WMO-numbered floats with QC'd temperature and salinity
  profiles, and surfacing trajectories
- **BGC floats** — real adjusted chlorophyll profiles
- **Gliders, CTD casts, moorings** — synthetic, pending a data source

Click any instrument for a depth profile beside the model field it sits in.

> **Argo observations are real.** 16 core floats (517 QC'd T/S profiles) and
> 16 BGC floats (343 chlorophyll profiles) from the Argo Global Data Assembly
> Centre, spanning the Arabian Sea, the Bay of Bengal and the equatorial Indian
> Ocean. Model fields, gliders, CTD casts and moorings are synthetic, and the UI
> says so on every surface that shows them.

The service layer (`dataService.js`) is a strict seam: swapping the remaining
synthetic sources for a real backend means editing **only that one file**.

---

## 🗂️ Project Structure

```
Ocean_Data_Visualization/
│
├── index.html              ← Single HTML shell — layout, all CSS, importmap
├── serve.py                ← Dev server (stdlib only, sends no-store)
│
├── assets/
│   └── incois-logo.png     ← INCOIS seal, downscaled 14584px → 96px (5.5 MB → 18 KB)
│
├── tools/
│   └── fetch_argo.py       ← Argo + BGC fetch with QC. Re-run to refresh data
│
└── js/
    ├── main.js             ← App boot entry point (WebGL2 check → scene → UI)
    ├── state.js            ← Reactive state store (pub/sub, dot-notation keys)
    ├── constants.js        ← DOMAIN, live VIEW bounds, derived scene dimensions
    ├── dataService.js      ← Data service + Plugin Registry (THE backend seam)
    ├── utils.js            ← Coordinate conversion, noise, cmocean palettes, heatmap
    ├── scene.js            ← Volume: planes, isosurface, TCHP, vectors, markers
    ├── globe.js            ← Overview globe: region + instrument selector
    ├── coastline.js        ← Embedded Natural Earth coastline (~20 KB)
    ├── charts.js           ← Canvas 2D: depth-profile chart, colorbar, depth gauge
    ├── ui.js               ← UI wiring: panels, timeline, tab bar, profile panel
    └── data/
        └── argo.json       ← Real Argo + BGC observations, QC'd (~1.9 MB)
```

> **No `node_modules`, no `package.json`, no build step.** Three.js, fonts and
> icons load from CDN via ES module importmap. Everything else — coastlines,
> observations, the logo — is bundled, so the app renders with no network call.
> A venue with bad wifi cannot break the demo.

---

## 🚀 Running Locally

### Prerequisites
- A modern browser: **Chrome 89+**, **Firefox 108+**, or **Edge 89+** (WebGL2 + importmap support)
- Python 3 **or** any static HTTP server (files must be served over HTTP, not `file://`)
- Internet connection (for CDN: Three.js, Google Fonts)

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/siddharthr21/Ocean_Data_Visualization.git
cd Ocean_Data_Visualization

# 2. Start the dev server, then open http://localhost:8791
python serve.py
```

`serve.py` is `python -m http.server` plus one header: `Cache-Control: no-store`.
Browsers keep an in-memory cache of ES modules that a **soft reload does not
revalidate**, so editing `js/scene.js` and pressing F5 can silently serve the
previous version. Use this rather than a bare `http.server` and you never have
to remember Ctrl+Shift+R.

Any static server works if you prefer, but hard-reload after every edit:

```bash
python -m http.server 8765     # then Ctrl+Shift+R on each change
```

In Claude Code, `.claude/launch.json` registers this as the `ocean3d` config,
so the preview starts without anyone picking a port.

> ⚠️ **Must use HTTP** — ES modules are blocked by browsers when opened directly via `file://` protocol due to CORS restrictions.

### GitHub Pages (No Server Needed)

Enable free hosting directly from the repo:
1. Go to **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `main` → `/ (root)`
4. Save — your site will be live at `https://siddharthr21.github.io/Ocean_Data_Visualization/`

---

## 🧱 Tech Stack

| Layer | Technology | Why |
|---|---|---|
| 3D Rendering | [Three.js v0.160.0](https://threejs.org/) | WebGL abstraction, geometry, materials, animation |
| Camera Controls | Three.js OrbitControls | Orbit/pan/zoom navigation |
| 2D Charts | Canvas 2D API | Depth-profile line chart, colorbar, sonar gauge — zero external deps |
| Module Loading | ES Modules + Importmap | Native browser modules, no bundler |
| Styling | Vanilla CSS3 | Custom properties, layered surfaces, `backdrop-filter` |
| Fonts | Google Fonts CDN | Outfit (display), Geist (UI), IBM Plex Mono (all numerics) |
| Icons | [Phosphor](https://phosphoricons.com/) via CDN | No hand-rolled SVG paths, no emoji |
| Colormaps | cmocean approximations | Perceptually uniform, the oceanographic standard |
| Observations | Argo GDAC via Ifremer ERDDAP | Fetched and QC'd offline by `tools/fetch_argo.py` |
| State | Custom reactive store | `state.js` pub/sub pattern |

**No React. No Vue. No Webpack. No npm.** The module structure is explicitly designed for easy migration into any framework later.

---

## 🎨 Visual Design

### Bathymetric surface ramp

Surfaces are named for the ocean's light zones rather than a generic grey scale,
and every one is tinted blue-green so the whole interface belongs to a single
water column. No pure black anywhere.

| Token | Hex | Zone | Used for |
|---|---|---|---|
| `--abyssal` | `#03101a` | below 4000 m | page ground, WebGL clear colour, fog |
| `--midnight` | `#061a27` | 1000-4000 m | panel fill |
| `--twilight` | `#0a2534` | 200-1000 m | raised surface |
| `--sunlit` | `#10394b` | 0-200 m | highest surface, hairlines |

### One chrome accent

| Token | Hex | Used for |
|---|---|---|
| `--lumen` | `#63e6be` | every interactive affordance, focus ring, active state, gauge |

Bioluminescent seafoam, chosen deliberately **instead of `#22d3ee`** — that exact
cyan is the default dark-tech accent and reads as generic. One accent, locked
across the whole interface.

### Data colours (exempt from the one-accent rule)

These are not chrome. Each encodes an instrument class and matches its 3D marker
hue, so the legend, the checkbox swatch, and the sphere in the scene agree.
**Never reuse them for UI decoration.**

| Token | Hex | Encodes |
|---|---|---|
| `--data-argo` | `#38bdf8` | Argo floats |
| `--data-glider` | `#a78bfa` | Gliders |
| `--data-ctd` | `#2dd4bf` | CTD casts |
| `--data-bgc` | `#fb923c` | BGC floats |
| `--data-mooring` | `#f472b6` | Moorings |

Field colours come from the cmocean palettes, never from these tokens.

### Typography

| Font | Usage |
|---|---|
| **Outfit** | Display headings, panel titles, brand name |
| **Geist** | UI body text, labels, buttons |
| **IBM Plex Mono** | Every numeric readout, with `tabular-nums` so figures do not shift as values change under a slider |

### Radius scale

One documented rule, applied everywhere: containers `14px`, inner controls
`7px`, pills full. Mixed radii without a rule is what makes a layout read as
assembled rather than designed.

### Composition

The console (left) and the layer rail (right) are deliberately **not** mirror
images: the console is wider, top-anchored, and carries a lit leading edge; the
rail is narrower, dropped down the viewport, and quieter. Twinned panels either
side of a canvas is the stock dashboard composition.

Surfaces carry an inner top highlight and a hue-tinted drop shadow rather than a
plain `backdrop-filter`, and a fixed `pointer-events: none` grain layer breaks
the digital flatness. The grain is fixed, never on a scrolling container, since
a scrolling noise layer forces continuous GPU repaints.

### Signature Design Element
The **sonar depth gauge dial** (bottom-left in the volume view) renders entirely
in Canvas 2D: tick marks and depth labels on a 300° arc, ambient sonar rings, a
needle sweeping to the current depth slice, and a numeric readout. The label sits
*above* the value so the two never collide as it grows from `0 m` to `2.00 km`.

### Branding

The top bar carries the official INCOIS seal (`assets/incois-logo.png`), sourced
from incois.gov.in and downscaled from 14584×14584 / 5.5 MB to 96 px / 18 KB. It
is bundled rather than hotlinked so it cannot fail on a poor connection, and it
sits on the bar with no plate behind it — the mark carries its own light circular
field, which the accent gradient previously fought.

---

## 🖥️ UI Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  TOP BAR: Brand | Temperature | Salinity | Currents | Chl | Argo│
├────────────┬────────────────────────────────────┬───────────────┤
│  CONTROLS  │                                    │    LAYERS     │
│  PANEL     │      THREE.JS 3D OCEAN SCENE       │    PANEL      │
│  (Left)    │         (Full viewport)            │    (Right)    │
│            │                                    │               │
│  Date      │   ┌─ Lon/Lat/Depth axes ──────┐   │  ☑ Sea surface│
│  Timestep  │   │  Heatmap planes           │   │  ☑ Lon section│
│  Depth ──  │   │  Current particles ·····  │   │  ☑ Lat section│
│  V.Exag ── │   │  Argo ● Glider ◆ CTD ●   │   │  ☑ Depth slice│
│  Opacity──  │   └───────────────────────────┘   │  ☑ Currents  │
│            │                                    │  ☑ Argo      │
│  Palette   │                       [Profile     │  ☑ Gliders   │
│  Min / Max │                        Panel       │  ☑ CTD       │
│  Lin / Log │                        on click]   │  ☑ Bathymetry│
├────────────┴────────────────────────────────────┴───────────────┤
│  [●DEPTH GAUGE]   [▶] [1×]  |00:00|  |06:00|  |12:00|  |18:00| │
│  (sonar dial)     Timeline scrubber with tick marks             │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🛟 Real Argo data

`js/data/argo.json` holds genuine Argo GDAC observations, fetched and quality
controlled by `tools/fetch_argo.py` and committed so the app needs no network at
runtime. Refresh with:

```bash
python tools/fetch_argo.py --start 2024-01-01 --end 2024-06-30 --max-floats 16
```

The bundled build is 16 core floats / 517 profiles and 16 BGC floats / 343
chlorophyll profiles (~1.9 MB), from 1.35 M raw levels after QC. Data modes span
all three: 393 delayed, 104 real-time, 20 adjusted.

> Argo data are collected and made freely available by the International Argo
> Program and the national programmes that contribute to it. <https://argo.ucsd.edu>

### What the fetch script enforces

None of this is optional for Argo, and skipping any of it produces plausible
looking numbers that are wrong.

| Rule | Why |
|---|---|
| Keep only QC flags **1** and **2**, per level | Raw Argo carries salinity spikes and pressure inversions that render as dramatic false features |
| Check whole-profile flags too (`profile_temp_qc`) | A broadly-fine profile can still contain bad levels |
| Choose `_ADJUSTED` vs raw from `data_mode` | Delayed-mode salinity drift correction is often larger than the signal being studied |
| Pressure stays in **decibars** | 1 dbar ≈ 1 m is fine for display, but the axis must not claim metres |
| Sanity checks | temp −2…35 °C, salinity 0…42 PSU, monotonic pressure, in-domain positions, no future timestamps |

In the current build **54% of salinity levels are rejected** and two floats have
salinity rejected outright. That is not a bug: those floats have failing
conductivity cells and delayed-mode QC flagged them correctly. The UI shows
*"Salinity rejected by QC"* rather than an empty chart, and strikes through the
variable button. Filling those gaps with zero would draw fresh water that is not
in the ocean.

### BGC chlorophyll

16 BGC floats, 343 profiles, from `ArgoFloats-synthetic-BGC` on the same server.

Chlorophyll comes from **`chla_adjusted`, never `chla`**. In this domain 100% of
raw fluorescence levels carry QC flag 3 ("probably bad") — the sensor needs a
factor-of-2 scale correction and is depressed near the surface by
non-photochemical quenching. Filtering raw on flags 1–2 yields **zero** usable
levels; the delayed-mode adjusted field yields 14,639.

Slightly negative adjusted values (to −0.005 mg m⁻³) are dark-count noise around
zero and are **passed through, not clipped**. Flooring them at zero would
misrepresent the correction that was applied.

The bundled profiles show a textbook **subsurface chlorophyll maximum**: 0.03 mg
m⁻³ at 35 dbar rising to 0.61 at 65 dbar, then falling away below the photic
zone.

### Instrument classes that are still synthetic

The domain was widened from the Arabian Sea (68–78°E / 8–20°N) to the basin
(55–95°E / 10°S–25°N) specifically to reach real data for every instrument
class. It roughly **quadrupled the real Argo** (10 → 16 floats, 165 → 517
profiles) and **grew BGC chlorophyll 26×** (13 → 343 profiles). Gliders and
moorings did not follow, for reasons that are worth stating precisely:

| Class | Status after widening |
|---|---|
| Gliders | **7 real deployments now in the domain**, but all are July 2016 (Bay of Bengal, ~8°N 86–89°E) or Nov 2021–Oct 2022 (Gulf of Oman, ~24°N 58°E). None overlap the 2024 Argo window, so co-visualising them would mean putting instruments 2–8 years apart in one frame. The GDAC also ships **no QC flags** for these deployments (`TEMP_QC`/`PSAL_QC` are all null), so range checks would be the only filter. One deployment is 163,150 rows over 11 days and needs heavy decimation. |
| CTD casts | `ArgoFloats-reference-CTD` returns **401 Unauthorized** — the dataset requires credentials. |
| Moorings | RAMA now has ~10 sites inside the domain. The PMEL ERDDAP **302-redirects to `coastwatch.pfeg.noaa.gov`, which is unreachable from this network**, so the fetch cannot complete here. The query itself is correct and is the natural next connector from a network that can reach NOAA. |

**To bring gliders in**, re-fetch Argo over a window that overlaps a deployment
(`--start 2022-07-01 --end 2022-10-31` overlaps `sea057_20220707`) so both
instrument classes describe the same months. That trades away the current dense
2024 BGC coverage, which is why it is not the default.

### Time: the model frame and the observations must agree

Observations are irregular in time and there is no timestep to snap them to, so
the app never implies a model frame and a float profile describe the same
instant unless they do.

- The **date control is bounded to the Argo coverage window** and labelled with
  it. The synthetic field will generate for any date, which is exactly why
  nothing objected when the default sat two years from every float. Real
  observations only exist where they were measured.
- Selecting a model timestep returns each float's **nearest cycle in time**, so
  scrubbing the date moves the observations instead of pinning one profile.
- Every profile states its **offset from the model frame** (`2.7 d before model
  frame`), colour-graded: accent within 5 days, neutral within a month, warning
  beyond a year. This applies to **synthetic platforms too** — a generated
  instrument dated two years from the frame is exactly as misleading as a real
  one, and only real profiles carried the badge at first.
- **Synthetic platforms are generated relative to the selected frame** rather
  than carrying fixed timestamps, and regenerate when the date changes. They
  previously held dates hardcoded when the default was 2026, so gliders and CTDs
  sat two years ahead of the model field with nothing saying so.

Bounds and default are read from `argo.json` at runtime, so re-running the fetch
script with a different window moves them automatically.

### What the profile panel states

`WMO`, `CYCLE_NUMBER`, data mode (real-time / adjusted / delayed), whether
adjusted or raw fields were used, level count and maximum pressure. A float's
reported position is where it **surfaced**, not where it profiled — it drifts
during ascent — so trajectories draw the surfacings as the dominant element and
the connecting line only as an indicative link.

---

## 🌀 Derived layers: isosurface, D26 and TCHP

Three layers computed from the temperature volume already in memory. No extra
data — which is the point: these are the quantities operational centres actually
watch, and they fall out of a field the app is already rendering.

### Isosurface

The depth at which the field crosses a threshold, as a shaded relief surface.

Implemented as a **single-valued depth surface per water column** rather than
general marching cubes. Below the mixed layer temperature is monotonic, so the
isotherm has exactly one depth per column — this is the correct shape, not an
approximation of one. It is also far cheaper than a full volumetric extraction.

Columns where the field never crosses the threshold emit **no geometry**, and
the control reports coverage (`227–566 m · present over 32% of the region`).
Interpolating across those columns would draw a surface at a depth where the
isotherm does not exist, and a surface spanning a third of the domain means
something very different from one spanning all of it.

### D26

The **D26** preset jumps the threshold to 26 °C — the conventional floor of the
layer that can fuel a tropical cyclone. In the bundled field it sits at
**43–124 m**, which is the right range for this basin.

### TCHP

```
TCHP = ρ · c_p · ∫ (T(z) − 26) dz     from the surface down to D26
```

Heat stored above the 26 °C isotherm, in **kJ cm⁻²**, the unit operational
centres use. Rendered as a surface-level field on a **fixed 0–160 scale**, never
auto-scaled per frame: the ≈50–60 kJ cm⁻² threshold associated with rapid
intensification only means something if a colour maps to the same value across
regions and timesteps. The legend states that threshold, because the bare number
is meaningless to most viewers without it.

TCHP is computed for temperature only. On any other variable it returns `null`
rather than integrating something with no physical meaning.

> **This corrected a real defect in the synthetic field.** The mock temperature
> was a linear 32 → 2 °C ramp, which puts the 26 °C isotherm near **400 m** and
> produced TCHP of 119–883 kJ cm⁻², roughly an order of magnitude too high. The
> field now uses a mixed layer over an exponential thermocline, giving a
> realistic column (29.5 °C surface, 7.6 °C at 500 m, 3.0 °C at depth). Every
> derived quantity depends on that shape, so getting it wrong is not cosmetic —
> and a linear ramp is the kind of thing an oceanographer spots instantly.

---

## 🖼️ Export with provenance

**Export** saves the current view as a PNG with a provenance strip composited
into the file:

```
INCOIS OCEAN3D
Temperature (°C)
55°E–95°E · 10°S–25°N · depth slice 200 m · vert. exag. 3×
2024-06-29 06:00 UTC · palette thermal · scale linear 2-32 · isosurface 26 °C @ 43–124 m
Observations: real (Argo GDAC, 32 floats, QC flags 1/2) · Model field: SYNTHETIC
```

A bare screenshot of an ocean field is unusable as evidence. It travels far
beyond whoever took it, and by then nobody knows the variable, the depth, the
date, the region, or whether the numbers were measured or generated. Everything
needed to interpret — or challenge — the image is burned into the image.

The last line is the one that matters most: it states plainly which half of the
figure is real. A slide deck circulating without it is exactly how a synthetic
field ends up quoted as an observation.

Files are named `incois-ocean3d_<variable>_<date>_<timestep>.png`, so a folder
of exports sorts meaningfully.

> **Implementation note.** The renderer runs without `preserveDrawingBuffer` —
> keeping it on costs memory and bandwidth on every frame — so by the time a
> click handler runs the drawing buffer is undefined and `toDataURL()` returns a
> blank image. `captureFrame()` renders immediately before reading, synchronously.
> An `await` between the two lets the compositor clear the buffer first.

---

## 🧭 Current vectors

The problem statement asks for current **vectors**. Particles convey flow
pattern but not magnitude, so they are paired with glyphs that carry both:
direction from the u/v components, magnitude from length and colour on the same
`speed` colormap the field uses, so a glyph can be read against the colorbar.

- **Decimated** to ~18 glyphs across. One per grid cell becomes noise long
  before it becomes information.
- **Length ∝ √speed**, not linear — a wide speed range makes slow flow invisible
  under linear scaling. The legend says so, because otherwise lengths are
  misread.
- A **reference magnitude** is stated (`⟶ longest glyph = 0.57 m s⁻¹ at 200 m`).
  Glyph length carries nothing quantitative without one.
- One **`InstancedMesh`**: 400 glyphs cost one draw call, not 400.
- They sit on the depth-slice plane and follow it as the slider moves, and only
  render on the currents field, which is the only one carrying u/v.

---

## 🌍 Two views: overview globe → depth volume

The app opens on a **globe**, not the volume. That mirrors how INCOIS operators
already choose what to look at:

| INCOIS tool | Interaction | Mirrored here |
|---|---|---|
| [Live Access Server](https://las.incois.gov.in/las/UI.vm) | drag a lat/lon box on a 2D map to clip a field | the model domain is drawn on the sphere and is clickable |
| [Ocean Observation Network](https://incois.gov.in/site/datainfo/OON.jsp) | pan a map, click an instrument pin | instrument pins on the globe, click to open that platform |

Clicking the highlighted domain flies the camera into the depth-resolved volume.
Clicking a pin does the same and then opens that instrument's profile once the
camera arrives. The **Overview** button returns to the globe.

The camera *flies* rather than cuts, deliberately: the transition is what
explains that the box you land in is the region you just clicked.

**Rendering.** The globe is fully procedural — an ocean sphere, a graticule,
coastlines, a view-angle atmospheric rim, and a tessellated domain patch that
curves with the surface. There is **no image texture and no runtime fetch**:
`coastline.js` embeds Natural Earth 1:110m coastline (public domain),
Douglas-Peucker simplified from 5128 to 1581 vertices. A venue with bad wifi
cannot break the opening view.

**No auto-rotate.** A slow idle spin looks good in isolation but carries the
domain and the pins off screen while the user reads the hint. The globe is a
selector; the thing you are meant to click stays where the camera framed it.

### Area selection

**Select area** arms a drag; dragging on the globe draws a lat/lon box and the
volume then renders *that* region. This is the Live Access Server's box-select,
on a sphere instead of a flat map.

The drag raycasts against the globe body and converts each hit to geographic
degrees, so the box is built from real corners. A screen-space rectangle would
skew against the curvature and mean something different at the limb than at the
centre.

Arming is explicit rather than always-on, because a bare drag on a globe already
means *rotate*; overloading it would make the globe feel broken. `Escape`
abandons an armed or in-progress selection, and **Whole basin** restores the
full extent.

What follows a selection:

| | |
|---|---|
| `VIEW` | the active bounds; `DOMAIN` stays the outer limit of available data |
| `SCENE_W` / `SCENE_D` | re-derived, so a tall narrow selection is not stretched to fill a wide box |
| Model field | regenerated over the selection, the way a subsetting backend would return it |
| Markers | filtered to the selection — otherwise the coordinate transform projects an outside float *into* the box, placing it where it was never measured |
| Scale badge | states the rendered extent and appends `· selected` |

`VIEW` is an `export let` in `constants.js`: ES module live bindings mean every
importer sees the new bounds after `setViewBounds()` with no subscription
plumbing. Selections below `MIN_SELECTION_DEG` (1.5°) are rejected, since a
degenerate box divides by zero in the coordinate transform.

---

## ⚙️ Module Reference

### `state.js` — Reactive State Store

Single source of truth for all application state. No component holds authoritative state directly.

```js
import State from './state.js';

// Read a value (supports dot notation for nested keys)
State.get('depthSlice');             // → 200
State.get('layers.argoFloats');      // → true

// Write a value (automatically notifies all subscribers)
State.set('depthSlice', 500);
State.set('layers.argoFloats', false);

// Subscribe to changes (returns unsubscribe function)
const unsub = State.subscribe('depthSlice', (newValue) => {
  console.log('Depth changed to', newValue);
});
unsub(); // stop listening

// Full state snapshot (read-only deep copy)
const snap = State.snapshot();
```

**Full state shape:**

```js
{
  activeVariable:      'temperature',          // 'temperature'|'salinity'|'currents'|'chlorophyll'
  selectedDate:        '2024-06-29',   // clamped to real Argo coverage
  selectedTimestep:    '06:00',
  availableTimesteps:  ['00:00','06:00','12:00','18:00'],
  depthSlice:          200,                    // metres (0–2000)
  verticalExaggeration: 5,                     // Y-axis scale multiplier
  layerOpacity:        0.82,                   // 0–1
  colorbarPalette:     'thermal',              // see PALETTES in utils.js
  colorbarMin:         null,                   // null = auto from variable defaults
  colorbarMax:         null,
  colorbarScale:       'linear',               // 'linear'|'log'

  // Model layers are listed explicitly. Instrument layers are keyed by
  // PLUGIN_REGISTRY id ('argo', 'glider', 'ctd', 'bgc', 'mooring', …) and
  // default to visible when absent — a new plugin needs no edit here.
  layers: {
    seaSurface:        true,
    lonSection:        true,
    latSection:        false,   // off by default: stacked planes wash each other out
    depthSlice:        true,
    currentParticles:  false,   // auto-enabled on the Currents variable
    bathymetryGrid:    true,
  },
  timelineIndex:       1,
  timelinePlaying:     false,
  timelineSpeed:       1,                      // 0.5|1|2|4
  selectedPlatform:    null,                   // clicked platform object | null
  profileData:         null,                   // getProfile() response | null
  controlsPanelOpen:   true,
  layersPanelOpen:     true,
  profilePanelOpen:    false,
}
```

---

### `constants.js` — Shared Constants

Zero dependencies. Imported by both `utils.js` and `dataService.js` to avoid circular dependency.

```js
export const DOMAIN = {
  lonMin: 68, lonMax: 78,   // Longitude range °E
  latMin: 8,  latMax: 20,   // Latitude range °N
  depthMin: 0, depthMax: 2000,  // Depth range in metres
};

export const SCENE_W = 10;  // Three.js scene X span (longitude)
export const SCENE_D = 12;  // Three.js scene Z span (latitude)
export const SCENE_H = 10;  // Three.js scene Y span (depth, before exaggeration)
```

---

### `dataService.js` — Mock Data Service & Plugin Registry

**This is the backend seam.** Every function is `async`. No other module generates or reads raw data.

#### Public API

```js
import { getModelField, getInstrumentPlatforms, getProfile, getAllPlatforms, PLUGIN_REGISTRY, VARIABLE_META, DOMAIN } from './dataService.js';

// Fetch a 3D model field
const field = await getModelField('temperature', '2024-06-29', '06:00');

// Fetch all platforms of one type
const argoList = await getInstrumentPlatforms('argo');

// Fetch depth profile for a platform
const profile = await getProfile('2903456');

// Fetch all registered source types at once
const allPlatforms = await getAllPlatforms();
```

#### Swapping Mock → Real REST API

```js
// CURRENT (mock):
export async function getModelField(variable, date, timestep) {
  await _delay(60);
  return _generateModelField(variable, date, timestep);
}

// SWAP TO REST API (one-line change):
export async function getModelField(variable, date, timestep) {
  const r = await fetch(`/api/model/${variable}/${date}/${timestep}`);
  return r.json();
}

// SWAP TO OPeNDAP:
export async function getModelField(variable, date, timestep) {
  const r = await fetch(
    `https://opendap.incois.gov.in/thredds/dodsC/INCOIS/${variable}.nc.ascii` +
    `?${variable}[0][0:1:39][0:1:39][0:1:19]`
  );
  return r.json(); // after server-side parsing
}
```

#### Variable Metadata

```js
// `cfName` is the CF standard name, so the colorbar states the quantity in the
// vocabulary INCOIS and international portals use, not an internal short key.
VARIABLE_META = {
  temperature: { label: 'Temperature', unit: '°C',     defaultMin: 2,  defaultMax: 32,  palette: 'thermal',
                 cfName: 'sea_water_potential_temperature' },
  salinity:    { label: 'Salinity',    unit: 'PSU',    defaultMin: 34, defaultMax: 37,  palette: 'haline',
                 cfName: 'sea_water_practical_salinity' },
  currents:    { label: 'Currents',    unit: 'm s⁻¹',  defaultMin: 0,  defaultMax: 1.5, palette: 'speed',
                 cfName: 'sea_water_velocity' },
  chlorophyll: { label: 'Chlorophyll', unit: 'mg m⁻³', defaultMin: 0,  defaultMax: 2,   palette: 'algae',
                 cfName: 'mass_concentration_of_chlorophyll_in_sea_water' },
}
```

---

### `utils.js` — Utilities & Coordinate Conversion

#### `latLonDepthToScene(lat, lon, depthM, vertExag)` ← **THE GLOBE SWAP SEAM**

```js
import { latLonDepthToScene } from './utils.js';

// Convert geographic coordinates → Three.js scene local space
const pos = latLonDepthToScene(14.2, 71.8, 200, 5);
// → { x: 3.8, y: -5.0, z: 3.7 }
```

> **This is the only function to update** if replacing the Three.js ocean box with a Cesium globe or Mapbox GL 3D terrain in a future version.

#### Color Palettes

Palettes are approximations of **cmocean** (Thyng et al., 2016) — the colormap set
oceanographers expect per variable. They are perceptually uniform: equal steps in
value look like equal steps in colour, and they remain readable under colour-vision
deficiency.

| Palette | Variable | Type |
|---|---|---|
| `thermal` | Temperature | sequential |
| `haline` | Salinity | sequential |
| `algae` | Chlorophyll | sequential |
| `speed` | Current magnitude | sequential |
| `balance` | Anomalies / signed fields | diverging |
| `viridis`, `cividis` | General purpose (`cividis` is colour-vision safe) | sequential |
| `jet` | **Not for presenting data** — retained only to demonstrate the difference | — |

> `jet` is non-monotonic in lightness: it invents banding where the field is smooth
> and flattens real gradients in the green band. Selecting it raises an on-screen
> advisory. It is never a default.

```js
import { valueToColor, PALETTES, DIVERGING_PALETTES } from './utils.js';

// Map a normalised value (0–1) → [r, g, b, a] (0–255)
valueToColor(0.7, 'thermal');   // temperature
valueToColor(0.7, 'haline');    // salinity

// Add a palette: one entry of evenly-spaced RGB stops (0–1), no other change.
PALETTES.dense = [[0.90,0.94,0.94], /* … */ [0.21,0.07,0.23]];
```

#### Heatmap Texture Generation

```js
import { generateHeatmapTexture } from './utils.js';

// Generate RGBA pixel data for a 2D grid slice
const texData = generateHeatmapTexture(
  float32Values,   // Float32Array, length width × height
  width, height,   // grid dimensions
  minVal, maxVal,  // value range for normalization
  'jet',           // palette
  'linear'         // 'linear' | 'log'
);
// → Uint8ClampedArray, length width × height × 4
```

---

### `scene.js` — Three.js 3D Scene Manager

**Owns the entire WebGL world.** Responds to state changes via subscriptions.

#### Scene Graph

```
THREE.Scene
├── Stars (Points — 1800 particles, ambient drift)
├── _oceanBoxGroup (Group)
│   ├── Box wireframe edge mesh
│   ├── Axis lines (X=cyan, Z=teal, Y=violet)
│   ├── waveSurface (Mesh — decorative animated air-sea interface, y=0.8)
│   ├── seaSurface (Mesh — horizontal heatmap plane at y=0)
│   ├── depthSlice (Mesh — horizontal heatmap plane at current depth)
│   ├── lonSection (Mesh — vertical E-W cross-section curtain)
│   ├── latSection (Mesh — vertical N-S cross-section curtain)
│   ├── isosurface (Mesh — depth-of-threshold relief, vertex-coloured)
│   ├── tchp (Mesh — derived cyclone-heat field at the surface)
│   ├── currentVectors (InstancedMesh — 400 arrow glyphs)
│   ├── bathymetryGrid (Mesh — wireframe floor plane)
│   └── currentParticles (Points — 3000 animated drift particles)
└── _markerGroup (Group)
    ├── Argo sphere markers × N
    ├── Glider sphere markers + CatmullRom spline tracks
    ├── CTD sphere markers × N
    ├── BGC sphere markers × N
    └── Mooring sphere markers × N (stub)
```

#### Public API

```js
import { initScene, handleCanvasClick, getCamera, getScene, refreshMarkers } from './scene.js';

// Boot the 3D scene (async — awaits first data load)
await initScene(canvasElement);

// Hit-test markers on click → returns platform object or null
const platform = handleCanvasClick(mouseEvent, canvasElement);

// Force refresh of all instrument markers (e.g. after data update)
await refreshMarkers();
```

#### State Subscriptions (automatic)

| State Key | Scene Response |
|---|---|
| `activeVariable` | Re-fetches field, rebuilds all heatmap planes |
| `selectedDate` | Re-fetches field |
| `selectedTimestep` | Re-fetches field |
| `depthSlice` | Repositions and re-textures depth slice plane only |
| `verticalExaggeration` | Rebuilds ocean box Y scale + all vertical planes |
| `layerOpacity` | Updates `material.opacity` on all layer meshes |
| `colorbarPalette/Min/Max/Scale` | Re-textures all heatmap planes |
| `layers.*` | Toggles `mesh.visible` per layer |
| `timelineIndex` | Triggers `selectedTimestep` update |

---

### `charts.js` — Canvas 2D Rendering

No external charting library. Pure Canvas 2D API.

#### `drawProfileChart(canvas, profileData, activeVar, opts)`

Renders a depth-vs-variable line chart with:
- Gradient fill under the line
- Grid lines at standard oceanographic depth levels (0, 200, 500, 1000, 1500, 2000 m)
- Colour-coded by variable: coral=temperature, cyan=salinity, green=chlorophyll
- Data point dots at each observation depth

#### `drawColorbar(canvas, palette, minVal, maxVal, unit)`

Renders a horizontal gradient strip with min/max labels. Updates live when the colorbar editor controls change.

#### `drawDepthGauge(canvas, depthM, maxDepth)` ← Signature Element

Renders the sonar-style circular depth dial:
- 300° arc sweep (0 m at 7 o'clock → 2000 m at 5 o'clock)
- Major/minor tick marks with depth labels
- Ambient sonar ring decorations
- Glowing needle pointing to current depth
- Numeric readout in the center

---

### `ui.js` — UI Wiring

Connects DOM events → State updates. Subscribes to State → updates DOM. Never touches raw data.

#### Public API

```js
import { initUI, showLoading, hideLoading } from './ui.js';

// Wire all UI components (call once after scene init)
initUI((mouseEvent) => handleCanvasClick(mouseEvent, canvas));

// Loading overlay control
showLoading('Custom message…');
hideLoading();
```

#### Components Managed

| Component | DOM ID | Behaviour |
|---|---|---|
| Variable tab bar | `#tab-bar` | Sets `activeVariable`, syncs colorbar defaults |
| Controls panel | `#controls-panel` | Collapsible; wires all sliders/selects → State |
| Layers panel | `#layers-panel` | Generates checkboxes from layer definitions |
| Profile panel | `#profile-panel` | Opens on marker click; fetches+draws profile chart |
| Timeline | `#timeline-track` | Tick-mark scrubber + play/pause/speed buttons |
| Colorbar legend | `#colorbar-legend` | Redraws on palette/range change |
| Depth gauge | `#depth-gauge-canvas` | Redraws on `depthSlice` state change |
| Plugin registry badges | `#plugin-registry-list` | Auto-generated from `PLUGIN_REGISTRY` array |

---

## 📡 Data Contracts / API Schema

These are the exact response shapes the mock returns today and that a real backend **must** match.

### `getModelField(variable, date, timestep)`

```json
{
  "variable": "temperature",
  "unit": "°C",
  "date": "2024-06-29",
  "timestep": "06:00",
  "bounds": {
    "lonMin": 68, "lonMax": 78,
    "latMin": 8,  "latMax": 20,
    "depthMin": 0, "depthMax": 2000
  },
  "grid": { "nx": 40, "ny": 40, "nz": 20 },
  "values": "Float32Array — length nx×ny×nz, row-major (x, y, z)"
}
```

For `variable = "currents"`, two extra fields are included:
```json
{
  "velocityU": "Float32Array — eastward component (m/s)",
  "velocityV": "Float32Array — northward component (m/s)"
}
```

### `getInstrumentPlatforms(type, atTime?)`

`atTime` is the selected model frame. Synthetic sources generate relative to it;
real sources ignore it, because they exist when they were measured.

```json
[
  {
    "platformId": "1902673",       // WMO number for Argo
    "type": "argo",
    "real": true,                  // drives the "Argo GDAC" vs "Synthetic" badge
    "lat": 13.117,                 // latest surfacing, NOT where it profiled
    "lon": 68.550,
    "lastUpdate": "2024-06-22T14:06:00Z",
    "dataMode": "D",               // R real-time | A adjusted | D delayed
    "cycleCount": 18,
    "track": [{ "lat": 13.1, "lon": 68.5 }]
  }
]
```

`type` values: `"argo"` | `"glider"` | `"ctd"` | `"bgc"` | `"mooring"`

`trackStyle` decides rendering: `spline` for gliders (dense sawtooth dives),
`link` for floats (ten-day surfacings joined by an indicative line), `none`
for single casts.

### `getProfile(platformId, atTime?)`

Returns the cycle **nearest `atTime`**, so scrubbing the model date moves the
observations rather than pinning one profile.

```json
{
  "platformId": "1902673",
  "real": true,
  "cycle": 25,                     // Argo CYCLE_NUMBER: profiles since deployment,
                                   // NOT an index into `cycleCount`
  "dataMode": "D",
  "adjusted": true,                // were _ADJUSTED fields used?
  "lat": 13.117, "lon": 68.550,
  "timestamps": ["2024-06-22T14:06:00Z"],
  "pressureDbar": [0, 4.9, 10.1],  // as measured. Presence of this field makes
                                   // the chart axis read "Pressure (dbar)"
  "depths":       [0, 4.9, 10.1],  // display convenience, 1 dbar ~ 1 m
  "variables": {
    "temperature": [30.7, 30.7, 30.6],
    "salinity":    [36.4, null, 36.4]   // null = level rejected by QC
  },
  "salinityRejected": false,       // true when NO level survived QC
  "offsetMs": -237000000,          // signed offset from the model frame
  "cycleCount": 18,
  "attribution": "Argo data collected and made freely available by ..."
}
```

**`null` inside a variable array means the level was rejected by QC, and must
stay null.** The chart breaks the line at gaps and excludes nulls from the axis
range. Filling them with `0` draws fresh water that is not in the ocean, and
`Math.min` over an array containing `null` silently coerces it to `0`.

When `salinityRejected` is true the panel shows *"Salinity rejected by QC"* and
strikes through the variable button, rather than rendering an empty chart.

---

## 🔗 Connecting a real dataset or a live feed

Everything the frontend knows about data enters through **one file**,
`js/dataService.js`. Nothing in `scene.js`, `ui.js`, `charts.js` or `globe.js`
reads a URL or parses a payload. Swapping a source means changing a function
body there and nothing else — the Argo connector already proves this: it
replaced a mock generator without touching the renderer.

Three deployment shapes, in increasing order of effort.

### 1. Bundled snapshot (what ships today)

A script pulls data, applies QC, writes JSON, and the JSON is committed.

```
tools/fetch_argo.py  →  js/data/argo.json  →  dataService.js  →  UI
```

Right for a demo and for offline resilience: no network at runtime, so a bad
venue connection cannot break the app. Wrong for operations — the data is as old
as the last fetch.

### 2. REST backend (the realistic INCOIS deployment)

Stand a thin API in front of the NetCDF archive and replace the function bodies:

```js
// dataService.js — the only file that changes
export async function getModelField(variable, date, timestep) {
  const r = await fetch(`/api/model/${variable}/${date}/${timestep}`);
  if (!r.ok) throw new Error(`model field ${r.status}`);
  return r.json();                 // must match the contract above
}

export async function getProfile(platformId, atTime) {
  const r = await fetch(`/api/profiles/${platformId}?at=${encodeURIComponent(atTime)}`);
  return r.json();
}
```

A FastAPI service reading the archive with `xarray` is the natural fit, since
that is already how the model output is stored:

```python
@app.get("/api/model/{variable}/{date}/{timestep}")
def model_field(variable: str, date: str, timestep: str):
    ds = xr.open_dataset(ARCHIVE / f"{date}.nc")          # CF-compliant NetCDF
    da = (ds[variable]
          .sel(time=f"{date}T{timestep}", method="nearest")
          .sel(lon=slice(55, 95), lat=slice(-10, 25)))
    return {
        "variable": variable,
        "unit": da.attrs["units"],                        # from CF metadata
        "bounds": {...}, "grid": {...},
        "values": da.values.astype("float32").ravel().tolist(),
    }
```

**Send binary, not JSON, once grids get real.** The demo grid is 40×40×20 =
32,000 floats. An operational grid is easily 100× that, and JSON-encoding
float arrays roughly triples the bytes and costs a full parse. Return
`Float32Array` buffers (`application/octet-stream`) and read them with
`new Float32Array(await r.arrayBuffer())`.

### 3. Standards-based services (interoperability)

The problem statement asks for OGC WMS/WCS and CF conventions, which also means
the app can consume national and international portals without custom code:

| Protocol | Use | Notes |
|---|---|---|
| **OPeNDAP / THREDDS** | Subset NetCDF over HTTP without downloading whole files | Server-side `[start:step:stop]` slicing. INCOIS already runs a THREDDS-style Live Access Server |
| **OGC WMS** | Pre-rendered map tiles | Cheapest path to a 2D basemap layer; `ncWMS` sits directly on a THREDDS catalogue |
| **OGC WCS** | Raw coverage values, not pictures | The right choice for the 3D volume, since the renderer needs numbers |
| **ERDDAP** | Tabular observations with server-side filtering | What the bundled Argo already uses — `tools/fetch_argo.py` is a working ERDDAP client |

### Practical notes, learned building the Argo connector

Each of these cost real debugging time here and will recur.

- **CORS.** Browsers block cross-origin reads unless the server allows them.
  INCOIS-hosted services on the same origin are fine; third-party ERDDAP
  generally is not, which is why the fetch runs server-side.
- **Percent-encode `<` and `>`.** Tomcat rejects them raw in a request target
  with `400 Invalid character found` before ERDDAP ever sees the query.
- **Distinguish 404 from 400.** A 404 from ERDDAP means "valid query, no rows",
  which is a legitimate empty result. A 400 means the query is wrong. Treating
  them alike turns a typo in a column name into a silent "no data available".
- **Never skip QC.** In this domain 54% of Argo salinity levels and 100% of raw
  BGC chlorophyll levels are flagged bad. Unfiltered they render as dramatic
  false features that an oceanographer spots instantly.
- **Check the variable exists before requesting it.** `data_mode` is present in
  `ArgoFloats` and absent from `ArgoFloats-synthetic-BGC`; asking for it returns
  400, not an empty column.
- **Align time explicitly.** Real observations exist only when they were
  measured. Bound the date control to actual coverage and state each profile's
  offset from the model frame; see *Time* above.

### Ingesting new variables or instruments

Adding a source is one `PLUGIN_REGISTRY` entry (below) plus a fetch function.
Model variables are one entry in `VARIABLE_META`, including its `cfName` and
cmocean palette. Neither requires touching the renderer.

---

## 🔌 Adding New Data Sources (Plugin Registry)

The `PLUGIN_REGISTRY` array in `dataService.js` is the only thing you need to edit to add a new sensor type, ML-derived product, or data source. **Zero UI or scene code changes required.**

### Registry Entry Schema

```js
{
  id:               string,    // Unique key — matches the 'type' field in platform objects
  label:            string,    // Human-readable display name
  markerColor:      string,    // CSS hex — 3D sphere marker fill color
  glowColor:        string,    // CSS hex with alpha — glow ring color
  profileVariables: string[],  // Variables available in the profile chart
  trackStyle:       string,    // 'none' | 'spline' | 'line'
  fetchFn:          async fn,  // Returns Platform[] matching the contract above
}
```

### Example: Adding an HF Radar Source

```js
// In js/dataService.js — add ONE entry to PLUGIN_REGISTRY:
{
  id: 'hfradar',
  label: 'HF Radar',
  markerColor: '#fbbf24',
  glowColor:   '#fbbf2488',
  profileVariables: ['currents'],
  trackStyle: 'none',
  fetchFn: async () => {
    const r = await fetch('/api/platforms/hfradar');
    return r.json();
  },
},
```

That's it. The new source will automatically appear in the layers panel, render markers in the scene, support click-to-profile, and be toggled by the layer visibility checkbox.

**Current registry entries:**

| ID | Label | Marker | Track | Profile variables | Data |
|---|---|---|---|---|---|
| `argo` | Argo Floats | `--data-argo` | link | temperature, salinity | **real** |
| `glider` | Gliders | `--data-glider` | spline | temperature, salinity | synthetic |
| `ctd` | CTD Casts | `--data-ctd` | none | temperature, salinity | synthetic |
| `bgc` | BGC Floats | `--data-bgc` | link | chlorophyll | **real** |
| `mooring` | Moorings (stub) | `--data-mooring` | none | temperature, salinity | synthetic |

---

## 🏗️ Architecture Decisions

### Why No Framework?

The codebase is structured for **zero-cost migration** to React/Vue/Svelte later:
- `state.js` can be replaced with Zustand/Pinia/Svelte stores
- `ui.js` maps 1:1 to component event handlers
- `scene.js` is a pure singleton service that any framework can call
- `dataService.js` maps directly to a custom hook (`useModelField`, `useProfile`, etc.)

### Module Dependency Graph

```
main.js
├── scene.js
│   ├── three (CDN via importmap)
│   ├── three/addons/controls/OrbitControls.js (CDN)
│   ├── state.js
│   ├── dataService.js
│   │   ├── utils.js
│   │   └── constants.js        ← no deps (leaf node)
│   └── utils.js
│       └── constants.js
├── ui.js
│   ├── state.js
│   ├── dataService.js
│   ├── charts.js
│   │   ├── dataService.js
│   │   └── utils.js
│   └── utils.js
└── (error handling — direct DOM, no deps)
```

> `constants.js` is a leaf node with zero imports, breaking what would otherwise be a circular dependency between `dataService.js` and `utils.js`.

### CDN & ImportMap

Three.js is loaded via a **browser-native importmap** in `index.html`:

```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
  }
}
</script>
```

This resolves both your code's `import * as THREE from 'three'` **and** OrbitControls' internal bare `import { ... } from 'three'` — which would otherwise crash with `"Failed to resolve module specifier 'three'"`.

To upgrade Three.js: change the version string in these two URLs only.

---

## 🔧 Configuration Reference

### Adjusting the Geographic Domain

In `js/constants.js`:
```js
export const DOMAIN = {
  lonMin: 68, lonMax: 78,    // ← Change these for a different region
  latMin: 8,  latMax: 20,
  depthMin: 0, depthMax: 2000,
};
```

The globe patch, the volume box, marker placement, camera framing and the date
bounds all derive from this — nothing else needs editing. **But it also decides
which real observations exist:** `tools/fetch_argo.py` carries the same bounds
and must be re-run after a change.

Two things are derived rather than hardcoded so a domain change cannot silently
distort the scene:

- **`SCENE_W` / `SCENE_D`** scale from the domain's aspect ratio. Fixed values
  tuned for a 10×12 box stretch one axis when the domain changes, and the
  coastline stops matching the data drawn on it. Near the equator a degree of
  longitude and a degree of latitude are within ~1% of the same distance, so one
  scale factor serves both.
- **Camera distance** is computed from the box extents and field of view, not
  from tuned constants that clipped the box as soon as it grew.

Straddling the equator also means latitudes go negative, so positions and the
domain badge print hemispheres (`2.274°S`, `10°S–25°N`) rather than an
unconditional `°N`.

### Adjusting Grid Resolution

In `js/dataService.js` → `_generateModelField()`:
```js
const nx = 40, ny = 40, nz = 20;   // ← Match your real NetCDF grid dimensions
```

### Adjusting Scene Scale

In `js/constants.js`:
```js
export const SCENE_W = 10;  // X span in Three.js units (longitude)
export const SCENE_D = 12;  // Z span in Three.js units (latitude)
export const SCENE_H = 10;  // Y span in Three.js units (depth, pre-exaggeration)
```

### Adding a New Color Palette

In `js/utils.js` → `valueToColor()`:
```js
} else if (palette === 'your_palette_name') {
  // t is 0–1, compute r/g/b as 0–1 floats
  r = ...; g = ...; b = ...;
}
```

Then add it to the `<select id="ctrl-palette">` in `index.html`.

---

## 📋 Feature Checklist

| Feature | Status | Notes |
|---|---|---|
| 3D ocean box with labelled axes | ✅ | Lon / Lat / Depth |
| Sea surface heatmap | ✅ | Depth iz=0 slice |
| Domain-derived scene dimensions | ✅ | Aspect preserved when `DOMAIN` changes |
| Isosurface extraction | ✅ | Depth-of-threshold surface; no geometry where uncrossed |
| D26 preset | ✅ | 26 °C isotherm, 43–124 m in the bundled field |
| TCHP derived layer | ✅ | Fixed 0–160 kJ cm⁻² scale, threshold stated |
| Current vector glyphs | ✅ | Instanced, decimated, √-scaled, reference magnitude |
| Realistic thermocline in synthetic field | ✅ | Mixed layer + exponential, not a linear ramp |
| PNG export with provenance | ✅ | Variable, region, depth, time, scale and real-vs-synthetic |
| Hemisphere-aware coordinates | ✅ | `2.274°S`, not `-2.274°N` |
| Depth-slice draggable plane | ✅ | Controlled by depth slider |
| Longitudinal cross-section | ✅ | Mid-latitude vertical curtain |
| Latitudinal cross-section | ✅ | Mid-longitude vertical curtain |
| Current particle animation | ✅ | 3000 additive-blended sprites; auto-enabled on Currents |
| Animated water surface | ✅ | GPU vertex shader, toggleable, marked `decor` in the layer list |
| Argo float markers | ✅ | **Real** WMO floats, raycasted, profile on click |
| Glider spline tracks | ✅ | CatmullRom spline (synthetic source) |
| CTD cast markers | ✅ | Synthetic source |
| BGC float markers | ✅ | **Real** adjusted chlorophyll profiles |
| Mooring stub (plugin proof) | ✅ | Synthetic; proves the registry pattern |
| Click-to-profile panel | ✅ | Depth-vs-variable Canvas chart |
| Multi-variable profile toggle | ✅ | Per-platform; QC-depleted variables struck through |
| Platform metadata display | ✅ | WMO, cycle, data mode, adjusted/raw, levels, max pressure |
| Colorbar editor (palette) | ✅ | cmocean set + colour-vision-safe fallbacks |
| Colorbar editor (min/max) | ✅ | Live re-texture; limits fixed across the animation |
| Linear / Log scale toggle | ✅ | Colorbar is labelled `log₁₀` when active |
| Interior colorbar ticks | ✅ | Numeric values, not just endpoints |
| Vertical exaggeration stated on screen | ✅ | Badge with factor + domain bounds |
| Palette advisory | ✅ | Warns on `jet`; notes centring on diverging scales |
| Layer opacity slider | ✅ | Global across all heatmap planes |
| Vertical exaggeration slider | ✅ | Y-axis scale 1–20× |
| Layer visibility checkboxes | ✅ | Per-layer toggle |
| Timeline scrubber | ✅ | 4 time steps (00:00 / 06:00 / 12:00 / 18:00) |
| Timeline play/pause | ✅ | Auto-advances with accumulator |
| Timeline playback speed | ✅ | 0.5× / 1× / 2× / 4× |
| Sonar depth gauge dial | ✅ | Signature element, Canvas 2D |
| Colorbar legend | ✅ | Live gradient strip with units |
| Ambient particulate | ✅ | 1800 points, tinted to the water column |
| Bathymetry wireframe grid | ✅ | Ocean floor |
| WebGL2 graceful degradation | ✅ | Clear error message if unsupported |
| Visual error display | ✅ | No DevTools needed; errors shown on loading screen |
| Responsive layout (tablet) | ✅ | Panels collapse on ≤768px |
| No build step / no npm | ✅ | Open and run |
| Plugin registry | ✅ | Add sensor in 1 object, 0 other file changes |
| dataService backend seam | ✅ | One function body change per endpoint |
| Overview globe selector | ✅ | Procedural, embedded coastlines, no runtime fetch |
| Camera flight between views | ✅ | 1.15 s eased; explains the region-to-volume link |
| Drag-to-select area on globe | ✅ | LAS-style lat/lon box, raycast to the sphere |
| Volume re-renders the selection | ✅ | Field, markers, scene dims and badge all follow |
| Real Argo ingestion + QC | ✅ | Flags 1–2, whole-profile flags, adjusted vs raw by data mode |
| Real BGC chlorophyll | ✅ | `chla_adjusted` only; raw is overwhelmingly flag 3 |
| Pressure vs depth honesty | ✅ | Axis reads `Pressure (dbar)` for Argo, never metres |
| QC gaps preserved | ✅ | Nulls break the line; never filled with zero |
| Model/observation time offset | ✅ | Stated per profile, colour-graded, real and synthetic |
| Date bounded to real coverage | ✅ | Read from `argo.json`, not hardcoded |
| Provenance badge | ✅ | Real vs synthetic stated in chrome and per platform |
| Reduced-motion support | ✅ | Waves freeze, camera cuts instead of flying |
| Favicon + meta description | ✅ | Inline SVG data URI; cannot 404 |

---

## 🌐 Browser Support

| Browser | Version | Status |
|---|---|---|
| Chrome / Chromium | 89+ | ✅ Full support |
| Edge | 89+ | ✅ Full support |
| Firefox | 108+ | ✅ Full support |
| Safari | 16.4+ | ✅ Full support |
| Mobile Chrome | Latest | ⚠️ Works, performance varies |
| IE / Legacy Edge | Any | ❌ Not supported (no WebGL2 / importmap) |

> **WebGL2 is required.** The app shows a clear error message if WebGL2 is not available instead of crashing.

---

## 🌀 Disaster management: from visualisation to decision support

INCOIS's operational mandate is hazard warning — cyclones, storm surge, tsunami,
high waves, search and rescue. A 3D viewer is not itself a forecast. What it
does is make the *state the forecast depends on* legible fast, and let a
forecaster check the model against real instruments before acting on it. That
check is the point: an advisory is only as good as the ocean state behind it.

### What the current build already supports

These are not roadmap items; they work today and each maps to a real workflow.

| Capability | Operational use |
|---|---|
| Depth-resolved temperature volume | Read the **warm layer**, not just SST. Cyclone intensification depends on heat through the upper ocean, so a thin warm skin over cool water and a deep warm layer look identical from satellite SST and behave completely differently |
| Click-to-profile against the model field | Verify the model where an instrument actually measured. If the float and the model disagree at depth, the forecast inherits that error |
| Time offset stated on every profile | Prevents the most common false confirmation: reading a model frame and an observation days or years apart as agreement |
| QC enforcement and honest gaps | A warning issued on a float with a failed conductivity cell is a warning issued on noise |
| Depth-slice navigation | Inspect the thermocline depth that governs upwelling and mixed-layer response |
| Vertical exaggeration, stated on screen | The domain is ~1100 km wide and 2 km deep; without exaggeration the water column is invisible, and without the label the picture is misleading |

### Cyclone intensification — the clearest case

Tropical cyclone intensity in the Arabian Sea and Bay of Bengal is strongly
controlled by upper-ocean heat, not surface temperature alone. Two quantities
matter, and both are derivable from data this app already renders:

- **Depth of the 26 °C isotherm (D26)** — the conventional floor of the layer
  that can fuel a cyclone.
- **Tropical Cyclone Heat Potential (TCHP)** — heat integrated from the surface
  down to D26.

**Both are now implemented** — see [Derived layers](#-derived-layers-isosurface-d26-and-tchp).
D26 is an isosurface of the temperature volume; TCHP is a vertical integral of
it. Neither needed new data, only derived layers over the field already in
memory. What they still need to be *operational* is a real INCOIS forecast
underneath them rather than a synthetic field.

The Bay of Bengal adds a wrinkle the visualisation is well suited to: heavy
river discharge creates a fresh, buoyant surface layer that suppresses mixing
and keeps warm water at the surface. That is a **salinity-driven barrier layer**,
visible as a mismatch between the thermocline and the halocline. Co-viewing the
temperature and salinity volumes with float profiles is exactly how you see it.

### Other hazard workflows this shape of tool serves

- **Storm surge and coastal inundation.** Surge models are driven by winds,
  bathymetry and coastal geometry. The value here is rapid comparison of the
  forecast field against tide gauges and moorings, and communicating the result
  to district authorities who will not read a NetCDF file.
- **Search and rescue.** Drift prediction depends on surface currents. The
  current-vector layer plus particle advection is the visual form of a drift
  estimate; overlaying real drifter or float trajectories is the reality check.
  Real Argo tracks already render as surfacing sequences.
- **Tsunami.** Propagation is a separate model class and belongs with INCOIS's
  existing tsunami system. The contribution here is a common 3D frame in which
  wave arrival, bathymetry and coastal exposure can be shown to non-specialists
  during an event.
- **Harmful algal blooms and fisheries.** The BGC chlorophyll layer is the
  starting point; bloom detection needs a time series and a climatological
  baseline, not a single profile.
- **Marine heatwaves.** A heatwave is defined against a climatological
  percentile, so this needs a baseline the current build does not carry. With
  one, the `balance` diverging palette already exists for anomaly display.

### What is required to get there

Being concrete about the gap, in dependency order:

1. **Real model fields.** Everything above assumes the volume is an INCOIS
   forecast, not synthetic. This is the REST/OPeNDAP work above and is the
   single blocking dependency.
2. **Derived-layer pipeline.** D26, TCHP, mixed-layer depth and barrier-layer
   thickness computed server-side and exposed as ordinary variables, so they
   arrive through `VARIABLE_META` with no renderer changes.
3. ~~**Isosurface extraction.**~~ Done. Full marching cubes would still be
   needed for a field that is not monotonic in depth.
4. **Climatology.** Anomalies and marine-heatwave thresholds need a baseline
   period; without one, "unusually warm" cannot be stated.
5. **Forecast lead time and uncertainty.** Ensemble spread or a stated error
   bound. A single deterministic field shown without uncertainty invites more
   confidence than it earns — the same failure the QC and time-offset work
   already guards against elsewhere in this app.
6. **Alerting.** Threshold rules over derived layers (for example TCHP above a
   basin-specific value along a forecast track) feeding INCOIS's existing
   advisory channels. The visualisation supports the decision; it should not
   become an unreviewed automatic trigger.

### An honest limit

This is a visualisation and verification tool. It does not forecast, and
attaching a prediction to it would mean building and validating an ocean or
cyclone model — a different project with a different burden of proof. The value
it adds to disaster management is speed and correctness of interpretation:
faster reading of the ocean state, and fewer confident conclusions drawn from
data that was stale, unadjusted, or quality-flagged.

---

## 🔮 Future Roadmap

**Data**
- [x] Real Argo GDAC profiles with QC (16 floats, 517 profiles)
- [x] Real BGC chlorophyll from adjusted fields (16 floats, 343 profiles)
- [ ] Real NetCDF/OPeNDAP model fields — blocks everything in the hazard section
- [ ] Glider feed (data exists, no temporal overlap and no QC flags; see above)
- [ ] RAMA mooring feed (sites in domain; PMEL redirects to an unreachable mirror)
- [ ] CTD feed (reference dataset requires credentials)
- [ ] Climatological baseline for anomalies and marine-heatwave thresholds

**Rendering**
- [x] Isosurface extraction (depth-of-threshold surface, D26 preset)
- [ ] Full marching cubes, for fields that are not monotonic in depth
- [x] Derived layers: D26 and TCHP
- [ ] Mixed-layer depth and barrier-layer thickness
- [ ] WMS basemap overlay
- [ ] Time interpolation between model frames

**Platform**
- [ ] Binary array transport instead of JSON for full-resolution grids
- [ ] User authentication / session management
- [x] Export to PNG with provenance strip
- [ ] Video / animation recording
- [ ] Mobile touch gesture support

---

## 👤 Author

**Siddharth R**
- GitHub: [@siddharthr21](https://github.com/siddharthr21)

Built for INCOIS — Indian National Centre for Ocean Information Services.

---

## 📄 License

This project is open source. See [LICENSE](LICENSE) for details.

---

<div align="center">

Made with 🌊 for the Indian Ocean

</div>
