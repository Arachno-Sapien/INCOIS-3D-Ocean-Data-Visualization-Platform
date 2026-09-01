/**
 * globe.js — Overview globe: the region and instrument selector.
 *
 * This is the entry view, modelled on how INCOIS operators already pick an
 * area of interest: the Live Access Server draws a lat/lon box on a 2D map,
 * and the Ocean Observation Network map shows clickable instrument pins.
 * This does both on a sphere, then flies into the depth-resolved volume.
 *
 * The default theme renders procedurally from embedded coastline data. The
 * optional NASA theme loads one bundled local image, never an external tile
 * service, so the overview remains safe to use without venue internet.
 *
 * The globe owns no state. scene.js drives visibility and the camera.
 */

import * as THREE from 'three';
import { COASTLINE } from './coastline.js';
import { DOMAIN } from './constants.js';

export const GLOBE_R = 8;
export const DEFAULT_GLOBE_THEME = 'digital';

export const GLOBE_THEMES = Object.freeze({
  digital: Object.freeze({
    label: 'Digital Ocean',
    showGraticule: true,
    coastlineOpacity: 0.62,
    atmosphereColor: 0x63e6be,
  }),
  nasa: Object.freeze({
    label: 'NASA Blue Marble',
    showGraticule: false,
    coastlineOpacity: 0.12,
    atmosphereColor: 0x69c9d5,
  }),
});

const NASA_TEXTURE_URL = './assets/textures/nasa-blue-marble-january-5400.jpg';

/**
 * Geographic position to a point on the globe.
 * `alt` lifts the point off the surface in globe radii.
 */
export function latLonToGlobe(lat, lon, alt = 0) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lon + 180) * Math.PI / 180;
  const r = GLOBE_R * (1 + alt);
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta)
  );
}

/**
 * Inverse of latLonToGlobe: a point on the sphere back to geographic degrees.
 * Used to turn a raycast hit into the corner of a selection box.
 */
export function globeToLatLon(p) {
  const n = p.clone().normalize();
  const lat = 90 - Math.acos(Math.max(-1, Math.min(1, n.y))) * 180 / Math.PI;
  const lon = ((Math.atan2(n.z, -n.x) * 180 / Math.PI) - 180 + 540) % 360 - 180;
  return { lat, lon };
}

/**
 * A lat/lon-aligned rectangle tessellated onto the sphere, so it curves with
 * the surface instead of floating as a flat card. Used for both the domain
 * extent and the live selection preview.
 */
export function buildLatLonPatch(bounds, { alt = 0.008, color = 0x63e6be, opacity = 0.2 } = {}) {
  const { lonMin, lonMax, latMin, latMax } = bounds;
  const NU = 24, NV = 24;
  const verts = [], idx = [];
  for (let j = 0; j <= NV; j++) {
    for (let i = 0; i <= NU; i++) {
      const p = latLonToGlobe(latMin + (latMax - latMin) * (j / NV),
        lonMin + (lonMax - lonMin) * (i / NU), alt);
      verts.push(p.x, p.y, p.z);
    }
  }
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const a = j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
  });
  return new THREE.Mesh(geo, mat);
}

/** The outline of a lat/lon box, following the sphere's curvature. */
export function buildLatLonOutline(bounds, { alt = 0.010, color = 0x8ff5d6, opacity = 0.9 } = {}) {
  const { lonMin, lonMax, latMin, latMax } = bounds;
  const ring = [];
  const edge = (aLat, aLon, bLat, bLon, n) => {
    for (let k = 0; k <= n; k++) {
      ring.push(latLonToGlobe(aLat + (bLat - aLat) * k / n,
        aLon + (bLon - aLon) * k / n, alt));
    }
  };
  edge(latMin, lonMin, latMin, lonMax, 24);
  edge(latMin, lonMax, latMax, lonMax, 24);
  edge(latMax, lonMax, latMax, lonMin, 24);
  edge(latMax, lonMin, latMin, lonMin, 24);
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(ring),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity })
  );
}

/**
 * Build the globe.
 * @param {Array} platforms  from getAllPlatforms()
 * @param {Array} registry   PLUGIN_REGISTRY, for per-type marker colour
 * @returns {{group, pins, domainHitbox, sphere, dispose}}
 */
export function buildGlobe(platforms, registry) {
  const group = new THREE.Group();
  group.name = 'globeGroup';
  const disposables = [];
  const track = (...xs) => { disposables.push(...xs); return xs[0]; };

  // ── Ocean body ────────────────────────────────────────────────────────
  // Slightly under the coastlines so the lines never z-fight with the fill.
  const oceanGeo = track(new THREE.SphereGeometry(GLOBE_R, 64, 48));
  const oceanMat = track(new THREE.MeshPhongMaterial({
    color: 0x0a2f45,
    emissive: 0x04141f,
    shininess: 12,
    specular: 0x1d5c66,
  }));
  // Kept as a handle: the area-selection drag raycasts against this to turn a
  // screen position into a lat/lon.
  const sphere = new THREE.Mesh(oceanGeo, oceanMat);
  sphere.name = 'globeSphere';
  group.add(sphere);

  // ── Graticule ─────────────────────────────────────────────────────────
  // A survey-chart reference, not decoration: it gives the eye a lat/lon
  // frame so the highlighted domain reads as a real geographic extent.
  const gratPts = [];
  for (let lat = -60; lat <= 60; lat += 30) {
    for (let lon = -180; lon < 180; lon += 4) {
      gratPts.push(latLonToGlobe(lat, lon, 0.001), latLonToGlobe(lat, lon + 4, 0.001));
    }
  }
  for (let lon = -180; lon < 180; lon += 30) {
    for (let lat = -88; lat < 88; lat += 4) {
      gratPts.push(latLonToGlobe(lat, lon, 0.001), latLonToGlobe(lat + 4, lon, 0.001));
    }
  }
  const gratGeo = track(new THREE.BufferGeometry().setFromPoints(gratPts));
  const gratMat = track(new THREE.LineBasicMaterial({
    color: 0x5f9fb0, transparent: true, opacity: 0.16,
  }));
  const graticule = new THREE.LineSegments(gratGeo, gratMat);
  group.add(graticule);

  // ── Coastlines ────────────────────────────────────────────────────────
  const coastPts = [];
  for (const seg of COASTLINE) {
    for (let i = 0; i + 3 < seg.length; i += 2) {
      coastPts.push(
        latLonToGlobe(seg[i + 1], seg[i], 0.004),
        latLonToGlobe(seg[i + 3], seg[i + 2], 0.004)
      );
    }
  }
  const coastGeo = track(new THREE.BufferGeometry().setFromPoints(coastPts));
  const coastMat = track(new THREE.LineBasicMaterial({
    color: 0x9fe8dc, transparent: true, opacity: 0.62,
  }));
  const coastlines = new THREE.LineSegments(coastGeo, coastMat);
  group.add(coastlines);

  // ── Atmospheric rim ───────────────────────────────────────────────────
  // Backside sphere with a view-angle falloff. Reads as depth at the limb
  // and separates the globe from the page ground without an outer glow.
  const atmoGeo = track(new THREE.SphereGeometry(GLOBE_R * 1.055, 48, 32));
  const atmoMat = track(new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0x63e6be) } },
    vertexShader: `
      varying float vRim;
      void main() {
        vec3 n = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vRim = pow(1.0 - abs(dot(n, normalize(-mv.xyz))), 3.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vRim;
      void main() { gl_FragColor = vec4(uColor, vRim * 0.55); }
    `,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  }));
  const atmosphere = new THREE.Mesh(atmoGeo, atmoMat);
  group.add(atmosphere);

  // ── Model domain ──────────────────────────────────────────────────────
  // The exact extent the volume view renders, drawn with the same builders the
  // live area selection uses so the two always agree visually.
  const domainHitbox = buildLatLonPatch(DOMAIN);
  domainHitbox.name = 'domainPatch';
  domainHitbox.userData = { domain: true };
  group.add(domainHitbox);
  disposables.push(domainHitbox.geometry, domainHitbox.material);

  const ringLine = buildLatLonOutline(DOMAIN);
  group.add(ringLine);
  disposables.push(ringLine.geometry, ringLine.material);

  // ── Instrument pins ───────────────────────────────────────────────────
  // Same hue per instrument class as the volume view and the layer list, so
  // a float is the same colour wherever it appears.
  const pins = [];
  const pinGeo = track(new THREE.SphereGeometry(0.085, 12, 12));
  const stemGeo = track(new THREE.CylinderGeometry(0.008, 0.008, 1, 6));

  for (const p of platforms) {
    const entry = registry.find(e => e.id === p.type);
    if (!entry) continue;
    const colour = new THREE.Color(entry.markerColor);
    const mat = track(new THREE.MeshBasicMaterial({ color: colour }));

    const surface = latLonToGlobe(p.lat, p.lon, 0.0);
    const head = latLonToGlobe(p.lat, p.lon, 0.055);

    const pin = new THREE.Mesh(pinGeo, mat);
    pin.position.copy(head);
    pin.userData = { platform: p };
    group.add(pin);
    pins.push(pin);

    // Stem, so a pin reads as standing on the surface rather than floating
    const stem = new THREE.Mesh(stemGeo, track(new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity: 0.45,
    })));
    const mid = surface.clone().lerp(head, 0.5);
    stem.position.copy(mid);
    stem.scale.y = surface.distanceTo(head);
    stem.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), head.clone().normalize());
    stem.userData = { platform: p };
    group.add(stem);
  }

  let nasaMaterial = null;
  let nasaTexture = null;
  let nasaTexturePromise = null;
  let themeRequest = 0;

  const loadNasaTexture = () => {
    if (nasaTexture) return Promise.resolve(nasaTexture);
    if (!nasaTexturePromise) {
      nasaTexturePromise = new THREE.TextureLoader().loadAsync(NASA_TEXTURE_URL)
        .then(texture => {
          // This is satellite colour imagery, unlike the app's data textures.
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = 2;
          nasaTexture = texture;
          disposables.push(texture);
          return texture;
        })
        .catch(error => {
          nasaTexturePromise = null; // permit a later retry after a deployment fix
          throw error;
        });
    }
    return nasaTexturePromise;
  };

  const applyOverlayTheme = theme => {
    graticule.visible = theme.showGraticule;
    coastMat.opacity = theme.coastlineOpacity;
    atmoMat.uniforms.uColor.value.setHex(theme.atmosphereColor);
  };

  const setTheme = async requestedTheme => {
    const name = GLOBE_THEMES[requestedTheme] ? requestedTheme : DEFAULT_GLOBE_THEME;
    const request = ++themeRequest;
    const theme = GLOBE_THEMES[name];

    if (name === 'digital') {
      sphere.material = oceanMat;
      applyOverlayTheme(theme);
      group.userData.globeTheme = name;
      return name;
    }

    const texture = await loadNasaTexture();
    // Ignore a completed image request if the user already picked another theme.
    if (request !== themeRequest) return group.userData.globeTheme;

    if (!nasaMaterial) {
      // Use a neutral white emissive so the satellite texture's own colours
      // (vivid blue ocean, tan/brown land, white clouds) read at full fidelity.
      // A tinted emissive suppresses every hue that is not in that tint; white
      // emissive is additive across the full spectrum.
      // emissiveIntensity drives overall brightness: 0.72 ≈ the reference image.
      nasaMaterial = track(new THREE.MeshPhongMaterial({
        map: texture,
        emissiveMap: texture,
        color: 0xffffff,
        emissive: 0xffffff,
        emissiveIntensity: 0.72,
        shininess: 4,
        specular: 0x112233,
      }));
    }
    sphere.material = nasaMaterial;
    applyOverlayTheme(theme);
    group.userData.globeTheme = name;
    return name;
  };

  // Digital stays the first paint, including when the saved NASA selection is
  // loading, so no slow asset can leave the overview blank.
  applyOverlayTheme(GLOBE_THEMES.digital);
  group.userData.globeTheme = DEFAULT_GLOBE_THEME;

  return {
    group,
    pins,
    domainHitbox,
    sphere,
    setTheme,
    dispose() {
      disposables.forEach(d => d.dispose && d.dispose());
    },
  };
}
