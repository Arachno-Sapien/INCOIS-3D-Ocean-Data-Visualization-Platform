#!/usr/bin/env python3
"""
Fetch real glider, CTD and mooring observations and write js/data/instruments.json.

These are the three instrument classes the app used to generate. Each comes from
a different server with a different schema and, more importantly, a different
relationship to the present:

  moorings  OSMC ERDDAP `OSMCV4_DUO_PROFILES`, moored buoys only.
            The Indian OMNI network, reporting nine-level temperature and
            salinity profiles from 10 m to 500 m every three hours, current to
            within hours. Note the *other* OSMC dataset, OSMCV4_DUO_TIME_SERIES,
            carries these same buoys with `observation_depth` 0 and nothing in
            `ztmp` — it is a surface feed, and using it would have made a
            profiling buoy look like a thermometer.

  gliders   Ifremer ERDDAP `OceanGlidersGDACTrajectories`.
            Seven deployments have ever entered this domain: five in the Bay of
            Bengal around 8N in mid-2016, two in the Gulf of Oman in 2021-22.
            Nothing since 2022-10-14. They are bundled at their true dates and
            the UI states how far that is from the model frame, which is the
            same treatment a float profile gets.

  ctd       OSMC ERDDAP `cchdo_ctd` (CCHDO / GO-SHIP).
            Ship-lowered casts, 1989 to 2025, 21 cruises in this domain. A
            cruise is treated as the platform and each cast as one of its
            profiles, so the markers draw the section line the ship actually
            steamed.

    python tools/fetch_instruments.py
    python tools/fetch_instruments.py --mooring-days 45 --max-dives 30
    python tools/fetch_instruments.py --check

WHY THE WINDOWS DIFFER
----------------------
tools/fetch_argo.py and tools/fetch_model.py both default to the last six
months, because both of their sources are current. Two of these three are not.
Applying one rolling window here would return an empty file for gliders and
CTD and quietly delete them from the app, so each source takes the window it
actually has data in and the result records which. An instrument class that
stopped reporting in 2022 is a fact about the ocean observing network, not a
bug to paper over.

QUALITY CONTROL
---------------
Only the CTD source ships usable per-level flags (WOCE: 2 is acceptable, 6 is
interpolated, 3/4 questionable or bad). Flag 2 only is kept — an interpolated
level is a value nobody measured, which is the same reason the Argo fetcher
keeps flags 1 and 2 and nothing else.

The glider aggregate returns TEMP_QC and PSAL_QC entirely null for these
deployments and fills TEMP_UNCERTAINTY with 99999, so there is nothing to
filter on. Range checks and a monotonic-pressure requirement do the work
instead, and the output says `qcFlags: false` so the UI cannot imply a
quality-controlled profile it did not get.
"""

import argparse
import http.client
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone

IFREMER = "https://erddap.ifremer.fr/erddap/tabledap"
OSMC = "https://osmc.noaa.gov/erddap/tabledap"

# Must match DOMAIN in js/constants.js (and the other two fetchers)
LON_MIN, LON_MAX = 55.0, 95.0
LAT_MIN, LAT_MAX = -10.0, 25.0
DEPTH_MAX = 2000.0

TEMP_RANGE = (-2.5, 36.0)     # degC
PSAL_RANGE = (0.0, 42.0)      # PSU
CTD_GOOD_QC = {2}             # WOCE: acceptable. 6 is interpolated, not measured.
GLIDER_FILL = 99999           # what the GDAC aggregate puts in empty columns
SURFACE_DBAR = 5.0            # above this a glider is between dives, not in one

ATTRIBUTION = {
    "glider": ("OceanGliders Global Data Assembly Centre, served via Ifremer "
               "ERDDAP. https://www.ocean-ops.org/oceangliders"),
    "ctd": ("CCHDO / GO-SHIP hydrographic CTD data, served via the NOAA "
            "Observing System Monitoring Center ERDDAP. https://cchdo.ucsd.edu"),
    "mooring": ("Moored buoy profiles distributed on the GTS and served via the "
                "NOAA Observing System Monitoring Center ERDDAP. The Indian "
                "buoys are the OMNI network operated by NIOT under the Ministry "
                "of Earth Sciences. https://osmc.noaa.gov"),
}


def get(base, dataset, query, timeout=300):
    """
    One ERDDAP tabledap request, as (rows, column-index map).

    404 is ERDDAP's "your query was valid and matched nothing", which for an
    instrument class that has not visited this basin lately is a real answer
    rather than a failure. Anything else is a broken query and must be loud.
    """
    # The double quote around a string constraint must be percent-encoded, as
    # must the spaces inside it: Tomcat rejects both raw in a request target
    # with a bare 400, before ERDDAP sees the query at all.
    url = f"{base}/{dataset}.json?" + urllib.parse.quote(query, safe="=&,.:-()")
    # One retry, and only for a connection that died mid-body. A single CTD
    # cruise is 16-25 MB and a truncated read killed a whole run once; a
    # genuinely bad query still fails on the first attempt, because HTTPError
    # is handled below and never retried.
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                table = json.loads(r.read().decode("utf-8"))["table"]
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return [], {}
            raise RuntimeError(
                f"{dataset} query failed with HTTP {e.code} (not an empty result):\n"
                f"{url[:200]}\n{e.read().decode('utf-8', 'replace')[:300]}"
            ) from e
        except (http.client.IncompleteRead, urllib.error.URLError,
                json.JSONDecodeError, TimeoutError) as e:
            if attempt == 2:
                raise RuntimeError(
                    f"{dataset} transfer failed twice: {type(e).__name__}\n{url[:200]}"
                ) from e
            print(f"    transfer interrupted ({type(e).__name__}), retrying once")
    return table["rows"], {n: i for i, n in enumerate(table["columnNames"])}


def bbox(t_from=None, t_to=None):
    q = (f"&longitude>={LON_MIN}&longitude<={LON_MAX}"
         f"&latitude>={LAT_MIN}&latitude<={LAT_MAX}")
    if t_from:
        q += f"&time>={t_from}T00:00:00Z"
    if t_to:
        q += f"&time<={t_to}T00:00:00Z"
    return q


def even_indices(n, max_n):
    """
    Indices of at most max_n items spread evenly across n, both ends kept.

    `int(i * n / max_n)` never reaches the last index. Thinning 1001 CTD levels
    to 120 stopped at index 992, so every cast ended 16 dbar above where the
    instrument did; subsampling a three-hourly mooring feed dropped the newest
    eight casts, a full day off a source the app calls current. Anchoring on
    n - 1 keeps the deepest level and the latest cast, which are the two the
    rest of this app most depends on.
    """
    if n <= max_n:
        return list(range(n))
    if max_n <= 1:
        return [n - 1]
    return sorted({round(i * (n - 1) / (max_n - 1)) for i in range(max_n)})


def thin(cols, n, max_n):
    """
    Reduce a profile to at most max_n levels by dropping whole levels.

    Deliberately not interpolation or averaging, matching tools/fetch_argo.py:
    resampling onto nominal depths would emit numbers the instrument never
    recorded, at depths it never visited.
    """
    if n <= max_n:
        return cols, False
    keep = even_indices(n, max_n)
    return [[c[i] for i in keep] for c in cols], True


def clean(pres, temp, psal, rejected):
    """
    Shared level QC: drop unusable levels, order by pressure, remove repeats.

    Salinity is optional per level — a level with good temperature and bad
    salinity keeps the temperature and nulls the salinity, rather than the
    whole level being thrown away.
    """
    keep = []
    for p, t, s in zip(pres, temp, psal):
        # Fill sentinels first: 99999 is also greater than DEPTH_MAX, so the
        # depth test used to claim them and the ledger reported a GDAC fill
        # value as an ordinary level below the domain floor.
        if p == GLIDER_FILL or t == GLIDER_FILL:
            rejected["fill_value"] += 1
            continue
        if p is None or t is None or p > DEPTH_MAX:
            rejected["missing_or_below_domain"] += 1
            continue
        if not (TEMP_RANGE[0] <= t <= TEMP_RANGE[1]):
            rejected["temp_range"] += 1
            continue
        if s is not None and (s == GLIDER_FILL
                              or not (PSAL_RANGE[0] <= s <= PSAL_RANGE[1])):
            rejected["psal_range"] += 1
            s = None
        keep.append((round(p, 1), round(t, 3), None if s is None else round(s, 3)))

    keep.sort(key=lambda r: r[0])
    # A repeated pressure after sorting means duplicated levels, which draw a
    # flat rung across the profile plot.
    out = [keep[0]] if keep else []
    for r in keep[1:]:
        if r[0] > out[-1][0]:
            out.append(r)
        else:
            rejected["duplicate_pressure"] += 1
    return ([r[0] for r in out], [r[1] for r in out], [r[2] for r in out])


# ---------------------------------------------------------------------------
# Moorings
# ---------------------------------------------------------------------------

def fetch_moorings(days, max_casts, rejected):
    """
    Indian OMNI and tropical moored buoys, as nine-level T/S profiles.

    Filtered to moored platforms server-side: the same dataset is dominated by
    Argo floats, which this app already draws from the GDAC, and pulling them
    twice would double-plot the same instrument under two different labels.
    """
    start = (datetime.now(timezone.utc).date() - timedelta(days=days)).isoformat()
    out = []
    for kind in ('MOORED BUOYS (GENERIC)', 'TROPICAL MOORED BUOYS'):
        q = ("platform_code,platform_type,country,time,latitude,longitude,"
             "depth,ztmp,zsal" + bbox(start) + f'&platform_type="{kind}"')
        rows, idx = get(OSMC, "OSMCV4_DUO_PROFILES", q)
        print(f"  {kind}: {len(rows)} levels")
        if not rows:
            continue

        casts = defaultdict(list)
        for r in rows:
            casts[(r[idx["platform_code"]], r[idx["time"]])].append(r)

        by_platform = defaultdict(list)
        for (code, when), levels in casts.items():
            pres, temp, psal = clean(
                [l[idx["depth"]] for l in levels],
                [l[idx["ztmp"]] for l in levels],
                [l[idx["zsal"]] for l in levels], rejected)
            if len(pres) < 3:
                rejected["too_few_levels"] += 1
                continue
            head = levels[0]
            by_platform[code].append({
                "time": when,
                "lat": round(head[idx["latitude"]], 4),
                "lon": round(head[idx["longitude"]], 4),
                "country": head[idx["country"]],
                # Reported as depth in metres, not pressure. Kept distinct from
                # the Argo path, which carries decibars.
                "depths": pres, "temp": temp, "psal": psal,
                "nLevels": len(pres),
            })

        for code, casts_list in by_platform.items():
            casts_list.sort(key=lambda c: c["time"])
            # Evenly spaced across the window rather than the newest run of
            # them: a buoy reports every three hours, and the app picks the
            # cast nearest the selected date.
            if len(casts_list) > max_casts:
                casts_list = [casts_list[i] for i in even_indices(len(casts_list), max_casts)]
            out.append({
                "id": code,
                "kind": kind,
                "country": casts_list[-1]["country"] or "UNKNOWN",
                "cycles": casts_list,
            })
    return out, start


# ---------------------------------------------------------------------------
# Gliders
# ---------------------------------------------------------------------------

def fetch_gliders(max_dives, max_levels, rejected):
    """
    Glider dives, one profile per descent.

    The GDAC serves a trajectory: a continuous ~1 Hz stream, 47,000 samples for
    three days of one deployment. That is not what the app draws. Each descent
    between two surfacings is one profile, which is the same object an Argo
    cycle is, so it flows through the existing contract untouched.
    """
    q = "platform_deployment,time,latitude,longitude" + bbox() + "&distinct()"
    rows, idx = get(IFREMER, "OceanGlidersGDACTrajectories", q, timeout=600)
    if not rows:
        print("  no glider deployments have entered this domain")
        return []
    names = sorted({r[idx["platform_deployment"]] for r in rows})
    print(f"  {len(names)} deployments: {', '.join(names)}")

    out = []
    for name in names:
        q = ("platform_deployment,time,latitude,longitude,PRES,TEMP,PSAL"
             + bbox() + f'&platform_deployment="{name}"')
        rows, idx = get(IFREMER, "OceanGlidersGDACTrajectories", q, timeout=600)
        if not rows:
            continue
        rows.sort(key=lambda r: r[idx["time"]])

        # Split at surfacings; each span between them is one dive.
        segs, cur = [], []
        for r in rows:
            p = r[idx["PRES"]]
            if p is None or p == GLIDER_FILL:
                continue
            if p < SURFACE_DBAR:
                if cur:
                    segs.append(cur)
                    cur = []
                continue
            cur.append(r)
        if cur:
            segs.append(cur)

        dives = []
        for seg in segs:
            # The descent only: from the start of the dive to its deepest
            # sample. Keeping the ascent too would fold two profiles, taken
            # minutes and a kilometre apart, into one column.
            deepest = max(range(len(seg)), key=lambda i: seg[i][idx["PRES"]])
            desc = seg[:deepest + 1]
            pres, temp, psal = clean(
                [r[idx["PRES"]] for r in desc],
                [r[idx["TEMP"]] for r in desc],
                [r[idx["PSAL"]] for r in desc], rejected)
            if len(pres) < 10:
                rejected["too_few_levels"] += 1
                continue
            (pres, temp, psal), thinned = thin([pres, temp, psal], len(pres), max_levels)
            head = desc[0]
            dives.append({
                "time": head[idx["time"]],
                "lat": round(head[idx["latitude"]], 4),
                "lon": round(head[idx["longitude"]], 4),
                "pres": pres, "temp": temp, "psal": psal,
                "nLevels": len(pres), "thinned": thinned,
            })

        if not dives:
            continue
        if len(dives) > max_dives:
            dives = [dives[i] for i in even_indices(len(dives), max_dives)]
        print(f"    {name}: {len(segs)} dives -> {len(dives)} kept, "
              f"{dives[0]['time'][:10]} to {dives[-1]['time'][:10]}")
        out.append({"id": name, "cycles": dives})
    return out


# ---------------------------------------------------------------------------
# CTD
# ---------------------------------------------------------------------------

def fetch_ctd(max_cruises, max_casts, max_levels, rejected):
    """
    Ship CTD casts, grouped by cruise.

    A cruise is the platform and its casts are the profiles, so the markers
    trace the section the ship steamed rather than scattering 1,144 unrelated
    dots. The most recent cruises are kept: GO-SHIP reoccupies the same lines
    for decades, and the newest occupation is the one worth showing beside a
    current model field.
    """
    # Bounded server-side as well as in clean(). GO-SHIP casts reach 5,482 dbar
    # and everything below the domain floor is discarded anyway, so asking for
    # it only makes a 25 MB response out of a 9 MB one.
    q = ("expocode,station,cast,time,latitude,longitude,pressure,"
         "ctd_temperature,ctd_temperature_qc,ctd_salinity,ctd_salinity_qc"
         + bbox() + f"&pressure<={DEPTH_MAX}")
    # Which cruises exist, newest first, before pulling any levels.
    rows, idx = get(OSMC, "cchdo_ctd",
                    "expocode,time" + bbox() + "&distinct()", timeout=600)
    if not rows:
        print("  no CTD casts in this domain")
        return []
    latest = {}
    for r in rows:
        e, t = r[idx["expocode"]], r[idx["time"]]
        if e not in latest or t > latest[e]:
            latest[e] = t
    cruises = sorted(latest, key=lambda e: latest[e], reverse=True)[:max_cruises]
    print(f"  {len(latest)} cruises in domain, keeping {len(cruises)}: "
          + ", ".join(f"{e} ({latest[e][:7]})" for e in cruises))

    out = []
    for exp in cruises:
        rows, idx = get(OSMC, "cchdo_ctd", q + f'&expocode="{exp}"', timeout=600)
        if not rows:
            continue
        casts = defaultdict(list)
        for r in rows:
            casts[(r[idx["station"]], r[idx["cast"]])].append(r)

        keep = []
        for (station, cast), levels in sorted(casts.items()):
            pres, temp, psal = [], [], []
            for l in levels:
                tq, sq = l[idx["ctd_temperature_qc"]], l[idx["ctd_salinity_qc"]]
                if tq not in CTD_GOOD_QC:
                    rejected["ctd_temp_qc"] += 1
                    continue
                pres.append(l[idx["pressure"]])
                temp.append(l[idx["ctd_temperature"]])
                # Flag 6 is interpolated: a number nobody measured, dropped on
                # the same principle the Argo fetcher drops raw fluorescence.
                psal.append(l[idx["ctd_salinity"]] if sq in CTD_GOOD_QC else None)
                if sq not in CTD_GOOD_QC:
                    rejected["ctd_psal_qc"] += 1
            pres, temp, psal = clean(pres, temp, psal, rejected)
            if len(pres) < 10:
                rejected["too_few_levels"] += 1
                continue
            (pres, temp, psal), thinned = thin([pres, temp, psal], len(pres), max_levels)
            head = levels[0]
            keep.append({
                "station": str(station), "cast": str(cast),
                "time": head[idx["time"]],
                "lat": round(head[idx["latitude"]], 4),
                "lon": round(head[idx["longitude"]], 4),
                "pres": pres, "temp": temp, "psal": psal,
                "nLevels": len(pres), "thinned": thinned,
            })
        if not keep:
            continue
        keep.sort(key=lambda c: c["time"])
        if len(keep) > max_casts:
            keep = [keep[i] for i in even_indices(len(keep), max_casts)]
        print(f"    {exp}: {len(casts)} casts -> {len(keep)} kept, "
              f"{keep[0]['time'][:10]}, max {max(c['pres'][-1] for c in keep):.0f} dbar")
        out.append({"id": exp, "cycles": keep})
    return out


def check(path):
    """Assertions over the written file: cheap, offline, and load-bearing."""
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)

    # The mooring/glider vertical unit is load-bearing downstream: js/charts.js
    # picks its axis label from whether pressureDbar is set, so a class silently
    # switching metres for decibars would ship a chart captioned "Pressure
    # (dbar)" over metres.
    units = {"gliders": ("glider", "decibar", "pres"),
             "ctd": ("ctd", "decibar", "pres"),
             "moorings": ("mooring", "metre", "depths")}
    for key, (src, unit, depth_key) in units.items():
        assert doc["sources"][src]["verticalUnit"] == unit, \
            f"{key}: verticalUnit is not {unit}"
        for p in doc[key]:
            for c in p["cycles"]:
                assert depth_key in c, f"{key}: cycles carry the wrong depth key"

    total = 0
    for key, depth_key in (("gliders", "pres"), ("ctd", "pres"),
                           ("moorings", "depths")):
        for p in doc[key]:
            assert p["cycles"], f"{key} {p['id']}: no profiles"
            for c in p["cycles"]:
                d, t = c[depth_key], c["temp"]
                assert len(d) == len(t) == len(c["psal"]), \
                    f"{key} {p['id']} {c['time']}: ragged arrays"
                assert d == sorted(d), f"{key} {p['id']}: depth not ascending"
                assert len(set(d)) == len(d), f"{key} {p['id']}: repeated depth"
                assert d[-1] <= DEPTH_MAX, f"{key} {p['id']}: below the domain"
                assert all(TEMP_RANGE[0] <= v <= TEMP_RANGE[1] for v in t), \
                    f"{key} {p['id']}: temperature out of range"
                assert LAT_MIN <= c["lat"] <= LAT_MAX, f"{key} {p['id']}: lat"
                assert LON_MIN <= c["lon"] <= LON_MAX, f"{key} {p['id']}: lon"
                # Surface warmer than depth, wherever the profile spans enough
                # of the water column to say so.
                if d[-1] - d[0] > 300:
                    assert t[0] > t[-1], f"{key} {p['id']}: inverted profile"
                total += 1
    print(f"OK  {os.path.basename(path)}  "
          f"{len(doc['gliders'])} gliders / {len(doc['ctd'])} cruises / "
          f"{len(doc['moorings'])} moorings, {total} profiles")
    for k, v in doc["sources"].items():
        print(f"    {k:8s} {v['window'][0]} to {v['window'][1]}  "
              f"qcFlags={v['qcFlags']}  {v['dataset']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mooring-days", type=int, default=45,
                    help="moorings are live, so they take a rolling window; "
                         "gliders and CTD take whatever they have")
    ap.add_argument("--max-casts", type=int, default=40)
    ap.add_argument("--max-dives", type=int, default=30)
    ap.add_argument("--max-cruises", type=int, default=5)
    ap.add_argument("--max-levels", type=int, default=120)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    dest = os.path.join(here, "js", "data", "instruments.json")
    if args.check:
        check(dest)
        return

    rejected = {k: defaultdict(int) for k in ("glider", "ctd", "mooring")}

    print("Moorings (OSMC, moored buoys only)...")
    moorings, mooring_start = fetch_moorings(
        args.mooring_days, args.max_casts, rejected["mooring"])
    print("Gliders (OceanGliders GDAC)...")
    gliders = fetch_gliders(args.max_dives, args.max_levels, rejected["glider"])
    print("CTD (CCHDO / GO-SHIP)...")
    ctd = fetch_ctd(args.max_cruises, args.max_casts, args.max_levels,
                    rejected["ctd"])

    def span(groups):
        t = [c["time"] for g in groups for c in g["cycles"]]
        return [min(t)[:10], max(t)[:10]] if t else [None, None]

    doc = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "domain": {"lonMin": LON_MIN, "lonMax": LON_MAX,
                   "latMin": LAT_MIN, "latMax": LAT_MAX, "depthMax": DEPTH_MAX},
        "sources": {
            "mooring": {
                "dataset": "OSMC ERDDAP / OSMCV4_DUO_PROFILES (moored buoys)",
                "attribution": ATTRIBUTION["mooring"],
                "window": span(moorings), "requestedFrom": mooring_start,
                "qcFlags": False, "verticalUnit": "metre",
                "note": "nine-level T/S profiles, three-hourly, near real time",
            },
            "glider": {
                "dataset": "Ifremer ERDDAP / OceanGlidersGDACTrajectories",
                "attribution": ATTRIBUTION["glider"],
                "window": span(gliders), "qcFlags": False,
                "verticalUnit": "decibar",
                "note": "one profile per descent; the GDAC serves a continuous "
                        "trajectory, not profiles. No deployment has entered "
                        "this domain since 2022.",
            },
            "ctd": {
                "dataset": "OSMC ERDDAP / cchdo_ctd (CCHDO / GO-SHIP)",
                "attribution": ATTRIBUTION["ctd"],
                "window": span(ctd), "qcFlags": True,
                "verticalUnit": "decibar",
                "note": "WOCE flag 2 only; flag 6 is interpolated and dropped",
            },
        },
        "qc": {"rejected": {k: dict(v) for k, v in rejected.items()},
               "ranges": {"temp": list(TEMP_RANGE), "psal": list(PSAL_RANGE)}},
        "gliders": gliders,
        "ctd": ctd,
        "moorings": moorings,
    }

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))

    kb = os.path.getsize(dest) / 1024
    print(f"\n{len(gliders)} gliders, {len(ctd)} cruises, {len(moorings)} moorings "
          f"-> {kb:.0f} KB")
    for k, v in rejected.items():
        print(f"rejected {k}: {dict(v)}")
    check(dest)


if __name__ == "__main__":
    main()
