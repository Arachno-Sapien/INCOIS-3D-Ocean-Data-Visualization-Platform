/**
 * state.js — Central application state store
 *
 * All mutable UI/scene state lives here.
 * Components subscribe via `State.subscribe(key, callback)`.
 * Components update via `State.set(key, value)`.
 * No component holds authoritative state directly.
 */

const _state = {
  // Which view owns the canvas.
  // 'globe'  — overview: pick the model region or an instrument
  // 'volume' — the depth-resolved box for the selected region
  viewMode: 'globe',

  // Active variable tab
  activeVariable: 'temperature',   // 'temperature' | 'salinity' | 'currents' | 'chlorophyll'

  // Date / time
  // Inside the real Argo coverage window. Clamped at runtime to whatever
  // js/data/argo.json actually holds, so this cannot drift out of range.
  selectedDate: '2024-06-29',
  selectedTimestep: '06:00',
  availableTimesteps: ['00:00', '06:00', '12:00', '18:00'],

  // 3D scene controls
  depthSlice: 200,           // metres
  verticalExaggeration: 3,   // 5x framed as a skyscraper; 3x reads as a volume
  layerOpacity: 0.82,

  // Colorbar — defaults to the cmocean palette for the active variable
  colorbarPalette: 'thermal',   // see PALETTES in utils.js
  colorbarMin: null,         // null = auto from variable defaults
  colorbarMax: null,
  colorbarScale: 'linear',   // 'linear' | 'log'

  // Isosurface threshold, in the active variable's units. 26 °C is D26,
  // the conventional floor of the cyclone-fuelling layer.
  isoValue: 26,
  isoStats: null,            // { threshold, minDepth, maxDepth, coverage }
  vectorScale: null,         // { maxSpeed, unit, glyphs, depthM } for the legend
  tchpStats: null,           // { min, max, unit } for the derived-layer readout

  // Layer visibility flags.
  // Model layers are listed here; instrument layers are keyed by PLUGIN_REGISTRY
  // id and default to visible when absent, so a new plugin needs no edit here.
  // Defaults show one horizontal and one vertical cut. Stacking every plane at
  // once accumulates alpha into a wash that hides the field it is drawing.
  layers: {
    seaSurface:          true,
    lonSection:          true,
    latSection:          false,
    depthSlice:          true,
    currentParticles:    false,   // auto-enabled on the Currents variable
    bathymetryGrid:      true,
    waveSurface:         true,    // decorative air-sea interface, carries no data
    isosurface:          false,   // opt-in: it occludes the slices behind it
    currentVectors:      true,    // only renders on the Currents field
    tchp:                false,   // derived cyclone-heat layer, temperature only
  },

  // Timeline
  timelineIndex: 1,          // index into availableTimesteps
  timelinePlaying: false,
  timelineSpeed: 1,          // multiplier

  // Selected instrument platform for profile panel
  selectedPlatform: null,    // { platformId, type, lat, lon, lastUpdate } | null
  profileData: null,         // getProfile() response | null

  // UI panel state
  controlsPanelOpen: true,
  layersPanelOpen: true,
  profilePanelOpen: false,
};

// Per-key subscriber lists
const _subscribers = {};

const State = {
  /**
   * Read a state key. Use dot notation for nested: `State.get('layers.argoFloats')`
   */
  get(key) {
    const parts = key.split('.');
    let val = _state;
    for (const p of parts) {
      if (val == null) return undefined;
      val = val[p];
    }
    return val;
  },

  /**
   * Write a state key and notify subscribers.
   * Supports dot notation for nested objects.
   */
  set(key, value) {
    const parts = key.split('.');
    let obj = _state;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    obj[leaf] = value;
    this._notify(key, value);
    // If nested, also notify the parent key
    if (parts.length > 1) {
      this._notify(parts[0], _state[parts[0]]);
    }
  },

  /**
   * Register a callback that fires whenever `key` changes.
   * Returns an unsubscribe function.
   */
  subscribe(key, callback) {
    if (!_subscribers[key]) _subscribers[key] = [];
    _subscribers[key].push(callback);
    return () => {
      _subscribers[key] = _subscribers[key].filter(cb => cb !== callback);
    };
  },

  _notify(key, value) {
    if (_subscribers[key]) {
      _subscribers[key].forEach(cb => cb(value));
    }
  },

  /** Snapshot of the entire state (read-only copy) */
  snapshot() {
    return JSON.parse(JSON.stringify(_state));
  },
};

export default State;
