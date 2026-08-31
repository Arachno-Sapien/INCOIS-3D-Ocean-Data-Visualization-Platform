#!/usr/bin/env python3
"""
Fetch the real gridded model field for the domain and write js/data/model.json.

Source: INCOIS ERDDAP — an objective analysis of Argo profiles onto a regular
grid, produced and served by INCOIS itself. Free, no credentials, no
registration. Two analyses of the same profiles are available on an identical
grid; see DATASETS below for why the variational one is the default.

Run this to refresh the bundled field:

    python tools/fetch_model.py                       # the last six months
    python tools/fetch_model.py --start 2024-05-10 --end 2024-06-10
    python tools/fetch_model.py --max-frames 4 --with-error
    python tools/fetch_model.py --dataset mccreary        # the other analysis
    python tools/fetch_model.py --check               # verify the written file
    python tools/fetch_model.py --validate-d26        # cross-check vs INCOIS D26

The output is committed so the app needs no network at runtime, exactly as
`tools/fetch_argo.py` does for the observations. None of these hosts send
`Access-Control-Allow-Origin`, so a browser cannot fetch them directly however
much one would like it to — the snapshot is not laziness, it is the only shape
that works without standing up a proxy.

WHY THIS DATASET
----------------
These are the only credential-free sources that are simultaneously:
  * 4D — longitude, latitude, 24 depth levels, time — so it fills the volume
    the renderer draws, not just a surface;
  * covering 30.5-119.5E / -29.5-29.5N, which contains the whole app domain;
  * current, to within about a month of today;
  * INCOIS's own product, which is the institution the problem statement names.

WHAT THIS SCRIPT ENFORCES
-------------------------
1. The depth axis is carried through as measured. It is NOT evenly spaced —
   5, 10, 20, 30, 50, 75, 100 ... 1800, 2000 m — and every consumer that
   integrates or indexes over depth must use these numbers. Assuming an even
   axis puts the top layer at 87 m instead of 5 m and inflates the heat-content
   integral by more than an order of magnitude.
2. Land and no-data cells stay null. ERDDAP returns null for them and about a
   quarter of the domain is land or unanalysed; substituting 0 would draw a
   coastline made of ice water and drag every colour scale with it.
3. Range checks per variable, counted and reported, on the same principle as
   the Argo fetcher: a value outside the physically possible band is a defect
   in the pipeline, not an interesting measurement.
4. The grid is rebuilt from the coordinate columns rather than trusting the row
   order of the response. ERDDAP does emit longitude-fastest today; a silent
   change to that would otherwise transpose the ocean without erroring.
5. Values are rounded to the precision the analysis actually carries. The
   product's own RMSE field is a few tenths of a degree, so storing six decimal
   places would be recording noise at four times the file size.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://erddap.incois.gov.in/erddap/griddap"

# Two INCOIS analyses of the same Argo profiles, on an identical grid: 1 degree,
# the same 24 levels, the same domain, the same ten-day cadence. They differ in
# method and, materially, in how much of the basin they resolve — over the app
# domain the variational analysis fills 82% of cells against McCreary's 67%,
# and the McCreary gaps are not bathymetry: they are identical at 5 m and
# 1800 m, and sit in open water thousands of metres deep. Hence the default.
DATASETS = {
    "vam": {
        "id": "incois_argo_10d_VAM",
        "label": "variational analysis",
        "vars": {"temperature": ("TEMP", "TERR"), "salinity": ("SAL", "SERR")},
    },
    "mccreary": {
        "id": "incois_argo_10day_McCreary",
        "label": "Kessler-McCreary objective analysis",
        "vars": {"temperature": ("T_ANALYZED", "T_RMSE"),
                 "salinity": ("S_ANALYZED", "S_RMSE")},
    },
}
DEFAULT_DATASET = "vam"

# INCOIS's own derived products, used only by --validate-d26. Computed
# independently of either analysis above, so agreement with it means something.
VALUE_ADDED = "incois_valueadded_products_datasets"

# Must match DOMAIN in js/constants.js (and LON_MIN/LAT_MIN in fetch_argo.py)
LON_MIN, LON_MAX = 55.0, 95.0
LAT_MIN, LAT_MAX = -10.0, 25.0
DEPTH_MIN, DEPTH_MAX = 0.0, 2000.0

# `decimals` is set from each product's own error field, not from taste: the
# relative-error fields run to a few tenths and a few hundredths respectively,
# so this keeps one digit past the noise floor and no more.
VARIABLES = {
    "temperature": {"unit": "degree_Celsius", "decimals": 2, "valid": (-2.5, 36.0)},
    "salinity":    {"unit": "PSU",            "decimals": 3, "valid": (0.0, 42.0)},
}


def attribution(ds):
    return (
        "Gridded temperature and salinity from the Indian National Centre for "
        f"Ocean Information Services (INCOIS), dataset {ds['id']}: a "
        f"{ds['label']} of Argo profiles. Served via INCOIS ERDDAP, "
        "https://erddap.incois.gov.in . Underlying profiles are collected and "
        "made freely available by the International Argo Program."
    )


def default_window(months=6):
    """
    The window to fetch when none is given: the last `months` up to today.

    Matches tools/fetch_argo.py so the field and the observations cover the same
    period by default. The analysis itself runs about a month behind real time,
    so the newest frames inside this window stop short of it — which is why the
    UI states the frame it is showing rather than the date that was asked for.
    """
    end = datetime.now(timezone.utc).date()
    return (end - timedelta(days=months * 31)).isoformat(), end.isoformat()


def get(dataset, query, timeout=300):
    """
    One ERDDAP griddap request, returned as (rows, column-index map).

    404 means the query was valid and selected nothing, which for a time or
    region with no coverage is a legitimate answer. Every other code is a
    broken query and must be loud, or a renamed variable quietly becomes
    "the ocean is empty here".
    """
    # `[`, `]`, `<` and `>` must be percent-encoded: Tomcat rejects them raw in
    # a request target with 400 "Invalid character found", before ERDDAP ever
    # sees them. Parentheses and colons pass through fine and stay readable.
    url = f"{BASE}/{dataset}.json?" + urllib.parse.quote(query, safe="=&,.:()-")
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            table = json.loads(r.read().decode("utf-8"))["table"]
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return [], {}
        raise RuntimeError(
            f"{dataset} query failed with HTTP {e.code} (not an empty result):\n"
            f"{url}\n{e.read().decode('utf-8', 'replace')[:300]}"
        ) from e
    return table["rows"], {n: i for i, n in enumerate(table["columnNames"])}


def axis(dataset, name):
    """An ERDDAP axis variable, in file order."""
    rows, _ = get(dataset, name)
    return [r[0] for r in rows]


def frame(dataset, var, time_iso, with_depth=True):
    """One timestep of one variable, subset to the domain."""
    depth = f"[({DEPTH_MIN}):({DEPTH_MAX})]" if with_depth else ""
    q = (f"{var}[({time_iso})]{depth}"
         f"[({LAT_MIN}):({LAT_MAX})][({LON_MIN}):({LON_MAX})]")
    return get(dataset, q)


def build_grid(rows, idx, var, spec, rejected):
    """
    Rows -> (lons, lats, depths, flat values) in the renderer's index order.

    Index order is iz*ny*nx + iy*nx + ix, which is what js/scene.js slices
    against. Positions are looked up from the coordinate columns rather than
    inferred from row order — see point 4 in the module docstring.
    """
    has_depth = "ZAX" in idx
    lons = sorted({r[idx["longitude"]] for r in rows})
    lats = sorted({r[idx["latitude"]] for r in rows})
    depths = sorted({r[idx["ZAX"]] for r in rows}) if has_depth else [0.0]

    ix_of = {v: i for i, v in enumerate(lons)}
    iy_of = {v: i for i, v in enumerate(lats)}
    iz_of = {v: i for i, v in enumerate(depths)}
    nx, ny, nz = len(lons), len(lats), len(depths)

    lo, hi = spec["valid"]
    dp = spec["decimals"]
    values = [None] * (nx * ny * nz)
    for r in rows:
        v = r[idx[var]]
        if v is None:
            rejected["null_land_or_nodata"] += 1
            continue
        if not (lo <= v <= hi):
            # Out of physical range: a pipeline defect, not a measurement.
            rejected["out_of_range"] += 1
            continue
        iz = iz_of[r[idx["ZAX"]]] if has_depth else 0
        k = iz * ny * nx + iy_of[r[idx["latitude"]]] * nx + ix_of[r[idx["longitude"]]]
        values[k] = round(v, dp)

    return lons, lats, depths, values


def fetch_field(ds, times, args):
    """Every requested variable at every requested timestep."""
    out, rejected = {}, {}
    axes = None

    for name, spec in VARIABLES.items():
        if args.vars and name not in args.vars:
            continue
        var, err_var = ds["vars"][name]
        rejected[name] = {"null_land_or_nodata": 0, "out_of_range": 0}
        frames, errors = [], []

        for t in times:
            rows, idx = frame(ds["id"], var, t)
            if not rows:
                print(f"  {name} {t[:10]}: no data returned, skipped")
                frames.append(None)
                errors.append(None)
                continue
            lons, lats, depths, values = build_grid(
                rows, idx, var, spec, rejected[name])
            if axes is None:
                axes = (lons, lats, depths)
            elif (lons, lats, depths) != axes:
                # Two variables on different grids cannot share one index space,
                # and silently keeping the last one would misplace the field.
                sys.exit(f"{name} at {t} returned a different grid to the first "
                         f"frame. Refusing to write a mixed-grid file.")
            good = sum(v is not None for v in values)
            print(f"  {name} {t[:10]}: {good}/{len(values)} cells "
                  f"({100 * good / len(values):.0f}% ocean)")
            frames.append(values)

            if args.with_error:
                erows, eidx = frame(ds["id"], err_var, t)
                if erows:
                    # The error field shares the variable's grid but not its
                    # physical range, so it gets its own permissive band.
                    espec = {"valid": (0.0, 1e6), "decimals": spec["decimals"]}
                    errors.append(build_grid(erows, eidx, err_var,
                                             espec, rejected[name])[3])
                else:
                    errors.append(None)

        if not any(f is not None for f in frames):
            sys.exit(f"No usable frames for {name}. Widen the time window.")
        out[name] = {
            "unit": spec["unit"],
            "dataset": ds["id"],
            "erddapVariable": var,
            "frames": frames,
        }
        if args.with_error:
            out[name]["errorVariable"] = err_var
            out[name]["errorFrames"] = errors

    if axes is None:
        sys.exit("No data returned for any variable or timestep.")
    return out, trim_dead_levels(out, axes), rejected


def trim_dead_levels(variables, axes):
    """
    Drop trailing depth levels that are null everywhere, in every variable and
    frame, and return the shortened axes.

    The product nominally reaches 2000 m but produces nothing there for this
    domain. Keeping the level would put a fully transparent row at the bottom of
    every vertical section and let `depths[-1]` claim data exists at a depth
    where none does — which is exactly the sort of quiet overstatement the
    provenance work elsewhere in this app exists to prevent.
    """
    lons, lats, depths = axes
    nx, ny, nz = len(lons), len(lats), len(depths)
    layer = nx * ny

    keep = nz
    while keep > 1:
        iz = keep - 1
        if any(f[iz * layer:(iz + 1) * layer].count(None) != layer
               for v in variables.values() for f in v["frames"] if f is not None):
            break
        keep -= 1
    if keep == nz:
        return axes

    print(f"  dropping {nz - keep} trailing depth level(s) with no data: "
          f"{depths[keep:]} m")
    for v in variables.values():
        for key in ("frames", "errorFrames"):
            if key not in v:
                continue
            v[key] = [None if f is None else f[:keep * layer] for f in v[key]]
    return lons, lats, depths[:keep]


def d26_from_column(temps, depths, t_ref=26.0):
    """
    Depth of the 26 degC isotherm for one water column, or None.

    Deliberately the same shallowest-crossing rule js/scene.js uses for the
    isosurface, so --validate-d26 is comparing the app's definition against
    INCOIS's and not two different definitions of D26.
    """
    for i in range(len(depths) - 1):
        a, b = temps[i], temps[i + 1]
        if a is None or b is None:
            return None
        if (a - t_ref) * (b - t_ref) <= 0 and a != b:
            f = (t_ref - a) / (b - a)
            return depths[i] + f * (depths[i + 1] - depths[i])
    return None


def validate_d26(ds, date):
    """
    Cross-check our D26 against INCOIS's own published D26 for the same date.

    Two independent things are being tested at once: that the depth axis is
    being read correctly, and that the crossing search matches the convention
    an operational centre uses. A large disagreement means one of them is wrong
    and the cyclone-heat layer downstream of it is not defensible.
    """
    va_times = axis(VALUE_ADDED, "time")
    if not va_times:
        sys.exit("Could not read the value-added time axis.")
    t_va = min(va_times, key=lambda t: abs(
        datetime.fromisoformat(t.replace("Z", "+00:00"))
        - datetime.fromisoformat(date + "T00:00:00+00:00")))

    mt = axis(ds["id"], "time")
    t_model = min(mt, key=lambda t: abs(
        datetime.fromisoformat(t.replace("Z", "+00:00"))
        - datetime.fromisoformat(t_va.replace("Z", "+00:00"))))
    print(f"INCOIS D26 frame {t_va[:10]}  vs  analysis frame {t_model[:10]}")

    rows, idx = frame(VALUE_ADDED, "D26", t_va, with_depth=False)
    if not rows:
        sys.exit(f"No D26 returned for {t_va}.")
    ref = {}
    for r in rows:
        v = r[idx["D26"]]
        if v is not None and 0 < v < DEPTH_MAX:
            ref[(round(r[idx["latitude"]], 3), round(r[idx["longitude"]], 3))] = v

    var = ds["vars"]["temperature"][0]
    trows, tidx = frame(ds["id"], var, t_model)
    lons, lats, depths, values = build_grid(
        trows, tidx, var, VARIABLES["temperature"],
        {"null_land_or_nodata": 0, "out_of_range": 0})
    nx, ny, nz = len(lons), len(lats), len(depths)

    diffs = []
    for iy, la in enumerate(lats):
        for ix, lo in enumerate(lons):
            r = ref.get((round(la, 3), round(lo, 3)))
            if r is None:
                continue
            col = [values[iz * ny * nx + iy * nx + ix] for iz in range(nz)]
            mine = d26_from_column(col, depths)
            if mine is not None:
                diffs.append(mine - r)

    if not diffs:
        sys.exit("No overlapping cells: the two products may be on different grids.")
    diffs.sort()
    n = len(diffs)
    mean = sum(diffs) / n
    median = diffs[n // 2]
    absmean = sum(abs(d) for d in diffs) / n
    within20 = sum(abs(d) <= 20 for d in diffs) / n
    print(f"\n{n} co-located cells")
    print(f"  mean difference   {mean:+9.3f} m   (ours minus INCOIS)")
    print(f"  median difference {median:+9.3f} m")
    print(f"  mean |difference| {absmean:9.3f} m")
    print(f"  max  |difference| {max(abs(d) for d in diffs):9.3f} m")
    print(f"  within 20 m       {100 * within20:8.1f}%")
    # One grid cell spans 25 m of the thermocline at these depths, so this is
    # about the tightest agreement the vertical resolution can express.
    assert absmean < 25, f"D26 disagrees with INCOIS by {absmean:.1f} m on average"
    print("\nOK: D26 agrees with INCOIS within the vertical resolution.")


def check(path):
    """
    Assertions over the written file. Cheap, offline, and catches the failures
    that would otherwise show up as a plausible-looking wrong picture.
    """
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)

    g = doc["grid"]
    nx, ny, nz = g["nx"], g["ny"], g["nz"]
    assert len(doc["lons"]) == nx and len(doc["lats"]) == ny
    assert len(doc["depths"]) == nz
    assert doc["depths"] == sorted(doc["depths"]), "depth axis is not ascending"
    assert len(set(doc["depths"])) == nz, "duplicate depth levels"
    assert doc["lons"] == sorted(doc["lons"]), "longitude axis is not ascending"
    assert doc["lats"] == sorted(doc["lats"]), "latitude axis is not ascending"
    assert doc["lons"][0] >= LON_MIN - 1 and doc["lons"][-1] <= LON_MAX + 1
    assert doc["lats"][0] >= LAT_MIN - 1 and doc["lats"][-1] <= LAT_MAX + 1
    assert len(doc["times"]) >= 1

    # The axis being uneven is the whole reason it is carried explicitly.
    steps = [b - a for a, b in zip(doc["depths"], doc["depths"][1:])]
    assert max(steps) > 2 * min(steps), \
        "depth axis looks evenly spaced — check it was not regenerated"

    for name, v in doc["variables"].items():
        assert len(v["frames"]) == len(doc["times"]), f"{name}: frame count"
        lo, hi = VARIABLES[name]["valid"]
        for t, fr in zip(doc["times"], v["frames"]):
            if fr is None:
                continue
            assert len(fr) == nx * ny * nz, f"{name} {t}: wrong cell count"
            vals = [x for x in fr if x is not None]
            assert vals, f"{name} {t}: every cell is null"
            assert lo <= min(vals) and max(vals) <= hi, f"{name} {t}: out of range"
            # A frame that is nearly all ocean or nearly all land means the
            # subset went somewhere other than the Indian Ocean.
            frac = len(vals) / len(fr)
            assert 0.35 < frac < 0.95, f"{name} {t}: {100*frac:.0f}% ocean, implausible"

        # Surface must be warmer than depth, or the vertical axis is inverted.
        # Compared against the deepest level that actually holds values: the
        # analysis thins out with depth and its bottom level is empty in some
        # frames, which is a property of the product, not a fault in the fetch.
        if name == "temperature":
            fr = max((f for f in v["frames"] if f is not None),
                     key=lambda f: len(f) - f.count(None))
            layer = lambda iz: [x for x in fr[iz * nx * ny:(iz + 1) * nx * ny]
                                if x is not None]
            top = layer(0)
            deepest = next((iz for iz in range(nz - 1, -1, -1) if layer(iz)), None)
            assert top and deepest, "no usable temperature levels"
            bot = layer(deepest)
            assert sum(top) / len(top) > sum(bot) / len(bot) + 15, \
                f"surface is not warmer than {doc['depths'][deepest]} m — " \
                "depth axis is inverted"

    print(f"OK  {os.path.basename(path)}  "
          f"{nx}x{ny}x{nz} grid, {len(doc['times'])} frames, "
          f"{', '.join(doc['variables'])}")
    print(f"    depths {doc['depths'][0]}-{doc['depths'][-1]} m, "
          f"{len(steps)} uneven steps ({min(steps)}-{max(steps)} m)")


def main():
    d_start, d_end = default_window()
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default=d_start)
    ap.add_argument("--end", default=d_end)
    ap.add_argument("--max-frames", type=int, default=8,
                    help="evenly sample at most this many of the available timesteps")
    ap.add_argument("--vars", nargs="*", choices=sorted(VARIABLES),
                    help="default: all of them")
    ap.add_argument("--dataset", default=DEFAULT_DATASET, choices=sorted(DATASETS),
                    help="which INCOIS analysis to pull; vam resolves more of the basin")
    ap.add_argument("--with-error", action="store_true",
                    help="also fetch the product's own relative-error field per frame")
    ap.add_argument("--check", action="store_true",
                    help="verify the existing js/data/model.json and exit")
    ap.add_argument("--validate-d26", metavar="DATE", nargs="?", const="2018-05-20",
                    help="cross-check computed D26 against INCOIS's own D26 and exit")
    args = ap.parse_args()

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    dest = os.path.join(here, "js", "data", "model.json")

    if args.check:
        check(dest)
        return
    ds = DATASETS[args.dataset]
    if args.validate_d26:
        validate_d26(ds, args.validate_d26)
        return

    print(f"Reading {ds['id']} time axis...")
    all_times = axis(ds["id"], "time")
    times = [t for t in all_times if args.start <= t[:10] <= args.end]
    if not times:
        sys.exit(f"No timesteps between {args.start} and {args.end}. "
                 f"Coverage is {all_times[0][:10]} to {all_times[-1][:10]}.")
    if len(times) > args.max_frames:
        # Even sample, both ends kept: the timeline should span the window
        # rather than crowd into the start of it.
        step = (len(times) - 1) / (args.max_frames - 1) if args.max_frames > 1 else 1
        times = [times[round(i * step)] for i in range(args.max_frames)]
    print(f"  {len(all_times)} available, {len(times)} selected "
          f"({times[0][:10]} to {times[-1][:10]})")

    variables, (lons, lats, depths), rejected = fetch_field(ds, times, args)

    doc = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": f"INCOIS ERDDAP griddap ({ds['id']})",
        "attribution": attribution(ds),
        "domain": {"lonMin": LON_MIN, "lonMax": LON_MAX,
                   "latMin": LAT_MIN, "latMax": LAT_MAX,
                   "depthMin": DEPTH_MIN, "depthMax": DEPTH_MAX},
        "timeRange": [args.start, args.end],
        "grid": {"nx": len(lons), "ny": len(lats), "nz": len(depths)},
        # Explicit axes. `depths` in particular is uneven and every consumer
        # must read it rather than derive depth from the level index.
        "lons": lons,
        "lats": lats,
        "depths": depths,
        "times": times,
        "qc": {"rejected": rejected,
               "note": "null cells are land or unanalysed water and are kept "
                       "as null; they must render as absent, not as zero"},
        "variables": variables,
    }

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))

    mb = os.path.getsize(dest) / 1024 / 1024
    print(f"\n{len(lons)}x{len(lats)}x{len(depths)} grid, {len(times)} frames, "
          f"{len(variables)} variables -> {mb:.1f} MB")
    print(f"depths: {depths}")
    for name, r in rejected.items():
        print(f"rejected {name}: {r}")
    check(dest)


if __name__ == "__main__":
    main()
