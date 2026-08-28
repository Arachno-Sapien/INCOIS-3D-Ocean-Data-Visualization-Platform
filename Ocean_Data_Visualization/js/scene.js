/**
 * scene.js — Three.js 3D Scene Manager
 *
 * Owns:
 *  - Renderer, camera, controls, scene graph
 *  - Ocean box (axes + tick labels)
 *  - Volumetric layer planes (sea surface, cross-sections, depth slice)
 *  - Current particle system
 *  - Instrument markers (Argo, Glider, CTD, BGC, Mooring)
 *  - Glider spline tracks
 *  - Bathymetry grid
 *  - Starfield background
 *  - Raycasting for marker click
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import State from './state.js';
import { PLUGIN_REGISTRY, VARIABLE_META, getModelField, getAllPlatforms } from './dataService.js';
import { latLonDepthToScene, depthToSceneY, seededNoise, generateHeatmapTexture, clamp, lerp, valueToColor } from './utils.js';
import { DOMAIN, VIEW, SCENE_W, SCENE_D, SCENE_H,
         setViewBounds, resetViewBounds, MIN_SELECTION_DEG } from './constants.js';
import { buildGlobe, latLonToGlobe, globeToLatLon, GLOBE_R,
         buildLatLonPatch, buildLatLonOutline } from './globe.js';

let renderer, camera, controls, scene;
let _animFrame = null;
let _clock;

// Three.js object references for layers
const layers = {
  seaSurface:       null,
  lonSection:       null,
  latSection:       null,
  depthSlice:       null,
  bathymetryGrid:   null,
  waveSurface:      null,
  isosurface:       null,
  currentVectors:   null,
  tchp:             null,
};

let _oceanBoxGroup = null;
let _depthAxisLine = null;
let _currentParticleSystem = null;
let _markerGroup = null;
let _raycaster = null;
let _markerObjects = [];   // { mesh, platform } for raycasting
let _markerGen = 0;        // guards concurrent marker refreshes
let _isoStats = null;      // coverage/depth range of the last isosurface
let _modelData = null;     // last fetched model field data

// Live query, so a mid-session OS setting change is picked up without reload
const _reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** The selected model frame as an ISO instant. */
function _modelTimeISO() {
  return `${State.get('selectedDate')}T${State.get('selectedTimestep')}:00Z`;
}

let _globe = null;          // { group, pins, domainHitbox, dispose }
let _camFlight = null;      // in-progress camera transition, or null

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

export async function initScene(canvas) {
  // WebGL2 check
  const testCanvas = document.createElement('canvas');
  const gl2 = testCanvas.getContext('webgl2');
  if (!gl2) {
    throw new Error('WebGL2 not available on this device.');
  }

  // Ensure canvas has explicit pixel dimensions before Three.js reads them
  const W = canvas.clientWidth  || window.innerWidth;
  const H = canvas.clientHeight || window.innerHeight;
  canvas.width  = W;
  canvas.height = H;

  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x03101a);
  renderer.shadowMap.enabled = false;

  // Scene
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x03101a, 0.020);

  _clock = new THREE.Clock();

  // Camera — framed so the whole water column is legible on first paint.
  // Aimed at mid-column rather than the surface, and offset off-axis so the
  // opening view is a three-quarter read of the volume, not a flat elevation.
  camera = new THREE.PerspectiveCamera(46, W / H, 0.1, 500);
  const boxH0 = SCENE_H * State.get('verticalExaggeration');
  camera.position.set(29, -boxH0 * 0.10, 42);
  camera.lookAt(0, -boxH0 * 0.5, 0);

  // Orbit controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.target.set(0, -boxH0 * 0.5, 0);
  controls.minDistance = 6;
  controls.maxDistance = 90;
  controls.update();

  // Raycaster
  _raycaster = new THREE.Raycaster();
  _raycaster.params.Points.threshold = 0.4;

  // Build scene graph
  _buildStarfield();
  _buildOceanBox();
  _buildLighting();

  // Load initial data
  await _refreshModelLayers();
  await _refreshInstrumentMarkers();
  _buildBathymetryGrid(State.get('verticalExaggeration'));
  _buildWaveSurface();

  // Overview globe, built from the same platform list as the volume markers
  _globe = buildGlobe(await getAllPlatforms(), PLUGIN_REGISTRY);
  scene.add(_globe.group);
  _applyViewMode(State.get('viewMode'), true);

  // State subscriptions — re-render when relevant state changes
  State.subscribe('activeVariable', () => _refreshModelLayers());
  // Markers refresh with the frame too: synthetic platforms are generated
  // relative to the selected time, so a stale set would drift away from it.
  State.subscribe('selectedDate',   () => { _refreshModelLayers(); _refreshInstrumentMarkers(); });
  State.subscribe('selectedTimestep', () => { _refreshModelLayers(); _refreshInstrumentMarkers(); });
  State.subscribe('depthSlice',     () => _updateDepthSlicePlane());
  State.subscribe('verticalExaggeration', () => _applyVerticalExaggeration());
  State.subscribe('layerOpacity',   () => _applyLayerOpacity());
  State.subscribe('colorbarPalette', () => _refreshModelLayers());
  State.subscribe('colorbarMin',    () => _refreshModelLayers());
  State.subscribe('colorbarMax',    () => _refreshModelLayers());
  State.subscribe('colorbarScale',  () => _refreshModelLayers());
  State.subscribe('isoValue',       () => _buildIsosurface());
  State.subscribe('layers',         () => _applyLayerVisibility());
  State.subscribe('timelineIndex',  () => {
    const ts = State.get('availableTimesteps')[State.get('timelineIndex')];
    State.set('selectedTimestep', ts);
  });
  State.subscribe('viewMode',       v  => _applyViewMode(v, false));

  // Resize handler
  window.addEventListener('resize', _onResize);

  // Start render loop
  _renderLoop();

  return { renderer, scene, camera };
}

// ---------------------------------------------------------------------------
// Click / Raycasting
// ---------------------------------------------------------------------------

/**
 * Hit-test the click against whichever view is active.
 *
 * Returns a platform object (open its profile), the string 'domain' (the user
 * picked the model region on the globe), or null.
 */
export function handleCanvasClick(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width)  *  2 - 1,
    -((event.clientY - rect.top)  / rect.height) * 2 + 1
  );
  _raycaster.setFromCamera(mouse, camera);

  if (State.get('viewMode') === 'globe') {
    if (!_globe) return null;
    // Pins take priority over the region patch they sit on.
    const pinHits = _raycaster.intersectObjects(_globe.pins, false);
    if (pinHits.length) return pinHits[0].object.userData.platform;
    if (_raycaster.intersectObject(_globe.domainHitbox, false).length) return 'domain';
    return null;
  }

  const hits = _raycaster.intersectObjects(_markerObjects.map(m => m.mesh), false);
  if (hits.length > 0) {
    const found = _markerObjects.find(m => m.mesh === hits[0].object);
    if (found) return found.platform;
  }
  return null;
}

/**
 * Frame the volume view.
 *
 * Distance is derived from the box, not hardcoded: the exaggerated water column
 * is far taller than the domain is wide, so height sets the framing. Fixed
 * numbers here were tuned for a 10x12 domain and clipped the box as soon as
 * DOMAIN or the exaggeration changed.
 */
function _volumeFraming() {
  const boxH = SCENE_H * State.get('verticalExaggeration');
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  // Whichever extent needs the most room decides the distance
  const need = Math.max(boxH, SCENE_D, SCENE_W / Math.max(camera.aspect, 0.1));
  const dist = (need / 2) / Math.tan(halfFov) * 1.35;   // 1.35 = breathing room
  const target = new THREE.Vector3(0, -boxH * 0.5, 0);
  // Fixed three-quarter direction, so the opening view reads as a volume
  const dir = new THREE.Vector3(0.553, 0.229, 0.801).normalize();
  return { pos: dir.multiplyScalar(dist).add(target), target };
}

/** Frame the globe so the model domain faces the camera. */
function _globeFraming() {
  const midLat = (DOMAIN.latMin + DOMAIN.latMax) / 2;
  const midLon = (DOMAIN.lonMin + DOMAIN.lonMax) / 2;
  return {
    pos: latLonToGlobe(midLat, midLon, 1.95),
    target: new THREE.Vector3(0, 0, 0),
  };
}

/**
 * Swap views. The camera flies between framings rather than cutting, so the
 * relationship between the region on the globe and the volume it opens stays
 * legible: the transition IS the explanation of what just happened.
 */
function _applyViewMode(mode, immediate) {
  const globeMode = mode === 'globe';
  if (_globe) _globe.group.visible = globeMode;
  if (_oceanBoxGroup) _oceanBoxGroup.visible = !globeMode;
  if (_markerGroup) _markerGroup.visible = !globeMode;
  // The selection box belongs to the globe; it has no meaning inside the volume
  if (_selectGroup) _selectGroup.visible = globeMode;

  const to = globeMode ? _globeFraming() : _volumeFraming();
  controls.minDistance = globeMode ? GLOBE_R * 1.25 : 6;
  controls.maxDistance = globeMode ? GLOBE_R * 6 : 90;

  if (immediate || _reduceMotion.matches) {
    camera.position.copy(to.pos);
    controls.target.copy(to.target);
    controls.update();
    _camFlight = null;
    return;
  }

  _camFlight = {
    fromPos: camera.position.clone(),
    toPos: to.pos,
    fromTarget: controls.target.clone(),
    toTarget: to.target,
    t: 0,
    dur: 1.15,
  };
}

// ---------------------------------------------------------------------------
// Area selection on the globe
// ---------------------------------------------------------------------------
// Modelled on the Live Access Server's lat/lon box, drawn on a sphere instead
// of a flat map. The drag raycasts against the globe body, so the box is built
// from real geographic corners rather than a screen rectangle that would skew
// with the curvature.

let _selectGroup = null;      // live preview: patch + outline
let _dragStart = null;        // { lat, lon } of pointerdown, or null

/** Screen position to geographic degrees via the globe surface. */
function _pointerToLatLon(event, canvas) {
  if (!_globe) return null;
  const rect = canvas.getBoundingClientRect();
  _raycaster.setFromCamera(new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  ), camera);
  const hit = _raycaster.intersectObject(_globe.sphere, false)[0];
  return hit ? globeToLatLon(hit.point) : null;   // null = pointer missed the globe
}

function _clearSelectionPreview() {
  if (!_selectGroup) return;
  _selectGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  scene.remove(_selectGroup);
  _selectGroup = null;
}

/** Draw the in-progress box. */
function _drawSelectionPreview(bounds) {
  _clearSelectionPreview();
  _selectGroup = new THREE.Group();
  _selectGroup.name = 'selectionPreview';
  _selectGroup.add(buildLatLonPatch(bounds, { alt: 0.012, color: 0xffd166, opacity: 0.22 }));
  _selectGroup.add(buildLatLonOutline(bounds, { alt: 0.014, color: 0xffd166, opacity: 1 }));
  scene.add(_selectGroup);
}

function _boundsFrom(a, b) {
  return {
    lonMin: Math.min(a.lon, b.lon), lonMax: Math.max(a.lon, b.lon),
    latMin: Math.min(a.lat, b.lat), latMax: Math.max(a.lat, b.lat),
  };
}

export function beginAreaDrag(event, canvas) {
  const p = _pointerToLatLon(event, canvas);
  if (!p) return false;
  _dragStart = p;
  controls.enabled = false;      // otherwise the drag spins the globe instead
  return true;
}

export function updateAreaDrag(event, canvas) {
  if (!_dragStart) return null;
  const p = _pointerToLatLon(event, canvas);
  if (!p) return null;           // pointer left the globe: keep the last box
  const b = _boundsFrom(_dragStart, p);
  _drawSelectionPreview(b);
  return b;
}

/**
 * Commit the drag.
 * @returns {object|null} the applied bounds, or null if the drag was too small
 *          to be a deliberate selection (a click, or a sliver).
 */
export function endAreaDrag(event, canvas) {
  controls.enabled = true;
  if (!_dragStart) return null;
  const p = _pointerToLatLon(event, canvas);
  const start = _dragStart;
  _dragStart = null;
  if (!p) { _clearSelectionPreview(); return null; }

  const b = _boundsFrom(start, p);
  if (b.lonMax - b.lonMin < MIN_SELECTION_DEG || b.latMax - b.latMin < MIN_SELECTION_DEG) {
    _clearSelectionPreview();
    return null;
  }
  const applied = setViewBounds(b);
  _drawSelectionPreview(applied);   // redraw at the clamped bounds actually used
  return applied;
}

export function cancelAreaDrag() {
  _dragStart = null;
  if (controls) controls.enabled = true;
  _clearSelectionPreview();
}

/** Drop the sub-region and rebuild the volume at full basin extent. */
export async function clearAreaSelection() {
  resetViewBounds();
  _clearSelectionPreview();
  await _rebuildForBounds();
}

/**
 * Rebuild everything that depends on the view bounds.
 * SCENE_W/SCENE_D are live bindings, so they already carry the new values by
 * the time this runs; the geometry built from them has to be regenerated.
 */
async function _rebuildForBounds() {
  if (!_oceanBoxGroup) return;
  scene.remove(_oceanBoxGroup);
  _oceanBoxGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  _oceanBoxGroup = null;
  for (const k of Object.keys(layers)) layers[k] = null;
  _currentParticleSystem = null;

  _buildOceanBox();
  await _refreshModelLayers();
  _buildBathymetryGrid(State.get('verticalExaggeration'));
  _buildWaveSurface();
  await _refreshInstrumentMarkers();
  _applyViewMode(State.get('viewMode'), true);
}

export function rebuildForBounds() { return _rebuildForBounds(); }

/** Advance an in-progress camera flight. Called once per frame. */
function _tickCamFlight(dt) {
  if (!_camFlight) return;
  _camFlight.t = Math.min(1, _camFlight.t + dt / _camFlight.dur);
  // easeInOutCubic: leaves and arrives calmly, moves quickly in between
  const p = _camFlight.t;
  const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  camera.position.lerpVectors(_camFlight.fromPos, _camFlight.toPos, e);
  controls.target.lerpVectors(_camFlight.fromTarget, _camFlight.toTarget, e);
  if (_camFlight.t >= 1) _camFlight = null;
}

// ---------------------------------------------------------------------------
// Internal: Starfield
// ---------------------------------------------------------------------------

function _buildStarfield() {
  const count = 1800;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3]     = (Math.random() - 0.5) * 300;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 300;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 300;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0x9fd8d0, size: 0.10, transparent: true, opacity: 0.42 });
  scene.add(new THREE.Points(geo, mat));
}

// ---------------------------------------------------------------------------
// Internal: Ocean Box
// ---------------------------------------------------------------------------

function _buildOceanBox() {
  _oceanBoxGroup = new THREE.Group();
  scene.add(_oceanBoxGroup);

  const EXAG = State.get('verticalExaggeration');
  const boxH = SCENE_H * EXAG;

  // Wireframe box edges
  const edgeGeo = new THREE.BoxGeometry(SCENE_W, boxH, SCENE_D);
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0x63e6be, wireframe: true, transparent: true, opacity: 0.12 });
  const edgeMesh = new THREE.Mesh(edgeGeo, edgeMat);
  edgeMesh.name = 'boxEdge';
  edgeMesh.position.y = -boxH / 2;
  _oceanBoxGroup.add(edgeMesh);

  // Axis lines — X (longitude)
  _addAxisLine(new THREE.Vector3(-SCENE_W/2, 0, -SCENE_D/2), new THREE.Vector3(SCENE_W/2, 0, -SCENE_D/2), 0x63e6be, _oceanBoxGroup);
  // Z (latitude)
  _addAxisLine(new THREE.Vector3(-SCENE_W/2, 0, -SCENE_D/2), new THREE.Vector3(-SCENE_W/2, 0, SCENE_D/2), 0x38bdf8, _oceanBoxGroup);
  // Y (depth) — kept so it can be rescaled with vertical exaggeration
  _depthAxisLine = _addAxisLine(new THREE.Vector3(-SCENE_W/2, 0, -SCENE_D/2), new THREE.Vector3(-SCENE_W/2, -boxH, -SCENE_D/2), 0x7dd3c8, _oceanBoxGroup);
}

function _addAxisLine(a, b, color, parent) {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 });
  const line = new THREE.Line(geo, mat);
  parent.add(line);
  return line;
}

// ---------------------------------------------------------------------------
// Internal: Lighting
// ---------------------------------------------------------------------------

function _buildLighting() {
  scene.add(new THREE.AmbientLight(0x1d4550, 1.2));
  const dir = new THREE.DirectionalLight(0x9fe8dc, 0.8);
  dir.position.set(15, 20, 10);
  scene.add(dir);
}

// ---------------------------------------------------------------------------
// Internal: Model layers (surface, sections, depth slice)
// ---------------------------------------------------------------------------

async function _refreshModelLayers() {
  const variable  = State.get('activeVariable');
  if (!VARIABLE_META[variable]) return;   // guard: 'argo' pseudo-tab, etc.
  const date      = State.get('selectedDate');
  const timestep  = State.get('selectedTimestep');
  const palette   = State.get('colorbarPalette');
  const scale     = State.get('colorbarScale');
  const meta      = VARIABLE_META[variable] || VARIABLE_META.temperature;
  const minVal    = State.get('colorbarMin') ?? meta.defaultMin;
  const maxVal    = State.get('colorbarMax') ?? meta.defaultMax;

  // Fetch field from dataService
  _modelData = await getModelField(variable, date, timestep);
  const { grid, values } = _modelData;
  const { nx, ny, nz } = grid;

  // Helper: extract a 2D horizontal slice at depth index iz
  function extractHSlice(iz) {
    const out = new Float32Array(nx * ny);
    for (let iy = 0; iy < ny; iy++)
      for (let ix = 0; ix < nx; ix++)
        out[iy * nx + ix] = values[iz * ny * nx + iy * nx + ix];
    return out;
  }

  // Helper: extract vertical X-Z slice at fixed iy
  function extractLonSlice(iy) {
    const out = new Float32Array(nx * nz);
    for (let iz = 0; iz < nz; iz++)
      for (let ix = 0; ix < nx; ix++)
        out[iz * nx + ix] = values[iz * ny * nx + iy * nx + ix];
    return out;
  }

  // Helper: extract vertical Y-Z slice at fixed ix
  function extractLatSlice(ix) {
    const out = new Float32Array(ny * nz);
    for (let iz = 0; iz < nz; iz++)
      for (let iy = 0; iy < ny; iy++)
        out[iz * ny + iy] = values[iz * ny * nx + iy * nx + ix];
    return out;
  }

  const EXAG = State.get('verticalExaggeration');

  // Sea surface (depth iz = 0)
  _buildHPlane('seaSurface', extractHSlice(0), nx, ny, 0, palette, minVal, maxVal, scale);

  // Depth slice plane
  const depthM = State.get('depthSlice');
  const depthIz = Math.round((depthM / DOMAIN.depthMax) * (nz - 1));
  _buildHPlane('depthSlice', extractHSlice(clamp(depthIz, 0, nz-1)), nx, ny, depthToSceneY(depthM, EXAG), palette, minVal, maxVal, scale);

  // Longitudinal (N-S) section — midpoint latitude
  _buildVPlaneX('lonSection', extractLonSlice(Math.floor(ny / 2)), nx, nz, EXAG, palette, minVal, maxVal, scale);

  // Latitudinal (E-W) section — midpoint longitude
  _buildVPlaneZ('latSection', extractLatSlice(Math.floor(nx / 2)), ny, nz, EXAG, palette, minVal, maxVal, scale);

  // Current particles
  _buildCurrentParticles(_modelData, EXAG);

  _buildIsosurface();
  _buildCurrentVectors();
  _buildTCHPLayer();

  _applyLayerVisibility();
  _applyLayerOpacity();
}

function _buildHPlane(name, slice, nx, ny, yPos, palette, minVal, maxVal, scale) {
  // Remove old
  if (layers[name]) { _oceanBoxGroup.remove(layers[name]); layers[name].geometry.dispose(); }

  const texData = generateHeatmapTexture(slice, nx, ny, minVal, maxVal, palette, scale);
  const imgData = new ImageData(new Uint8ClampedArray(texData), nx, ny);
  const cv = document.createElement('canvas');
  cv.width = nx; cv.height = ny;
  cv.getContext('2d').putImageData(imgData, 0, 0);

  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;

  const geo = new THREE.PlaneGeometry(SCENE_W, SCENE_D);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, opacity: State.get('layerOpacity'), depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.position.y = yPos;
  _oceanBoxGroup.add(mesh);
  layers[name] = mesh;
}

function _buildVPlaneX(name, slice, nx, nz, exag, palette, minVal, maxVal, scale) {
  if (layers[name]) { _oceanBoxGroup.remove(layers[name]); layers[name].geometry.dispose(); }

  const texData = generateHeatmapTexture(slice, nx, nz, minVal, maxVal, palette, scale);
  const imgData = new ImageData(new Uint8ClampedArray(texData), nx, nz);
  const cv = document.createElement('canvas');
  cv.width = nx; cv.height = nz;
  cv.getContext('2d').putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(cv);

  const boxH = SCENE_H * exag;
  const geo = new THREE.PlaneGeometry(SCENE_W, boxH);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, opacity: State.get('layerOpacity'), depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.position.set(0, -boxH / 2, 0);
  mesh.rotation.x = 0;
  _oceanBoxGroup.add(mesh);
  layers[name] = mesh;
}

function _buildVPlaneZ(name, slice, ny, nz, exag, palette, minVal, maxVal, scale) {
  if (layers[name]) { _oceanBoxGroup.remove(layers[name]); layers[name].geometry.dispose(); }

  const texData = generateHeatmapTexture(slice, ny, nz, minVal, maxVal, palette, scale);
  const imgData = new ImageData(new Uint8ClampedArray(texData), ny, nz);
  const cv = document.createElement('canvas');
  cv.width = ny; cv.height = nz;
  cv.getContext('2d').putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(cv);

  const boxH = SCENE_H * exag;
  const geo = new THREE.PlaneGeometry(SCENE_D, boxH);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, opacity: State.get('layerOpacity'), depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.position.set(0, -boxH / 2, 0);
  mesh.rotation.y = Math.PI / 2;
  _oceanBoxGroup.add(mesh);
  layers[name] = mesh;
}

function _updateDepthSlicePlane() {
  if (!_modelData) return;
  const { grid, values } = _modelData;
  const { nx, ny, nz } = grid;
  const depthM  = State.get('depthSlice');
  const depthIz = Math.round((depthM / DOMAIN.depthMax) * (nz - 1));
  const EXAG    = State.get('verticalExaggeration');
  const palette = State.get('colorbarPalette');
  const scale   = State.get('colorbarScale');
  const meta    = VARIABLE_META[State.get('activeVariable')] || VARIABLE_META.temperature;
  const minVal  = State.get('colorbarMin') ?? meta.defaultMin;
  const maxVal  = State.get('colorbarMax') ?? meta.defaultMax;

  const slice = new Float32Array(nx * ny);
  for (let iy = 0; iy < ny; iy++)
    for (let ix = 0; ix < nx; ix++)
      slice[iy * nx + ix] = values[clamp(depthIz, 0, nz-1) * ny * nx + iy * nx + ix];

  _buildHPlane('depthSlice', slice, nx, ny, depthToSceneY(depthM, EXAG), palette, minVal, maxVal, scale);
  _buildCurrentVectors();
  _applyLayerVisibility();
}

// ---------------------------------------------------------------------------
// Internal: Current particles
// ---------------------------------------------------------------------------

const MAX_PARTICLES = 3000;
let _particlePositions = null;
let _particleVelocities = null;
let _particleAges = null;

function _buildCurrentParticles(modelData, exag) {
  // Remove old system
  if (_currentParticleSystem) {
    _oceanBoxGroup.remove(_currentParticleSystem);
    _currentParticleSystem.geometry.dispose();
  }

  const count = MAX_PARTICLES;
  const geo = new THREE.BufferGeometry();
  _particlePositions  = new Float32Array(count * 3);
  _particleVelocities = new Float32Array(count * 3);
  _particleAges       = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    _respawnParticle(i, exag);
  }

  geo.setAttribute('position', new THREE.BufferAttribute(_particlePositions, 3));

  // Glow texture for sprites
  const spriteTex = _makeGlowSprite(0x63e6be);

  const mat = new THREE.PointsMaterial({
    color: 0x63e6be,
    size: 0.18,
    map: spriteTex,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });

  _currentParticleSystem = new THREE.Points(geo, mat);
  _currentParticleSystem.name = 'currentParticles';
  _oceanBoxGroup.add(_currentParticleSystem);
}

function _respawnParticle(i, exag) {
  _particlePositions[i*3]   = (Math.random() - 0.5) * SCENE_W;
  _particlePositions[i*3+1] = -Math.random() * SCENE_H * exag;
  _particlePositions[i*3+2] = (Math.random() - 0.5) * SCENE_D;

  // Velocity from seeded noise → smooth flow field
  const x = _particlePositions[i*3];
  const z = _particlePositions[i*3+2];
  const ns = seededNoise(x * 0.4, z * 0.4, 0.2);
  const angle = ns * Math.PI * 2;
  const speed = 0.02 + Math.random() * 0.015;
  _particleVelocities[i*3]   = Math.cos(angle) * speed;
  _particleVelocities[i*3+1] = (Math.random() - 0.7) * 0.005;
  _particleVelocities[i*3+2] = Math.sin(angle) * speed;

  _particleAges[i] = Math.random() * 200;
}

function _tickCurrentParticles(dt, exag) {
  if (!_currentParticleSystem || !_particlePositions) return;
  const count = MAX_PARTICLES;
  const posAttr = _currentParticleSystem.geometry.getAttribute('position');
  const maxLife = 250;

  for (let i = 0; i < count; i++) {
    _particleAges[i]++;
    _particlePositions[i*3]   += _particleVelocities[i*3];
    _particlePositions[i*3+1] += _particleVelocities[i*3+1];
    _particlePositions[i*3+2] += _particleVelocities[i*3+2];

    // Out of bounds or aged out → respawn
    if (_particleAges[i] > maxLife ||
        Math.abs(_particlePositions[i*3])   > SCENE_W/2 ||
        Math.abs(_particlePositions[i*3+2]) > SCENE_D/2 ||
        _particlePositions[i*3+1] < -SCENE_H * exag ||
        _particlePositions[i*3+1] > 0) {
      _respawnParticle(i, exag);
    }
  }
  posAttr.needsUpdate = true;
}

function _makeGlowSprite(color) {
  const size = 32;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const r = color >> 16, g = (color >> 8) & 0xff, b = color & 0xff;
  const grd = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  grd.addColorStop(0, `rgba(${r},${g},${b},1)`);
  grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Internal: Instrument markers
// ---------------------------------------------------------------------------

async function _refreshInstrumentMarkers() {
  // Fetch BEFORE touching the scene, and drop the result if another refresh
  // started meanwhile. Resetting _markerGroup and then awaiting let two
  // concurrent callers (init, vertical exaggeration, layer changes) both
  // populate the surviving group: markers were duplicated, and the later set
  // never received the visibility pass, so it ignored the layer toggles.
  const gen = ++_markerGen;
  const platforms = await getAllPlatforms(_modelTimeISO());
  if (gen !== _markerGen) return;   // superseded by a newer refresh

  if (_markerGroup) scene.remove(_markerGroup);
  _markerGroup = new THREE.Group();
  // Named because the globe's pins also carry userData.platform; without a
  // way to tell the two sets apart, a scene-wide traverse double-counts them.
  _markerGroup.name = 'markerGroup';
  _markerObjects = [];
  scene.add(_markerGroup);

  const EXAG = State.get('verticalExaggeration');

  for (const platform of platforms) {
    const regEntry = PLUGIN_REGISTRY.find(e => e.id === platform.type);
    if (!regEntry) continue;

    // Only instruments inside the selected region. Without this a float outside
    // the box is still projected into it by the coordinate transform and lands
    // somewhere it was never measured.
    if (platform.lat < VIEW.latMin || platform.lat > VIEW.latMax ||
        platform.lon < VIEW.lonMin || platform.lon > VIEW.lonMax) continue;

    const scenePos = latLonDepthToScene(platform.lat, platform.lon, 0, EXAG);

    // Marker sphere
    const geo = new THREE.SphereGeometry(0.16, 12, 12);
    const color = new THREE.Color(regEntry.markerColor);
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(scenePos.x, 0.15, scenePos.z);
    mesh.userData = { platform };
    _markerGroup.add(mesh);
    _markerObjects.push({ mesh, platform });

    // Glow ring
    const ringGeo = new THREE.RingGeometry(0.22, 0.30, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(regEntry.markerColor),
      transparent: true, opacity: 0.4,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(scenePos.x, 0.05, scenePos.z);
    ring.userData = { platform };   // so layer toggles hide the ring with its marker
    _markerGroup.add(ring);

    // Tracks
    if (regEntry.trackStyle === 'spline' && platform.track?.length > 1) {
      _buildGliderTrack(platform, regEntry.markerColor, EXAG);
    } else if (regEntry.trackStyle === 'link' && platform.track?.length > 1) {
      _buildFloatTrack(platform, regEntry.markerColor, EXAG);
    }
  }

  // Freshly built markers start visible; apply the current layer state or a
  // toggled-off class reappears every time the markers are rebuilt.
  _applyLayerVisibility();
}

/**
 * Argo float trajectory: a sequence of surfacings roughly ten days apart.
 *
 * Drawn as faint straight links plus a small dot at every surfacing. The float
 * did NOT travel in straight segments — it drifted at depth — so the link is
 * deliberately subordinate and the surfacings are the real information.
 */
function _buildFloatTrack(platform, colorHex, exag) {
  const pts = platform.track.map(p => {
    const s = latLonDepthToScene(p.lat, p.lon, 0, exag);
    return new THREE.Vector3(s.x, 0.1, s.z);
  });
  const colour = new THREE.Color(colorHex);

  const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({
    color: colour, transparent: true, opacity: 0.28,
  }));
  line.userData = { platform };
  _markerGroup.add(line);

  // Surfacing points, excluding the last (that one already has a full marker)
  const dotGeo = new THREE.BufferGeometry().setFromPoints(pts.slice(0, -1));
  const dots = new THREE.Points(dotGeo, new THREE.PointsMaterial({
    color: colour, size: 0.13, transparent: true, opacity: 0.8,
    sizeAttenuation: true, depthWrite: false,
  }));
  dots.userData = { platform };
  _markerGroup.add(dots);
}

function _buildGliderTrack(platform, colorHex, exag) {
  const pts = platform.track.map(p => {
    const s = latLonDepthToScene(p.lat, p.lon, 50, exag);
    return new THREE.Vector3(s.x, s.y + 0.1, s.z);
  });
  if (pts.length < 2) return;

  const curve = new THREE.CatmullRomCurve3(pts);
  const points = curve.getPoints(60);
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color(colorHex),
    transparent: true, opacity: 0.7,
  });
  const line = new THREE.Line(geo, mat);
  line.userData = { platform };   // so layer toggles hide the track with its marker
  _markerGroup.add(line);
}

// ---------------------------------------------------------------------------
// Internal: Bathymetry grid
// ---------------------------------------------------------------------------

/**
 * Decorative air-sea interface.
 *
 * Deliberately a SEPARATE sheet floating above the sea-surface data plane, not
 * a displacement of it. Warping the data plane would invent spatial structure
 * that is not in the field — a visualisation of ocean data is a scientific
 * claim, and this layer makes none. It carries no value, no colormap, and no
 * legend entry; it is scene-setting only, which is why it is toggleable.
 *
 * Displacement runs in the vertex shader so the CPU does no per-frame work
 * beyond incrementing one uniform.
 */
function _buildWaveSurface() {
  if (layers.waveSurface) {
    _oceanBoxGroup.remove(layers.waveSurface);
    layers.waveSurface.geometry.dispose();
    layers.waveSurface.material.dispose();
  }

  const geo = new THREE.PlaneGeometry(SCENE_W, SCENE_D, 96, 96);
  geo.rotateX(-Math.PI / 2);   // bake to XZ so position.y is the up axis

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:    { value: 0 },
      uAmp:     { value: 0.34 },
      uColor:   { value: new THREE.Color(0x63e6be) },
      uOpacity: { value: 0.30 },
    },
    vertexShader: `
      uniform float uTime;
      uniform float uAmp;
      varying float vH;
      void main() {
        vec3 pos = position;
        float t = uTime;
        // Four superposed travelling waves at different headings: enough
        // interference that the pattern never visibly repeats.
        float h  = sin(pos.x * 0.90 + t * 0.70) * 0.55;
              h += sin(pos.z * 0.70 - t * 0.50) * 0.45;
              h += sin((pos.x + pos.z) * 1.60 + t * 1.10) * 0.22;
              h += sin((pos.x - pos.z * 0.60) * 2.40 - t * 1.50) * 0.12;
        h *= uAmp;
        pos.y += h;
        vH = h;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vH;
      void main() {
        float crest = smoothstep(-0.30, 0.42, vH);
        vec3 c = mix(uColor * 0.30, uColor, crest);
        gl_FragColor = vec4(c, uOpacity * (0.40 + crest * 0.60));
      }
    `,
    transparent: true,
    depthWrite: false,          // never occludes markers or the data plane
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'waveSurface';
  // Sits above the markers: floats and gliders are in the water, the
  // interface is above them.
  mesh.position.y = 0.8;
  _oceanBoxGroup.add(mesh);
  layers.waveSurface = mesh;
}

/**
 * Isosurface: the depth at which the field crosses a threshold.
 *
 * Implemented as a single-valued depth surface per water column rather than
 * general marching cubes. For a monotonic profile — which temperature is,
 * below the mixed layer — the isotherm has exactly one depth per column, so
 * this is the correct shape and not an approximation of one.
 *
 * It is also precisely the definition of **D26**, the depth of the 26 °C
 * isotherm, which is the conventional floor of the layer that can fuel a
 * tropical cyclone.
 *
 * Columns where the field never crosses the threshold have NO isosurface, and
 * emit no geometry. Interpolating across them would draw a surface at a depth
 * where the isotherm does not exist.
 */
function _buildIsosurface() {
  if (layers.isosurface) {
    _oceanBoxGroup.remove(layers.isosurface);
    layers.isosurface.geometry.dispose();
    layers.isosurface.material.dispose();
    layers.isosurface = null;
  }
  if (!_modelData) return;

  const { grid, values } = _modelData;
  const { nx, ny, nz } = grid;
  const thr = Number(State.get('isoValue'));
  const EXAG = State.get('verticalExaggeration');
  if (!Number.isFinite(thr)) return;

  const at = (ix, iy, iz) => values[iz * ny * nx + iy * nx + ix];
  const depthAt = iz => (iz / (nz - 1)) * VIEW.depthMax;

  // Crossing depth per column, or null where the threshold is never crossed
  const cross = new Array(nx * ny).fill(null);
  let minD = Infinity, maxD = -Infinity;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz - 1; iz++) {
        const a = at(ix, iy, iz), b = at(ix, iy, iz + 1);
        if ((a - thr) * (b - thr) <= 0 && a !== b) {
          const t = (thr - a) / (b - a);
          const d = lerp(depthAt(iz), depthAt(iz + 1), t);
          cross[iy * nx + ix] = d;
          if (d < minD) minD = d;
          if (d > maxD) maxD = d;
          break;                       // shallowest crossing wins
        }
      }
    }
  }
  if (!Number.isFinite(minD)) return;  // threshold outside the field entirely

  // Vertices, plus per-vertex colour by depth so the surface reads as a relief
  const verts = [], cols = [], index = [];
  const vidx = new Int32Array(nx * ny).fill(-1);
  let n = 0;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const d = cross[iy * nx + ix];
      if (d === null) continue;
      verts.push(
        (ix / (nx - 1) - 0.5) * SCENE_W,
        depthToSceneY(d, EXAG),
        (iy / (ny - 1) - 0.5) * SCENE_D
      );
      // Shallow isotherm = warm column shoaling; deep = thick warm layer
      const t = maxD > minD ? (d - minD) / (maxD - minD) : 0.5;
      const [r, g, b] = valueToColor(1 - t, 'thermal');
      cols.push(r / 255, g / 255, b / 255);
      vidx[iy * nx + ix] = n++;
    }
  }

  // Only emit a quad where all four corners actually have a crossing
  for (let iy = 0; iy < ny - 1; iy++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = vidx[iy * nx + ix], b = vidx[iy * nx + ix + 1];
      const c = vidx[(iy + 1) * nx + ix], d = vidx[(iy + 1) * nx + ix + 1];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      index.push(a, c, b, b, c, d);
    }
  }
  if (!index.length) return;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
    emissive: 0x0a1f28,
  }));
  mesh.name = 'isosurface';
  _oceanBoxGroup.add(mesh);
  layers.isosurface = mesh;

  // Coverage matters: a surface over 30% of the domain means something very
  // different from one over 95%, and the UI should not have to guess.
  _isoStats = {
    threshold: thr,
    minDepth: minD, maxDepth: maxD,
    coverage: cross.filter(v => v !== null).length / (nx * ny),
  };
  State.set('isoStats', _isoStats);
}

/**
 * Current vector glyphs on the depth-slice plane.
 *
 * Particles convey flow pattern but not magnitude. Glyphs carry both: direction
 * from the u/v components, and speed from length and colour on the same `speed`
 * colormap the field uses, so a glyph can be read against the colorbar.
 *
 * Decimated to a readable density — one glyph per grid cell becomes noise long
 * before it becomes information — and drawn with a single InstancedMesh so the
 * count costs one draw call rather than hundreds.
 */
function _buildCurrentVectors() {
  if (layers.currentVectors) {
    _oceanBoxGroup.remove(layers.currentVectors);
    layers.currentVectors.geometry.dispose();
    layers.currentVectors.material.dispose();
    layers.currentVectors = null;
  }
  const d = _modelData;
  if (!d?.velocityU || !d?.velocityV) return;   // only the currents field has them

  const { nx, ny, nz } = d.grid;
  const EXAG = State.get('verticalExaggeration');
  const depthM = State.get('depthSlice');
  const iz = clamp(Math.round((depthM / VIEW.depthMax) * (nz - 1)), 0, nz - 1);
  // Clear of the depth-slice plane it annotates. Too small an offset and the
  // glyphs are lost behind the stack of translucent planes.
  const y = depthToSceneY(depthM, EXAG) + 0.18;

  const STEP = Math.max(1, Math.round(nx / 18));   // ~18 glyphs across
  const cells = [];
  let vmax = 0;
  for (let iy = 0; iy < ny; iy += STEP) {
    for (let ix = 0; ix < nx; ix += STEP) {
      const k = iz * ny * nx + iy * nx + ix;
      const u = d.velocityU[k], v = d.velocityV[k];
      const sp = Math.hypot(u, v);
      if (!Number.isFinite(sp)) continue;
      if (sp > vmax) vmax = sp;
      cells.push({ ix, iy, u, v, sp });
    }
  }
  if (!cells.length || vmax <= 0) return;

  // A cone on a stem, pointing +X, so instance rotation is a single yaw
  const shaft = new THREE.CylinderGeometry(0.012, 0.012, 1, 5);
  shaft.rotateZ(-Math.PI / 2);
  shaft.translate(0.5, 0, 0);
  const head = new THREE.ConeGeometry(0.045, 0.16, 7);
  head.rotateZ(-Math.PI / 2);
  head.translate(1.08, 0, 0);
  const geo = mergeGeometries([shaft, head]);

  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 });
  const inst = new THREE.InstancedMesh(geo, mat, cells.length);
  inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cells.length * 3), 3);

  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const maxLen = (SCENE_W / 18) * 0.9;

  cells.forEach((c, i) => {
    pos.set(
      (c.ix / (nx - 1) - 0.5) * SCENE_W, y,
      (c.iy / (ny - 1) - 0.5) * SCENE_D
    );
    // sqrt scaling: a linear length map makes slow flow invisible next to fast
    const len = Math.sqrt(c.sp / vmax) * maxLen;
    // Screen +X is east, +Z is south, so a northward v rotates negative
    q.setFromAxisAngle(up, Math.atan2(-c.v, c.u));
    scl.set(len, 1, 1);
    inst.setMatrixAt(i, m.compose(pos, q, scl));
    const [r, g, b] = valueToColor(c.sp / vmax, 'speed');
    inst.setColorAt(i, new THREE.Color(r / 255, g / 255, b / 255));
  });
  inst.instanceMatrix.needsUpdate = true;
  inst.instanceColor.needsUpdate = true;

  inst.name = 'currentVectors';
  // Drawn after the translucent field planes, so the glyphs stay legible
  // instead of being tinted by every sheet in front of them.
  inst.renderOrder = 3;
  _oceanBoxGroup.add(inst);
  layers.currentVectors = inst;

  // A reference magnitude, or glyph length means nothing quantitative
  State.set('vectorScale', { maxSpeed: vmax, unit: 'm s⁻¹', glyphs: cells.length, depthM });
}

/**
 * Tropical Cyclone Heat Potential, rendered as a surface-level field.
 *
 *   TCHP = rho * cp * integral( T(z) - 26 ) dz,  from the surface down to D26
 *
 * The heat stored above the 26 °C isotherm — the conventional measure of the
 * ocean energy available to a tropical cyclone. Reported in kJ cm-2, the unit
 * operational centres use, where roughly 50-60 kJ cm-2 is the threshold
 * associated with rapid intensification.
 *
 * Derived from the temperature volume already in memory: no new data, which is
 * exactly why it is worth having. Only defined for temperature; returns null
 * for any other variable rather than computing something meaningless.
 */
function _computeTCHP() {
  if (!_modelData || _modelData.variable !== 'temperature') return null;
  const { grid, values } = _modelData;
  const { nx, ny, nz } = grid;

  const RHO = 1026;      // kg m-3, seawater
  const CP = 3990;       // J kg-1 K-1, specific heat
  const T_REF = 26;      // degC

  const out = new Float32Array(nx * ny);
  const dz = VIEW.depthMax / (nz - 1);
  let min = Infinity, max = -Infinity;

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      let joules = 0;
      for (let iz = 0; iz < nz - 1; iz++) {
        const a = values[iz * ny * nx + iy * nx + ix];
        const b = values[(iz + 1) * ny * nx + iy * nx + ix];
        if (a <= T_REF) break;                    // below D26: contributes nothing
        // Trapezoid over the part of the layer that is still above 26 degC
        const frac = b >= T_REF ? 1 : (a - T_REF) / (a - b);
        const meanExcess = b >= T_REF
          ? ((a - T_REF) + (b - T_REF)) / 2
          : (a - T_REF) / 2;
        joules += RHO * CP * meanExcess * dz * frac;
        if (b < T_REF) break;
      }
      const kJcm2 = joules / 1e7;                 // J m-2 -> kJ cm-2
      out[iy * nx + ix] = kJcm2;
      if (kJcm2 < min) min = kJcm2;
      if (kJcm2 > max) max = kJcm2;
    }
  }
  return { values: out, nx, ny, min, max };
}

function _buildTCHPLayer() {
  if (layers.tchp) {
    _oceanBoxGroup.remove(layers.tchp);
    layers.tchp.geometry.dispose();
    layers.tchp.material.map?.dispose();
    layers.tchp.material.dispose();
    layers.tchp = null;
  }
  const t = _computeTCHP();
  State.set('tchpStats', t ? { min: t.min, max: t.max, unit: 'kJ cm⁻²' } : null);
  if (!t) return;

  // Fixed 0-160 kJ cm-2 scale, NOT auto-scaled to this frame: the ~50-60
  // threshold only means anything if the colour for a value is stable across
  // regions and timesteps.
  const texData = generateHeatmapTexture(t.values, t.nx, t.ny, 0, 160, 'thermal', 'linear');
  const cv = document.createElement('canvas');
  cv.width = t.nx; cv.height = t.ny;
  cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(texData), t.nx, t.ny), 0, 0);

  const geo = new THREE.PlaneGeometry(SCENE_W, SCENE_D);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(cv), side: THREE.DoubleSide,
    transparent: true, opacity: 0.95, depthWrite: false,
  }));
  mesh.name = 'tchp';
  mesh.position.y = 0.45;          // just above the sea surface plane
  mesh.renderOrder = 2;
  _oceanBoxGroup.add(mesh);
  layers.tchp = mesh;
}

function _buildBathymetryGrid(exag) {
  const boxH = SCENE_H * exag;
  const geo = new THREE.PlaneGeometry(SCENE_W, SCENE_D, 20, 20);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x0d3345, wireframe: true, transparent: true, opacity: 0.3,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'bathymetryGrid';
  mesh.position.y = -boxH;
  layers.bathymetryGrid = mesh;
  _oceanBoxGroup.add(mesh);
}

// ---------------------------------------------------------------------------
// Internal: Apply state → scene
// ---------------------------------------------------------------------------

function _applyVerticalExaggeration() {
  const exag = State.get('verticalExaggeration');
  if (!_oceanBoxGroup) return;
  const boxH = SCENE_H * exag;

  const boxEdge = _oceanBoxGroup.getObjectByName('boxEdge');
  if (boxEdge) {
    boxEdge.geometry.dispose();
    boxEdge.geometry = new THREE.BoxGeometry(SCENE_W, boxH, SCENE_D);
    boxEdge.position.y = -boxH / 2;
  }

  // Depth axis line and ocean floor must follow the box, or they detach from it.
  if (_depthAxisLine) {
    _depthAxisLine.geometry.dispose();
    _depthAxisLine.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-SCENE_W/2, 0, -SCENE_D/2),
      new THREE.Vector3(-SCENE_W/2, -boxH, -SCENE_D/2),
    ]);
  }
  if (layers.bathymetryGrid) layers.bathymetryGrid.position.y = -boxH;

  // Re-build sections and particles at the new scale
  _refreshModelLayers();
  _refreshInstrumentMarkers();
}

function _applyLayerOpacity() {
  const op = State.get('layerOpacity');
  Object.values(layers).forEach(mesh => {
    if (!mesh || !mesh.material) return;
    // The wave sheet is a ShaderMaterial: `.opacity` is inert on it, so drive
    // its uniform instead, scaled so it stays subordinate to the data layers.
    if (mesh.material.uniforms?.uOpacity) {
      mesh.material.uniforms.uOpacity.value = op * 0.37;
    } else {
      mesh.material.opacity = op;
    }
  });
}

function _applyLayerVisibility() {
  const vis = State.get('layers');
  Object.keys(layers).forEach(key => {
    if (layers[key]) layers[key].visible = vis[key] !== false;
  });
  if (_currentParticleSystem) _currentParticleSystem.visible = vis.currentParticles !== false;
  if (_markerGroup) {
    // Keyed by plugin-registry id, so a new registry entry needs no edit here.
    // Spheres, glow rings and track lines all carry userData.platform.
    _markerGroup.children.forEach(obj => {
      const p = obj.userData?.platform;
      if (p) obj.visible = vis[p.type] !== false;
    });
  }
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

let _timelineAccum = 0;

function _renderLoop() {
  _animFrame = requestAnimationFrame(_renderLoop);
  const dt = _clock.getDelta();
  const exag = State.get('verticalExaggeration');
  const onGlobe = State.get('viewMode') === 'globe';

  _tickCamFlight(dt);

  // No idle spin here on purpose. The globe is a selector, not an ornament:
  // an auto-rotate slowly carries the model domain and the instrument pins off
  // screen, so the one thing the user is meant to click drifts away while they
  // read the hint. The camera arrives framed on the domain and stays there.

  // Volume-view animation is skipped entirely on the globe. A hidden parent
  // group does not clear its children's own `visible` flags, so these need an
  // explicit mode guard or they keep burning frames behind the globe.
  if (!onGlobe) {
    if (State.get('layers').currentParticles) {
      _tickCurrentParticles(dt, exag);
    }
    // Under reduced motion the sheet keeps its wave form but stops travelling.
    if (layers.waveSurface && layers.waveSurface.visible && !_reduceMotion.matches) {
      layers.waveSurface.material.uniforms.uTime.value += dt;
    }
  }

  // Timeline auto-advance (accumulator-based, not modulo)
  if (State.get('timelinePlaying')) {
    const speed = State.get('timelineSpeed');
    _timelineAccum += dt;
    const interval = 1.5 / speed;
    if (_timelineAccum >= interval) {
      _timelineAccum -= interval;
      const ts = State.get('availableTimesteps');
      const next = (State.get('timelineIndex') + 1) % ts.length;
      State.set('timelineIndex', next);
    }
  } else {
    _timelineAccum = 0;
  }

  controls.update();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

function _onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * A PNG of the current frame.
 *
 * The renderer runs without `preserveDrawingBuffer` (keeping it on costs memory
 * and bandwidth every frame), so the drawing buffer is undefined by the time an
 * event handler runs. Rendering immediately before reading it is what makes the
 * capture non-blank, and it must stay synchronous — an await here would let the
 * compositor clear the buffer first.
 */
export function captureFrame() {
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
}

export function getCamera() { return camera; }
export function getScene()  { return scene; }

export function refreshMarkers() { return _refreshInstrumentMarkers(); }
