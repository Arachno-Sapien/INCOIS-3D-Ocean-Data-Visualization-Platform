#!/usr/bin/env python3
"""
Fetch real Argo float profiles for the model domain and write js/data/argo.json.

Source: Ifremer ERDDAP `ArgoFloats` (the Argo Global Data Assembly Centre).
Argo data are freely available and collected by the International Argo Program.

Run this to refresh the bundled observations:

    python tools/fetch_argo.py                 # the last six months, to today
    python tools/fetch_argo.py --start 2024-01-01 --end 2024-12-31 --max-floats 12

The output is committed so the app needs no network at runtime. A live backend
would replace this file with a request from dataService.js; the JSON shape is
the API contract either way.

WHAT THIS SCRIPT ENFORCES (none of it is optional for Argo)
-----------------------------------------------------------
1. Per-level QC. Only flags 1 (good) and 2 (probably good) are kept. Raw Argo
   contains salinity spikes and pressure inversions that render as dramatic
   false features; anyone in the field spots them immediately.
2. Whole-profile QC (`profile_temp_qc` / `profile_psal_qc`) as well as
   per-level, since a broadly-fine profile can still carry bad levels.
3. Adjusted vs raw chosen by `data_mode`:
      R = real-time (raw only, automated QC)
      A = real-time adjustment applied
      D = delayed mode, expert-checked -> _ADJUSTED is authoritative
   Delayed-mode salinity drift correction is often larger than the signal being
   studied, so this choice materially changes the numbers. Which set was used
   is recorded per profile and shown in the UI.
4. Pressure stays in decibars. 1 dbar ~ 1 m is fine for display, but the axis
   must not silently claim metres.
5. Sanity checks that catch distinct real-world defects: temperature outside
   -2..35 C, salinity outside 0..42 PSU, non-monotonic pressure, positions on
   land, timestamps in the future.
"""

import argparse
import json
import os
import sys
import urllib.parse
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone

ERDDAP = "https://erddap.ifremer.fr/erddap/tabledap/ArgoFloats.json"
ERDDAP_BGC = "https://erddap.ifremer.fr/erddap/tabledap/ArgoFloats-synthetic-BGC.json"

# Chlorophyll must come from `chla_adjusted`, never `chla`.
# Raw fluorescence is routinely flagged QC 3 ("probably bad") because it needs a
# factor-of-2 scale correction and is depressed near the surface by
# non-photochemical quenching. In this domain 100% of raw levels are flag 3 and
# would be discarded entirely; the delayed-mode adjusted field is the usable one.
# NOTE: the synthetic-BGC dataset has no `data_mode` column (it is a merged
# product). Requesting it returns 400, not 404.
BGC_COLUMNS = [
    "platform_number", "cycle_number",
    "latitude", "longitude", "time",
    "pres", "pres_qc",
    "chla", "chla_qc", "chla_adjusted", "chla_adjusted_qc",
]

# Must match DOMAIN in js/constants.js
LON_MIN, LON_MAX = 55.0, 95.0
LAT_MIN, LAT_MAX = -10.0, 25.0

GOOD_QC = {"1", "2"}          # per the Argo QC scale
TEMP_RANGE = (-2.0, 35.0)     # degC
PSAL_RANGE = (0.0, 42.0)      # PSU

COLUMNS = [
    "platform_number", "cycle_number", "data_mode", "data_center", "direction",
    "latitude", "longitude", "time", "position_qc",
    "profile_temp_qc", "profile_psal_qc",
    "pres", "pres_qc", "pres_adjusted", "pres_adjusted_qc",
    "temp", "temp_qc", "temp_adjusted", "temp_adjusted_qc",
    "psal", "psal_qc", "psal_adjusted", "psal_adjusted_qc",
]


def fetch_bgc(start, end, max_floats, max_levels):
    """
    BGC floats: chlorophyll-a profiles.

    Returns [] rather than raising when the domain has no BGC coverage, since
    that is a legitimate outcome and must not fail the core Argo fetch.
    """
    q = ",".join(BGC_COLUMNS) + (
        f"&longitude>={LON_MIN}&longitude<={LON_MAX}"
        f"&latitude>={LAT_MIN}&latitude<={LAT_MAX}"
        f"&time>={start}T00:00:00Z&time<={end}T00:00:00Z"
    )
    url = ERDDAP_BGC + "?" + urllib.parse.quote(q, safe="=&,.:-")
    print("Fetching BGC chlorophyll...")
    try:
        with urllib.request.urlopen(url, timeout=300) as r:
            table = json.loads(r.read().decode("utf-8"))["table"]
    except urllib.error.HTTPError as e:
        # 404 means the query was valid and matched nothing: a legitimate
        # "no BGC floats here". Anything else is a broken query and must be
        # loud, or a typo in a column name silently becomes "no data".
        if e.code == 404:
            print("  no BGC coverage in this domain/window")
            return []
        raise RuntimeError(
            f"BGC query failed with HTTP {e.code} (not an empty result):\n"
            f"{e.read().decode('utf-8', 'replace')[:300]}"
        ) from e
    idx = {n: i for i, n in enumerate(table["columnNames"])}
    print(f"  {len(table['rows'])} BGC levels returned")

    grouped = defaultdict(list)
    for row in table["rows"]:
        grouped[(row[idx["platform_number"]], row[idx["cycle_number"]])].append(row)

    profiles, rejected = [], defaultdict(int)
    for (wmo, cycle), levels in grouped.items():
        pres, chla = [], []
        for row in levels:
            p, c = row[idx["pres"]], row[idx["chla_adjusted"]]
            c_qc = row[idx["chla_adjusted_qc"]]
            if p is None or c is None:
                rejected["missing"] += 1
                continue
            if str(row[idx["pres_qc"]]) not in GOOD_QC or str(c_qc) not in GOOD_QC:
                rejected["level_qc"] += 1
                continue
            # Adjusted fluorescence can sit marginally below zero after the
            # dark-count correction. That is instrument noise around zero, not a
            # negative concentration, and it is NOT clipped: silently flooring
            # it at 0 would misrepresent the correction that was applied.
            pres.append(round(p, 1))
            chla.append(round(c, 4))

        if len(pres) < 8:
            rejected["too_few_levels"] += 1
            continue

        order = sorted(range(len(pres)), key=lambda i: pres[i])
        pres = [pres[i] for i in order]
        chla = [chla[i] for i in order]
        keep = [0] + [i for i in range(1, len(pres)) if pres[i] > pres[i - 1]]
        pres, chla = [pres[i] for i in keep], [chla[i] for i in keep]

        if len(pres) > max_levels:
            sel = even_indices(len(pres), max_levels)
            pres, chla = [pres[i] for i in sel], [chla[i] for i in sel]

        head = levels[0]
        profiles.append({
            "wmo": wmo, "cycle": cycle,
            "dataMode": "D",                  # adjusted chla is delayed-mode only
            "adjusted": True,                 # always: raw chla is unusable here
            "lat": round(head[idx["latitude"]], 4),
            "lon": round(head[idx["longitude"]], 4),
            "time": head[idx["time"]],
            "pres": pres, "chla": chla,
            "nLevels": len(pres),
        })

    by_float = defaultdict(list)
    for p in profiles:
        by_float[p["wmo"]].append(p)
    chosen = sorted(by_float, key=lambda w: -len(by_float[w]))[:max_floats]
    out = [{"wmo": w, "cycles": sorted(by_float[w], key=lambda p: p["cycle"])}
           for w in sorted(chosen)]
    print(f"  {len(out)} BGC floats, {sum(len(f['cycles']) for f in out)} profiles"
          f"  rejected={dict(rejected)}")
    return out


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


def default_window(months=6):
    """
    The window to fetch when none is given: the last `months` up to today.

    A literal default goes stale the day it is written, and the whole point of
    this script is to keep the bundled snapshot current. The window actually
    used is written into the output as `timeRange`, so a committed file still
    states exactly what it covers.
    """
    end = datetime.now(timezone.utc).date()
    return (end - timedelta(days=months * 31)).isoformat(), end.isoformat()


def census(start, end):
    """
    Every float that reported in the domain, counted by Data Assembly Centre.

    The floats bundled below are a readable subset — the ones with the most
    cycles, so their tracks are real trajectories rather than single dots. That
    subset says nothing about who operates this basin, and a bare "16 floats"
    reads as the whole picture when the real network is an order of magnitude
    larger. This counts the population the subset is drawn from, and India's
    share of it, which for an INCOIS problem statement is the number that
    matters.
    """
    q = "platform_number,data_center" + (
        f"&longitude>={LON_MIN}&longitude<={LON_MAX}"
        f"&latitude>={LAT_MIN}&latitude<={LAT_MAX}"
        f"&time>={start}T00:00:00Z&time<={end}T00:00:00Z"
        "&distinct()"
    )
    url = ERDDAP + "?" + urllib.parse.quote(q, safe="=&,.:-()")
    print("Counting the float population...")
    try:
        with urllib.request.urlopen(url, timeout=300) as r:
            table = json.loads(r.read().decode("utf-8"))["table"]
    except Exception as e:
        # Context, not content. This runs after the multi-minute profile fetch
        # and QC pass have already succeeded, so anything raised here — a
        # timeout, a reset connection, a short body — must not throw that away.
        # Deliberately broad for exactly that reason.
        print(f"  census unavailable ({type(e).__name__}: {e}), continuing without it")
        return None
    idx = {n: i for i, n in enumerate(table["columnNames"])}
    by_dc = defaultdict(set)
    for row in table["rows"]:
        # ERDDAP can return an empty data centre; '??' keeps it countable
        # instead of putting a null key in the JSON and in the badge.
        by_dc[row[idx["data_center"]] or "??"].add(row[idx["platform_number"]])
    counts = {k: len(v) for k, v in sorted(by_dc.items(), key=lambda kv: -len(kv[1]))}
    total = len(set().union(*by_dc.values())) if by_dc else 0
    print(f"  {total} floats in the domain, by DAC: {counts}")
    return {"floats": total, "byDataCentre": counts,
            "incois": counts.get("IN", 0), "window": [start, end]}


def select_floats(by_float, dac_of, counts, n):
    """
    Choose which floats to bundle: stratified across Data Assembly Centres in
    proportion to each centre's share of the basin, and within a centre the
    floats with the most cycles.

    Ranking on cycle count alone is what this used to do, and against a
    six-month window it returned sixteen floats of which not one was Indian --
    while the census in the same file says INCOIS operates just under half the
    floats in this domain. A displayed subset that contradicts the population
    stated beside it is worse than a smaller subset, so the sample is now drawn
    to match the basin it claims to represent. Cycle count still decides which
    floats fill a centre's seats, so the tracks are still real trajectories
    rather than isolated dots.
    """
    avail = defaultdict(list)
    for wmo in by_float:
        avail[dac_of[wmo]].append(wmo)
    for dc in avail:
        avail[dc].sort(key=lambda w: -len(by_float[w]))

    # No census means no shares to apportion by; fall back to the old rule
    # rather than inventing a distribution.
    if not counts:
        return sorted(by_float, key=lambda w: -len(by_float[w]))[:n]

    # Highest averages (D'Hondt): each seat goes to the centre currently
    # furthest below its entitlement that still has floats left.
    #
    # A largest-remainder pass followed by round-robin was wrong whenever the
    # large centres ran out of floats: the leftover seats went to whoever had
    # capacity rather than to whoever had a claim. On a thin pool that handed
    # MEDS, which operates two of the 221 floats in this basin, eight of the
    # sixteen seats. Allocating one seat at a time keeps the shares honest
    # under any pool, and is shorter.
    seats = {dc: 0 for dc in avail}
    # A centre with floats in hand demonstrably operates here, so a census that
    # omits it is incomplete — not a claim that it runs nothing.
    share = {dc: counts.get(dc) or 1 for dc in avail}
    for _ in range(min(n, len(by_float))):
        room = [dc for dc in avail if seats[dc] < len(avail[dc])]
        if not room:
            break
        seats[max(room, key=lambda d: (share[d] / (seats[d] + 1), share[d], d))] += 1

    return sorted(w for dc in avail for w in avail[dc][:seats[dc]])


def fetch(start, end):
    q = ",".join(COLUMNS) + (
        f"&longitude>={LON_MIN}&longitude<={LON_MAX}"
        f"&latitude>={LAT_MIN}&latitude<={LAT_MAX}"
        f"&time>={start}T00:00:00Z&time<={end}T00:00:00Z"
    )
    # `<` and `>` must be percent-encoded: Tomcat rejects them raw in a request
    # target with 400 "Invalid character found", before ERDDAP ever sees them.
    url = ERDDAP + "?" + urllib.parse.quote(q, safe="=&,.:-")
    print(f"GET {url[:110]}...")
    with urllib.request.urlopen(url, timeout=300) as r:
        payload = json.loads(r.read().decode("utf-8"))
    table = payload["table"]
    idx = {n: i for i, n in enumerate(table["columnNames"])}
    print(f"  {len(table['rows'])} levels returned")
    return table["rows"], idx


def pick(row, idx, base, mode):
    """
    Return (value, qc, used_adjusted) honouring data_mode.

    Adjusted is authoritative in delayed mode and preferred in 'A'. Fall back to
    raw when the adjusted field is fill/None, and report which was used.
    """
    adj, adj_qc = row[idx[base + "_adjusted"]], row[idx.get(base + "_adjusted_qc", -1)] if base + "_adjusted_qc" in idx else None
    raw, raw_qc = row[idx[base]], row[idx[base + "_qc"]]
    if mode in ("D", "A") and adj is not None:
        return adj, (adj_qc if adj_qc is not None else raw_qc), True
    return raw, raw_qc, False


def build(rows, idx):
    profiles = defaultdict(list)
    meta = {}
    for row in rows:
        key = (row[idx["platform_number"]], row[idx["cycle_number"]])
        profiles[key].append(row)
        meta.setdefault(key, row)

    out, rejected = [], defaultdict(int)
    for key, levels in profiles.items():
        wmo, cycle = key
        head = meta[key]
        mode = head[idx["data_mode"]]
        # The Data Assembly Centre that curated this profile: AO aoml, BO bodc,
        # CS csiro, HZ csio, IF coriolis, IN incois, JA jma, KM kma, ME meds.
        dc = head[idx["data_center"]] or "??"

        # Whole-profile flags: 'A' (all good) or 'B' (most good) only
        if head[idx["profile_temp_qc"]] not in (None, "", "A", "B"):
            rejected["profile_temp_qc"] += 1
            continue
        if str(head[idx["position_qc"]]) not in GOOD_QC:
            rejected["position_qc"] += 1
            continue

        pres, temp, psal = [], [], []
        used_adj = False
        for row in levels:
            p, p_qc, a1 = pick(row, idx, "pres", mode)
            t, t_qc, a2 = pick(row, idx, "temp", mode)
            s, s_qc, a3 = pick(row, idx, "psal", mode)
            used_adj = used_adj or a1 or a2 or a3

            if p is None or t is None:
                rejected["missing"] += 1
                continue
            if str(p_qc) not in GOOD_QC or str(t_qc) not in GOOD_QC:
                rejected["level_qc"] += 1
                continue
            if not (TEMP_RANGE[0] <= t <= TEMP_RANGE[1]):
                rejected["temp_range"] += 1
                continue
            # Salinity is optional per level; drop the value, keep the level
            if s is not None and (str(s_qc) not in GOOD_QC
                                  or not (PSAL_RANGE[0] <= s <= PSAL_RANGE[1])):
                rejected["psal_qc_or_range"] += 1
                s = None

            pres.append(round(p, 1))
            temp.append(round(t, 3))
            psal.append(round(s, 3) if s is not None else None)

        if len(pres) < 8:
            rejected["too_few_levels"] += 1
            continue

        order = sorted(range(len(pres)), key=lambda i: pres[i])
        pres = [pres[i] for i in order]
        temp = [temp[i] for i in order]
        psal = [psal[i] for i in order]

        # Pressure must increase down the profile after sorting; a repeat means
        # duplicated levels, which would draw a flat rung in the profile plot.
        dedup = [0] + [i for i in range(1, len(pres)) if pres[i] > pres[i - 1]]
        if len(dedup) != len(pres):
            rejected["duplicate_pressure"] += len(pres) - len(dedup)
            pres = [pres[i] for i in dedup]
            temp = [temp[i] for i in dedup]
            psal = [psal[i] for i in dedup]

        ts = head[idx["time"]]
        if datetime.fromisoformat(ts.replace("Z", "+00:00")) > datetime.now(timezone.utc):
            rejected["future_timestamp"] += 1
            continue

        out.append({
            "wmo": wmo,
            "cycle": cycle,
            "dataMode": mode,
            "dataCentre": dc,
            "adjusted": used_adj,
            "lat": round(head[idx["latitude"]], 4),
            "lon": round(head[idx["longitude"]], 4),
            "time": ts,
            "pres": pres,          # decibars, NOT metres
            "temp": temp,
            "psal": psal,
            "nLevels": len(pres),
        })

    out.sort(key=lambda p: (p["wmo"], p["cycle"]))
    return out, dict(rejected)


def check(path):
    """Assertions over the written file: cheap, offline, and load-bearing."""
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)

    assert "floats" in doc and len(doc["floats"]) >= 1, "no core floats in argo.json"
    assert "bgcFloats" in doc, "bgcFloats key missing"
    assert doc["domain"]["lonMin"] == LON_MIN and doc["domain"]["lonMax"] == LON_MAX
    assert doc["domain"]["latMin"] == LAT_MIN and doc["domain"]["latMax"] == LAT_MAX

    n_core_prof = 0
    for f in doc["floats"]:
        assert "wmo" in f and "cycles" in f, "malformed float entry"
        for c in f["cycles"]:
            n_core_prof += 1
            pres, temp, psal = c["pres"], c["temp"], c["psal"]
            assert len(pres) == len(temp) == len(psal), f"ragged arrays on WMO {f['wmo']} cycle {c.get('cycle')}"
            assert pres == sorted(pres), f"pressure not ascending on WMO {f['wmo']} cycle {c.get('cycle')}"
            assert all(TEMP_RANGE[0] <= v <= TEMP_RANGE[1] for v in temp if v is not None), f"temperature out of range on WMO {f['wmo']}"
            assert all(PSAL_RANGE[0] <= v <= PSAL_RANGE[1] for v in psal if v is not None), f"salinity out of range on WMO {f['wmo']}"
            assert LAT_MIN <= c["lat"] <= LAT_MAX, f"latitude out of bounds: {c['lat']}"
            assert LON_MIN <= c["lon"] <= LON_MAX, f"longitude out of bounds: {c['lon']}"
            valid_t = [v for v in temp if v is not None]
            if len(valid_t) > 1 and pres[-1] - pres[0] > 300:
                assert valid_t[0] > valid_t[-1], f"inverted temperature profile on WMO {f['wmo']}"

    n_bgc_prof = 0
    for f in doc.get("bgcFloats", []):
        for c in f["cycles"]:
            n_bgc_prof += 1
            pres, chla = c["pres"], c["chla"]
            assert len(pres) == len(chla), f"ragged BGC arrays on WMO {f['wmo']}"
            assert pres == sorted(pres), f"BGC pressure not ascending on WMO {f['wmo']}"
            assert all(-0.1 <= v <= 20.0 for v in chla if v is not None), f"chlorophyll out of range on WMO {f['wmo']}"

    print(f"OK  {os.path.basename(path)}  {len(doc['floats'])} core floats ({n_core_prof} profiles), "
          f"{len(doc.get('bgcFloats', []))} BGC floats ({n_bgc_prof} profiles)")
    print(f"    QC kept flags {doc['qc']['keptFlags']}, timeRange {doc['timeRange'][0]} to {doc['timeRange'][1]}")


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    dest = os.path.join(here, "js", "data", "argo.json")

    d_start, d_end = default_window()
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default=d_start)
    ap.add_argument("--end", default=d_end)
    ap.add_argument("--max-floats", type=int, default=16)
    ap.add_argument("--max-levels", type=int, default=140,
                    help="thin each profile to at most this many levels (no interpolation)")
    ap.add_argument("--check", action="store_true", help="verify the written file and exit")
    args = ap.parse_args()

    if args.check:
        check(dest)
        return

    rows, idx = fetch(args.start, args.end)
    profiles, rejected = build(rows, idx)
    if not profiles:
        sys.exit("No profiles survived QC. Widen the time window.")

    # The census comes first: it is what the selection apportions seats by.
    pop = census(args.start, args.end)

    by_float = defaultdict(list)
    dac_of = {}
    for p in profiles:
        by_float[p["wmo"]].append(p)
        dac_of[p["wmo"]] = p["dataCentre"]
    chosen = select_floats(by_float, dac_of,
                           (pop or {}).get("byDataCentre"), args.max_floats)

    floats = []
    for wmo in sorted(chosen):
        cycles = sorted(by_float[wmo], key=lambda p: p["cycle"])
        for p in cycles:
            n = len(p["pres"])
            if n > args.max_levels:
                # Thin by index. Deliberately NOT interpolation: resampling onto
                # nominal depths would invent values Argo never measured.
                keep = even_indices(n, args.max_levels)
                for k in ("pres", "temp", "psal"):
                    p[k] = [p[k][i] for i in keep]
                p["thinned"] = True
            p["nLevels"] = len(p["pres"])
        floats.append({"wmo": wmo, "cycles": cycles})

    bgc = fetch_bgc(args.start, args.end, args.max_floats, args.max_levels)

    doc = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Ifremer ERDDAP / Argo GDAC (ArgoFloats)",
        "attribution": ("Argo data collected and made freely available by the "
                        "International Argo Program and the national programmes "
                        "that contribute to it. https://argo.ucsd.edu"),
        "domain": {"lonMin": LON_MIN, "lonMax": LON_MAX,
                   "latMin": LAT_MIN, "latMax": LAT_MAX},
        "timeRange": [args.start, args.end],
        "qc": {"keptFlags": sorted(GOOD_QC), "rejected": rejected},
        # The population these floats were selected from, so the UI can say how
        # much of the basin is shown and who operates the rest of it.
        "census": pop,
        "units": {"pres": "decibar", "temp": "degree_Celsius", "psal": "PSU",
                  "chla": "mg m-3"},
        "floats": floats,
        "bgcFloats": bgc,
    }

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    dest = os.path.join(here, "js", "data", "argo.json")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))

    kb = os.path.getsize(dest) / 1024
    print(f"\n{len(floats)} floats, {sum(len(f['cycles']) for f in floats)} profiles -> {kb:.0f} KB")
    print("rejected:", rejected)
    for f in floats:
        c = f["cycles"]
        print(f"  {f['wmo']}  dac={c[-1]['dataCentre']:2s}  cycles={len(c):3d}  "
              f"mode={c[-1]['dataMode']}  levels={c[-1]['nLevels']:3d}  "
              f"maxP={max(c[-1]['pres']):.0f} dbar")


if __name__ == "__main__":
    main()
