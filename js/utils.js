/**
 * utils.js — Shared utility functions
 *
 * Coordinate conversion, noise, color mapping, math helpers.
 * These are the SEAMS: swapping to a real globe (Cesium) means
 * only `latLonDepthToScene` needs updating.
 */

import { VIEW, SCENE_W, SCENE_D, SCENE_H } from './constants.js';

// ---------------------------------------------------------------------------
// Coordinate conversion
// ---------------------------------------------------------------------------

/**
 * Convert geographic lat/lon/depth to local Three.js scene coordinates.
 *
 * Scene space:
 *   X = longitude → [-5, +5]
 *   Y = depth      → [0, +10] (surface = 0, bottom = 10 before exaggeration)
 *   Z = latitude   → [-6, +6]
 *
 * This is the ONE function to change if replacing Three.js box with a real globe.
 */
export function latLonDepthToScene(lat, lon, depthM, vertExag = 1) {
  const xNorm = (lon - VIEW.lonMin) / (VIEW.lonMax - VIEW.lonMin);
  const zNorm = (lat - VIEW.latMin) / (VIEW.latMax - VIEW.latMin);
  const yNorm = depthM / VIEW.depthMax;

  return {
    x: (xNorm - 0.5) * SCENE_W,
    y: -yNorm * SCENE_H * vertExag,
    z: (zNorm - 0.5) * SCENE_D,
  };
}

/**
 * Inverse: scene x,y,z → geographic lon, lat, depth.
 */
export function sceneToLatLonDepth(x, y, z, vertExag = 1) {
  const xNorm = x / SCENE_W + 0.5;
  const zNorm = z / SCENE_D + 0.5;
  const yNorm = -y / (SCENE_H * vertExag);
  return {
    lon: xNorm * (VIEW.lonMax - VIEW.lonMin) + VIEW.lonMin,
    lat: zNorm * (VIEW.latMax - VIEW.latMin) + VIEW.latMin,
    depth: yNorm * VIEW.depthMax,
  };
}

/** Depth in metres → scene Y coordinate */
export function depthToSceneY(depthM, vertExag = 1) {
  return -(depthM / VIEW.depthMax) * SCENE_H * vertExag;
}

// ---------------------------------------------------------------------------
// Seeded pseudo-random noise (no external lib)
// ---------------------------------------------------------------------------

/**
 * Smooth noise in [0,1]. Deterministic for given (x,y,z).
 * Uses a multi-octave value-noise approach with sine hashing.
 */
export function seededNoise(x, y, z = 0) {
  const dot = (ax, ay, az) => Math.sin(ax * 127.1 + ay * 311.7 + az * 74.9) * 43758.5;
  const frac = v => v - Math.floor(v);

  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = frac(x), fy = frac(y), fz = frac(z);

  // Smooth interpolation
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const r = (ox, oy, oz) => frac(Math.abs(dot(ix + ox, iy + oy, iz + oz)));

  return lerp(
    lerp(lerp(r(0,0,0), r(1,0,0), ux), lerp(r(0,1,0), r(1,1,0), ux), uy),
    lerp(lerp(r(0,0,1), r(1,0,1), ux), lerp(r(0,1,1), r(1,1,1), ux), uy),
    uz
  );
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

export function lerp(a, b, t) { return a + (b - a) * t; }
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export function invLerp(a, b, v) { return (v - a) / (b - a); }
export function remap(v, a, b, c, d) { return lerp(c, d, clamp(invLerp(a, b, v), 0, 1)); }

// ---------------------------------------------------------------------------
// Color palettes & mapping
// ---------------------------------------------------------------------------

/**
 * Colour palettes, as evenly-spaced RGB stops (0–1) interpolated at lookup.
 *
 * The defaults are approximations of `cmocean` — the community-standard
 * colormap set for oceanography (Thyng et al., 2016). They are perceptually
 * uniform: equal steps in value look like equal steps in colour, and they
 * stay readable under colour-vision deficiency.
 *
 * `jet` is retained ONLY so the difference can be demonstrated. It is not a
 * valid choice for presenting data: its lightness is non-monotonic, so it
 * invents banding where the field is smooth and flattens real gradients in
 * the green band. Do not make it a default for any variable.
 */
// ponytail: 7-stop linear approximations of cmocean, not the full 256-entry
// lookup tables. Visually faithful and enough for rendering; if a colour-accuracy
// claim is ever needed, swap in the published cmocean RGB tables — valueToColor
// interpolates any stop count, so nothing else changes.
export const PALETTES = {
  // cmocean 'thermal' — temperature
  thermal: [[0.016,0.138,0.201],[0.229,0.145,0.427],[0.417,0.146,0.489],
            [0.629,0.196,0.437],[0.827,0.288,0.322],[0.940,0.549,0.172],[0.910,0.984,0.353]],
  // cmocean 'haline' — salinity
  haline:  [[0.122,0.114,0.337],[0.098,0.283,0.522],[0.106,0.443,0.507],
            [0.148,0.599,0.437],[0.397,0.741,0.334],[0.741,0.855,0.437],[0.933,0.945,0.569]],
  // cmocean 'algae' — chlorophyll / biology
  algae:   [[0.122,0.125,0.086],[0.106,0.271,0.153],[0.145,0.420,0.196],
            [0.263,0.573,0.243],[0.494,0.725,0.325],[0.694,0.831,0.435],[0.847,0.890,0.545]],
  // cmocean 'speed' — current magnitude
  speed:   [[1.000,0.992,0.804],[0.878,0.910,0.502],[0.686,0.796,0.361],
            [0.447,0.616,0.204],[0.239,0.502,0.204],[0.149,0.376,0.180],[0.090,0.208,0.118]],
  // cmocean 'balance' — anomalies / signed fields, neutral at the midpoint
  balance: [[0.094,0.110,0.263],[0.180,0.333,0.616],[0.404,0.616,0.827],
            [0.961,0.957,0.949],[0.851,0.518,0.396],[0.706,0.243,0.196],[0.345,0.075,0.086]],
  // General-purpose perceptually-uniform fallbacks
  viridis: [[0.267,0.005,0.329],[0.283,0.141,0.458],[0.254,0.265,0.530],
            [0.208,0.372,0.553],[0.128,0.567,0.551],[0.361,0.722,0.356],[0.993,0.906,0.144]],
  cividis: [[0.000,0.135,0.304],[0.000,0.231,0.427],[0.220,0.338,0.451],
            [0.400,0.442,0.459],[0.565,0.556,0.447],[0.752,0.686,0.396],[0.996,0.843,0.223]],
  // Retained for comparison only — see note above.
  jet:     [[0.000,0.000,0.500],[0.000,0.200,1.000],[0.000,0.800,1.000],
            [0.400,1.000,0.600],[1.000,0.900,0.100],[1.000,0.350,0.000],[0.500,0.000,0.000]],
};

/** Palettes whose midpoint is a neutral value rather than a mid-magnitude. */
export const DIVERGING_PALETTES = new Set(['balance']);

/**
 * Map a normalised value (0–1) to an RGBA colour using the chosen palette.
 * Returns [r, g, b, a] each 0–255.
 *
 * A non-finite `t` returns fully transparent rather than a colour. Real fields
 * carry land and unanalysed cells as NaN, and without this the arithmetic below
 * indexes the stop table with NaN and throws — one missing cell would take the
 * whole layer, and with it the scene, down. Absent data must render as absent.
 */
export function valueToColor(t, palette = 'thermal', alpha = 255) {
  if (!Number.isFinite(t)) return [0, 0, 0, 0];
  t = clamp(t, 0, 1);
  const stops = PALETTES[palette] || PALETTES.thermal;
  const seg = (stops.length - 1) * t;
  const i = Math.min(Math.floor(seg), stops.length - 2);
  const f = seg - i;
  const a = stops[i], b = stops[i + 1];
  return [
    Math.round(lerp(a[0], b[0], f) * 255),
    Math.round(lerp(a[1], b[1], f) * 255),
    Math.round(lerp(a[2], b[2], f) * 255),
    alpha,
  ];
}

/**
 * Build a 256×1 gradient ImageData for a colorbar canvas.
 */
export function buildColorbarImageData(palette) {
  const data = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b, a] = valueToColor(i / 255, palette);
    data[i * 4]     = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return new ImageData(data, 256, 1);
}

/**
 * Generate a heatmap texture (Uint8ClampedArray, RGBA) for a 2D grid slice.
 * w × h pixels, values is a flat Float32Array of length w*h.
 */
export function generateHeatmapTexture(values, w, h, min, max, palette = 'jet', scale = 'linear') {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    // Land and unanalysed cells arrive as NaN and stay a hole. Substituting a
    // number here — 0, the minimum, a neighbour — would paint a continent as
    // water at whatever temperature that number happens to mean.
    if (!Number.isFinite(values[i])) continue;   // leaves RGBA 0,0,0,0
    let t;
    if (scale === 'log') {
      const logMin = Math.log(Math.max(min, 1e-6));
      const logMax = Math.log(Math.max(max, 1e-5));
      t = (Math.log(Math.max(values[i], 1e-6)) - logMin) / (logMax - logMin);
    } else {
      t = (values[i] - min) / (max - min);
    }
    const [r, g, b, a] = valueToColor(t, palette, 220);
    data[i * 4]     = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return data;
}

/**
 * Resample a vertical section from the field's own depth levels onto an evenly
 * spaced one, so it can be drawn as a texture.
 *
 * A texture maps its rows linearly across the plane it is on. The real levels
 * are not linear — 5, 10, 20, 30, 50, 75, 100 ... 1800, 2000 m — so painting
 * them row-for-row puts the 100 m level a quarter of the way down a 2000 m box
 * and draws the thermocline at five times its true depth. That is not a styling
 * choice, it is the picture being wrong, and it is the reason `depths` is
 * carried through from the fetch rather than derived from the level index.
 *
 * @param {Float32Array} values  w × depths.length, row-major (row = level)
 * @param {number} w             columns (longitude or latitude samples)
 * @param {number[]} depths      the field's real levels, ascending, in metres
 * @param {number} outH          output rows, evenly spaced over [0, depthMax]
 * @param {number} depthMax      bottom of the box, in metres
 * @returns {Float32Array} w × outH, NaN where the field has no value
 */
export function resampleDepthRows(values, w, depths, outH, depthMax) {
  const nz = depths.length;
  const out = new Float32Array(w * outH).fill(NaN);
  let k = 0;
  for (let j = 0; j < outH; j++) {
    const d = (j / (outH - 1)) * depthMax;
    // Deeper than the product reaches: stays NaN. Extrapolating downward would
    // invent a water column below where the analysis actually stops.
    if (d > depths[nz - 1]) break;
    if (d <= depths[0]) {
      // Above the shallowest level. Held flat rather than faded out: the top
      // level here is 5 m and it sits inside the mixed layer, which is by
      // definition uniform over that distance.
      out.set(values.subarray(0, w), j * w);
      continue;
    }
    while (k < nz - 2 && depths[k + 1] < d) k++;
    const t = (d - depths[k]) / (depths[k + 1] - depths[k]);
    for (let i = 0; i < w; i++) {
      const a = values[k * w + i], b = values[(k + 1) * w + i];
      // A hole on either side is a hole here: the seafloor between two levels
      // is not somewhere to interpolate through.
      out[j * w + i] = Number.isFinite(a) && Number.isFinite(b)
        ? a + (b - a) * t
        : NaN;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

export function formatDepth(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

export function formatDate(isoStr) {
  return new Date(isoStr).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC';
}
