/**
 * constants.js — Shared constants (no imports, no circular deps)
 */

/**
 * DOMAIN — the full extent data exists for.
 *
 * Basin-scale Indian Ocean rather than the Arabian Sea alone, because this is
 * the extent where real observations exist: Argo and BGC floats across the
 * Arabian Sea, Bay of Bengal and equatorial Indian Ocean.
 *
 * `tools/fetch_argo.py` carries the same bounds — change both, then re-fetch.
 * This is the outer limit; it never changes at runtime.
 */
export const DOMAIN = {
  lonMin: 55, lonMax: 95,
  latMin: -10, latMax: 25,
  depthMin: 0, depthMax: 2000,
};

/**
 * VIEW — the bounds the volume is currently rendering.
 *
 * Equal to DOMAIN until the user drags an area on the overview globe, then a
 * sub-box of it. This is what the coordinate transform and the model field use,
 * so selecting a region genuinely re-renders that region rather than cropping a
 * picture of the whole basin.
 *
 * Exported as `let` on purpose: ES module live bindings mean importers see the
 * updated object after `setViewBounds()` without any subscription plumbing.
 */
export let VIEW = { ...DOMAIN };

/**
 * Scene dimensions (Three.js local space), derived from VIEW.
 *
 * Recomputed on every selection: with fixed values a tall narrow selection is
 * stretched to fill a wide box and the geography silently distorts. Near the
 * equator a degree of longitude and a degree of latitude are within ~1% of the
 * same distance, so one scale factor serves both axes.
 */
export const SCENE_SPAN = 14;     // longest horizontal axis, in scene units
export const SCENE_H = 10;        // Y (depth, before exaggeration)

export let SCENE_W = 0;           // X (longitude)
export let SCENE_D = 0;           // Z (latitude)

function _recomputeSceneDims() {
  const lonDeg = VIEW.lonMax - VIEW.lonMin;
  const latDeg = VIEW.latMax - VIEW.latMin;
  const k = SCENE_SPAN / Math.max(lonDeg, latDeg);
  SCENE_W = lonDeg * k;
  SCENE_D = latDeg * k;
}

/**
 * Point the volume at a sub-region. Bounds are clamped to DOMAIN and ordered,
 * so a drag in any direction produces a valid box.
 * @returns {object} the applied VIEW
 */
export function setViewBounds(b) {
  const lonMin = Math.max(DOMAIN.lonMin, Math.min(b.lonMin, b.lonMax));
  const lonMax = Math.min(DOMAIN.lonMax, Math.max(b.lonMin, b.lonMax));
  const latMin = Math.max(DOMAIN.latMin, Math.min(b.latMin, b.latMax));
  const latMax = Math.min(DOMAIN.latMax, Math.max(b.latMin, b.latMax));

  // A degenerate box would divide by zero in the coordinate transform
  if (lonMax - lonMin < MIN_SELECTION_DEG || latMax - latMin < MIN_SELECTION_DEG) {
    return VIEW;
  }
  VIEW = { ...DOMAIN, lonMin, lonMax, latMin, latMax };
  _recomputeSceneDims();
  return VIEW;
}

/** Back to the whole basin. */
export function resetViewBounds() {
  VIEW = { ...DOMAIN };
  _recomputeSceneDims();
  return VIEW;
}

/** True when the volume is showing a sub-region rather than everything. */
export function isSubRegion() {
  return VIEW.lonMin !== DOMAIN.lonMin || VIEW.lonMax !== DOMAIN.lonMax
      || VIEW.latMin !== DOMAIN.latMin || VIEW.latMax !== DOMAIN.latMax;
}

/** Smallest selectable side, in degrees. Below this the box is unusable. */
export const MIN_SELECTION_DEG = 1.5;

/** Operational thresholds for tropical cyclone intensification */
export const TCHP_THRESHOLD = 50;  // kJ cm⁻², energy threshold associated with rapid intensification
export const D26_THRESHOLD = 50;   // m, minimum 26 °C isotherm depth for a sustained heat reservoir

_recomputeSceneDims();

