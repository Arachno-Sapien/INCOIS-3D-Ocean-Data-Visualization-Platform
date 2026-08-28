---
name: argo-glider
description: Working with in-situ ocean observations — Argo float profiles, glider dives, CTD casts, moorings and drifters. Covers QC flags, adjusted vs raw variables, data modes, ragged profile arrays, platform identifiers, trajectory reconstruction, and rendering tracks and profiles in 3D. Use this for anything involving profiles, floats, WMO numbers, PSAL/TEMP/PRES, QC filtering, or plotting observation locations and dives — including "just show the float positions", since unfiltered observation data contains values that are known to be wrong.
---

# Argo, Glider, and In-Situ Observation Data

Gridded model output and in-situ observations behave completely differently.
Observations are sparse, irregular in space and time, and carry quality information
that is not optional to apply.

## Quality control is mandatory

Every Argo measurement has a per-level QC flag. The scale:

| Flag | Meaning | Use |
|---|---|---|
| 1 | Good | yes |
| 2 | Probably good | yes |
| 3 | Probably bad / correctable | no (display only if flagged as suspect) |
| 4 | Bad | never |
| 5 | Value changed | yes (adjusted) |
| 8 | Interpolated | only if labelled as interpolated |
| 9 | Missing | never |

Default filter: keep flags 1 and 2. Never plot unfiltered profiles — bad Argo levels
include salinity spikes and pressure inversions that will appear as dramatic false
features and will be spotted instantly by anyone in the field.

Filter on the per-level flag (`TEMP_QC`, `PSAL_QC`) as well as the whole-profile flag
(`PROFILE_TEMP_QC`); a profile can be broadly fine with a handful of bad levels.

## Adjusted vs raw

Argo variables come in pairs: `TEMP`/`TEMP_ADJUSTED`, `PSAL`/`PSAL_ADJUSTED`, plus
`_ADJUSTED_ERROR`. `DATA_MODE` says which to trust:

- `R` (real-time) — only raw is available; automated QC only.
- `A` (adjusted) — real-time adjustment applied.
- `D` (delayed) — expert-checked; `_ADJUSTED` is authoritative.

Rule: use `_ADJUSTED` when it exists and is not fill; fall back to raw otherwise, and
record which was used. Salinity drift correction in delayed mode is often larger than
the signal being studied, so this choice materially changes results. Surface the data
mode in the UI when a user inspects a profile.

## Ragged arrays

Profile files are dimensioned `(N_PROF, N_LEVELS)` where `N_LEVELS` is the maximum
across profiles — shorter profiles are padded with fill values. Naive statistics
across `N_LEVELS` therefore average in padding.

Always mask by the fill value or the QC flag before any reduction. Levels are also
irregularly spaced and differ between profiles, so profiles cannot be stacked into a
grid without interpolating onto common depth levels first — and that interpolation
must not extrapolate past a profile's deepest valid level.

## Pressure, depth, and units

Argo reports **pressure in decibars**, not depth in metres. The approximation
1 dbar ≈ 1 m is adequate for display; for anything quantitative use a proper
conversion accounting for latitude (`gsw.z_from_p`). Do not silently relabel dbar as
metres in a UI axis.

Practical salinity (PSU) and conservative temperature/absolute salinity (TEOS-10) are
different quantities. If mixing observations with model output, check which convention
each uses; `gsw` handles the conversions.

## Identifiers

- Argo floats are identified by **WMO number** (`PLATFORM_NUMBER`), with `CYCLE_NUMBER`
  incrementing per profile. WMO + cycle is the unique key for a profile.
- Gliders use deployment-specific identifiers with no universal registry; carry the
  operator and deployment name.
- A float's position is where it surfaced, which is not exactly where it profiled — it
  drifts during ascent. Do not present positions as more precise than they are.

Use `argopy` for access rather than hand-rolling GDAC index parsing; it handles the
index files, caching, and the `xarray` conversion.

## Trajectories

A float track is an ordered sequence of surfacings, typically ten days apart. Drawing
straight lines between them implies a path the float did not take — style the
connection as an indicative link, and make the actual surfacing points the visually
dominant element.

Glider tracks are the opposite case: dense sawtooth dives, hundreds of profiles over
days, with real horizontal motion between them. Rendering every point is both slow
and unreadable; decimate for the track line and keep full resolution for the profile
view.

## Rendering in the 3D scene

- Position markers with the shared conversion from the `geospatial-ocean` skill so
  observations align with the field they sit in. Applying vertical exaggeration to the
  field but not to the tracks is the classic misalignment bug.
- Use one `InstancedMesh` for markers, not one `Mesh` per observation — deployments
  run to thousands of profiles.
- Colour profile points by the same colormap and same scale limits as the volume, so
  an observation can be compared against the model field by eye. Different scales for
  the same variable make the comparison meaningless.
- Make points pickable and show, on selection: platform id, cycle, timestamp, position,
  data mode, and the profile plot itself.

## Time handling

Observations are irregular in time; there is no timestep to snap to. When the user
selects a model timestep, show observations within a stated window (e.g. ±3 days) and
display the window. Silently showing "nearby in time" observations without saying how
near invites a false comparison.

## Sanity checks

Before shipping an observation layer, verify: no positions on land, no pressures
increasing then decreasing within a profile, salinity within roughly 0–42 PSU,
temperature within roughly −2 to 35 °C, and timestamps not in the future. Each of
these catches a distinct real-world data defect.
