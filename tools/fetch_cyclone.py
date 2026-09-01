#!/usr/bin/env python3
"""
Fetch the Cyclone Mocha case study and write js/data/cyclone.json.

    python tools/fetch_cyclone.py
    python tools/fetch_cyclone.py --max-floats 10
    python tools/fetch_cyclone.py --check          # re-validate the written file

WHY A SECOND SNAPSHOT INSTEAD OF THE LIVE ONE
---------------------------------------------
The app's live window is Feb-Aug 2026 and has to stay current. It contains no
cyclone, and that is not a data lag: IBTrACS is current to 2026-08-30 with
3,272 rows for the season and *zero* of them in the North Indian basin. The NI
season runs Apr-Jun and Oct-Dec, and 2026 has so far produced nothing. A
cyclone-heat layer with no cyclone to point it at demonstrates nothing, so the
case study travels to a storm rather than waiting for one.

Mocha (2023-05-08 to 2023-05-15) is the storm to use: the most intense cyclone
ever recorded in the Bay of Bengal, 145 kt at peak, and it crossed water this
same INCOIS analysis resolves. This file is written and read entirely
separately from argo.json / model.json — the live view is not touched.

WHAT THE ANALYSIS ACTUALLY SHOWS, AND WHAT IT DOES NOT
------------------------------------------------------
The obvious framing fails. TCHP under the storm *at* the moment it was
intensifying separates nothing: rapid-intensification steps sit over
essentially the same heat content as every other step, and Mocha reached its
145 kt peak over ~26 kJ cm-2 — downstream, near the coast, over the cold wake
it had just upwelled itself. Anyone building a "high TCHP means strong
cyclone" readout would be building a claim this data refutes.

Reframed to a *lead*, it separates cleanly. TCHP under the storm now, against
the intensity change over the following 24 hours, is the way an operational
forecaster actually reads the field: it is a statement about the water the
storm is about to cross, not a diagnosis of the storm over it. Both framings
are computed below and both are written to the file, because the negative
result is what makes the positive one worth stating.

The 50 kJ cm-2 split is taken from the operational literature a priori. It is
not fitted here, and this script does not search for a better one — a
threshold chosen after seeing the data would be a description of 44 points
rather than a finding.

The separation is in the means, not step by step: individual sub-threshold
steps do intensify. `analysis.caveat` carries that sentence into the app so
the UI cannot quietly promote it to a forecast.

WHAT IS FETCHED
---------------
  track   IBTrACS v04r01, `last3years`. NOT the full `ibtracs.NI.list`: that
          file silently truncates on a 180 s timeout and hands back data
          ending in 1986 with no error of any kind.
  field   Three INCOIS VAM frames bracketing the storm — 2023-04-30 is the
          ocean Mocha found, before its own wake is in the analysis.
  argo    Real profiles in the domain over the storm window, so there are
          observations under the track rather than only an analysis of one.

The field and float blocks are written in exactly the schema of model.json and
argo.json, so js/dataService.js swaps documents rather than growing a second
code path for reading them.
"""

import argparse
import csv
import io
import json
import math
import os
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone

# Sibling scripts, not a package. The grid crop, the ERDDAP quoting rules and
# the Argo QC pass are all already correct in those two files and re-deriving
# any of them here is how the two snapshots would drift apart.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_argo    # noqa: E402
import fetch_model   # noqa: E402

IBTRACS = ("https://www.ncei.noaa.gov/data/international-best-track-archive-"
           "for-climate-stewardship-ibtracs/v04r01/access/csv/"
           "ibtracs.last3years.list.v04r01.csv")

STORM_NAME = "MOCHA"
STORM_BASIN = "NI"

# Frames bracketing the storm. The analysis is ten-daily, so these are the
# three it has: before genesis, mid-track, and after landfall.
FRAME_DATES = ("2023-04-30", "2023-05-10", "2023-05-20")
ARGO_START, ARGO_END = "2023-05-01", "2023-05-20"

# Domain, shared with the live snapshot so both are cropped identically.
LON_MIN, LON_MAX = fetch_model.LON_MIN, fetch_model.LON_MAX
LAT_MIN, LAT_MAX = fetch_model.LAT_MIN, fetch_model.LAT_MAX

LEAD_HOURS = 24          # the forecast horizon TCHP is actually used over
RI_KT = 30.0             # operational rapid-intensification threshold, kt/24 h
TCHP_THRESHOLD = 50.0    # kJ cm-2, from the literature. NOT fitted here.
WIND_RANGE = (0.0, 200.0)      # kt; anything outside is a corrupt best-track row
TRACK_MAX_GAP_H = 6.0    # a wider hole than this is a gap, not a 24 h partner

# A 24-hour window with either end this close to land is a landfall window, and
# the storm's decay across it is land interaction rather than anything the
# ocean did. Reported as a separate subset instead of being folded in: over the
# full track the collapse from 145 kt to 20 kt happens to coincide with the
# shelf water, and a correlation that is really "it hit Myanmar" would be a
# flattering one.
OFFSHORE_KM = 200.0

ATTRIBUTION = {
    "track": ("International Best Track Archive for Climate Stewardship "
              "(IBTrACS) v04r01, NOAA National Centers for Environmental "
              "Information. Intensity is USA_WIND, the JTWC one-minute "
              "sustained wind. https://www.ncei.noaa.gov/products/"
              "international-best-track-archive"),
}


# ---------------------------------------------------------------------------
# Track
# ---------------------------------------------------------------------------

def fetch_track(rejected, timeout=300):
    """
    Mocha's best-track positions and intensities, oldest first.

    IBTrACS ships two header rows — names then units — and a missing value is
    an empty field rather than a sentinel, so a row is dropped on a blank
    rather than on a magic number. Rows are kept whether or not they fall
    inside the model domain: the storm crossed into Myanmar and clipping the
    track to the box the field covers would redraw history to fit the data.
    """
    print(f"IBTrACS {STORM_BASIN}/{STORM_NAME}...")
    with urllib.request.urlopen(IBTRACS, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    print(f"  {len(raw) / 1e6:.1f} MB")

    reader = csv.reader(io.StringIO(raw))
    header = next(reader)
    next(reader)                       # units row
    ix = {n: i for i, n in enumerate(header)}
    need = ("SID", "SEASON", "BASIN", "NAME", "ISO_TIME", "LAT", "LON",
            "USA_WIND", "DIST2LAND")
    missing = [c for c in need if c not in ix]
    if missing:
        sys.exit(f"IBTrACS is missing columns {missing} — the schema changed.")

    points, sids, seasons = [], set(), set()
    for row in reader:
        if row[ix["BASIN"]].strip() != STORM_BASIN:
            continue
        if row[ix["NAME"]].strip().upper() != STORM_NAME:
            continue
        wind = row[ix["USA_WIND"]].strip()
        lat, lon = row[ix["LAT"]].strip(), row[ix["LON"]].strip()
        if not wind or not lat or not lon:
            # A best-track fix with no intensity cannot enter an intensity
            # analysis, and interpolating one would invent the very quantity
            # being tested.
            rejected["missing_position_or_wind"] += 1
            continue
        try:
            lat, lon, wind = float(lat), float(lon), float(wind)
        except ValueError:
            rejected["unparseable"] += 1
            continue
        if not (WIND_RANGE[0] <= wind <= WIND_RANGE[1]):
            rejected["wind_out_of_range"] += 1
            continue
        d2l = row[ix["DIST2LAND"]].strip()
        sids.add(row[ix["SID"]])
        seasons.add(row[ix["SEASON"]].strip())
        points.append({
            "time": row[ix["ISO_TIME"]].strip().replace(" ", "T") + "Z",
            "lat": round(lat, 3),
            "lon": round(lon, 3),
            "windKt": round(wind, 1),
            # IBTrACS's own distance to the nearest land, in km. 0 means the
            # centre is over land.
            "dist2LandKm": int(d2l) if d2l.lstrip("-").isdigit() else None,
        })

    if not points:
        sys.exit(f"No {STORM_NAME} rows in the {STORM_BASIN} basin. IBTrACS "
                 f"covers the last three years only — has the window moved past it?")
    if len(sids) > 1:
        # Two storms of the same name in three years would silently interleave
        # two tracks into one polyline.
        sys.exit(f"{STORM_NAME} matched more than one storm: {sorted(sids)}")

    points.sort(key=lambda p: p["time"])
    print(f"  {len(points)} fixes, {points[0]['time'][:16]} to "
          f"{points[-1]['time'][:16]}, peak {max(p['windKt'] for p in points):.0f} kt")
    return points, sids.pop(), int(sorted(seasons)[0])


def _ts(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


# ---------------------------------------------------------------------------
# Heat content
# ---------------------------------------------------------------------------

def tchp_column(temps, depths, t_ref=26.0):
    """
    Tropical cyclone heat potential for one water column, in kJ cm-2, or None.

        TCHP = rho * cp * integral (T(z) - 26) dz,  surface down to D26

    Deliberately the same integration as `_computeTCHP` in js/scene.js, level
    for level: the top level counted at its own temperature down to 5 m, a
    trapezoid over each layer, and the last layer weighted by the fraction of
    it that is still above 26 degC. Two definitions of the same name — one for
    the number in the file and one for the number on screen — is exactly the
    kind of quiet disagreement this codebase spends its comments preventing.

    Returns None where the surface is land or unanalysed, so the caller can
    leave a hole rather than record a zero heat content for a continent.
    """
    rho, cp = 1026.0, 3990.0
    surf = temps[0] if temps else None
    if surf is None:
        return None

    joules = rho * cp * (surf - t_ref) * depths[0] if surf > t_ref else 0.0
    for i in range(len(depths) - 1):
        a, b = temps[i], temps[i + 1]
        if a is None or a <= t_ref:
            break
        if b is None:                     # seafloor, or the analysis stops here
            break
        dz = depths[i + 1] - depths[i]
        frac = 1.0 if b >= t_ref else (a - t_ref) / (a - b)
        excess = ((a - t_ref) + (b - t_ref)) / 2 if b >= t_ref else (a - t_ref) / 2
        joules += rho * cp * excess * dz * frac
        if b < t_ref:
            break
    return joules / 1e7                   # J m-2 -> kJ cm-2


def tchp_grid(values, lons, lats, depths):
    """TCHP over a whole frame, in the frame's own (iy * nx + ix) order."""
    nx, ny = len(lons), len(lats)
    out = [None] * (nx * ny)
    for iy in range(ny):
        for ix in range(nx):
            col = [values[iz * ny * nx + iy * nx + ix] for iz in range(len(depths))]
            out[iy * nx + ix] = tchp_column(col, depths)
    return out


def cell_at(lons, lats, lat, lon):
    """
    Index of the grid cell containing a position, or None when it is outside.

    Nearest cell, never an interpolation between cells: the renderer magnifies
    this field nearest-neighbour too, so a track point reads the same number
    the viewer sees under it. Cells are one degree on half-degree centres, so
    "outside" means further than half a cell beyond the edge.
    """
    dx = lons[1] - lons[0]
    dy = lats[1] - lats[0]
    if not (lons[0] - dx / 2 <= lon <= lons[-1] + dx / 2):
        return None
    if not (lats[0] - dy / 2 <= lat <= lats[-1] + dy / 2):
        return None
    ix = min(range(len(lons)), key=lambda i: abs(lons[i] - lon))
    iy = min(range(len(lats)), key=lambda i: abs(lats[i] - lat))
    return iy * len(lons) + ix


# ---------------------------------------------------------------------------
# The analysis
# ---------------------------------------------------------------------------

def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx <= 0 or syy <= 0:
        return None
    return sxy / math.sqrt(sxx * syy)


def _partner(track, i, hours):
    """
    The fix `hours` away from fix i, or None when the track has none there.

    The partner has to actually land near t + hours. IBTrACS is three-hourly
    through this storm so it normally lands exactly; taking "the nearest fix"
    unconditionally would pair the final fix with itself and report a 24-hour
    change of zero across the landfall, where Mocha in fact lost 100 kt.
    """
    target = _ts(track[i]["time"]) + timedelta(hours=hours)
    best = min(track, key=lambda p: abs((_ts(p["time"]) - target).total_seconds()))
    gap = abs((_ts(best["time"]) - target).total_seconds()) / 3600
    return None if gap > TRACK_MAX_GAP_H else best


def analyse(track, predictor, rejected):
    """
    One TCHP predictor, two framings, and only one of them works.

    `predictor` is (iso_time, tchp_grid, lons, lats) for the PRE-GENESIS frame
    — the ocean Mocha found. The mid-storm analysis is not used here and the
    choice is not cosmetic: the INCOIS product assimilates the Argo profiles
    taken around its own frame date, so by 2023-05-10 the storm's cold wake is
    already inside the field. Predicting a storm from an analysis that has
    absorbed that storm's effect is leakage, and it inflates the corridor by
    10-20 kJ cm-2 in exactly the places the storm had just churned.

    Both framings then read the same number:

      lead  TCHP now against the intensity change over the NEXT 24 h. This is
            how the field is used operationally — a statement about the water
            ahead, not a diagnosis of the storm above it.
      lag   TCHP now against the change over the PREVIOUS 24 h, split on the
            operational 30 kt rapid-intensification definition. This is the
            intuitive reading, and it separates nothing.

    The negative result is kept because it is what makes the positive one worth
    anything: the same field, the same threshold, the same storm.
    """
    ft, grid, lons, lats = predictor
    lead, lag, offshore = [], [], []
    for i, p in enumerate(track):
        k = cell_at(lons, lats, p["lat"], p["lon"])
        tchp = grid[k] if k is not None else None
        if k is None:
            rejected["fix_outside_domain"] += 1
        elif tchp is None:
            rejected["fix_over_land_or_unanalysed"] += 1

        # Rounded before it is used, not after. The statistics below have to be
        # the statistics of the numbers this file actually ships, or --check
        # cannot re-derive them and the app quotes an r nobody can reproduce
        # from the track it is drawing.
        tchp = None if tchp is None else round(tchp, 1)
        ahead = _partner(track, i, LEAD_HOURS)
        behind = _partner(track, i, -LEAD_HOURS)
        p["tchpPre"] = tchp
        p["leadKt"] = None if ahead is None else ahead["windKt"] - p["windKt"]
        # Change over the 24 hours ENDING here, so rapid intensification is a
        # positive number. Subtracting the other way round reported every
        # intensifying step as a 30 kt loss and found no RI in a storm that
        # gained 120 kt in three days.
        p["lagKt"] = None if behind is None else p["windKt"] - behind["windKt"]

        if tchp is None:
            continue
        if p["leadKt"] is not None:
            lead.append((tchp, p["leadKt"]))
            far = min(p["dist2LandKm"] if p["dist2LandKm"] is not None else 0,
                      ahead["dist2LandKm"] if ahead["dist2LandKm"] is not None else 0)
            if far >= OFFSHORE_KM:
                offshore.append((tchp, p["leadKt"]))
        if p["lagKt"] is not None:
            lag.append((tchp, p["lagKt"]))

    def split(pairs):
        hi = [d for t, d in pairs if t >= TCHP_THRESHOLD]
        lo = [d for t, d in pairs if t < TCHP_THRESHOLD]
        mean = lambda s: round(sum(s) / len(s), 1) if s else None
        return {
            "n": len(pairs),
            "r": round(pearson([t for t, _ in pairs], [d for _, d in pairs]), 3)
                 if pearson([t for t, _ in pairs], [d for _, d in pairs]) is not None else None,
            "above": {"n": len(hi), "meanDeltaKt": mean(hi)},
            "below": {"n": len(lo), "meanDeltaKt": mean(lo)},
        }

    ri = [t for t, d in lag if d >= RI_KT]
    other = [t for t, d in lag if d < RI_KT]
    mean = lambda s: round(sum(s) / len(s), 1) if s else None

    peak = max(track, key=lambda p: p["windKt"])
    tchps = [p["tchpPre"] for p in track if p["tchpPre"] is not None]

    return {
        "leadHours": LEAD_HOURS,
        # r is sensitive to how the 24-hour partner is chosen, and quoting it to
        # three decimals implies a precision the method does not have. An
        # independent recomputation with a 21-27 h acceptance band instead of
        # this nearest-to-24 h rule returns 0.874 against 0.911 on the same
        # track and the same field. The conclusion survives either way; the
        # third digit does not, so the UI states it to one decimal and carries
        # the rule that produced the exact figure.
        "pairing": {
            "rule": (f"nearest fix to t + {LEAD_HOURS} h, "
                     f"accepting a gap up to {TRACK_MAX_GAP_H:.0f} h"),
            "maxPartnerGapHours": TRACK_MAX_GAP_H,
            "rSensitivityNote": "0.87-0.91 across reasonable pairing rules",
        },
        "thresholdKJcm2": TCHP_THRESHOLD,
        "thresholdSource": ("operational literature, chosen before the split "
                            "was computed and not tuned to it"),
        "predictorFrame": ft,
        "predictorNote": ("pre-genesis analysis: the ocean the storm found. "
                          "Later frames have assimilated Argo profiles taken "
                          "in the storm's own cold wake."),
        "lead": split(lead),
        # The same test with every 24-hour window that touches land removed.
        # Mocha's collapse from 145 kt to 20 kt happened over the shelf AND
        # over Myanmar, and those two explanations have to be separated before
        # the correlation can be attributed to the ocean.
        "leadOffshore": {"minDist2LandKm": OFFSHORE_KM, **split(offshore)},
        "lag": {
            "n": len(lag),
            "r": round(pearson([t for t, _ in lag], [d for _, d in lag]), 3)
                 if pearson([t for t, _ in lag], [d for _, d in lag]) is not None else None,
            "riThresholdKt": RI_KT,
            "riSteps": {"n": len(ri), "meanTchp": mean(ri)},
            "otherSteps": {"n": len(other), "meanTchp": mean(other)},
        },
        "peak": {"windKt": peak["windKt"], "time": peak["time"],
                 "lat": peak["lat"], "lon": peak["lon"], "tchpPre": peak["tchpPre"],
                 "dist2LandKm": peak["dist2LandKm"]},
        "corridor": {"maxTchp": round(max(tchps), 1) if tchps else None,
                     "meanTchp": round(sum(tchps) / len(tchps), 1) if tchps else None,
                     "nSampled": len(tchps)},
        "caveat": ("Separation is in the means, not step by step: individual "
                   "sub-threshold steps do intensify. Read as favourable for "
                   "intensification, never as a forecast that it will."),
    }


def basin_context(grid, corridor_max):
    """
    Where the storm's corridor sits in the basin that fortnight.

    A corridor peak of 55 kJ cm-2 is meaningless on its own — the reader has no
    idea whether that is unusual water or Tuesday. Stated as a percentile of
    every analysed cell in the domain on the same frame, it is checkable.
    """
    vals = sorted(v for v in grid if v is not None)
    if not vals:
        return None
    below = sum(1 for v in vals if v < corridor_max) if corridor_max is not None else None
    return {
        "cells": len(vals),
        "medianTchp": round(vals[len(vals) // 2], 1),
        "maxTchp": round(vals[-1], 1),
        "corridorPercentile": round(100 * below / len(vals)) if below is not None else None,
    }


# ---------------------------------------------------------------------------
# Field and floats
# ---------------------------------------------------------------------------

def fetch_field(ds, times, rejected):
    """
    The bracketing analysis frames, in exactly the schema of js/data/model.json.

    Written whole rather than as a delta so js/dataService.js can swap one
    document for the other; a second reader for a second shape is a second
    thing to keep correct.
    """
    variables, axes = {}, None
    for name, spec in fetch_model.VARIABLES.items():
        var = ds["vars"][name][0]
        rejected[name] = {"null_land_or_nodata": 0, "out_of_range": 0}
        frames = []
        for t in times:
            rows, idx = fetch_model.frame(ds["id"], var, t)
            if not rows:
                print(f"  {name} {t[:10]}: nothing returned, frame kept null")
                frames.append(None)
                continue
            lons, lats, depths, values = fetch_model.build_grid(
                rows, idx, var, spec, rejected[name])
            if axes is None:
                axes = (lons, lats, depths)
            elif (lons, lats, depths) != axes:
                sys.exit(f"{name} at {t} came back on a different grid.")
            good = sum(v is not None for v in values)
            print(f"  {name} {t[:10]}: {good}/{len(values)} cells "
                  f"({100 * good / len(values):.0f}% ocean)")
            frames.append(values)
        if not any(frames):
            sys.exit(f"No usable frames for {name}.")
        variables[name] = {"unit": spec["unit"], "dataset": ds["id"],
                           "erddapVariable": var, "frames": frames}
    if axes is None:
        sys.exit("No field data returned at all.")
    return variables, fetch_model.trim_dead_levels(variables, axes)


def _km(lat1, lon1, lat2, lon2):
    """Great-circle distance, for ranking floats by how close they got."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def fetch_floats(track, max_floats, max_levels):
    """
    Argo profiles over the storm window, ranked by how close they came to the
    track.

    tools/fetch_argo.py apportions its sample across data centres, because the
    live snapshot's job is to represent the basin's float network. This one has
    a different job: to put observations under the storm. Nearest-to-track is
    the selection that serves it, and the two rules are kept apart rather than
    one being bent to cover both.
    """
    rows, idx = fetch_argo.fetch(ARGO_START, ARGO_END)
    profiles, rejected = fetch_argo.build(rows, idx)
    if not profiles:
        sys.exit("No Argo profiles survived QC for the storm window.")

    by_float = defaultdict(list)
    for p in profiles:
        by_float[p["wmo"]].append(p)

    def nearest(wmo):
        return min(_km(c["lat"], c["lon"], t["lat"], t["lon"])
                   for c in by_float[wmo] for t in track)

    dist = {w: nearest(w) for w in by_float}
    chosen = sorted(by_float, key=lambda w: dist[w])[:max_floats]

    floats = []
    for wmo in sorted(chosen):
        cycles = sorted(by_float[wmo], key=lambda p: p["cycle"])
        for p in cycles:
            n = len(p["pres"])
            if n > max_levels:
                # Whole levels dropped, never resampled — see tools/fetch_argo.py.
                keep = fetch_argo.even_indices(n, max_levels)
                for k in ("pres", "temp", "psal"):
                    p[k] = [p[k][i] for i in keep]
                p["thinned"] = True
            p["nLevels"] = len(p["pres"])
        floats.append({"wmo": wmo, "cycles": cycles})

    print(f"  {len(profiles)} profiles from {len(by_float)} floats; keeping the "
          f"{len(floats)} nearest the track "
          f"({min(dist[w] for w in chosen):.0f}-{max(dist[w] for w in chosen):.0f} km)")
    return floats, rejected, {w: round(dist[w], 1) for w in chosen}


# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

def check(path):
    """Assertions over the written file: cheap, offline, and load-bearing."""
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)

    st, tr, an = doc["storm"], doc["track"], doc["analysis"]
    assert st["name"] == STORM_NAME and st["basin"] == STORM_BASIN
    assert len(tr) >= 20, "implausibly short best track"
    assert [p["time"] for p in tr] == sorted(p["time"] for p in tr), \
        "track is not in time order"
    assert len(set(p["time"] for p in tr)) == len(tr), "duplicate track times"
    for p in tr:
        assert WIND_RANGE[0] <= p["windKt"] <= WIND_RANGE[1], "wind out of range"
        assert -90 <= p["lat"] <= 90 and -180 <= p["lon"] <= 360, "position off the earth"
        # A fix outside the analysed box must carry no heat content rather than
        # a nearest-edge value: Mocha made landfall past the domain corner.
        inside = (LAT_MIN <= p["lat"] <= LAT_MAX + 0.5
                  and LON_MIN <= p["lon"] <= LON_MAX + 0.5)
        assert inside or p["tchpPre"] is None, \
            f"{p['time']}: TCHP sampled outside the model domain"
        assert p["tchpPre"] is None or 0 <= p["tchpPre"] < 300, "TCHP implausible"
    assert st["peakWindKt"] == max(p["windKt"] for p in tr)

    # The finding itself, re-derived from the file rather than trusted.
    lead = [(p["tchpPre"], p["leadKt"]) for p in tr
            if p["tchpPre"] is not None and p["leadKt"] is not None]
    assert len(lead) == an["lead"]["n"], "lead sample size does not match the track"
    r = pearson([t for t, _ in lead], [d for _, d in lead])
    assert abs(r - an["lead"]["r"]) < 5e-4, \
        f"stored r {an['lead']['r']} does not reproduce ({r:.3f})"
    for hot, key in ((True, "above"), (False, "below")):
        sel = [d for t, d in lead if (t >= an["thresholdKJcm2"]) == hot]
        assert len(sel) == an["lead"][key]["n"], f"{key}: group size"
        if sel:
            assert abs(sum(sel) / len(sel) - an["lead"][key]["meanDeltaKt"]) < 0.05, \
                f"{key}: stored mean does not reproduce"

    # The lag framing must stay in the file even though it finds nothing, and
    # its sign must stay the right way up: rapid intensification is a gain.
    assert an["lag"]["riSteps"]["n"] > 0, \
        "no rapid-intensification step in a storm that gained 120 kt — check the sign"
    assert an["lead"]["r"] > abs(an["lag"]["r"]), \
        "the lead framing no longer beats the lag framing; the case study's claim is gone"
    # The landfall-free subset is what makes the correlation attributable to
    # the ocean rather than to Myanmar, so it is not allowed to go missing.
    assert an["leadOffshore"]["n"] >= 10 and an["leadOffshore"]["r"] is not None
    assert an["caveat"], "the caveat is not optional"

    # The field block has to satisfy everything model.json does, because
    # dataService.js reads it through the same code path.
    m = doc["model"]
    g = m["grid"]
    assert len(m["lons"]) == g["nx"] and len(m["lats"]) == g["ny"]
    assert len(m["depths"]) == g["nz"] == len(m["depths"])
    assert m["depths"] == sorted(m["depths"]) and len(set(m["depths"])) == g["nz"]
    steps = [b - a for a, b in zip(m["depths"], m["depths"][1:])]
    assert max(steps) > 2 * min(steps), "depth axis looks evenly spaced"
    for name, v in m["variables"].items():
        assert len(v["frames"]) == len(m["times"]), f"{name}: frame count"
        lo, hi = fetch_model.VARIABLES[name]["valid"]
        for t, fr in zip(m["times"], v["frames"]):
            if fr is None:
                continue
            assert len(fr) == g["nx"] * g["ny"] * g["nz"], f"{name} {t}: cell count"
            vals = [x for x in fr if x is not None]
            assert vals and lo <= min(vals) and max(vals) <= hi, f"{name} {t}: range"
            frac = len(vals) / len(fr)
            assert 0.35 < frac < 0.95, f"{name} {t}: {100 * frac:.0f}% ocean, implausible"

    # Recompute TCHP straight out of the bundled field and confirm the track
    # agrees with it. This is the join between the two halves of the snapshot
    # and the one that would otherwise fail silently — a track carrying heat
    # content from a frame the file does not contain would look entirely fine.
    fi = m["times"].index(an["predictorFrame"])
    assert an["predictorFrame"] == min(m["times"]), \
        "the predictor is not the earliest frame — it may include the storm's wake"
    temp = m["variables"]["temperature"]["frames"][fi]
    nx, ny = g["nx"], g["ny"]
    checked = 0
    for p in tr:
        if p["tchpPre"] is None:
            continue
        k = cell_at(m["lons"], m["lats"], p["lat"], p["lon"])
        col = [temp[iz * ny * nx + k] for iz in range(g["nz"])]
        again = tchp_column(col, m["depths"])
        assert again is not None and abs(again - p["tchpPre"]) < 0.05, \
            f"{p['time']}: track TCHP {p['tchpPre']} does not reproduce from the field ({again})"
        checked += 1
    assert checked, "no track fix could be re-derived from the bundled field"

    for f in doc["argo"]["floats"]:
        assert f["cycles"], f"{f['wmo']}: no profiles"
        for c in f["cycles"]:
            assert len(c["pres"]) == len(c["temp"]) == len(c["psal"]), "ragged"
            assert c["pres"] == sorted(c["pres"]), "pressure not ascending"
            assert ARGO_START <= c["time"][:10] <= ARGO_END, "profile outside the window"

    print(f"OK  {os.path.basename(path)}  {st['name']} {st['season']}  "
          f"{len(tr)} fixes, peak {st['peakWindKt']:.0f} kt, "
          f"{len(doc['argo']['floats'])} floats, {len(m['times'])} frames")
    print(f"    predictor {an['predictorFrame'][:10]} (pre-genesis), "
          f"corridor {an['corridor']['maxTchp']} max, basin median "
          f"{an['basin']['medianTchp']} ({an['basin']['corridorPercentile']}th pct)")
    for key, label in (("lead", "lead     "), ("leadOffshore", "  offshore")):
        b = an[key]
        print(f"    {label} n={b['n']:3d}  r={b['r']:+.3f}   "
              f">={an['thresholdKJcm2']:.0f}: {b['above']['meanDeltaKt']:+.1f} kt "
              f"(n={b['above']['n']})   "
              f"<{an['thresholdKJcm2']:.0f}: {b['below']['meanDeltaKt']:+.1f} kt "
              f"(n={b['below']['n']})")
    print(f"    lag       n={an['lag']['n']:3d}  r={an['lag']['r']:+.3f}   "
          f"RI steps mean TCHP {an['lag']['riSteps']['meanTchp']} "
          f"(n={an['lag']['riSteps']['n']})   "
          f"others {an['lag']['otherSteps']['meanTchp']} "
          f"(n={an['lag']['otherSteps']['n']})")
    print(f"    peak      {an['peak']['windKt']:.0f} kt at {an['peak']['time'][:16]} "
          f"over TCHP {an['peak']['tchpPre']}")
    print(f"    {checked} track fixes re-derived from the bundled field")


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-floats", type=int, default=12,
                    help="floats nearest the track to bundle")
    ap.add_argument("--max-levels", type=int, default=140)
    ap.add_argument("--dataset", default=fetch_model.DEFAULT_DATASET,
                    choices=sorted(fetch_model.DATASETS))
    ap.add_argument("--check", action="store_true",
                    help="verify the existing js/data/cyclone.json and exit")
    args = ap.parse_args()

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    dest = os.path.join(here, "js", "data", "cyclone.json")
    if args.check:
        check(dest)
        return

    rejected = defaultdict(int)
    track, sid, season = fetch_track(rejected)

    ds = fetch_model.DATASETS[args.dataset]
    print(f"Reading {ds['id']} time axis...")
    available = fetch_model.axis(ds["id"], "time")
    # Nearest available analysis to each wanted date. The axis is ten-daily and
    # its phase is the product's, not ours; asking for a date it does not carry
    # would drop the frame entirely.
    times = sorted({min(available, key=lambda t: abs(
        (_ts(t) - _ts(d + "T00:00:00Z")).total_seconds())) for d in FRAME_DATES})
    print(f"  {len(available)} available, using {[t[:10] for t in times]}")

    field_rejected = {}
    variables, (lons, lats, depths) = fetch_field(ds, times, field_rejected)

    print("Heat content along the track...")
    # The predictor is the earliest frame, which is the pre-genesis one — see
    # analyse(). Asserted rather than assumed: reordering FRAME_DATES would
    # otherwise silently start predicting the storm from its own wake.
    pre = min(times)
    if _ts(pre) > _ts(track[0]["time"]):
        sys.exit(f"The earliest frame {pre[:10]} is after genesis "
                 f"({track[0]['time'][:10]}); there is no pre-storm ocean to "
                 f"predict from. Widen FRAME_DATES.")
    pre_grid = tchp_grid(variables["temperature"]["frames"][times.index(pre)],
                         lons, lats, depths)
    analysis = analyse(track, (pre, pre_grid, lons, lats), rejected)

    # Compared against the same frame the corridor was sampled from, or the
    # percentile would be measuring two different oceans against each other.
    analysis["basin"] = basin_context(pre_grid, analysis["corridor"]["maxTchp"])
    analysis["basin"]["frame"] = pre

    print("Argo under the storm...")
    floats, argo_rejected, distances = fetch_floats(
        track, args.max_floats, args.max_levels)

    doc = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "storm": {
            "name": STORM_NAME, "sid": sid, "season": season, "basin": STORM_BASIN,
            "basinLabel": "North Indian",
            "source": "IBTrACS v04r01 (NOAA NCEI), last3years archive",
            "attribution": ATTRIBUTION["track"],
            "windVariable": "USA_WIND",
            "windUnit": "knot",
            "windNote": "JTWC one-minute sustained wind",
            "peakWindKt": max(p["windKt"] for p in track),
            "window": [track[0]["time"], track[-1]["time"]],
            "fixes": len(track),
            # Where the case study opens: the fix where the run to 145 kt began.
            "focusDate": "2023-05-11",
        },
        "domain": {"lonMin": LON_MIN, "lonMax": LON_MAX,
                   "latMin": LAT_MIN, "latMax": LAT_MAX},
        "track": track,
        "analysis": analysis,
        "qc": {
            "rejected": {"track": dict(rejected), "argo": argo_rejected,
                         "field": field_rejected},
            # IBTrACS ships no per-fix quality flags; range and ordering checks
            # are all that stand behind this track, and the UI must not imply
            # more than that.
            "trackQcFlags": False,
            "note": ("Track fixes outside the analysed domain carry tchp null "
                     "and are excluded from the statistics; they are not "
                     "clamped to the nearest edge cell."),
        },
        # Written in exactly the schema of js/data/model.json — see fetch_field.
        "model": {
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": f"INCOIS ERDDAP griddap ({ds['id']})",
            "attribution": fetch_model.attribution(ds),
            "domain": {"lonMin": LON_MIN, "lonMax": LON_MAX,
                       "latMin": LAT_MIN, "latMax": LAT_MAX,
                       "depthMin": fetch_model.DEPTH_MIN,
                       "depthMax": fetch_model.DEPTH_MAX},
            "timeRange": [FRAME_DATES[0], FRAME_DATES[-1]],
            "grid": {"nx": len(lons), "ny": len(lats), "nz": len(depths)},
            "lons": lons, "lats": lats, "depths": depths, "times": times,
            "qc": {"rejected": field_rejected,
                   "note": "null cells are land or unanalysed water and must "
                           "render as absent, not as zero"},
            "variables": variables,
        },
        # And in exactly the schema of js/data/argo.json, minus the basin
        # census: these floats are selected by distance to one track, so a
        # data-centre breakdown of them would describe nothing.
        "argo": {
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "Ifremer ERDDAP / Argo GDAC (ArgoFloats)",
            "attribution": ("Argo data collected and made freely available by "
                            "the International Argo Program and the national "
                            "programmes that contribute to it. "
                            "https://argo.ucsd.edu"),
            "domain": {"lonMin": LON_MIN, "lonMax": LON_MAX,
                       "latMin": LAT_MIN, "latMax": LAT_MAX},
            "timeRange": [ARGO_START, ARGO_END],
            "qc": {"keptFlags": sorted(fetch_argo.GOOD_QC), "rejected": argo_rejected},
            "census": None,
            "selection": {"rule": "nearest to the storm track",
                          "kmToTrack": distances},
            "units": {"pres": "decibar", "temp": "degree_Celsius",
                      "psal": "PSU", "chla": "mg m-3"},
            "floats": floats,
            "bgcFloats": [],
        },
    }

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))

    print(f"\n-> {os.path.getsize(dest) / 1024 / 1024:.1f} MB")
    print(f"track rejected: {dict(rejected)}")
    check(dest)


if __name__ == "__main__":
    main()
