---
name: ogc-services
description: Consuming and exposing standards-based geospatial services — OGC WMS, WMTS, WCS, WFS, OGC API Environmental Data Retrieval, OPeNDAP/THREDDS, and ERDDAP — plus writing CF-compliant NetCDF output. Use this when integrating an external data server, when the problem statement or spec asks for OGC/WMS/WCS compliance, when building an interoperable endpoint, or when deciding between fetching tiles and fetching raw arrays.
---

# OGC Services and Interoperability

The INCOIS-style problem space expects standards compliance, not a bespoke API only
this frontend can talk to. Standards compliance is also usually an explicit scoring
criterion, so treat it as a requirement rather than a nice-to-have.

## Which protocol for which job

| Need | Use | Returns |
|---|---|---|
| A pre-rendered map image / basemap overlay | WMS `GetMap`, or WMTS for cached tiles | PNG/JPEG |
| The actual numeric values for client-side rendering | WCS `GetCoverage`, OPeNDAP, or ERDDAP `griddap` | NetCDF / binary |
| Vector features (boundaries, EEZ, stations) | WFS / OGC API – Features | GeoJSON |
| Point, vertical-profile, or trajectory queries | OGC API – EDR | JSON / CoverageJSON |
| Discovering what a server holds | `GetCapabilities` / `/collections` | XML / JSON |

The important distinction: **WMS gives pixels, WCS/OPeNDAP gives numbers.** Volumetric
rendering, isosurfaces, and any client-side colormap change need numbers. WMS is
appropriate for basemaps and for a quick 2D overlay, not as the data source for the
3D layer.

## Reading capabilities before hardcoding

Always fetch `GetCapabilities` (or the OGC API `/collections` document) and read it,
rather than assuming layer names, CRS support, or available time steps. It gives:

- exact layer/coverage names, which are rarely what documentation suggests
- supported CRS list — do not request EPSG:4326 from a server that only offers 3857
- the time dimension's actual extent and step, often an ISO 8601 interval like
  `2026-01-01/2026-08-26/P1D`
- the elevation/depth dimension and its units and sign
- supported output formats

Cache the parsed capabilities; it is a slow, large document and it changes rarely.

## OPeNDAP and THREDDS

THREDDS servers expose datasets over OPeNDAP, which xarray reads directly:

```python
ds = xr.open_dataset("https://server/thredds/dodsC/path/file.nc", chunks={})
```

This is lazy — only the requested slices transfer. That makes it excellent for
server-side subsetting and terrible if a `.values` on a full array slips through, at
which point it silently downloads gigabytes over HTTP.

Practical notes: OPeNDAP has request size limits and will return a cryptic error when
exceeded, so chunk large reads; connections are slow to establish, so reuse the open
dataset; and the server may be down, so handle failure with a clear 503 rather than a
traceback.

## ERDDAP

ERDDAP is common for ocean observation data and easier to work with than raw THREDDS.
Its `griddap`/`tabledap` URLs encode the subset directly and it will return CSV, JSON,
NetCDF, or GeoJSON by changing the file extension in the URL. Build these URLs
programmatically with proper encoding rather than string concatenation, and respect
the server's rate limits — public ERDDAP instances will throttle a scraping pattern.

## OGC API – EDR

EDR is the modern standard designed for exactly this use case: querying environmental
data at a position, along a corridor, over an area, or down a vertical profile. Its
query types (`/position`, `/area`, `/cube`, `/trajectory`, `/vertical_profile`) map
almost directly onto the frontend's needs, and implementing it makes the backend
interoperable with other clients for far less work than a full WCS implementation.

If the choice is between implementing WCS properly and implementing EDR properly, EDR
is usually the better use of effort — while still exposing WMS for basemap-style
overlays.

## Exposing standards-compliant endpoints

If the deliverable includes a compliant service:

- Serve a real `GetCapabilities` / `/collections` document with accurate extents,
  generated from the datasets rather than hand-written, so it cannot drift.
- Honour the standard parameter names exactly (`bbox`, `time`, `crs`, `datetime`) —
  a near-miss spelling defeats the point of the standard.
- Use ISO 8601 for all times, in UTC, including intervals and periodicity.
- Support `bbox` crossing the antimeridian.
- Return standard error documents with the standard exception codes.

Test against a real client (QGIS reads WMS/WCS/WFS well) rather than only against the
project's own frontend. A service only this frontend can consume is not interoperable,
and QGIS will surface spec violations immediately.

## CF-compliant output

Any NetCDF written out should carry:

- `Conventions = "CF-1.8"` (or later)
- `standard_name`, `long_name`, and `units` on every variable, with units in
  UDUNITS-parseable form (`m s-1`, not `m/s²` prose)
- coordinate variables with `axis` attributes (`X`, `Y`, `Z`, `T`)
- `positive = "down"` on a depth coordinate
- time as `units = "seconds since 1970-01-01T00:00:00Z"` with a stated `calendar`
- `_FillValue` matching the actual fill used
- global provenance: `title`, `institution`, `source`, `history`, `references`

Validate with the CF checker rather than assuming compliance. Non-compliant output
will be rejected by downstream tooling in ways that are hard to diagnose later.
