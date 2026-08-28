---
name: testing
description: Testing strategy for a scientific visualization stack — synthetic xarray fixtures, coordinate round-trip tests, numerical tolerance, API contract tests, WebGL and shader testing, and the edge cases that actually break ocean software (antimeridian, descending latitude, all-NaN blocks, single-level depth). Use when writing or reviewing tests, when a bug is found and needs a regression test, and when deciding what is worth testing in code where the output is a picture.
---

# Testing the Ocean Platform

The hard part here is that much of the output is visual, and visual output is
expensive to assert on. The strategy is to push correctness down into testable
layers — coordinate transforms, subsetting, unit handling, API contracts — and test
the rendering layer only where it can be done cheaply and deterministically.

## What to test, in priority order

1. **Coordinate transforms.** Cheap, deterministic, and the source of the worst bugs.
   Round-trip every conversion: `scene(geo(x)) == x` within tolerance, for points
   including the antimeridian, the equator, high latitude, the surface, and the
   deepest level.
2. **Data ingestion and subsetting.** Given a known synthetic dataset, does a bbox
   request return exactly the expected cells with the expected values?
3. **API contracts.** Status codes, response shape, headers, and the size limit.
4. **Physical invariants.** Values in plausible ranges, masks preserved, units
   converted correctly.
5. **Rendering.** Last, and selectively — see below.

## Build synthetic fixtures, do not ship data files

A test suite depending on a 2 GB NetCDF file is a test suite nobody runs. Construct
datasets in code with known analytic values, so expected results can be computed
rather than eyeballed:

```python
import numpy as np, xarray as xr, pytest

@pytest.fixture
def synthetic_ocean():
    lat = np.linspace(-10, 30, 41)
    lon = np.linspace(60, 100, 41)
    depth = np.array([0., 10., 50., 100., 500., 1000.])   # deliberately uneven
    time = xr.cftime_range("2026-08-01", periods=5, freq="D")
    temp = (30 - 0.02 * depth[None, :, None, None]
              - 0.1 * np.abs(lat)[None, None, :, None]
              + 0 * lon[None, None, None, :])
    temp = np.broadcast_to(temp, (5, 6, 41, 41)).copy()
    temp[:, :, :5, :5] = np.nan                            # a land block
    return xr.Dataset(
        {"thetao": (("time", "depth", "lat", "lon"), temp,
                    {"units": "degC", "standard_name": "sea_water_potential_temperature"})},
        coords={"time": time, "depth": ("depth", depth, {"positive": "down"}),
                "lat": lat, "lon": lon},
        attrs={"Conventions": "CF-1.8"},
    )
```

Then parameterize variants of it — descending latitude, 0–360 longitude, a single
depth level, an all-NaN timestep — because each of these is a real product that
exists somewhere.

## The edge cases that actually break things

Write an explicit test for each; these are not hypothetical:

- Latitude in **descending** order (slices silently return empty)
- Longitude in **0–360** (a request for −20° matches nothing)
- A bbox **crossing the antimeridian** (west > east)
- A region that is **entirely land** (all-NaN result — must return an empty-but-valid
  response, not a 500)
- A **single depth level** dataset (code that assumes nz > 1 for gradients)
- **Non-uniform depth spacing** (index-space interpolation gives wrong answers)
- A **non-standard calendar** (`360_day`, `noleap` — breaks `.dt` and pandas)
- A request **outside the dataset domain** in space or time
- A request **larger than the size cap**
- **Unit mismatch** — a file in Kelvin where the code assumes °C

## Numerical assertions

Never use `==` on floats. Use `np.testing.assert_allclose` with an explicit tolerance
chosen for the physical quantity: temperature to 0.01 °C is meaningful, to 1e-12 is
not. Where float32 casting happens for GPU upload, assert against float32 tolerance,
not float64.

For interpolation, assert properties rather than exact values where possible: the
result at an existing grid point equals the original, the result never exceeds the
local min/max of its neighbours, and the mask is preserved.

## API tests

Use `TestClient` with the dataset dependency overridden to the synthetic fixture, so
tests run without any real file:

```python
app.dependency_overrides[get_dataset] = lambda: synthetic_ocean
```

Cover: a valid request returns 200 with the declared shape in the header and a payload
of exactly `prod(shape) * 4` bytes; an invalid bbox returns 422; an oversized request
returns 413 with the limit in the message; an unknown variable returns 404; and CORS
preflight succeeds for an allowed origin and fails for a disallowed one.

## Testing WebGL and shaders

Pixel-comparison tests against a reference screenshot are famously flaky — driver,
GPU, and antialiasing differences produce false failures and get disabled within
weeks. Prefer, in order:

1. **Extract the math.** Colormap lookup, normalization, ray/box intersection, and the
   depth-to-Y mapping can be implemented in plain JS/TS, unit-tested exhaustively, and
   mirrored in GLSL. Test the JS version.
2. **Assert on state, not pixels.** After a data load, assert that the texture has the
   expected dimensions and format, that the uniforms hold the expected min/max, that
   `renderer.info.memory` reflects the expected allocations, and that a dataset swap
   returns the counts to baseline (leak test).
3. **Smoke-test with Playwright.** Load the page, wait for a "ready" signal the app
   emits, assert no console errors and no WebGL context loss, and assert that the
   canvas is not uniformly blank. That catches catastrophic breakage without
   asserting on appearance.
4. **Visual review by a human** for anything about whether the picture is right.

If pixel comparison is used at all, restrict it to small crops with a generous
per-pixel tolerance, and run it on one pinned browser image only.

## Regression discipline

Every bug fixed gets a test reproducing it first. Ocean data bugs recur, because the
next product arrives with a different convention and re-triggers the same assumption.

## Performance guards

Add a lightweight assertion that a representative subset request stays under a time
budget, and that a fixture load stays under a memory budget. These catch the
accidental `.compute()` on a full array or the missing `.dispose()` far earlier than
noticing a slow demo the night before a deadline.
