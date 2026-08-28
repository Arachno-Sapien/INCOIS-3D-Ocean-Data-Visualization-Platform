---
name: scientific-visualization
description: Making visual output scientifically defensible — colormap choice, diverging vs sequential scales, colorbars and units, consistent scaling across time, handling missing data honestly, uncertainty, annotation, and accessibility. Use this whenever choosing colors for a field, designing a legend or colorbar, plotting anomalies, comparing timesteps, or deciding how to display gaps and interpolated values. Apply it by default to any new visual layer, not only when someone asks about "design".
---

# Scientific Visualization Standards

A visualization of ocean data is a scientific claim. These rules keep it from making
claims the data does not support. Domain reviewers will notice violations immediately.

## Colormaps

**Never use jet or rainbow.** They introduce false boundaries where the perceived
lightness reverses, hide real gradients in the green band, and are unusable for
colorblind viewers. This is the fastest way to lose credibility with an oceanographic
audience.

Use perceptually uniform maps. `cmocean` is the domain standard and its names map
directly to variables:

| Field | Colormap | Type |
|---|---|---|
| Temperature | `thermal` | sequential |
| Salinity | `haline` | sequential |
| Chlorophyll | `algae` | sequential |
| Bathymetry / depth | `deep` | sequential |
| Current speed | `speed` | sequential |
| Anomalies, u/v components | `balance` or `delta` | diverging |
| Density | `dense` | sequential |

`viridis`, `magma`, and `cividis` are safe general-purpose fallbacks. `cividis` is
specifically designed for colorblind viewers.

## Sequential vs diverging

- **Sequential** for quantities with a natural low-to-high ordering and no meaningful
  midpoint — temperature, salinity, concentration.
- **Diverging** for quantities where zero (or a climatological mean) is meaningful —
  anomalies, vertical velocity, u/v components, differences between two runs.

A diverging map must be **centered on its neutral value**. An anomaly scale running
−1 to +4 with white at the arithmetic midpoint of the range implies a bias that is
not in the data. Set symmetric limits (±max|value|) or explicitly pin the neutral
point.

## Scale limits

- Fix limits across a time animation. Auto-scaling per frame makes a static field
  appear to pulse and destroys the ability to compare frames — the most common
  animation error.
- Fix limits across panels being compared side by side, and say so.
- Clip outliers by percentile (e.g. 2nd–98th) rather than letting one bad value
  flatten the whole range, and mark that the scale is clipped.
- State the limits numerically in the UI. "Blue to red" is not information.

## Colorbars

Every field needs a colorbar carrying:

- the variable name (`Sea water potential temperature`, not `thetao`)
- the units (`°C`, `PSU`, `m s⁻¹`)
- numeric tick values including the endpoints
- an explicit marker for the neutral value on diverging scales
- a distinct swatch or note for "no data"

If the scale is nonlinear (log for chlorophyll is common and appropriate), label it as
such — a log colorbar read as linear misstates magnitudes by orders of magnitude.

## Missing data

Land, below-bathymetry cells, and observation gaps are three different things and
should not all render as the same grey. At minimum, distinguish structurally-absent
(land/seafloor) from unmeasured. Never fill gaps with zero — zero is a valid
temperature and a valid velocity, and filling with it invents cold water and stagnant
flow.

Where values are interpolated rather than observed, indicate it — reduced opacity,
hatching, or a coverage overlay. This matters most for sparse in-situ data, where a
smooth interpolated field can imply coverage that does not exist.

## Vertical exaggeration

Always label the factor on screen (`Vertical exaggeration: 100×`). A 3D ocean view
without it is misleading by default, since the true aspect ratio is nearly flat.
Include a vertical scale bar in metres so the viewer can calibrate.

## Vectors and flow

- Decimate glyphs to a readable density; a glyph per grid cell becomes noise.
- Include a reference arrow with a stated magnitude (e.g. "→ 0.5 m/s").
- Scale glyph length nonlinearly (sqrt) if the speed range is wide, and say so.
- Animated particles convey pattern well but not magnitude — pair them with a speed
  colormap or a reference, never on their own.

## Accessibility

Roughly 8% of male viewers have a colour vision deficiency. Perceptually uniform maps
are largely safe; verify anything custom with a simulator. Never rely on colour alone
to distinguish categories — add shape, pattern, or direct labels. Maintain adequate
contrast for text and axes over the field.

## Provenance on screen

Any exported figure or screenshot should carry: dataset/product name, variable,
depth, timestamp with timezone (UTC unless stated), region, and units. Screenshots
travel far beyond the person who made them, and an unlabelled ocean field is
unusable evidence.

## Sanity checks before shipping a layer

- Do the values fall in a physically plausible range? Sea surface temperature outside
  roughly −2 to 35 °C, or salinity outside 0–42 PSU, means a units or scaling bug.
- Do the patterns match known features — western boundary currents, the seasonal
  monsoon reversal in the northern Indian Ocean, thermocline depth?
- Does the field flip when the colormap is inverted in a way that changes the story?
  If so, the scale is doing too much work.
