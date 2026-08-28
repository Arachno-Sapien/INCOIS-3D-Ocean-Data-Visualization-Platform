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

/** Provenance for the UI: what is real, what is synthetic. */
export async function getDataProvenance() {
  await _argoReady;
  return {
    argo: _argoDoc
      ? { real: true, source: _argoDoc.source, generated: _argoDoc.generated,
          timeRange: _argoDoc.timeRange, attribution: _argoDoc.attribution,
          floats: _argoDoc.floats.length,
          profiles: _argoDoc.floats.reduce((n, f) => n + f.cycles.length, 0),
          qc: _argoDoc.qc }
      : { real: false },
    bgc: _argoDoc?.bgcFloats?.length
      ? { real: true, floats: _argoDoc.bgcFloats.length,
          profiles: _argoDoc.bgcFloats.reduce((n, f) => n + f.cycles.length, 0) }
      : { real: false },
    model: { real: false, note: 'Synthetic field with physically plausible structure' },
  };
}

/** Await before any call that may need real Argo data. */
export function whenDataReady() { return _argoReady; }

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
  salinity:    { label: 'Salinity',    unit: 'PSU',  defaultMin: 34,  defaultMax: 37,  palette: 'haline',
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
  // ── REAL API SWAP: replace body with fetch() call ──
  await _delay(60);
  return _generateModelField(variable, date, timestep);
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
 * getProfile(platformId)
 *
 * Returns: { platformId, timestamps, depths, variables: { temp, sal, chl } }
 */
/**
 * @param {string} platformId
 * @param {string} [atTime] ISO time of the selected model timestep. The float's
 *        cycle nearest that time is returned, so scrubbing the model date moves
 *        the observations instead of leaving one fixed profile on screen.
 */
export async function getProfile(platformId, atTime) {
  await _argoReady;
  const real = _realArgoProfile(platformId, atTime) || _realBgcProfile(platformId, atTime);
  if (real) return real;
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
    markerColor: '#a78bfa',
    glowColor:   '#a78bfa88',
    profileVariables: ['temperature', 'salinity'],
    trackStyle: 'spline',
    fetchFn: async (atTime) => _mockGliderPlatforms(atTime),
  },
  {
    id: 'ctd',
    label: 'CTD Casts',
    markerColor: '#2dd4bf',
    glowColor:   '#2dd4bf88',
    profileVariables: ['temperature', 'salinity'],
    trackStyle: 'none',
    fetchFn: async (atTime) => _mockCTDPlatforms(atTime),
  },
  {
    id: 'bgc',
    label: 'BGC Floats',
    markerColor: '#fb923c',
    glowColor:   '#fb923c88',
    profileVariables: ['chlorophyll'],
    trackStyle: 'link',
    fetchFn: async (atTime) => {
      await _argoReady;
      return _realBgcPlatforms() || _mockBGCPlatforms(atTime);
    },
  },
  // ── PROOF-OF-CONCEPT: new sensor — zero UI/scene code changed ──
  {
    id: 'mooring',
    label: 'Moorings (stub)',
    markerColor: '#f472b6',
    glowColor:   '#f472b688',
    profileVariables: ['temperature', 'salinity'],
    trackStyle: 'none',
    fetchFn: async (atTime) => _mockMooringPlatforms(atTime),
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
  if (!_argoDoc?.bgcFloats?.length) return null;
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
