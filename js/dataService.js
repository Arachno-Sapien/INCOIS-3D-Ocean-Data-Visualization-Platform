/**
 * dataService.js — Mock Data Service Layer
 *
 * ============================================================
 * ARCHITECTURE NOTE — HOW TO PLUG IN A REAL BACKEND
 * ============================================================
 *
 * Every public function here is async and returns data in the
 * exact schema that a real backend must also return.
 *
 * To swap mock → REST API, replace the function body:
 *   MOCK:  return generateMockField(variable, date, timestep);
 *   REST:  const r = await fetch(`/api/model/${variable}/${date}/${timestep}`);
 *          return r.json();
 *
 * To swap mock → OPeNDAP/WMS endpoint:
 *   OPeNDAP: const r = await fetch(
 *     `https://opendap.incois.gov.in/thredds/dodsC/INCOIS/${variable}.nc.ascii?${variable}[0][0:1:39][0:1:39][0:1:19]`
 *   );
 *   WMS tile: fetch(`https://wms.incois.gov.in/ncWMS/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&...`)
 *
 * No component outside this file generates or accesses raw mock data.
 * ============================================================
 *
 * PLUGIN REGISTRY
 * ============================================================
 * Each entry defines a data source that can be rendered in the scene.
 * Add new sensors/products here — scene/UI code never needs to change.
 *
 * Schema per entry:
 * {
 *   id:               string   — unique key, matches API type param
 *   label:            string   — display name
 *   fetchFn:          async fn — returns platform array (see contract)
 *   markerColor:      string   — CSS hex color for 3D markers
 *   glowColor:        string   — CSS hex for marker glow ring
 *   profileVariables: string[] — variables available in profile chart
 *   trackStyle:       'none' | 'spline' | 'line'
 * }
 * ============================================================
 */

import { seededNoise, lerp, clamp } from './utils.js';
import { DOMAIN, VIEW } from './constants.js';
export { DOMAIN, VIEW };

// ---------------------------------------------------------------------------
// Real Argo observations
// ---------------------------------------------------------------------------
// js/data/argo.json is real Argo GDAC data, fetched and quality-controlled by
// tools/fetch_argo.py and committed so the app needs no network at runtime.
// Model fields below are still synthetic; the two are labelled separately in
// the UI so nobody mistakes one for the other.
let _argoDoc = null;
const _argoReady = fetch('./js/data/argo.json')
  .then(r => r.ok ? r.json() : Promise.reject(new Error(`argo.json ${r.status}`)))
  .then(d => { _argoDoc = d; return d; })
  .catch(err => {
    // Degrade to synthetic floats rather than showing an empty ocean, and say so.
    console.warn('[INCOIS] Real Argo data unavailable, falling back to mock:', err.message);
    return null;
  });

// ---------------------------------------------------------------------------
// Real gridded model field
// ---------------------------------------------------------------------------
// js/data/model.json is the INCOIS objective analysis of Argo onto a regular
// grid, fetched by tools/fetch_model.py. It is bundled for the same reason
// argo.json is: none of these hosts send an Access-Control-Allow-Origin header,
// so the browser cannot reach them directly whatever we do at this layer.
//
// It covers temperature and salinity only. Currents and chlorophyll have no
// counterpart in this product and stay synthetic — labelled per variable, not
// per app, so nothing inherits credibility from the layer next to it.
let _modelDoc = null;
const _modelReady = fetch('./js/data/model.json')
  .then(r => r.ok ? r.json() : Promise.reject(new Error(`model.json ${r.status}`)))
  .then(d => { _modelDoc = d; return d; })
  .catch(err => {
    console.warn('[INCOIS] Real model field unavailable, falling back to synthetic:', err.message);
    return null;
  });

// ---------------------------------------------------------------------------
// Real current vectors
// ---------------------------------------------------------------------------
// js/data/currents.json, from tools/fetch_currents.py — Copernicus Marine
// GLOBAL_MULTIYEAR_PHY_001_030 (GLORYS12V1), resampled onto model.json's exact
// lons/lats/depths/times so it is a drop-in second document for the same
// cropper rather than a field with its own grid. A separate document, and a
// separate provenance record below, because it comes from a different
// institution on a different day than the INCOIS temperature/salinity grid —
// folding it into _modelDoc would have this field's numbers cite that one's
// source.
let _currentsDoc = null;
const _currentsReady = fetch('./js/data/currents.json')
  .then(r => r.ok ? r.json() : Promise.reject(new Error(`currents.json ${r.status}`)))
  .then(d => { _currentsDoc = d; return d; })
  .catch(err => {
    console.warn('[INCOIS] Real current field unavailable, falling back to synthetic:', err.message);
    return null;
  });

// ---------------------------------------------------------------------------
// Real glider, CTD and mooring observations
// ---------------------------------------------------------------------------
// js/data/instruments.json, from tools/fetch_instruments.py. Three sources on
// three servers, reduced to the same platform/profile contract the floats use,
// so the scene and the profile panel needed no knowledge of any of them.
//
// They do not share a time window, and that is a property of the observing
// network rather than an oversight: the moorings report three-hourly and are
// current, the last glider left this basin in 2022, and the CTD casts are
// research cruises going back to 2007. Each profile carries its own date and
// the UI states the offset from the model frame.
let _instDoc = null;
const _instReady = fetch('./js/data/instruments.json')
  .then(r => r.ok ? r.json() : Promise.reject(new Error(`instruments.json ${r.status}`)))
  .then(d => { _instDoc = d; return d; })
  .catch(err => {
    console.warn('[INCOIS] Real instrument data unavailable, falling back to mock:', err.message);
    return null;
  });

// ---------------------------------------------------------------------------
// Cyclone Mocha case study
// ---------------------------------------------------------------------------
// js/data/cyclone.json, from tools/fetch_cyclone.py. A SEPARATE snapshot, and
// deliberately not merged into the live one: the app's window is Feb-Aug 2026,
// which contains no North Indian cyclone at all — IBTrACS is current to
// 2026-08-30 and the basin has produced nothing this season.
//
// The file carries its own `model` and `argo` blocks in exactly the schema of
// model.json and argo.json, so entering the case study swaps documents rather
// than adding a second way to read a field. Loaded on demand, never at boot:
// the live view must not pay 1.3 MB for a case study nobody opened.
let _caseDoc = null;            // the loaded cyclone.json, or null
let _caseLive = null;           // the live docs, held while the case study is on
let _caseReady = null;          // in-flight fetch, so a double click loads once

/** True while the app is showing the case-study snapshot instead of the live one. */
export function isCaseStudy() {
  return !!_caseLive;
}

/** The storm, its track and the analysis — or null when the case study is off. */
export function getCaseStudy() {
  return _caseLive ? _caseDoc : null;
}

/**
 * Swap the live snapshot for the case study, or back.
 *
 * The field cache is keyed by variable, frame index and bounds — none of which
 * distinguish the two documents — so it has to be dropped on every swap or the
 * 2023 view is served 2026 cells under a 2023 label.
 */
export async function setCaseStudy(on) {
  if (on === isCaseStudy()) return _caseLive ? _caseDoc : null;
  if (on) {
    _caseReady = _caseReady || fetch('./js/data/cyclone.json')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`cyclone.json ${r.status}`)));
    _caseDoc = await _caseReady;
    _caseLive = { model: _modelDoc, argo: _argoDoc };
    _modelDoc = _caseDoc.model;
    _argoDoc = _caseDoc.argo;
  } else {
    ({ model: _modelDoc, argo: _argoDoc } = _caseLive);
    _caseLive = null;
  }
  _fieldCache.clear();
  return _caseLive ? _caseDoc : null;
}

/**
 * The storm as one platform, positioned at its fix nearest the selected frame.
 *
 * The marker moves with the date control rather than sitting at the peak, so
 * the readout describing the water ahead describes the water ahead of where
 * the storm actually was. `offsetMs` is carried for the same reason every
 * other observation carries it.
 */
function _cyclonePlatform(atTime) {
  if (!_caseLive || !_caseDoc?.track?.length) return null;
  const s = _caseDoc.storm;
  const track = _caseDoc.track;

  let fix = track[0];
  let offsetMs = null;
  const t = Date.parse(atTime || '');
  if (Number.isFinite(t)) {
    fix = track.reduce((best, cur) =>
      Math.abs(Date.parse(cur.time) - t) < Math.abs(Date.parse(best.time) - t) ? cur : best);
    offsetMs = Date.parse(fix.time) - t;
  }

  return {
    platformId: s.name,
    type: 'cyclone',
    real: true,
    lat: fix.lat, lon: fix.lon,
    lastUpdate: fix.time,
    cycleCount: track.length,
    offsetMs,
    fix,
    storm: s,
    // Extra keys per point are ignored by the marker code, which reads lat/lon;
    // the cyclone track builder reads windKt off the same objects.
    track,
  };
}

/** Which bundled group and source key each registry id reads from. */
const INSTRUMENTS = {
  glider:  { group: 'gliders',  source: 'glider',  short: 'OceanGliders GDAC' },
  ctd:     { group: 'ctd',      source: 'ctd',     short: 'CCHDO / GO-SHIP' },
  mooring: { group: 'moorings', source: 'mooring', short: 'Moored buoy (GTS)' },
};

/**
 * A bundled instrument group as platform objects.
 *
 * `lat`/`lon` are the most recent profile's position. For a mooring that is
 * fixed; for a glider or a ship it is the end of a path, and `track` carries
 * the whole of it.
 */
function _realInstPlatforms(type) {
  const spec = INSTRUMENTS[type];
  const groups = _instDoc?.[spec.group];
  if (!groups?.length) return null;
  return groups.map(g => {
    const last = g.cycles[g.cycles.length - 1];
    return {
      platformId: g.id,
      type,
      real: true,
      lat: last.lat,
      lon: last.lon,
      lastUpdate: last.time,
      cycleCount: g.cycles.length,
      country: g.country,
      kind: g.kind,
      track: g.cycles.map(c => ({ lat: c.lat, lon: c.lon })),
    };
  });
}

/**
 * One profile from a bundled instrument, nearest the selected model frame.
 *
 * The vertical coordinate is carried in the unit the instrument reports it in.
 * A moored buoy reports depth in metres; a glider and a CTD report pressure in
 * decibars. Relabelling one as the other is a small lie that the profile chart
 * would then print on its axis, so `pressureDbar` is null for the buoys and
 * the chart says "Depth (m)" on its own.
 */
function _realInstProfile(type, platformId, atTime) {
  const spec = INSTRUMENTS[type];
  const g = _instDoc?.[spec.group]?.find(x => x.id === platformId);
  if (!g) return null;

  let c = g.cycles[g.cycles.length - 1];
  let offsetMs = null;
  if (atTime) {
    const t = Date.parse(atTime);
    if (Number.isFinite(t)) {
      c = g.cycles.reduce((best, cur) =>
        Math.abs(Date.parse(cur.time) - t) < Math.abs(Date.parse(best.time) - t) ? cur : best);
      offsetMs = Date.parse(c.time) - t;
    }
  }

  const src = _instDoc.sources[spec.source];
  const byDepth = src.verticalUnit === 'metre';
  const levels = byDepth ? c.depths : c.pres;
  const usableSalinity = c.psal.some(v => v !== null);

  return {
    platformId: g.id,
    real: true,
    lat: c.lat, lon: c.lon,
    timestamps: [c.time],
    // Only one of these is a measurement; the other is the display convenience.
    pressureDbar: byDepth ? null : levels,
    depths: levels,
    variables: {
      temperature: c.temp,
      salinity: usableSalinity ? c.psal : null,
    },
    salinityRejected: !usableSalinity,
    cycleCount: g.cycles.length,
    thinned: !!c.thinned,
    // Whether the source shipped per-level quality flags at all. Two of the
    // three do not, and a profile panel that implied QC where there was none
    // would be claiming more than the data supports.
    qcFlags: src.qcFlags,
    sourceLabel: src.dataset,
    sourceShort: spec.short,
    station: c.station, cast: c.cast, country: c.country,
    offsetMs,
    attribution: src.attribution,
  };
}

/** Cropped fields, keyed by variable, frame and bounds. */
const _fieldCache = new Map();

/** Provenance for the UI: what is real, what is synthetic. */
export async function getDataProvenance() {
  await Promise.all([_argoReady, _modelReady, _instReady, _currentsReady]);
  return {
    argo: _argoDoc
      ? { real: true, source: _argoDoc.source, generated: _argoDoc.generated,
          timeRange: _argoDoc.timeRange, attribution: _argoDoc.attribution,
          floats: _argoDoc.floats.length,
          profiles: _argoDoc.floats.reduce((n, f) => n + f.cycles.length, 0),
          qc: _argoDoc.qc,
          // The population the bundled floats were drawn from. The subset is
          // stratified by data centre to match it, so both numbers describe
          // the same basin rather than contradicting each other.
          census: _argoDoc.census || null,
          // Core and BGC are selected independently and do overlap — three
          // WMOs are in both today. Summing the two counts and stating the
          // total against a distinct-platform census would be wrong arithmetic
          // in the one line that exists to be checkable.
          distinctFloats: new Set([
            ..._argoDoc.floats.map(f => f.wmo),
            ...(_argoDoc.bgcFloats || []).map(f => f.wmo),
          ]).size,
          byDataCentre: _argoDoc.floats.reduce((m, f) => {
            const dc = f.cycles[f.cycles.length - 1].dataCentre;
            m[dc] = (m[dc] || 0) + 1; return m;
          }, {}) }
      : { real: false },
    bgc: _argoDoc?.bgcFloats?.length
      ? { real: true, floats: _argoDoc.bgcFloats.length,
          profiles: _argoDoc.bgcFloats.reduce((n, f) => n + f.cycles.length, 0) }
      : { real: false },
    model: _modelDoc
      ? { real: true, source: _modelDoc.source, generated: _modelDoc.generated,
          // Read off whichever variable was fetched: `--vars salinity`
          // produces a file with no temperature, and hardcoding it stamped
          // the exported figure with the literal string "undefined".
          dataset: Object.values(_modelDoc.variables)[0]?.dataset,
          attribution: _modelDoc.attribution,
          grid: _modelDoc.grid, levels: _modelDoc.depths.length,
          depthRange: [_modelDoc.depths[0], _modelDoc.depths[_modelDoc.depths.length - 1]],
          frames: _modelDoc.times.length,
          timeRange: [_modelDoc.times[0], _modelDoc.times[_modelDoc.times.length - 1]],
          // Named individually: 'the model field is real' is only true of the
          // two variables the product actually carries.
          realVariables: Object.keys(_modelDoc.variables),
          // Currents gets its own provenance record below — a different
          // institution, a different day — so it never appears here even when
          // synthetic, or 'still synthetic: currents' would sit next to a
          // model.source string that is not where currents comes from.
          syntheticVariables: Object.keys(VARIABLE_META)
            .filter(v => v !== 'currents')
            .filter(v => !(v in _modelDoc.variables)) }
      : { real: false, note: 'Synthetic field with physically plausible structure' },
    currents: _currentsDoc
      ? { real: true, source: _currentsDoc.source, generated: _currentsDoc.generated,
          dataset: Object.values(_currentsDoc.variables)[0]?.dataset,
          attribution: _currentsDoc.attribution,
          grid: _currentsDoc.grid, levels: _currentsDoc.depths.length,
          depthRange: [_currentsDoc.depths[0], _currentsDoc.depths[_currentsDoc.depths.length - 1]],
          frames: _currentsDoc.times.length,
          timeRange: [_currentsDoc.times[0], _currentsDoc.times[_currentsDoc.times.length - 1]] }
      : { real: false },
    instruments: _instDoc
      ? Object.fromEntries(Object.entries(INSTRUMENTS).map(([type, spec]) => {
          const groups = _instDoc[spec.group] || [];
          const src = _instDoc.sources[spec.source];
          return [type, {
            real: groups.length > 0,
            platforms: groups.length,
            profiles: groups.reduce((n, g) => n + g.cycles.length, 0),
            window: src.window,
            qcFlags: src.qcFlags,
            dataset: src.dataset,
            attribution: src.attribution,
            note: src.note,
          }];
        }))
      : null,
  };
}

/** Await before any call that may need real Argo data. */
export function whenDataReady() {
  return Promise.all([_argoReady, _modelReady, _instReady, _currentsReady]);
}

/** True when this variable is served from a real grid (INCOIS, or Copernicus for currents). */
export function isModelVariableReal(variable) {
  if (variable === 'currents') return !!_currentsDoc;
  return !!_modelDoc?.variables?.[variable];
}

/** The frames the real field actually holds, for the date control. */
export function getModelFrames() {
  return _modelDoc ? _modelDoc.times.slice() : null;
}

/**
 * The depth levels the field is defined on, or null when it is synthetic.
 *
 * Exported so the depth control can offer the levels that exist rather than a
 * continuous slider over depths nothing was ever computed at.
 */
export function getModelLevels(variable) {
  if (variable === 'currents') return _currentsDoc ? _currentsDoc.depths.slice() : null;
  if (!_modelDoc) return null;
  // Chlorophyll falls through to the synthetic generator and its even
  // ladder, so answering with the INCOIS levels for it would have the depth
  // control label a sheet with a depth it is not drawn at.
  if (variable && !_modelDoc.variables[variable]) return null;
  return _modelDoc.depths.slice();
}

// ---------------------------------------------------------------------------
// Variable metadata defaults
// ---------------------------------------------------------------------------
// Palettes follow cmocean conventions — the colormap set an oceanographic
// audience expects per variable. See PALETTES in utils.js.
// `cfName` is the CF standard name, so the colorbar states the quantity in the
// vocabulary INCOIS and international portals use, not an internal short key.
export const VARIABLE_META = {
  temperature: { label: 'Temperature', unit: '°C',   defaultMin: 2,   defaultMax: 32,  palette: 'thermal',
                 cfName: 'sea_water_potential_temperature' },
  // The floor is 32, not the 34 an open-ocean scale would use: the real field
  // reaches 32.4 in the northern Bay of Bengal, where the Ganges-Brahmaputra
  // discharge caps the surface with fresh water. A 34 floor clipped that entire
  // signal to one flat colour — the synthetic field never left 34.6-35.1, so
  // nothing showed it.
  salinity:    { label: 'Salinity',    unit: 'PSU',  defaultMin: 32,  defaultMax: 37,  palette: 'haline',
                 cfName: 'sea_water_practical_salinity' },
  currents:    { label: 'Currents',    unit: 'm s⁻¹',defaultMin: 0,   defaultMax: 1.5, palette: 'speed',
                 cfName: 'sea_water_velocity' },
  chlorophyll: { label: 'Chlorophyll', unit: 'mg m⁻³',defaultMin: 0,  defaultMax: 2,   palette: 'algae',
                 cfName: 'mass_concentration_of_chlorophyll_in_sea_water' },
};

// ---------------------------------------------------------------------------
// Model field API
// ---------------------------------------------------------------------------

/**
 * getModelField(variable, date, timestep)
 *
 * Returns:
 * {
 *   variable, unit, date, timestep,
 *   bounds: { lonMin, lonMax, latMin, latMax, depthMin, depthMax },
 *   grid:   { nx, ny, nz },
 *   values: Float32Array  (length nx*ny*nz, row-major x,y,z)
 *   velocityU?: Float32Array  (only when variable === 'currents')
 *   velocityV?: Float32Array
 * }
 */
export async function getModelField(variable, date, timestep) {
  await _modelReady;
  const real = _realModelField(variable, date, timestep);
  if (real) return real;
  // ── REAL API SWAP: replace body with fetch() call ──
  await _delay(60);
  return _generateModelField(variable, date, timestep);
}

/**
 * The real INCOIS field for this variable, cropped to the current VIEW, or null
 * when the product does not carry the variable at all.
 *
 * Two things are reconciled here and neither is cosmetic.
 *
 * TIME. The product is a ten-day analysis; the app asks for an arbitrary date
 * and one of four times of day. There is no frame at that instant and inventing
 * one by interpolation would present a field nobody computed. The nearest frame
 * is returned with `offsetMs` stating how far away it is, exactly as
 * `_realArgoProfile` does for a float cycle.
 *
 * SPACE. Cells are a fixed one degree on half-degree centres, so a dragged
 * selection almost never lands on a cell edge. The crop takes every cell whose
 * area intersects the selection and reports the resulting cell-edge `bounds`.
 * Stretching those cells to fill the requested box instead would move the
 * ocean — up to several percent on a small selection — and quietly break the
 * co-location between the field and the floats drawn on top of it.
 */
function _realModelField(variable, date, timestep) {
  // Currents live in a separate document (see _currentsDoc above) built on
  // the identical lons/lats/depths/times axes, so every line below this
  // reads generically off `doc` and needs no branch of its own.
  const doc = variable === 'currents' ? _currentsDoc : _modelDoc;
  const v = doc?.variables?.[variable];
  if (!v) return null;

  const wanted = Date.parse(`${date}T${timestep}:00Z`);
  let fi = 0;
  if (Number.isFinite(wanted)) {
    doc.times.forEach((t, i) => {
      if (Math.abs(Date.parse(t) - wanted) < Math.abs(Date.parse(doc.times[fi]) - wanted)) fi = i;
    });
  }
  // A frame the fetch could not retrieve is null; fall back to the nearest one
  // that exists rather than rendering an empty box.
  if (!v.frames[fi]) {
    const ok = v.frames.map((f, i) => f ? i : -1).filter(i => i >= 0);
    if (!ok.length) return null;
    // Nearest in time, not in array position: --max-frames subsamples the
    // ten-daily axis unevenly, so index distance is not time distance.
    fi = ok.reduce((a, b) =>
      Math.abs(Date.parse(doc.times[b]) - wanted) <
      Math.abs(Date.parse(doc.times[a]) - wanted) ? b : a);
  }

  const key = `${variable}|${fi}|${VIEW.lonMin},${VIEW.lonMax},${VIEW.latMin},${VIEW.latMax}`;
  const hit = _fieldCache.get(key);
  // The date and timestep are display-only below the crop, so a cached field
  // is re-stamped rather than recomputed. The tab and exaggeration controls
  // both re-request the same field several times per interaction.
  if (hit) return { ...hit, date, timestep, offsetMs: Date.parse(doc.times[fi]) - wanted };

  const [ix0, ix1] = _cropAxis(doc.lons, VIEW.lonMin, VIEW.lonMax);
  const [iy0, iy1] = _cropAxis(doc.lats, VIEW.latMin, VIEW.latMax);
  const nx = ix1 - ix0 + 1, ny = iy1 - iy0 + 1, nz = doc.depths.length;
  const sw = doc.grid.nx, sh = doc.grid.ny;

  const values = _cropFrame(v.frames[fi], sw, sh, ix0, iy0, nx, ny, nz);

  const dLon = doc.lons[1] - doc.lons[0];
  const dLat = doc.lats[1] - doc.lats[0];
  const field = {
    variable,
    unit: (VARIABLE_META[variable] || VARIABLE_META.temperature).unit,
    real: true,
    source: doc.source,
    dataset: v.dataset,
    erddapVariable: v.erddapVariable,
    sourceUnit: v.unit,
    attribution: doc.attribution,
    time: doc.times[fi],
    frameIndex: fi,
    frameCount: doc.times.length,
    // Cell edges, not centres: this is the extent the field actually covers,
    // and the renderer sizes the planes from it.
    bounds: {
      lonMin: doc.lons[ix0] - dLon / 2, lonMax: doc.lons[ix1] + dLon / 2,
      latMin: doc.lats[iy0] - dLat / 2, latMax: doc.lats[iy1] + dLat / 2,
      depthMin: DOMAIN.depthMin, depthMax: DOMAIN.depthMax,
    },
    grid: { nx, ny, nz },
    lons: doc.lons.slice(ix0, ix1 + 1),
    lats: doc.lats.slice(iy0, iy1 + 1),
    // Uneven by nature. Every consumer that turns a level index into a depth,
    // or integrates over depth, must read this rather than divide by nz.
    depths: doc.depths,
    values,
  };
  // Current vectors carry components alongside the speed scalar in `values`;
  // scene.js's glyphs read these two and skip drawing when either is absent,
  // which is also how they stay off every other variable's field for free.
  if (variable === 'currents' && v.uFrames?.[fi] && v.vFrames?.[fi]) {
    field.velocityU = _cropFrame(v.uFrames[fi], sw, sh, ix0, iy0, nx, ny, nz);
    field.velocityV = _cropFrame(v.vFrames[fi], sw, sh, ix0, iy0, nx, ny, nz);
  }
  _fieldCache.set(key, field);
  return { ...field, date, timestep, offsetMs: Date.parse(doc.times[fi]) - wanted };
}

/**
 * Index range of the cells whose area intersects [lo, hi].
 *
 * Cell i covers half a step either side of its centre, so a cell counts as
 * inside when its interval overlaps the request, not when its centre does.
 * Always returns at least two indices: a one-cell field has no extent for the
 * renderer to scale against.
 */
function _cropAxis(centres, lo, hi) {
  const d = centres[1] - centres[0];
  let i0 = centres.findIndex(c => c + d / 2 > lo);
  if (i0 < 0) i0 = 0;
  let i1 = i0;
  for (let i = i0; i < centres.length; i++) if (centres[i] - d / 2 < hi) i1 = i;
  if (i1 <= i0) {
    if (i0 > 0) i0--; else i1 = Math.min(i0 + 1, centres.length - 1);
  }
  return [i0, i1];
}

/**
 * Crop one flat (iz*sh*sw + iy*sw + ix)-ordered frame to a lon/lat window,
 * re-indexed to (iz*ny*nx + iy*nx + ix). Shared by `values` and, for
 * currents, `velocityU`/`velocityV` — three identical loops collapsed to one.
 */
function _cropFrame(src, sw, sh, ix0, iy0, nx, ny, nz) {
  const out = new Float32Array(nx * ny * nz);
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const s = src[iz * sh * sw + (iy0 + iy) * sw + (ix0 + ix)];
        // null is land or water the analysis did not resolve. It becomes NaN
        // and stays a hole all the way to the pixel; see generateHeatmapTexture.
        out[iz * ny * nx + iy * nx + ix] = s === null ? NaN : s;
      }
    }
  }
  return out;
}

/**
 * Sample the uncropped model column nearest a given geographic position (lat, lon)
 * and time instant.
 *
 * Samples the uncropped _modelDoc so that platforms outside a dragged area
 * selection still sample the real field. Returns the vertical profile across
 * available real model variables (temperature and salinity), with depth in metres.
 *
 * @param {number} lat - Latitude in degrees
 * @param {number} lon - Longitude in degrees
 * @param {string} [atTime] - ISO 8601 timestamp string
 * @returns {object|null} Model profile column or null if unavailable / on land
 */
export function sampleModelColumn(lat, lon, atTime) {
  const doc = _modelDoc;
  if (!doc || !doc.variables) return null;

  const lons = doc.lons, lats = doc.lats;
  if (!lons?.length || !lats?.length) return null;

  const dLon = lons.length > 1 ? lons[1] - lons[0] : 1;
  const dLat = lats.length > 1 ? lats[1] - lats[0] : 1;
  if (lon < lons[0] - dLon / 2 || lon > lons[lons.length - 1] + dLon / 2) return null;
  if (lat < lats[0] - dLat / 2 || lat > lats[lats.length - 1] + dLat / 2) return null;

  let ix = 0, iy = 0;
  for (let i = 1; i < lons.length; i++) {
    if (Math.abs(lons[i] - lon) < Math.abs(lons[ix] - lon)) ix = i;
  }
  for (let i = 1; i < lats.length; i++) {
    if (Math.abs(lats[i] - lat) < Math.abs(lats[iy] - lat)) iy = i;
  }

  const wanted = atTime ? Date.parse(atTime) : NaN;
  let fi = 0;
  if (Number.isFinite(wanted)) {
    doc.times.forEach((t, i) => {
      if (Math.abs(Date.parse(t) - wanted) < Math.abs(Date.parse(doc.times[fi]) - wanted)) fi = i;
    });
  }

  const sw = doc.grid.nx, sh = doc.grid.ny, nz = doc.depths.length;
  const colIndex = iy * sw + ix;

  const variables = {};
  let anyValid = false;

  for (const [varName, v] of Object.entries(doc.variables)) {
    let frameIdx = fi;
    if (!v.frames[frameIdx]) {
      const ok = v.frames.map((f, i) => (f ? i : -1)).filter(i => i >= 0);
      if (!ok.length) continue;
      frameIdx = ok.reduce((a, b) =>
        Math.abs(Date.parse(doc.times[b]) - wanted) <
        Math.abs(Date.parse(doc.times[a]) - wanted) ? b : a
      );
    }
    const src = v.frames[frameIdx];
    if (!src) continue;

    const colVals = [];
    for (let iz = 0; iz < nz; iz++) {
      const val = src[iz * sh * sw + colIndex];
      const num = val === null || !Number.isFinite(val) ? null : val;
      colVals.push(num);
      if (num !== null) anyValid = true;
    }
    variables[varName] = colVals;
  }

  if (!anyValid) return null;

  return {
    real: true,
    gridLat: lats[iy],
    gridLon: lons[ix],
    depths: doc.depths.slice(),
    time: doc.times[fi],
    offsetMs: Number.isFinite(wanted) ? Date.parse(doc.times[fi]) - wanted : 0,
    variables,
    source: doc.source,
    attribution: doc.attribution,
  };
}


// ---------------------------------------------------------------------------
// Instrument platform API
// ---------------------------------------------------------------------------

/**
 * getInstrumentPlatforms(type)
 * type: 'argo' | 'glider' | 'ctd' | 'bgc' | 'mooring'
 *
 * Returns: Platform[]  (see schema in Section 6 of build prompt)
 */
/**
 * @param {string} type
 * @param {string} [atTime] ISO time of the selected model frame. Synthetic
 *        platforms are generated relative to it so they never sit years away
 *        from the field they are displayed beside. Real platforms ignore it —
 *        they exist when they were measured.
 */
export async function getInstrumentPlatforms(type, atTime) {
  // ── REAL API SWAP: replace body with fetch() call ──
  await _delay(40);
  const entry = PLUGIN_REGISTRY.find(e => e.id === type);
  if (!entry) return [];
  return entry.fetchFn(atTime);
}

/**
 * getProfile(platformId, atTime, type)
 *
 * Returns: { platformId, timestamps, depths, variables: { temp, sal, chl } }
 */
/**
 * @param {string} platformId
 * @param {string} [atTime] ISO time of the selected model timestep. The float's
 *        cycle nearest that time is returned, so scrubbing the model date moves
 *        the observations instead of leaving one fixed profile on screen.
 * @param {string} [type] PLUGIN_REGISTRY id the marker came from. Ids are only
 *        unique within a source, so pass it whenever it is known.
 */
export async function getProfile(platformId, atTime, type) {
  await Promise.all([_argoReady, _instReady]);

  // Resolve inside the source the marker came from. Identifiers are unique
  // per source, not across them: five floats appear in both the core and BGC
  // lists, and a moored buoy's WMO number shares a namespace with a float's.
  // Without the type, the first source that recognised an id won — which
  // handed a BGC marker its core temperature profile and left the chlorophyll
  // chart with nothing to draw, for five of the sixteen BGC floats.
  const lookup = {
    argo:    () => _realArgoProfile(platformId, atTime),
    bgc:     () => _realBgcProfile(platformId, atTime),
    glider:  () => _realInstProfile('glider', platformId, atTime),
    ctd:     () => _realInstProfile('ctd', platformId, atTime),
    mooring: () => _realInstProfile('mooring', platformId, atTime),
  };
  // Omitting the type keeps the original behaviour for any caller that has
  // only an id to go on.
  for (const key of (lookup[type] ? [type] : Object.keys(lookup))) {
    const real = lookup[key]();
    if (real) return real;
  }
  // ── REAL API SWAP: replace body with fetch() call ──
  await _delay(30);
  return _generateProfile(platformId, atTime);
}

/** Observation coverage, so the UI can constrain the model date to it. */
export async function getObservationWindow() {
  await _argoReady;
  if (!_argoDoc) return null;
  const times = _argoDoc.floats.flatMap(f => f.cycles.map(c => c.time)).sort();
  return { start: times[0], end: times[times.length - 1], count: times.length };
}

/**
 * Most recent QC'd profile for a float, in the shape the chart consumes.
 *
 * Pressure is carried through in decibars as measured. `depths` is the display
 * convenience (1 dbar ~ 1 m); the panel states which is which rather than
 * quietly relabelling one as the other.
 */
function _realArgoProfile(platformId, atTime) {
  if (!_argoDoc) return null;
  const f = _argoDoc.floats.find(x => x.wmo === platformId);
  if (!f) return null;

  // Nearest cycle in time, not simply the newest. Observations are irregular
  // in time and there is no timestep to snap to, so the honest answer is the
  // closest one plus a statement of how far off it is.
  let c = f.cycles[f.cycles.length - 1];
  let offsetMs = null;
  if (atTime) {
    const t = Date.parse(atTime);
    if (Number.isFinite(t)) {
      c = f.cycles.reduce((best, cur) =>
        Math.abs(Date.parse(cur.time) - t) < Math.abs(Date.parse(best.time) - t) ? cur : best);
      offsetMs = Date.parse(c.time) - t;
    }
  }
  const usableSalinity = c.psal.some(v => v !== null);

  return {
    platformId: c.wmo,
    real: true,
    cycle: c.cycle,
    dataMode: c.dataMode,            // R real-time | A adjusted | D delayed
    adjusted: c.adjusted,            // _ADJUSTED fields used?
    thinned: !!c.thinned,
    lat: c.lat, lon: c.lon,
    timestamps: [c.time],
    pressureDbar: c.pres,
    depths: c.pres,                  // 1 dbar ~ 1 m, labelled as such in the UI
    variables: {
      temperature: c.temp,
      // Nulls are levels QC rejected. Left as null on purpose: filling them
      // with 0 would draw a fresh-water spike that is not in the ocean.
      salinity: usableSalinity ? c.psal : null,
    },
    salinityRejected: !usableSalinity,
    // Argo does ship per-level flags, so a missing salinity here really was
    // rejected. The instrument sources mostly do not, and the chart has to be
    // able to tell those two cases apart.
    qcFlags: true,
    cycleCount: f.cycles.length,
    // Signed milliseconds from the selected model timestep to this profile.
    // Surfaced in the UI: an observation two years from the model frame must
    // not sit next to it looking like a validation of it.
    offsetMs,
    attribution: _argoDoc.attribution,
  };
}

/**
 * getAllPlatforms()  — convenience: fetches all registered source types.
 */
export async function getAllPlatforms(atTime) {
  const results = await Promise.all(
    PLUGIN_REGISTRY.map(e => getInstrumentPlatforms(e.id, atTime))
  );
  return results.flat();
}

/**
 * Anchor a synthetic observation to the selected model frame.
 * @param {string} atTime ISO model time (falls back to now)
 * @param {number} hoursBefore how far before the frame this platform reported
 */
function _syntheticTime(atTime, hoursBefore) {
  const base = Date.parse(atTime || '') || Date.now();
  return new Date(base - hoursBefore * 3600_000).toISOString().replace('.000', '');
}

// ---------------------------------------------------------------------------
// PLUGIN REGISTRY
// ---------------------------------------------------------------------------
// Adding a new sensor/ML-product: add ONE entry here. Done.
// ---------------------------------------------------------------------------
export const PLUGIN_REGISTRY = [
  {
    id: 'argo',
    label: 'Argo Floats',
    idLabel: 'WMO',
    markerColor: '#22d3ee',
    glowColor:   '#22d3ee88',
    profileVariables: ['temperature', 'salinity'],
    // 'link': straight segments between surfacings, drawn faint. A float does
    // not travel in straight lines between ten-day surfacings, so the line is
    // an indicative connection and the surfacing points carry the weight.
    trackStyle: 'link',
    fetchFn: async (atTime) => {
      await _argoReady;
      return _realArgoPlatforms() || _mockArgoPlatforms(atTime);
    },
  },
  {
    id: 'glider',
    label: 'Gliders',
    // Not a WMO number: gliders are identified by deployment.
    idLabel: 'Deployment',
    markerColor: '#a78bfa',
    glowColor:   '#a78bfa88',
    profileVariables: ['temperature', 'salinity'],
    // A glider really does fly a continuous path between dives, unlike a
    // drifting float, so a spline through the dive positions is the honest
    // shape here rather than an indicative link.
    trackStyle: 'spline',
    fetchFn: async (atTime) => {
      await _instReady;
      return _realInstPlatforms('glider') || _mockGliderPlatforms(atTime);
    },
  },
  {
    id: 'ctd',
    label: 'CTD Casts',
    // A cruise ExpoCode, e.g. 325020250321 — ship, then sailing date.
    idLabel: 'ExpoCode',
    markerColor: '#2dd4bf',
    glowColor:   '#2dd4bf88',
    profileVariables: ['temperature', 'salinity'],
    // One platform per cruise, one profile per cast, so the track is the
    // section line the ship actually steamed.
    trackStyle: 'link',
    fetchFn: async (atTime) => {
      await _instReady;
      return _realInstPlatforms('ctd') || _mockCTDPlatforms(atTime);
    },
  },
  {
    id: 'bgc',
    label: 'BGC Floats',
    idLabel: 'WMO',
    markerColor: '#fb923c',
    glowColor:   '#fb923c88',
    profileVariables: ['chlorophyll'],
    trackStyle: 'link',
    fetchFn: async (atTime) => {
      await _argoReady;
      return _realBgcPlatforms() || _mockBGCPlatforms(atTime);
    },
  },
  {
    id: 'mooring',
    label: 'Moorings',
    // Moored buoys on the GTS genuinely do carry WMO identifiers.
    idLabel: 'WMO',
    markerColor: '#f472b6',
    glowColor:   '#f472b688',
    profileVariables: ['temperature', 'salinity'],
    // Fixed position: the profiles stack at one point rather than tracing one.
    trackStyle: 'none',
    fetchFn: async (atTime) => {
      await _instReady;
      return _realInstPlatforms('mooring') || _mockMooringPlatforms(atTime);
    },
  },
  {
    id: 'cyclone',
    label: 'Cyclone Track',
    // Not a platform identifier at all: IBTrACS names storms, and the serial
    // is in the panel rather than pretending to be a registration number.
    idLabel: 'Storm',
    // White, not another data colour. The track is an annotation over the heat
    // field, and every part of the thermal ramp it crosses is warm — a red or
    // orange track would vanish into exactly the values it is there to mark.
    markerColor: '#f1f5f9',
    glowColor:   '#f1f5f988',
    // A storm has no water column. Left empty on purpose: ui.js reads this to
    // decide whether a marker opens a profile at all, so the alternative is a
    // panel offering a temperature profile of a hurricane.
    profileVariables: [],
    // A cyclone genuinely does travel a continuous path between three-hourly
    // fixes, so a spline is the honest shape here — the same reasoning that
    // gives a glider one and denies a drifting float one. Fixes are drawn
    // scaled by wind speed on top of it.
    trackStyle: 'cyclone',
    // Empty until the case study is entered; there is no cyclone in the live
    // 2026 window to draw.
    fetchFn: async (atTime) => {
      const p = _cyclonePlatform(atTime);
      return p ? [p] : [];
    },
  },
];

// ---------------------------------------------------------------------------
// Internal mock generators
// ---------------------------------------------------------------------------

function _delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function _generateModelField(variable, date, timestep) {
  const meta = VARIABLE_META[variable] || VARIABLE_META.temperature;
  const nx = 40, ny = 40, nz = 20;
  const values = new Float32Array(nx * ny * nz);
  const seed = _dateSeed(date, timestep, variable);

  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const idx = iz * ny * nx + iy * nx + ix;
        const nx01 = ix / (nx - 1);
        const ny01 = iy / (ny - 1);
        const nz01 = iz / (nz - 1);

        let val = seededNoise(nx01 * 4 + seed, ny01 * 4, nz01 * 3);

        // Physically plausible gradient: cooler/saltier at depth
        if (variable === 'temperature') {
          // A mixed layer over an exponential thermocline, not a linear ramp.
          // A linear 32->2 degC ramp puts the 26 degC isotherm near 400 m; the
          // real Indian Ocean has it at 50-120 m, and D26/TCHP are computed
          // from exactly that depth, so the shape has to be right or every
          // derived quantity is out by an order of magnitude.
          const depth = nz01 * DOMAIN.depthMax;
          const mld = 45 + val * 25;                    // 45-70 m mixed layer
          const tSurf = 29.4 - (ny01 - 0.5) * 3.2 + val * 0.8;   // cooler poleward
          const tDeep = 3.0;
          const H = 260;                                // thermocline e-folding scale
          val = depth <= mld
            ? tSurf
            : tDeep + (tSurf - tDeep) * Math.exp(-(depth - mld) / H);
        } else if (variable === 'salinity') {
          val = lerp(35.1, 34.6, nz01) + val * 0.4;
        } else if (variable === 'chlorophyll') {
          // Subsurface chlorophyll maximum around 75m
          const chlPeak = Math.exp(-Math.pow((nz01 * nz - 3), 2) / 2);
          val = clamp(val * 0.5 + chlPeak, 0, 2);
        } else if (variable === 'currents') {
          val = clamp(Math.abs(val) * 0.8 + nz01 * 0.3, 0, 1.5);
        }

        values[idx] = val;
      }
    }
  }

  const result = {
    variable,
    unit: meta.unit,
    date,
    timestep,
    bounds: { ...VIEW },
    grid: { nx, ny, nz },
    values,
  };

  // Velocity components for currents
  if (variable === 'currents') {
    result.velocityU = new Float32Array(nx * ny * nz).map((_, i) => {
      const s = (i * 0.0013 + seed) % 1;
      return (seededNoise(s * 5, 0.2, 0.1) - 0.5) * 1.2;
    });
    result.velocityV = new Float32Array(nx * ny * nz).map((_, i) => {
      const s = (i * 0.0017 + seed) % 1;
      return (seededNoise(s * 5, 0.8, 0.3) - 0.5) * 1.0;
    });
  }

  return result;
}

function _dateSeed(date, timestep, variable) {
  const varSeeds = { temperature: 1, salinity: 2, currents: 3, chlorophyll: 4 };
  const d = new Date(date + 'T' + timestep + 'Z');
  return ((d.getTime() / 86400000) % 100) * 0.01 + (varSeeds[variable] || 1) * 0.25;
}

function _generateProfile(platformId, atTime) {
  const seed = platformId.split('').reduce((a, c) => a + c.charCodeAt(0), 0) * 0.003;
  const depths = [0, 10, 20, 50, 100, 200, 500, 1000, 1500, 2000];
  return {
    platformId,
    timestamps: [_syntheticTime(atTime, 0)],
    depths,
    variables: {
      temperature: depths.map((d, i) => {
        const base = lerp(29, 2, i / (depths.length - 1));
        return +(base + seededNoise(seed + i * 0.1, 0.5, 0.1) * 2 - 1).toFixed(2);
      }),
      salinity: depths.map((d, i) => {
        const base = lerp(35.0, 34.6, i / (depths.length - 1));
        return +(base + seededNoise(seed + i * 0.07, 0.3, 0.5) * 0.3).toFixed(3);
      }),
      chlorophyll: depths.map((d, i) => {
        const peak = Math.exp(-Math.pow(i - 3, 2) / 3);
        return +(peak * 0.9 + seededNoise(seed + i * 0.2, 0.7, 0.2) * 0.1).toFixed(3);
      }),
    },
  };
}

// --- Mock platform generators ---

/**
 * Real floats as platform objects.
 *
 * `lat`/`lon` are the latest surfacing. A float's reported position is where it
 * surfaced, not where it profiled: it drifts during ascent, so these are not
 * presented as more precise than they are.
 *
 * `track` is the ordered surfacing sequence, roughly ten days apart. The scene
 * draws the surfacings as the dominant element and the connecting line only as
 * an indicative link, because the float did not travel in straight segments.
 */
function _realArgoPlatforms() {
  if (!_argoDoc) return null;
  return _argoDoc.floats.map(f => {
    const cycles = f.cycles;
    const last = cycles[cycles.length - 1];
    return {
      platformId: f.wmo,               // WMO number
      type: 'argo',
      real: true,
      lat: last.lat,
      lon: last.lon,
      lastUpdate: last.time,
      dataMode: last.dataMode,
      cycleCount: cycles.length,
      track: cycles.map(c => ({ lat: c.lat, lon: c.lon })),
    };
  });
}

/** Real BGC floats. Same platform contract, distinguished by `type`. */
function _realBgcPlatforms() {
  // `null` means no snapshot loaded, and only that: the registry reads it as
  // permission to generate. A loaded snapshot holding no BGC floats is an
  // answer — there were none — and returns an empty list so the layer renders
  // as absent. Conflating the two put six generated floats on screen under a
  // provenance strip that had already gone green for the real ones beside them.
  if (!_argoDoc) return null;
  if (!_argoDoc.bgcFloats?.length) return [];
  return _argoDoc.bgcFloats.map(f => {
    const last = f.cycles[f.cycles.length - 1];
    return {
      platformId: f.wmo,
      type: 'bgc',
      real: true,
      lat: last.lat,
      lon: last.lon,
      lastUpdate: last.time,
      dataMode: last.dataMode,
      cycleCount: f.cycles.length,
      track: f.cycles.map(c => ({ lat: c.lat, lon: c.lon })),
    };
  });
}

/**
 * Chlorophyll profile from a BGC float.
 *
 * Values come from `chla_adjusted` only. Raw fluorescence in this domain is
 * 100% QC flag 3, since it needs a scale correction and is depressed near the
 * surface by non-photochemical quenching. Slightly negative adjusted values are
 * dark-count noise around zero and are passed through rather than clipped.
 */
function _realBgcProfile(platformId, atTime) {
  if (!_argoDoc?.bgcFloats?.length) return null;
  const f = _argoDoc.bgcFloats.find(x => x.wmo === platformId);
  if (!f) return null;

  let c = f.cycles[f.cycles.length - 1];
  let offsetMs = null;
  if (atTime) {
    const t = Date.parse(atTime);
    if (Number.isFinite(t)) {
      c = f.cycles.reduce((best, cur) =>
        Math.abs(Date.parse(cur.time) - t) < Math.abs(Date.parse(best.time) - t) ? cur : best);
      offsetMs = Date.parse(c.time) - t;
    }
  }

  return {
    platformId: c.wmo,
    real: true,
    cycle: c.cycle,
    dataMode: c.dataMode,
    adjusted: true,
    lat: c.lat, lon: c.lon,
    timestamps: [c.time],
    pressureDbar: c.pres,
    depths: c.pres,
    variables: { chlorophyll: c.chla },
    cycleCount: f.cycles.length,
    offsetMs,
    attribution: _argoDoc.attribution,
  };
}

function _mockArgoPlatforms(atTime) {
  return [
    { platformId: '2903456', type: 'argo', lat: 14.2, lon: 71.8, lastUpdate: _syntheticTime(atTime, 0), track: [] },
    { platformId: '2903457', type: 'argo', lat: 10.5, lon: 73.2, lastUpdate: _syntheticTime(atTime, 12), track: [] },
    { platformId: '2903458', type: 'argo', lat: 17.8, lon: 69.5, lastUpdate: _syntheticTime(atTime, 6), track: [] },
    { platformId: '2903459', type: 'argo', lat: 12.1, lon: 75.4, lastUpdate: _syntheticTime(atTime, 42), track: [] },
    { platformId: '2903460', type: 'argo', lat: 16.3, lon: 72.9, lastUpdate: _syntheticTime(atTime, 24), track: [] },
  ];
}

function _mockGliderPlatforms(atTime) {
  return [
    {
      platformId: 'SG601', type: 'glider', lat: 13.5, lon: 72.1, lastUpdate: _syntheticTime(atTime, 0),
      track: [
        { lat: 11.0, lon: 70.5 }, { lat: 11.8, lon: 71.0 }, { lat: 12.6, lon: 71.4 },
        { lat: 13.0, lon: 71.8 }, { lat: 13.5, lon: 72.1 },
      ],
    },
    {
      platformId: 'SG602', type: 'glider', lat: 15.9, lon: 74.2, lastUpdate: _syntheticTime(atTime, 18),
      track: [
        { lat: 14.2, lon: 73.0 }, { lat: 14.9, lon: 73.5 }, { lat: 15.4, lon: 73.9 }, { lat: 15.9, lon: 74.2 },
      ],
    },
  ];
}

function _mockCTDPlatforms(atTime) {
  return [
    { platformId: 'CTD001', type: 'ctd', lat: 9.8,  lon: 76.1, lastUpdate: _syntheticTime(atTime, 70), track: [] },
    { platformId: 'CTD002', type: 'ctd', lat: 18.5, lon: 70.3, lastUpdate: _syntheticTime(atTime, 88), track: [] },
    { platformId: 'CTD003', type: 'ctd', lat: 11.2, lon: 68.9, lastUpdate: _syntheticTime(atTime, 116), track: [] },
  ];
}

function _mockBGCPlatforms(atTime) {
  return [
    { platformId: 'BGC701', type: 'bgc', lat: 15.0, lon: 69.8, lastUpdate: _syntheticTime(atTime, 6), track: [] },
    { platformId: 'BGC702', type: 'bgc', lat: 19.1, lon: 73.6, lastUpdate: _syntheticTime(atTime, 12), track: [] },
  ];
}

function _mockMooringPlatforms(atTime) {
  // Stub — proves plugin registry pattern: zero scene/UI code changed
  return [
    { platformId: 'MR001', type: 'mooring', lat: 12.0, lon: 74.5, lastUpdate: _syntheticTime(atTime, 0), track: [] },
  ];
}
