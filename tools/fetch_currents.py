#!/usr/bin/env python3
"""
Fetch real ocean current vectors and write js/data/currents.json.

Source: Copernicus Marine Service, product GLOBAL_MULTIYEAR_PHY_001_030
(GLORYS12V1) -> dataset cmems_mod_glo_phy_my_0.083deg_P1D-m. Eastward and
northward sea water velocity (uo, vo), daily, 1/12 degree, 50 depth levels,
1993-01-01 to a few months behind today.

Requires a free Copernicus Marine account. Register at
https://data.marine.copernicus.eu, then in a terminal you control (never
through an agent) run:

    copernicusmarine login

which caches credentials locally. This script does not accept a username or
password itself; it relies on that cache, or on
COPERNICUSMARINE_SERVICE_USERNAME / COPERNICUSMARINE_SERVICE_PASSWORD already
set in the environment.

Run this to refresh the bundled field (after tools/fetch_model.py has run at
least once -- see WHY THIS SHAPE below):

    python tools/fetch_currents.py
    python tools/fetch_currents.py --check      # verify the written file

WHY THIS SHAPE
--------------
js/data/model.json (from tools/fetch_model.py) already fixes the grid the
whole app renders on: a 1-degree lon/lat grid, 24 uneven depth levels, and
whichever ten-daily dates INCOIS last analysed. js/dataService.js's field
cropper (_realModelField) assumes one shared lons/lats/depths/times axis per
document -- it has no notion of a variable carrying its own grid. So rather
than fetch GLORYS on its native 1/12-degree grid, this script resamples it
(nearest neighbour, in space and time) onto model.json's exact axes and
writes a second file with the identical lons/lats/depths/times. dataService.js
then only needs to pick this file instead of model.json when the requested
variable is 'currents'; the crop/cache/lookup code is unchanged.

GLORYS is a reanalysis and runs a few months behind the live INCOIS
ten-day analysis. Whichever of model.json's frames fall after GLORYS's own
latest available day come out null in currents.json -- exactly like a
timestep ERDDAP had no data for elsewhere in this pipeline -- rather than
silently reusing the nearest earlier day under a later day's label.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

DATASET_ID = "cmems_mod_glo_phy_my_0.083deg_P1D-m"
PRODUCT_ID = "GLOBAL_MULTIYEAR_PHY_001_030"

# Speed, not a component: negative eastward flow is still valid, but a scalar
# magnitude past this is a pipeline defect (mis-set axis, unit mismatch), not
# a current -- the fastest boundary jets in this basin run under 2 m/s.
VALID_SPEED = (0.0, 5.0)
DECIMALS = 4  # ~0.1 mm/s: past GLORYS's own noise floor, not into it

# A day either side of the target: enough to tolerate the daily product's own
# occasional missing day without silently matching a date a week off.
TIME_TOLERANCE_DAYS = 1
# Degrees of padding around model.json's lon/lat extent so nearest-neighbour
# at the domain edge has a real GLORYS cell to land on rather than the edge
# of the fetch window.
SPACE_PAD_DEG = 1.0
DEPTH_PAD_M = 200.0  # GLORYS levels aren't round numbers; give the deepest one room


def attribution():
    return (
        f"Ocean current velocity from the Copernicus Marine Service, product "
        f"{PRODUCT_ID} (GLORYS12V1), dataset {DATASET_ID}. Generated using "
        f"E.U. Copernicus Marine Service Information, "
        f"https://doi.org/10.48670/moi-00021 . "
        f"https://data.marine.copernicus.eu/product/{PRODUCT_ID}"
    )


def load_model_doc(path):
    if not os.path.exists(path):
        sys.exit(
            f"{path} does not exist. Run tools/fetch_model.py first -- "
            "currents.json is resampled onto its exact grid and dates."
        )
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def open_source(lons, lats, depths):
    """Lazy xarray Dataset over the padded domain, uo/vo only."""
    import copernicusmarine

    try:
        return copernicusmarine.open_dataset(
            dataset_id=DATASET_ID,
            variables=["uo", "vo"],
            minimum_longitude=min(lons) - SPACE_PAD_DEG,
            maximum_longitude=max(lons) + SPACE_PAD_DEG,
            minimum_latitude=min(lats) - SPACE_PAD_DEG,
            maximum_latitude=max(lats) + SPACE_PAD_DEG,
            minimum_depth=0.0,
            maximum_depth=max(depths) + DEPTH_PAD_M,
        )
    except Exception as e:  # copernicusmarine raises its own auth exceptions
        name = type(e).__name__
        if "Credential" in name or "Username" in name or "Password" in name or "Auth" in name:
            sys.exit(
                "Copernicus Marine credentials not found or invalid.\n"
                "Register at https://data.marine.copernicus.eu, then in a "
                "terminal you control run:\n\n    copernicusmarine login\n"
            )
        raise


def fetch_frame(src, lons, lats, depths, iso_time, rejected):
    """uo/vo resampled onto (depths, lats, lons) for one date, or (None, None)."""
    import numpy as np
    import pandas as pd

    try:
        at_time = src.sel(
            time=pd.Timestamp(iso_time),
            method="nearest",
            tolerance=pd.Timedelta(days=TIME_TOLERANCE_DAYS),
        )
    except KeyError:
        return None, None  # nothing within tolerance -- GLORYS hasn't reached this date yet

    on_grid = at_time.sel(depth=depths, latitude=lats, longitude=lons, method="nearest")
    uo = on_grid["uo"].transpose("depth", "latitude", "longitude").values
    vo = on_grid["vo"].transpose("depth", "latitude", "longitude").values

    def flat(arr):
        out = []
        lo, hi = 0.0, 20.0  # component sanity band, wider than VALID_SPEED
        for v in arr.ravel(order="C"):
            v = float(v)
            if np.isnan(v):
                rejected["null_land_or_nodata"] += 1
                out.append(None)
            elif not (-hi <= v <= hi):
                rejected["out_of_range"] += 1
                out.append(None)
            else:
                out.append(round(v, DECIMALS))
        return out

    u_flat, v_flat = flat(uo), flat(vo)
    speed_flat = []
    for u, v in zip(u_flat, v_flat):
        if u is None or v is None:
            speed_flat.append(None)
            continue
        s = round((u * u + v * v) ** 0.5, DECIMALS)
        if not (VALID_SPEED[0] <= s <= VALID_SPEED[1]):
            rejected["out_of_range"] += 1
            speed_flat.append(None)
        else:
            speed_flat.append(s)

    return speed_flat, (u_flat, v_flat)


def check(path):
    """Assertions over the written file, mirroring tools/fetch_model.py --check."""
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)

    g = doc["grid"]
    nx, ny, nz = g["nx"], g["ny"], g["nz"]
    assert len(doc["lons"]) == nx and len(doc["lats"]) == ny
    assert len(doc["depths"]) == nz
    assert len(doc["times"]) >= 1

    v = doc["variables"]["currents"]
    assert len(v["frames"]) == len(doc["times"])
    assert len(v["uFrames"]) == len(doc["times"])
    assert len(v["vFrames"]) == len(doc["times"])

    n_real = 0
    for t, fr, uf, vf in zip(doc["times"], v["frames"], v["uFrames"], v["vFrames"]):
        if fr is None:
            print(f"  {t[:10]}: null (outside GLORYS coverage)")
            continue
        n_real += 1
        assert len(fr) == nx * ny * nz == len(uf) == len(vf), f"{t}: wrong cell count"
        vals = [x for x in fr if x is not None]
        assert vals, f"{t}: every cell is null"
        lo, hi = VALID_SPEED
        assert lo <= min(vals) and max(vals) <= hi, f"{t}: speed out of range"
        frac = len(vals) / len(fr)
        assert 0.35 < frac < 0.95, f"{t}: {100 * frac:.0f}% ocean, implausible"
        print(f"  {t[:10]}: {len(vals)}/{len(fr)} cells "
              f"({100 * frac:.0f}% ocean), max speed {max(vals):.2f} m/s")

    assert n_real >= 1, "no real frames at all -- every date fell outside GLORYS coverage"
    print(f"OK  {os.path.basename(path)}  {nx}x{ny}x{nz} grid, "
          f"{n_real}/{len(doc['times'])} frames real")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=None,
                     help="path to the model.json whose grid/dates to match "
                          "(default: js/data/model.json next to this script)")
    ap.add_argument("--out", default=None,
                     help="output path (default: js/data/currents.json)")
    ap.add_argument("--check", action="store_true",
                     help="verify the existing js/data/currents.json and exit")
    args = ap.parse_args()

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    model_path = args.model or os.path.join(here, "js", "data", "model.json")
    out_path = args.out or os.path.join(here, "js", "data", "currents.json")

    if args.check:
        check(out_path)
        return

    model = load_model_doc(model_path)
    lons, lats, depths, times = model["lons"], model["lats"], model["depths"], model["times"]
    print(f"Matching {os.path.basename(model_path)}'s grid: "
          f"{len(lons)}x{len(lats)}x{len(depths)}, {len(times)} dates "
          f"({times[0][:10]} to {times[-1][:10]})")

    print(f"Opening {DATASET_ID} (Copernicus Marine)...")
    src = open_source(lons, lats, depths)

    rejected = {"null_land_or_nodata": 0, "out_of_range": 0}
    speed_frames, u_frames, v_frames = [], [], []
    for t in times:
        speed, uv = fetch_frame(src, lons, lats, depths, t, rejected)
        if speed is None:
            print(f"  {t[:10]}: outside GLORYS coverage, skipped")
            speed_frames.append(None)
            u_frames.append(None)
            v_frames.append(None)
            continue
        u, v = uv
        good = sum(x is not None for x in speed)
        print(f"  {t[:10]}: {good}/{len(speed)} cells "
              f"({100 * good / len(speed):.0f}% ocean)")
        speed_frames.append(speed)
        u_frames.append(u)
        v_frames.append(v)

    if not any(f is not None for f in speed_frames):
        sys.exit("No date in model.json falls inside GLORYS coverage. "
                  "Re-run tools/fetch_model.py for an earlier window, or wait "
                  "for GLORYS to catch up.")

    doc = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": f"Copernicus Marine ({DATASET_ID})",
        "attribution": attribution(),
        "domain": model["domain"],
        "timeRange": model["timeRange"],
        "grid": model["grid"],
        "lons": lons,
        "lats": lats,
        "depths": depths,
        "times": times,
        "qc": {"rejected": rejected,
               "note": "null cells are land, unanalysed water, or a frame "
                       "outside GLORYS's own coverage; they stay null and "
                       "must render as absent, not as zero"},
        "variables": {
            "currents": {
                "unit": "m s-1",
                "dataset": f"{PRODUCT_ID} / {DATASET_ID} (GLORYS12V1)",
                "copernicusVariable": "uo, vo",
                "frames": speed_frames,
                "uFrames": u_frames,
                "vFrames": v_frames,
            }
        },
    }

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    size_mb = os.path.getsize(out_path) / 1e6
    print(f"\nWrote {out_path} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
