---
name: netcdf-xarray
description: Reading, subsetting, and validating scientific ocean datasets — NetCDF, HDF5, Zarr, GRIB — with xarray, Dask, and CF conventions. Use this for anything involving ds/xr code, .nc files, coordinates, dimensions, _FillValue, scale_factor, time decoding, depth axes, chunking, lazy loading, regridding, or preparing gridded data for the renderer. Trigger it even when the request sounds simple, like "load the temperature file" or "cut this to the Arabian Sea" — the failure modes here are silent and produce plausible-looking wrong numbers.
---

# NetCDF / xarray for Ocean Data

This data is not generic JSON. It carries metadata that determines whether the
numbers mean anything, and ignoring that metadata produces output that renders fine
and is scientifically wrong.

## Always inspect before computing

On first contact with any new file or product, print and read:

```python
import xarray as xr
ds = xr.open_dataset(path, chunks={})   # chunks={} = lazy, Dask-backed
print(ds)                                # dims, coords, data_vars, dtypes
print(ds.attrs)                          # global: Conventions, institution, source
for name, v in ds.variables.items():
    print(name, v.dims, v.attrs)         # units, standard_name, _FillValue, positive
```

Specifically confirm, every time:

- **Dimension order.** `(time, depth, lat, lon)` is common but not guaranteed. Index
  by name (`ds.sel`, `ds.isel(time=0)`), never by positional axis number.
- **Coordinate monotonicity and direction.** Latitude descending is common in model
  output. `ds.sel(lat=slice(8, 20))` silently returns an empty array if latitude runs
  20→8. Check `ds.lat[0] < ds.lat[-1]` and build slices accordingly, or `.sortby()`.
- **Longitude convention.** 0–360 and −180–180 both occur, sometimes across files in
  the same product.
- **Depth sign and direction.** Read the `positive` attribute. `positive: "down"`
  means depth values increase downward and are usually positive. Some model files use
  `z` increasing upward with negative values. Never assume.
- **Units.** Temperature may be °C or K. Salinity is usually PSU/dimensionless, but
  check. Currents in m/s vs cm/s differ by 100×, which looks like a plausible eddy
  field rather than an obvious error.
- **Calendar and epoch.** `days since 1950-01-01` with a `360_day` or `noleap`
  calendar is normal in ocean modelling; those decode to `cftime` objects, not
  `numpy.datetime64`, and will break `.dt` accessors and pandas interop.
- **CRS / geospatial metadata.** Grid may be curvilinear (2D lat/lon arrays), not
  rectilinear. If `ds.lat.ndim == 2`, ordinary `.sel` on lat/lon does not apply.

## Never assume

- depth is positive downward
- coordinates are equally spaced (many products stretch vertical levels)
- time is ISO-8601
- longitude is −180…180
- the grid is rectilinear
- missing data is NaN already
- the file is CF-compliant just because it is NetCDF

## Fill values, scaling, masking

`xr.open_dataset` applies `mask_and_scale=True` by default: it applies
`scale_factor`/`add_offset` and converts `_FillValue`/`missing_value` to NaN, which
also promotes integer arrays to float. Keep it on unless there is a specific reason
not to, and if it is turned off, do the conversion explicitly.

Two distinct kinds of "no data" exist and should stay distinguishable: land/below-
bathymetry (structurally absent, permanent) and observation gaps (temporarily
missing). Carry a mask rather than collapsing both to NaN when the distinction
matters downstream.

Before sending anything to the browser, replace NaN with an in-range sentinel plus a
validity mask — NaN does not survive GPU linear filtering (see `threejs-ocean`).

## Longitude normalization

```python
# 0..360 -> -180..180
ds = ds.assign_coords(lon=(((ds.lon + 180) % 360) - 180)).sortby("lon")
```

Do this once at ingest and record which convention the API speaks. Requests spanning
the antimeridian need two subsets concatenated — handle it explicitly rather than
letting the slice return nothing.

## Subsetting

```python
sub = ds["thetao"].sel(
    latitude=slice(lat_min, lat_max),
    longitude=slice(lon_min, lon_max),
    depth=slice(0, 500),
    time="2026-08-20",
)
```

- `.sel` is label-based, `.isel` is positional. Mixing them up is a classic
  off-by-a-whole-ocean bug.
- `method="nearest"` with a `tolerance` for point queries; without a tolerance a
  request far outside the domain silently snaps to the nearest edge cell.
- Slice bounds are inclusive of both endpoints in xarray, unlike Python slicing.

## Lazy loading and Dask

Open with `chunks=` so nothing loads until needed. Align chunks with the file's
internal HDF5 chunking where possible — cross-cutting chunks force reading the whole
file per request. Inspect with `ds["thetao"].encoding["chunksizes"]`.

Rules of thumb:

- Chunk sizes in the 10–100 MB range; thousands of tiny chunks cost more in scheduler
  overhead than they save.
- Use `open_mfdataset` for time series across files, with `combine="by_coords"` and
  an explicit `chunks`; it is slow to open, so cache the result.
- Call `.compute()`/`.load()` exactly once, at the last possible moment, on data
  already subset to what is needed. `.values` on a full 4D array is how a laptop runs
  out of RAM.
- Never call `.compute()` inside a loop over timesteps.

## Interpolation and regridding

`.interp()` handles linear interpolation onto new coordinates and is fine for modest
regridding. It does **not** understand land masks — it will interpolate across a
coastline and invent water where there is none. Mask before and after, or use
conservative regridding (`xesmf`) when fluxes/means must be preserved.

For vertical interpolation onto fixed depth levels, remember that level spacing is
usually non-uniform and much finer near the surface; linear interpolation in index
space is wrong, interpolation in depth space is right.

## Serving to the frontend

Convert to a browser-friendly form at the API boundary, not in the browser:

- Subset → cast to `float32` (or `float16` for display-only fields) → send as raw
  binary, not JSON. JSON-encoding a million floats is roughly 10× the bytes and
  orders of magnitude slower to parse.
- Send the array's shape, dtype, coordinate vectors, min/max, units, and fill
  sentinel as a small JSON header alongside the binary payload.
- Consider Zarr as the storage format for anything served repeatedly — it is chunked,
  compressed, and readable directly over HTTP range requests.

## Provenance

Preserve `attrs` through processing steps (`keep_attrs=True` on operations that drop
them) and record the source file, variable, and processing steps in the output. When
a plot looks wrong, provenance is the difference between a five-minute fix and a
day of guessing.
