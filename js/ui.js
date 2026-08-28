/**
 * ui.js — UI wiring, panel management, event handlers
 *
 * Reads from / writes to State. Never touches raw data directly.
 * Calls chart functions from charts.js.
 * Calls scene helpers from scene.js.
 */

import State from './state.js';
import { PLUGIN_REGISTRY, VARIABLE_META, getProfile, getDataProvenance,
         getObservationWindow } from './dataService.js';
import { drawProfileChart, drawColorbar, drawDepthGauge } from './charts.js';
import { beginAreaDrag, updateAreaDrag, endAreaDrag, cancelAreaDrag,
         clearAreaSelection, rebuildForBounds, captureFrame } from './scene.js';
import { formatDate, DIVERGING_PALETTES } from './utils.js';
import { DOMAIN, VIEW, isSubRegion } from './constants.js';

// Keep references to key DOM elements after init
const DOM = {};

/**
 * Escape a value before it goes into innerHTML.
 * Platform ids, data modes and timestamps now originate from an external API
 * (Argo GDAC via ERDDAP), so they are untrusted input by definition even
 * though today they are short scientific codes.
 */
function esc(v) {
  return String(v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Initialise — called once after DOMContentLoaded
// ---------------------------------------------------------------------------

export function initUI(onCanvasClick) {
  _cacheDOM();
  _wireTabBar();
  _wireControls();
  _wireLayers();
  _wireTimeline();
  _wireProfilePanel();
  _wireResizeAmbient();

  // Canvas click. On the globe this is region/instrument selection; in the
  // volume it opens a profile. Picking an instrument does both: dive in, then
  // show its profile once the camera has arrived.
  DOM.canvas.addEventListener('click', e => {
    const hit = onCanvasClick(e);
    if (!hit) return;

    if (hit === 'domain') {
      State.set('viewMode', 'volume');
      return;
    }
    if (State.get('viewMode') === 'globe') {
      State.set('viewMode', 'volume');
      // Wait out the camera flight so the panel does not cover the transition
      setTimeout(() => _openProfilePanel(hit), 1150);
      return;
    }
    _openProfilePanel(hit);
  });

  _wireViewMode();
  _wireAreaSelection();
  _wireIsosurface();
  _wireExport();
  _renderProvenanceBadge();

  // Initial renders
  _updateColorbar();
  _updateDepthGauge();
  _updateScaleBadge();

  // State subscriptions that update UI
  State.subscribe('activeVariable',     () => { _updateTabBar(); _updateColorbar(); });
  State.subscribe('depthSlice',         () => _updateDepthGauge());
  State.subscribe('colorbarPalette',    () => _updateColorbar());
  State.subscribe('colorbarMin',        () => _updateColorbar());
  State.subscribe('colorbarMax',        () => _updateColorbar());
  State.subscribe('colorbarScale',      () => _updateColorbar());
  State.subscribe('verticalExaggeration', () => _updateScaleBadge());
  State.subscribe('vectorScale',        () => _updateVectorKey());
  State.subscribe('tchpStats',          () => _updateTchpKey());
  State.subscribe('depthSlice',         () => _updateVectorKey());
  State.subscribe('timelineIndex',      () => _updateTimeline());
  State.subscribe('layers',             () => { _syncLayerCheckboxes(); _updateTchpKey(); _updateVectorKey(); });
  State.subscribe('timelinePlaying',    () => _updatePlayButton());
  State.subscribe('profilePanelOpen',   v  => { DOM.profilePanel.classList.toggle('hidden', !v); });
  State.subscribe('controlsPanelOpen',  v  => { DOM.controlsPanel.classList.toggle('collapsed', !v); });
  State.subscribe('layersPanelOpen',    v  => { DOM.layersPanel.classList.toggle('collapsed', !v); });
}

// ---------------------------------------------------------------------------
// DOM cache
// ---------------------------------------------------------------------------

function _cacheDOM() {
  const g = id => document.getElementById(id);
  Object.assign(DOM, {
    canvas:           g('ocean-canvas'),
    tabBar:           g('tab-bar'),

    // Controls panel
    controlsPanel:    g('controls-panel'),
    controlsToggle:   g('controls-toggle'),
    dateInput:        g('ctrl-date'),
    timestepSelect:   g('ctrl-timestep'),
    depthSlider:      g('ctrl-depth'),
    depthReadout:     g('ctrl-depth-readout'),
    vertExagSlider:   g('ctrl-vert-exag'),
    vertExagReadout:  g('ctrl-vert-exag-readout'),
    opacitySlider:    g('ctrl-opacity'),
    opacityReadout:   g('ctrl-opacity-readout'),
    paletteSelect:    g('ctrl-palette'),
    colorbarMinInput: g('ctrl-min'),
    colorbarMaxInput: g('ctrl-max'),
    scaleLinear:      g('scale-linear'),
    scaleLog:         g('scale-log'),

    // Layers panel
    layersPanel:      g('layers-panel'),
    layersToggle:     g('layers-toggle'),

    // Timeline
    timelineBar:      g('timeline-bar'),
    playBtn:          g('timeline-play'),
    speedBtn:         g('timeline-speed'),
    timelineTrack:    g('timeline-track'),

    // Profile panel
    profilePanel:     g('profile-panel'),
    profileClose:     g('profile-close'),
    profileTitle:     g('profile-title'),
    profileMeta:      g('profile-meta'),
    profileChart:     g('profile-chart-canvas'),
    profileVarToggle: g('profile-var-toggle'),

    // Colorbar canvas
    colorbarCanvas:   g('colorbar-canvas'),

    // Depth gauge
    depthGauge:       g('depth-gauge-canvas'),

    // Loading overlay
    loadingOverlay:   g('loading-overlay'),
  });
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

function _wireTabBar() {
  DOM.tabBar.addEventListener('click', e => {
    const btn = e.target.closest('[data-variable]');
    if (!btn) return;
    const v = btn.dataset.variable;

    if (v === 'argo') {
      // Pseudo-tab: highlight instrument markers rather than switching model field
      DOM.tabBar.querySelectorAll('[data-variable]').forEach(b => b.classList.toggle('active', b === btn));
      // Ensure all instrument layers are visible
      PLUGIN_REGISTRY.forEach(p => State.set(`layers.${p.id}`, true));
      // Open layers panel so user sees the checkboxes
      State.set('layersPanelOpen', true);
      return;
    }

    State.set('activeVariable', v);
    _syncColorbarInputsToVariable(v);

    // Particles show flow pattern but not magnitude, so they belong with the
    // currents field (which carries a speed colorbar), not over scalar fields.
    State.set('layers.currentParticles', v === 'currents');
  });
}

function _updateTabBar() {
  const v = State.get('activeVariable');
  DOM.tabBar.querySelectorAll('[data-variable]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.variable === v);
  });
}

function _syncColorbarInputsToVariable(variable) {
  const meta = VARIABLE_META[variable] || VARIABLE_META.temperature;
  DOM.colorbarMinInput.value = meta.defaultMin;
  DOM.colorbarMaxInput.value = meta.defaultMax;
  DOM.paletteSelect.value    = meta.palette;
  State.set('colorbarMin',     meta.defaultMin);
  State.set('colorbarMax',     meta.defaultMax);
  State.set('colorbarPalette', meta.palette);
}

// ---------------------------------------------------------------------------
// Controls panel
// ---------------------------------------------------------------------------

function _wireControls() {
  // Panel collapse toggle
  DOM.controlsToggle.addEventListener('click', () => {
    State.set('controlsPanelOpen', !State.get('controlsPanelOpen'));
  });

  // Date. Bounded to the period we actually hold observations for — see
  // _constrainDateToObservations().
  DOM.dateInput.value = State.get('selectedDate');
  DOM.dateInput.addEventListener('change', e => State.set('selectedDate', e.target.value));
  _constrainDateToObservations();

  // Timestep
  _populateTimestepSelect();
  DOM.timestepSelect.addEventListener('change', e => {
    const idx = parseInt(e.target.value);
    State.set('timelineIndex', idx);
  });

  // Depth
  DOM.depthSlider.value = State.get('depthSlice');
  DOM.depthReadout.textContent = `${State.get('depthSlice')} m`;
  DOM.depthSlider.addEventListener('input', e => {
    const v = parseInt(e.target.value);
    State.set('depthSlice', v);
    DOM.depthReadout.textContent = `${v} m`;
  });

  // Vertical exaggeration
  DOM.vertExagSlider.value = State.get('verticalExaggeration');
  DOM.vertExagReadout.textContent = `${State.get('verticalExaggeration')}×`;
  DOM.vertExagSlider.addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    State.set('verticalExaggeration', v);
    DOM.vertExagReadout.textContent = `${v}×`;
  });

  // Opacity
  DOM.opacitySlider.value = State.get('layerOpacity');
  DOM.opacityReadout.textContent = `${Math.round(State.get('layerOpacity') * 100)}%`;
  DOM.opacitySlider.addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    State.set('layerOpacity', v);
    DOM.opacityReadout.textContent = `${Math.round(v * 100)}%`;
  });

  // Palette
  DOM.paletteSelect.value = State.get('colorbarPalette');
  DOM.paletteSelect.addEventListener('change', e => State.set('colorbarPalette', e.target.value));

  // Min / max
  const meta0 = VARIABLE_META[State.get('activeVariable')];
  DOM.colorbarMinInput.value = meta0.defaultMin;
  DOM.colorbarMaxInput.value = meta0.defaultMax;
  DOM.colorbarMinInput.addEventListener('change', e => State.set('colorbarMin', parseFloat(e.target.value)));
  DOM.colorbarMaxInput.addEventListener('change', e => State.set('colorbarMax', parseFloat(e.target.value)));

  // Linear / Log toggle
  DOM.scaleLinear.addEventListener('click', () => {
    State.set('colorbarScale', 'linear');
    DOM.scaleLinear.classList.add('active');
    DOM.scaleLog.classList.remove('active');
  });
  DOM.scaleLog.addEventListener('click', () => {
    State.set('colorbarScale', 'log');
    DOM.scaleLog.classList.add('active');
    DOM.scaleLinear.classList.remove('active');
  });
}

/**
 * Bound the model date to the period we hold observations for.
 *
 * The synthetic model field will happily generate for any date, so nothing ever
 * objected to a 2026 model frame sitting beside 2024 float profiles. Real
 * observations only exist where they were measured; offering dates outside that
 * range invites exactly the false comparison this guards against.
 *
 * Read from the data rather than hardcoded, so re-running tools/fetch_argo.py
 * with a different window moves this automatically.
 */
async function _constrainDateToObservations() {
  const win = await getObservationWindow();
  const note = document.getElementById('date-note');
  if (!win) {
    if (note) note.textContent = 'Synthetic field: any date.';
    return;
  }

  const start = win.start.slice(0, 10);
  const end = win.end.slice(0, 10);
  DOM.dateInput.min = start;
  DOM.dateInput.max = end;

  const current = State.get('selectedDate');
  if (current < start || current > end) {
    // Snap into coverage rather than leaving the model two years from the floats
    DOM.dateInput.value = end;
    State.set('selectedDate', end);
  }

  if (note) {
    note.textContent = `Argo coverage ${start} to ${end} · ${win.count} profiles`;
  }
}

function _populateTimestepSelect() {
  const ts = State.get('availableTimesteps');
  DOM.timestepSelect.innerHTML = ts.map((t, i) =>
    `<option value="${i}" ${i === State.get('timelineIndex') ? 'selected' : ''}>${t} UTC</option>`
  ).join('');
}

// ---------------------------------------------------------------------------
// Layers panel
// ---------------------------------------------------------------------------

function _wireLayers() {
  DOM.layersToggle.addEventListener('click', () => {
    State.set('layersPanelOpen', !State.get('layersPanelOpen'));
  });

  // Model layers are fixed; instrument layers come from the plugin registry,
  // so adding a registry entry adds its checkbox with no edit here.
  const layerDefs = [
    { key: 'seaSurface',      label: 'Sea surface' },
    { key: 'lonSection',      label: 'Longitudinal section' },
    { key: 'latSection',      label: 'Latitudinal section' },
    { key: 'depthSlice',      label: 'Depth slice plane' },
    { key: 'currentParticles',label: 'Current particles' },
    { key: 'bathymetryGrid',  label: 'Bathymetry grid' },
    { key: 'waveSurface',     label: 'Water surface', note: 'Decorative. Carries no data.' },
    { key: 'isosurface',      label: 'Isosurface' },
    { key: 'currentVectors',  label: 'Current vectors' },
    { key: 'tchp',            label: 'Cyclone heat (TCHP)', note: 'Derived from temperature. Fixed 0-160 kJ cm-2 scale.' },
    ...PLUGIN_REGISTRY.map(e => ({ key: e.id, label: e.label, color: e.markerColor })),
  ];

  const list = document.getElementById('layers-list');
  list.innerHTML = layerDefs.map(({ key, label, color, note }) => `
    <label class="layer-row" for="layer-${key}"${note ? ` title="${note}"` : ''}>
      <input type="checkbox" id="layer-${key}" data-layer="${key}" ${State.get('layers.' + key) !== false ? 'checked' : ''}>
      <span class="layer-label">${label}${note ? '<em class="layer-note">decor</em>' : ''}</span>
      ${color ? `<span class="layer-swatch" style="background:${color}"></span>` : ''}
    </label>
  `).join('');

  list.addEventListener('change', e => {
    const cb = e.target.closest('[data-layer]');
    if (!cb) return;
    State.set(`layers.${cb.dataset.layer}`, cb.checked);
  });

  _syncLayerCheckboxes();

  // Add plugin registry entries as informational badges
  const pluginList = document.getElementById('plugin-registry-list');
  if (pluginList) {
    pluginList.innerHTML = PLUGIN_REGISTRY.map(e => `
      <span class="plugin-badge" style="--color:${e.markerColor}">
        <span class="plugin-dot"></span>${e.label}
      </span>
    `).join('');
  }
}

/**
 * Export the current view as a PNG with a provenance strip burned in.
 *
 * A bare screenshot of an ocean field is unusable as evidence: it travels far
 * beyond whoever took it, and by then nobody knows the variable, the depth, the
 * date, the region or whether the numbers were real. Everything needed to
 * interpret the image is composited into the file itself.
 */
async function _exportPNG() {
  const btn = document.getElementById('export-btn');
  const frame = new Image();
  frame.src = captureFrame();
  await new Promise(res => { frame.onload = res; });

  const STRIP = 118;
  const out = document.createElement('canvas');
  out.width = frame.width;
  out.height = frame.height + STRIP;
  const c = out.getContext('2d');

  c.drawImage(frame, 0, 0);
  c.fillStyle = '#03101a';
  c.fillRect(0, frame.height, out.width, STRIP);
  c.fillStyle = 'rgba(120,190,200,0.30)';
  c.fillRect(0, frame.height, out.width, 1);

  const meta = VARIABLE_META[State.get('activeVariable')] || VARIABLE_META.temperature;
  const prov = await getDataProvenance();
  const iso = State.get('isoStats');
  const y0 = frame.height + 26;
  const L = 24, R = out.width - 24;

  c.fillStyle = '#63e6be';
  c.font = "600 15px 'Outfit', sans-serif";
  c.fillText('INCOIS OCEAN3D', L, y0);

  c.fillStyle = '#dff0ef';
  c.font = "13px 'IBM Plex Mono', monospace";
  c.fillText(`${meta.label} (${meta.unit})`, L, y0 + 24);

  // Everything a reader needs to reproduce or challenge the figure
  c.fillStyle = 'rgba(223,240,239,0.62)';
  c.font = "11px 'IBM Plex Mono', monospace";
  const line1 = [
    `${_hemi(VIEW.lonMin,'EW')}–${_hemi(VIEW.lonMax,'EW')}`,
    `${_hemi(VIEW.latMin,'NS')}–${_hemi(VIEW.latMax,'NS')}`,
    `depth slice ${State.get('depthSlice')} m`,
    `vert. exag. ${State.get('verticalExaggeration')}×`,
  ].join('   ·   ');
  const line2 = [
    `${State.get('selectedDate')} ${State.get('selectedTimestep')} UTC`,
    `palette ${State.get('colorbarPalette')}`,
    `scale ${State.get('colorbarScale')} ${Number(State.get('colorbarMin') ?? meta.defaultMin)}–${Number(State.get('colorbarMax') ?? meta.defaultMax)}`,
    iso && State.get('layers.isosurface') !== false
      ? `isosurface ${iso.threshold} ${meta.unit} @ ${Math.round(iso.minDepth)}–${Math.round(iso.maxDepth)} m`
      : null,
  ].filter(Boolean).join('   ·   ');
  c.fillText(line1, L, y0 + 46);
  c.fillText(line2, L, y0 + 64);

  // The honesty line: which half of what you are looking at is measured
  c.font = "11px 'IBM Plex Mono', monospace";
  c.fillStyle = '#ff8a5c';
  const provText = prov.argo.real
    ? `Observations: real (Argo GDAC, ${prov.argo.floats + (prov.bgc?.floats || 0)} floats, QC flags ${prov.argo.qc.keptFlags.join('/')})   ·   Model field: SYNTHETIC`
    : 'All data synthetic';
  c.fillText(provText, L, y0 + 82);

  c.textAlign = 'right';
  c.fillStyle = 'rgba(223,240,239,0.38)';
  c.fillText(new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC', R, y0 + 82);
  c.textAlign = 'left';

  const stamp = `${State.get('activeVariable')}_${State.get('selectedDate')}_${State.get('selectedTimestep').replace(':', '')}`;
  const a = document.createElement('a');
  a.href = out.toDataURL('image/png');
  a.download = `incois-ocean3d_${stamp}.png`;
  a.click();

  if (btn) {
    btn.classList.add('done');
    setTimeout(() => btn.classList.remove('done'), 1400);
  }
  return { width: out.width, height: out.height };
}

function _wireExport() {
  const btn = document.getElementById('export-btn');
  if (btn) btn.addEventListener('click', () => _exportPNG());
  // Expose for the smoke test; harmless and keeps the export path verifiable
  window.__exportPNG = _exportPNG;
}

/**
 * TCHP readout, with the operational threshold stated.
 * A number in kJ cm-2 means nothing to most viewers without the ~50-60 figure
 * associated with rapid intensification, so the scale carries it.
 */
function _updateTchpKey() {
  const el = document.getElementById('tchp-key');
  if (!el) return;
  const t = State.get('tchpStats');
  const on = State.get('layers.tchp') !== false && t;
  el.classList.toggle('hidden', !on);
  if (!on) return;
  el.innerHTML =
    `TCHP ${t.min.toFixed(0)}–${t.max.toFixed(0)} ${esc(t.unit)} · fixed 0–160 scale<br>` +
    `<b>&ge;50</b> associated with rapid intensification`;
}

/**
 * Isosurface controls.
 *
 * The threshold slider tracks the active variable's range, and the D26 preset
 * jumps to 26 °C — the depth of that isotherm is the standard proxy for the
 * heat available to a tropical cyclone.
 */
function _wireIsosurface() {
  const slider = document.getElementById('ctrl-iso');
  const readout = document.getElementById('ctrl-iso-readout');
  const note = document.getElementById('iso-note');
  const d26 = document.getElementById('iso-preset-d26');
  const toggle = document.getElementById('iso-toggle');
  if (!slider) return;

  const syncToggle = () => {
    const on = State.get('layers.isosurface') !== false;
    toggle.classList.toggle('active', on);
    toggle.textContent = on ? 'Hide' : 'Show';
  };

  const applyRange = () => {
    const meta = VARIABLE_META[State.get('activeVariable')] || VARIABLE_META.temperature;
    slider.min = meta.defaultMin;
    slider.max = meta.defaultMax;
    slider.step = (meta.defaultMax - meta.defaultMin) / 120;
    // Keep the threshold inside the new variable's range, or the surface
    // silently vanishes when switching variables.
    const v = clampNum(Number(State.get('isoValue')), meta.defaultMin, meta.defaultMax);
    slider.value = v;
    readout.textContent = `${v.toFixed(1)} ${meta.unit}`;
    if (v !== Number(State.get('isoValue'))) State.set('isoValue', v);
    d26.disabled = State.get('activeVariable') !== 'temperature';
    d26.style.opacity = d26.disabled ? 0.4 : 1;
  };

  slider.addEventListener('input', e => {
    const meta = VARIABLE_META[State.get('activeVariable')] || VARIABLE_META.temperature;
    const v = parseFloat(e.target.value);
    readout.textContent = `${v.toFixed(1)} ${meta.unit}`;
    State.set('isoValue', v);
  });

  d26.addEventListener('click', () => {
    State.set('activeVariable', 'temperature');
    _syncColorbarInputsToVariable('temperature');
    State.set('isoValue', 26);
    slider.value = 26;
    readout.textContent = '26.0 °C';
    State.set('layers.isosurface', true);
    syncToggle();
  });

  toggle.addEventListener('click', () => {
    State.set('layers.isosurface', State.get('layers.isosurface') === false);
    syncToggle();
  });

  // Coverage is the honest caveat: a surface spanning a third of the domain
  // means something different from one spanning all of it.
  State.subscribe('isoStats', s => {
    if (!s) { note.textContent = ''; return; }
    const pct = Math.round(s.coverage * 100);
    if (pct === 0) {
      note.textContent = 'Threshold not crossed anywhere in this region.';
      note.className = 'ctrl-note warn';
      return;
    }
    note.className = 'ctrl-note';
    note.textContent =
      `${Math.round(s.minDepth)}–${Math.round(s.maxDepth)} m` +
      (pct < 100 ? ` · present over ${pct}% of the region` : ' · full coverage');
  });

  State.subscribe('activeVariable', applyRange);
  applyRange();
  syncToggle();
}

const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Area selection: drag a lat/lon box on the globe to choose what the volume
 * renders, the way the Live Access Server lets an operator clip a field.
 *
 * Arming is explicit rather than always-on, because a bare drag on a globe
 * means "rotate". Overloading it would make the globe feel broken.
 */
function _wireAreaSelection() {
  const btn = document.getElementById('area-select-btn');
  const reset = document.getElementById('area-reset-btn');
  const readout = document.getElementById('area-readout');
  const canvas = DOM.canvas;
  if (!btn || !canvas) return;

  let armed = false;
  let dragging = false;

  const setArmed = on => {
    armed = on;
    btn.classList.toggle('armed', on);
    document.body.classList.toggle('area-arming', on);
    btn.querySelector('span').textContent = on ? 'Drag a box…' : 'Select area';
  };

  const showBounds = b => {
    readout.classList.remove('hidden');
    readout.textContent =
      `${_hemi(b.lonMin, 'EW', 1)}–${_hemi(b.lonMax, 'EW', 1)} · ` +
      `${_hemi(b.latMin, 'NS', 1)}–${_hemi(b.latMax, 'NS', 1)}`;
  };

  btn.addEventListener('click', () => {
    if (armed) { cancelAreaDrag(); setArmed(false); } else { setArmed(true); }
  });

  reset.addEventListener('click', async () => {
    await clearAreaSelection();
    reset.classList.add('hidden');
    readout.classList.add('hidden');
    _updateScaleBadge();
  });

  canvas.addEventListener('pointerdown', e => {
    if (!armed || State.get('viewMode') !== 'globe') return;
    if (beginAreaDrag(e, canvas)) {
      dragging = true;
      canvas.setPointerCapture?.(e.pointerId);
    }
  });

  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    const b = updateAreaDrag(e, canvas);
    if (b) showBounds(b);
  });

  const finish = async e => {
    if (!dragging) return;
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
    const applied = endAreaDrag(e, canvas);
    setArmed(false);
    if (!applied) {                       // too small to be deliberate
      readout.classList.add('hidden');
      return;
    }
    showBounds(applied);
    reset.classList.remove('hidden');
    await rebuildForBounds();
    _updateScaleBadge();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  // Escape abandons an armed or in-progress selection
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || (!armed && !dragging)) return;
    dragging = false;
    cancelAreaDrag();
    setArmed(false);
    if (!isSubRegion()) readout.classList.add('hidden');
  });
}

/**
 * Say which data is real and which is synthetic, permanently and in the chrome.
 * The observations are genuine Argo GDAC; the model field is not. Leaving that
 * ambiguous is the kind of thing that turns a good demo into a bad question.
 */
async function _renderProvenanceBadge() {
  const el = document.getElementById('provenance-badge');
  if (!el) return;
  const p = await getDataProvenance();
  if (p.argo.real) {
    const n = p.argo.floats + (p.bgc?.real ? p.bgc.floats : 0);
    el.textContent = `ARGO LIVE · ${n} FLOATS`;
    el.classList.add('is-real');
    el.title =
      `Core Argo: ${p.argo.profiles} QC'd T/S profiles from ${p.argo.floats} floats\n` +
      (p.bgc?.real
        ? `BGC: ${p.bgc.profiles} chlorophyll profiles from ${p.bgc.floats} floats\n`
        : '') +
      `Gliders, CTD, moorings: synthetic (no public data in this domain)\n` +
      `Source: ${p.argo.source}\n` +
      `Window: ${p.argo.timeRange.join(' to ')}\n` +
      `QC: kept flags ${p.argo.qc.keptFlags.join(', ')}\n` +
      `Model field: synthetic\n\n${p.argo.attribution}`;
  } else {
    el.textContent = 'SYNTHETIC DATA';
    el.title = 'Real Argo data could not be loaded; showing synthetic floats.';
  }
}

/**
 * View mode. The globe is a selector, so the controls that only act on the
 * volume are hidden there rather than left inert: an enabled control that
 * does nothing is worse than an absent one.
 */
function _wireViewMode() {
  const back = document.getElementById('back-to-globe');
  const hint = document.getElementById('globe-hint');
  if (back) back.addEventListener('click', () => State.set('viewMode', 'globe'));

  const apply = mode => {
    const onGlobe = mode === 'globe';
    document.body.classList.toggle('view-globe', onGlobe);
    if (back) back.classList.toggle('hidden', onGlobe);
    if (hint) hint.classList.toggle('hidden', !onGlobe);
    if (onGlobe) {
      State.set('profilePanelOpen', false);
      State.set('selectedPlatform', null);
    }
  };
  State.subscribe('viewMode', apply);
  apply(State.get('viewMode'));
}

/** Keep checkboxes in step with state changed from elsewhere (e.g. the Argo tab). */
function _syncLayerCheckboxes() {
  document.querySelectorAll('#layers-list [data-layer]').forEach(cb => {
    cb.checked = State.get('layers.' + cb.dataset.layer) !== false;
  });
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function _wireTimeline() {
  // Build timeline tick marks
  const ts = State.get('availableTimesteps');
  DOM.timelineTrack.innerHTML = ts.map((t, i) => `
    <div class="timeline-tick ${i === State.get('timelineIndex') ? 'active' : ''}" data-index="${i}">
      <div class="tick-bar"></div>
      <span class="tick-label">${t}</span>
    </div>
  `).join('');

  DOM.timelineTrack.addEventListener('click', e => {
    const tick = e.target.closest('[data-index]');
    if (!tick) return;
    State.set('timelineIndex', parseInt(tick.dataset.index));
  });

  DOM.playBtn.addEventListener('click', () => {
    State.set('timelinePlaying', !State.get('timelinePlaying'));
  });

  DOM.speedBtn.addEventListener('click', () => {
    const speeds = [0.5, 1, 2, 4];
    const cur = State.get('timelineSpeed');
    const next = speeds[(speeds.indexOf(cur) + 1) % speeds.length];
    State.set('timelineSpeed', next);
    DOM.speedBtn.textContent = `${next}×`;
  });
}

function _updateTimeline() {
  const idx = State.get('timelineIndex');
  DOM.timelineTrack.querySelectorAll('[data-index]').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.index) === idx);
  });
  // Sync timestep select
  if (DOM.timestepSelect) DOM.timestepSelect.value = idx;
}

function _updatePlayButton() {
  const playing = State.get('timelinePlaying');
  DOM.playBtn.innerHTML = playing
    ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`;
  DOM.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

// ---------------------------------------------------------------------------
// Profile panel
// ---------------------------------------------------------------------------

let _profileActiveVar = 'temperature';

/**
 * Position with the correct hemisphere.
 * The domain now straddles the equator, so a negative latitude is South. Always
 * printing "°N" turned 2.27°S into "-2.274°N", which is both wrong and unusual
 * enough to read as a rendering fault.
 */
function _formatLatLon(lat, lon) {
  return `${_hemi(lat, 'NS', 3)}, ${_hemi(lon, 'EW', 3)}`;
}

/** One signed degree value as an unsigned magnitude plus its hemisphere. */
function _hemi(v, axis, dp = 0) {
  return `${Math.abs(v).toFixed(dp)}°${v >= 0 ? axis[0] : axis[1]}`;
}

/** The selected model frame as an ISO instant (date + timestep). */
function _selectedModelTimeISO() {
  return `${State.get('selectedDate')}T${State.get('selectedTimestep')}:00Z`;
}

function _wireProfilePanel() {
  DOM.profileClose.addEventListener('click', () => {
    State.set('profilePanelOpen', false);
    State.set('selectedPlatform', null);
  });

  DOM.profileVarToggle.addEventListener('click', e => {
    const btn = e.target.closest('[data-var]');
    if (!btn) return;
    _profileActiveVar = btn.dataset.var;
    DOM.profileVarToggle.querySelectorAll('[data-var]').forEach(b =>
      b.classList.toggle('active', b.dataset.var === _profileActiveVar)
    );
    const pd = State.get('profileData');
    if (pd) drawProfileChart(DOM.profileChart, pd, _profileActiveVar);
  });
}

async function _openProfilePanel(platform) {
  State.set('selectedPlatform', platform);
  State.set('profilePanelOpen', true);

  const regEntry = PLUGIN_REGISTRY.find(e => e.id === platform.type);

  // Update header
  const typeLabel = regEntry?.label || platform.type;
  DOM.profileTitle.textContent = platform.real
    ? `${typeLabel} — WMO ${platform.platformId}`
    : `${typeLabel} — ${platform.platformId}`;

  // Build variable toggle buttons from plugin registry
  const vars = regEntry?.profileVariables || ['temperature'];
  _profileActiveVar = vars[0];
  DOM.profileVarToggle.innerHTML = vars.map(v => `
    <button class="var-btn ${v === _profileActiveVar ? 'active' : ''}" data-var="${v}">
      ${VARIABLE_META[v]?.label || v}
    </button>
  `).join('');

  // Show loading state
  const ctx = DOM.profileChart.getContext('2d');
  ctx.clearRect(0, 0, DOM.profileChart.width, DOM.profileChart.height);

  // Fetch the profile nearest the selected model timestep
  const pd = await getProfile(platform.platformId, _selectedModelTimeISO());
  State.set('profileData', pd);
  _renderProfileMeta(platform, pd);

  // A variable with no surviving levels gets a disabled button rather than one
  // that silently draws an empty chart.
  DOM.profileVarToggle.querySelectorAll('[data-var]').forEach(b => {
    const series = pd.variables?.[b.dataset.var];
    const empty = !series || !series.some(v => v !== null && Number.isFinite(v));
    b.classList.toggle('depleted', empty);
    b.title = empty ? 'No levels survived quality control' : '';
  });

  drawProfileChart(DOM.profileChart, pd, _profileActiveVar);
}

/**
 * Provenance strip. For real Argo this states the Argo data mode, the cycle,
 * and whether adjusted or raw fields were used — delayed-mode salinity
 * correction can exceed the signal, so which set was used is not a detail.
 */
function _renderProfileMeta(platform, pd) {
  const when = pd?.real ? pd.timestamps[0] : platform.lastUpdate;
  const bits = [
    `<span class="meta-item"><i class="ph ph-crosshair"></i>${_formatLatLon(pd?.lat ?? platform.lat, pd?.lon ?? platform.lon)}</span>`,
    `<span class="meta-item"><i class="ph ph-clock-counter-clockwise"></i>${formatDate(when)}</span>`,
  ];

  // How far this observation sits from the model frame on screen. Without it,
  // a profile and a model field shown together read as agreeing at one instant.
  // Applies to synthetic platforms too: a generated instrument dated two years
  // from the frame is exactly as misleading as a real one.
  const offset = pd?.offsetMs ?? (when ? Date.parse(when) - Date.parse(_selectedModelTimeISO()) : null);
  if (offset !== null && Number.isFinite(offset)) {
    const days = offset / 86400000;
    const mag = Math.abs(days);
    const dir = days >= 0 ? 'after' : 'before';
    let txt, cls;
    if (mag < 1)        { txt = 'Same day as model frame';            cls = 'is-real'; }
    else if (mag <= 5)  { txt = `${mag.toFixed(1)} d ${dir} model frame`; cls = 'is-real'; }
    else if (mag <= 31) { txt = `${Math.round(mag)} d ${dir} model frame`; cls = ''; }
    else                { txt = `${(mag / 365).toFixed(1)} yr ${dir} model frame`; cls = 'is-mock'; }
    bits.push(`<span class="meta-item ${cls}" title="Offset between this profile and the selected model timestep"><i class="ph ph-arrows-left-right"></i>${esc(txt)}</span>`);
  }

  if (pd?.real) {
    const modeLabel = { R: 'Real-time', A: 'Adjusted', D: 'Delayed mode' }[pd.dataMode] || pd.dataMode;
    bits.push(
      `<span class="meta-item is-real"><i class="ph ph-seal-check"></i>Argo GDAC</span>`,
      // CYCLE_NUMBER counts every profile since deployment, so it is not an
      // index into the cycles bundled here. Reporting "cycle 323 of 18" would
      // be nonsense; these are two separate facts.
      `<span class="meta-item" title="Argo CYCLE_NUMBER: profiles since deployment"><i class="ph ph-arrows-clockwise"></i>Cycle ${esc(pd.cycle)}</span>`,
      `<span class="meta-item" title="Cycles bundled in this build">${esc(pd.cycleCount)} in track</span>`,
      `<span class="meta-item" title="Argo data mode">${esc(modeLabel)}${pd.adjusted ? ' · adjusted' : ' · raw'}</span>`,
      `<span class="meta-item"><i class="ph ph-gauge"></i>${pd.pressureDbar.length} levels to ${Math.round(Math.max(...pd.pressureDbar))} dbar</span>`
    );
  } else {
    bits.push(`<span class="meta-item is-mock"><i class="ph ph-flask"></i>Synthetic</span>`);
  }
  DOM.profileMeta.innerHTML = bits.join('');
}

// ---------------------------------------------------------------------------
// Colorbar
// ---------------------------------------------------------------------------

function _updateColorbar() {
  const palette = State.get('colorbarPalette');
  const variable = State.get('activeVariable');
  const scale = State.get('colorbarScale');
  const meta = VARIABLE_META[variable] || VARIABLE_META.temperature;
  const minVal = State.get('colorbarMin') ?? meta.defaultMin;
  const maxVal = State.get('colorbarMax') ?? meta.defaultMax;

  drawColorbar(DOM.colorbarCanvas, palette, minVal, maxVal, meta.unit, scale);

  // Name the quantity in CF vocabulary — an unlabelled ocean field is
  // unusable as evidence once a screenshot leaves the room.
  const legendLabel = document.getElementById('colorbar-label');
  if (legendLabel) {
    legendLabel.textContent = `${meta.label} (${meta.unit})`;
    legendLabel.title = meta.cfName ? `CF standard name: ${meta.cfName}` : '';
  }
  _updatePaletteNote();
  _updateVectorKey();
  _updateTchpKey();
}

/**
 * Reference magnitude for the current-vector glyphs.
 * Glyph length carries no quantitative meaning without one, and the scaling is
 * sqrt rather than linear, which has to be stated or lengths are misread.
 */
function _updateVectorKey() {
  const el = document.getElementById('vector-key');
  if (!el) return;
  const vs = State.get('vectorScale');
  const on = State.get('activeVariable') === 'currents'
          && State.get('layers.currentVectors') !== false && vs;
  el.classList.toggle('hidden', !on);
  if (!on) return;
  el.innerHTML =
    `<span class="vk-arrow">&#10230;</span> longest glyph = ${vs.maxSpeed.toFixed(2)} ${esc(vs.unit)} ` +
    `at ${vs.depthM} m<br>length &prop; &radic;speed &middot; ${vs.glyphs} glyphs, decimated`;
}

/** Warn when a palette choice would misrepresent the field. */
function _updatePaletteNote() {
  const el = document.getElementById('palette-note');
  if (!el) return;
  const p = State.get('colorbarPalette');
  if (p === 'jet') {
    el.textContent = '⚠ Jet is not perceptually uniform — it creates false banding and hides real gradients. Shown for comparison only.';
    el.className = 'ctrl-note warn';
  } else if (DIVERGING_PALETTES.has(p)) {
    el.textContent = 'Diverging scale — set symmetric min/max so the neutral value stays centred.';
    el.className = 'ctrl-note';
  } else {
    el.textContent = '';
    el.className = 'ctrl-note';
  }
}

// ---------------------------------------------------------------------------
// Depth gauge
// ---------------------------------------------------------------------------

function _updateDepthGauge() {
  drawDepthGauge(DOM.depthGauge, State.get('depthSlice'), DOMAIN.depthMax);
}

/**
 * A 3D ocean view is misleading by default: the true aspect ratio of this
 * domain is nearly flat (~1100 km wide, 2 km deep). State the exaggeration
 * factor and the domain in the view itself, not only in a control panel.
 */
function _updateScaleBadge() {
  const el = document.getElementById('scale-badge');
  if (!el) return;
  const exag = State.get('verticalExaggeration');
  el.innerHTML = `
    <span class="badge-exag">Vertical exaggeration ${exag}×</span>
    <span class="badge-domain">${_hemi(VIEW.lonMin, 'EW')}–${_hemi(VIEW.lonMax, 'EW')} · ${_hemi(VIEW.latMin, 'NS')}–${_hemi(VIEW.latMax, 'NS')} · 0–${VIEW.depthMax} m${isSubRegion() ? ' · selected' : ''}</span>
  `;
}

// ---------------------------------------------------------------------------
// Loading overlay
// ---------------------------------------------------------------------------

export function showLoading(msg = 'Loading ocean data…') {
  if (!DOM.loadingOverlay) return;
  DOM.loadingOverlay.querySelector('.loading-msg').textContent = msg;
  DOM.loadingOverlay.classList.remove('hidden');
}

export function hideLoading() {
  if (!DOM.loadingOverlay) return;
  DOM.loadingOverlay.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Responsive
// ---------------------------------------------------------------------------

function _wireResizeAmbient() {
  const mq = window.matchMedia('(max-width: 768px)');
  function handleMQ(e) {
    if (e.matches) {
      State.set('controlsPanelOpen', false);
      State.set('layersPanelOpen', false);
    }
  }
  mq.addEventListener('change', handleMQ);
  handleMQ(mq);
}
