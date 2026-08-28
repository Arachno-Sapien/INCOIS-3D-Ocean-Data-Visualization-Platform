---
name: geospatial-ocean
description: Converting between geographic coordinates (lat/lon/depth, WGS84) and 3D scene coordinates, plus bounding boxes, projections, the antimeridian, bathymetry, vertical exaggeration, distances, and spatial interpolation. Use this whenever code touches latitude, longitude, depth-to-Y mapping, EPSG codes, map projections, bbox parsing, great-circle distance, or placing anything at a geographic position in the 3D scene — including seemingly trivial cases like "put a marker where the float is".
---

# Geospatial Handling for the Ocean Platform

Three coordinate spaces are in play and every bug in this layer comes from confusing
two of them:

```
geographic (lat°, lon°, depth m, WGS84)
        ↓  projection / local tangent mapping
metric   (x m, y m, z m, some local frame)
        ↓  scene scale + vertical exaggeration
scene    (Three.js units, Y up)
```

Write the conversion once, in one module, in both directions, and use it everywhere.
Two independent implementations will drift and produce markers offset from the field
they annotate.

## Choosing the horizontal mapping

- **Regional domain** (a basin, e.g. the Arabian Sea / Bay of Bengal, up to a few
  thousand km): equirectangular with a cosine-latitude correction is accurate enough
  and keeps the math trivial.

  ```
  x = (lon - lon0) * 111320 * cos(radians(lat0))
  y = (lat - lat0) * 110540
  ```

  Use a fixed reference latitude `lat0` at the domain centre, not per-point cosine,
  or straight grid lines will bend.

- **Global domain**: either project to ECEF on the WGS84 ellipsoid and render a
  globe, or accept a plate carrée map and be explicit about the distortion. Web
  Mercator (EPSG:3857) is a poor fit here — it fails above ~85° latitude and grossly
  distorts area at high latitudes, which matters for polar ocean data.

Record the chosen `lat0`, `lon0`, and scale in the scene metadata so the inverse
transform (picking a screen position back to lat/lon for readouts) uses the same
constants.

## Depth to scene Y

```
sceneY = -(depth_m / metersPerSceneUnit) * verticalExaggeration
```

with depth positive downward. Keep the negation in this one function so nothing
downstream has to remember the sign.

Exaggeration between 50× and 500× is normal given ~5 km of depth against thousands of
km of horizontal extent. It must be:

- applied consistently to the field, isosurfaces, tracks, bathymetry, and axes,
- displayed in the UI as a numeric factor, and
- excluded from any distance, gradient, or slope computation. Gradients computed in
  exaggerated space are physically meaningless; compute them in metric space and
  visualize the result.

## Bounding boxes

Standardize on one order and enforce it at the API boundary. `[west, south, east, north]`
matches OGC and GeoJSON; `[minLat, minLon, maxLat, maxLon]` also occurs in the wild.
Whichever is chosen, validate on arrival:

- south < north, and both within [−90, 90]
- west/east within the declared longitude convention
- a bbox where west > east means it crosses the antimeridian, which is legal — not an
  error to reject

## The antimeridian

A request spanning 180° must be split into two subsets and concatenated. Polygons
crossing it must be split or they render as a band wrapping the wrong way around the
world. This is the single most common source of "why is there a stripe across the
Pacific" artifacts. Test it explicitly.

The poles are the other special case: longitude is degenerate there, and grid cells
converge. Guard against division by `cos(lat)` at ±90°.

## Distances

Never use Euclidean distance on degrees. For distances, use the haversine formula
(fine to ~0.5% error) or `pyproj.Geod.inv` for geodesic accuracy. Grid cell area
varies with latitude — any spatial mean must be area-weighted:

```python
weights = np.cos(np.deg2rad(ds.lat))
ds.weighted(weights).mean(dim=["lat", "lon"])
```

An unweighted mean over a lat/lon grid over-weights high latitudes. This is a
quietly wrong result, not a crash.

## Vector components

Ocean current `u`/`v` are eastward/northward in **m/s**, not degrees per unit time.
Converting to a displacement in degrees for particle advection:

```
dlon = u * dt / (111320 * cos(radians(lat)))
dlat = v * dt / 110540
```

The `cos(lat)` term is required — omitting it makes particles at high latitude move
far too slowly in longitude, which looks like a plausible circulation pattern rather
than a bug. Also confirm whether the product's `u`/`v` are on the same grid points as
the scalars or staggered (Arakawa C-grid), in which case they need interpolating to
cell centres before glyph placement.

## Bathymetry

GEBCO is the usual global source. When rendering the seafloor:

- Apply the same vertical exaggeration as the data volume.
- Match the bathymetry mask to the data's land mask, or the field will appear to
  extend into rock.
- Downsample to display resolution; full-resolution GEBCO is far more triangles than
  a browser needs, and the visual difference at typical zoom is negligible.

## Spatial interpolation

Interpolating a field near a coastline mixes water values with land fill and produces
warm/fresh artifacts hugging the shore. Always mask first, interpolate second, and
re-mask. The same applies vertically near the seafloor.

For irregularly spaced observations (Argo, gliders, CTD casts) do not treat them as a
grid. Interpolate with an explicitly chosen method — nearest-neighbour, inverse
distance weighting, or objective analysis — and state which one was used on screen,
because the choice changes the picture materially.

## Precision

Float32 gives roughly 1 m precision on degrees at typical magnitudes, which is fine
for display. Keep positions in float64 through all computation and only cast to
float32 at the point of GPU upload.
