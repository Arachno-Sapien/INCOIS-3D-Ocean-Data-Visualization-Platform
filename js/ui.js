/**
 * ui.js — UI wiring, panel management, event handlers
 *
 * Reads from / writes to State. Never touches raw data directly.
 * Calls chart functions from charts.js.
 * Calls scene helpers from scene.js.
 */

import State from './state.js';
import { PLUGIN_REGISTRY, VARIABLE_META, getProfile, getDataProvenance,
         getObservationWindow, getModelFrames, getModelLevels,
         setCaseStudy, getCaseStudy, isCaseStudy, sampleModelColumn } from './dataService.js';
import { drawProfileChart, drawColorbar, drawDepthGauge } from './charts.js';
import { beginAreaDrag, updateAreaDrag, endAreaDrag, cancelAreaDrag,
         clearAreaSelection, rebuildForBounds, captureFrame,
         refreshMarkers } from './scene.js';
import { formatDate, DIVERGING_PALETTES } from './utils.js';
import { DOMAIN, VIEW, isSubRegion, setViewBounds, resetViewBounds,
         TCHP_THRESHOLD, D26_THRESHOLD } from './constants.js';

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
  _wireCaseStudy();
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
  State.subscribe('modelFrame',         () => _updateDateNote());
  State.subscribe('depthSlice',         () => _updateVectorKey());
  State.subscribe('timelineIndex',      () => _updateTimeline());
  State.subscribe('layers',             () => { _syncLayerCheckboxes(); _updateTchpKey(); _updateVectorKey(); });
  State.subscribe('timelinePlaying',    () => _updatePlayButton());
  State.subscribe('profilePanelOpen',   v  => { DOM.profilePanel.classList.toggle('hidden', !v); });
  State.subscribe('controlsPanelOpen',  v  => { DOM.controlsPanel.classList.toggle('collapsed', !v); });
  State.subscribe('layersPanelOpen',    v  => { DOM.layersPanel.classList.toggle('collapsed', !v); });

  const _refreshOpenProfile = () => {
    if (State.get('profilePanelOpen')) {
      const plat = State.get('selectedPlatform');
      if (plat) _openProfilePanel(plat);
    }
  };
  State.subscribe('selectedDate', _refreshOpenProfile);
  State.subscribe('selectedTimestep', _refreshOpenProfile);
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
  DOM.dateInput.addEventListener('change', e => {
    // An emptied date input reports '' and still fires change. Letting that
    // through makes Date.parse NaN everywhere downstream: the field silently
    // falls back to the first frame in the file, months from what was on
    // screen, and the export strip is stamped "NaN yr before requested ".
    if (e.target.value) State.set('selectedDate', e.target.value);
    else e.target.value = State.get('selectedDate');
  });
  _constrainDateToObservations();

  // Timestep
  _populateTimestepSelect();
  DOM.timestepSelect.addEventListener('change', e => {
    const idx = parseInt(e.target.value);
    State.set('timelineIndex', idx);
  });

  // Depth. Snapped to the levels the field is actually defined on — 5, 10, 20,
  // 30, 50, 75, 100 ... 1800 m — so the readout, the exported provenance strip
  // and the sheet on screen all name the same depth. A free slider let the
  // label claim 340 m while the nearest computed level was 300.
  // Read per event, not once at wiring: currents and chlorophyll have no real
  // counterpart and render on the synthetic even ladder, so snapping those to
  // the INCOIS levels would label the sheet with a depth it is not at.
  const snap = v => {
    const levels = getModelLevels(State.get('activeVariable'));
    return levels ? levels.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a) : v;
  };
  DOM.depthSlider.value = State.get('depthSlice');
  DOM.depthReadout.textContent = `${State.get('depthSlice')} m`;
  DOM.depthSlider.addEventListener('input', e => {
    const levels = getModelLevels(State.get('activeVariable'));
    const v = snap(parseInt(e.target.value));
    // Move the thumb to the level that was chosen. Without this the control
    // sits at the dragged position while its own readout, the depth gauge and
    // the exported strip all name the snapped one.
    e.target.value = v;
    State.set('depthSlice', v);
    DOM.depthReadout.textContent = levels ? `${v} m · level` : `${v} m`;
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
async function _constrainDateToObservations(preferred) {
  const win = await getObservationWindow();
  if (!win) {
    _obsNote = '';
    _updateDateNote();
    return;
  }

  const start = win.start.slice(0, 10);
  const end = win.end.slice(0, 10);
  DOM.dateInput.min = start;
  DOM.dateInput.max = end;

  // Open on the newest frame the field actually holds. Both layers are real
  // now and the analysis runs about a month behind the floats, so opening on
  // the last observation date would put a month-stale field under fresh
  // observations — the exact mismatch the offset readout exists to expose.
  //
  // `preferred` overrides that for the case study, which opens on the date the
  // storm began its run rather than on the newest frame in the snapshot.
  const current = State.get('selectedDate');
  const frames = getModelFrames() || [];
  const usable = frames.map(t => t.slice(0, 10)).filter(d => d >= start && d <= end);
  const newest = usable.length ? usable[usable.length - 1]
               : (current < start || current > end ? end : null);
  const open = preferred && preferred >= start && preferred <= end ? preferred : newest;
  DOM.dateInput.value = open || current;
  // Only when it actually moves: State.set notifies regardless, and the
  // 'selectedDate' subscribers rebuild the whole field and every marker.
  if (open && open !== current) State.set('selectedDate', open);

  _obsNote = `Argo coverage ${start} to ${end} · ${win.count} profiles`;
  _updateDateNote();
}

let _obsNote = '';

/**
 * What the date control is actually bound to, on both sides.
 *
 * The observations constrain the range; the field constrains the resolution.
 * The analysis is ten-daily, so most dates in the range have no field of their
 * own and the nearest frame is shown instead — which the reader has to be told,
 * or a date picker that accepts any day implies a field for any day.
 */
function _updateDateNote() {
  const note = document.getElementById('date-note');
  if (!note) return;
  const mf = State.get('modelFrame');
  const frames = getModelFrames();
  const bits = [_obsNote];
  if (mf && frames) {
    const off = _offsetParts(mf.offsetMs);
    bits.push(`field frame ${mf.time.slice(0, 10)}`
      + (off.txt === 'same day' ? '' : ` (${off.txt})`));
    // Not "ten-day": --max-frames subsamples the ten-daily axis, so the
    // bundled frames sit 20-31 days apart and saying otherwise understates
    // how far the nearest frame can be from the date asked for.
    const gaps = frames.slice(1).map((t, i) =>
      (Date.parse(t) - Date.parse(frames[i])) / 86400000);
    bits.push(gaps.length
      ? `${frames.length} frames, ${Math.round(Math.min(...gaps))}–${Math.round(Math.max(...gaps))} d apart`
      : `${frames.length} frame`);
  }
  note.textContent = bits.filter(Boolean).join(' · ') || 'Synthetic field: any date.';
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

  // Tall enough for the lowest baseline: y0 is frame.height + 26 and the
  // instrument-window line sits at y0 + 98, so anything under ~136 clips it.
  //
  // The case study adds a header, a statistics line and the caveat. The caveat
  // is a sentence rather than a field and does not fit on one line at any
  // sensible export width, so it is wrapped and the strip is sized from the
  // result — a fixed height silently truncated it off the right edge, which on
  // the one line that says "this is not a forecast" is the worst place to lose
  // text.
  const cs = getCaseStudy();
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = "10px 'IBM Plex Mono', monospace";
  const caveatLines = cs ? _wrapText(measure, cs.analysis.caveat, frame.width - 48) : [];
  const STRIP = cs ? 184 + 14 * (caveatLines.length - 1) : 138;
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
  // The extent of the cells drawn, not the box requested. A dragged selection
  // snaps outward to whole grid cells, and a figure that names the request
  // instead of the data is the failure this strip exists to prevent.
  const ext = State.get('modelFrame')?.bounds || VIEW;
  const line1 = [
    `${_hemi(ext.lonMin,'EW')}–${_hemi(ext.lonMax,'EW')}`,
    `${_hemi(ext.latMin,'NS')}–${_hemi(ext.latMax,'NS')}`,
    `depth slice ${State.get('depthSlice')} m`,
    `vert. exag. ${State.get('verticalExaggeration')}×`,
  ].join('   ·   ');
  // The frame drawn, not the date requested. A ten-day analysis has no field
  // at an arbitrary instant, and a figure that names the request rather than
  // the data is exactly the sort of thing this strip exists to prevent.
  const mf = State.get('modelFrame');
  const line2 = [
    mf
      ? `frame ${mf.time.slice(0, 10)} (${_offsetLabel(mf.offsetMs)} requested ${State.get('selectedDate')})`
      : `${State.get('selectedDate')} ${State.get('selectedTimestep')} UTC`,
    `palette ${State.get('colorbarPalette')}`,
    `scale ${State.get('colorbarScale')} ${Number(State.get('colorbarMin') ?? meta.defaultMin)}–${Number(State.get('colorbarMax') ?? meta.defaultMax)}`,
    iso && State.get('layers.isosurface') !== false
      ? `isosurface ${iso.threshold} ${meta.unit} @ ${Math.round(iso.minDepth)}–${Math.round(iso.maxDepth)} m`
      : null,
  ].filter(Boolean).join('   ·   ');
  c.fillText(line1, L, y0 + 46);
  c.fillText(line2, L, y0 + 64);

  // The honesty line: which half of what you are looking at is measured.
  // Stated for the variable actually exported — temperature and salinity come
  // from the INCOIS grid, currents and chlorophyll are still generated, and one
  // sentence covering both would be false about one of them.
  c.font = "11px 'IBM Plex Mono', monospace";
  const variable = State.get('activeVariable');
  const fieldReal = prov.model.real && prov.model.realVariables.includes(variable);
  const cen = prov.argo.census;
  // The frame contains four observation classes, not one. Attributing all of
  // them to "Argo GDAC" was wrong even on the healthy path — gliders come from
  // the OceanGliders GDAC, CTD from CCHDO/GO-SHIP, moorings from the GTS — and
  // when instruments.json fails to load the registry silently falls back to
  // the mock generators, so the strip was captioning six synthetic markers
  // "real", in green.
  const inst = prov.instruments;
  const instReal = !!inst && Object.values(inst).every(v => v.real);
  const obs = prov.argo.real
    ? `Observations: Argo GDAC ${prov.argo.distinctFloats} floats`
      + (cen ? ` of ${cen.floats} in basin, ${cen.incois} INCOIS-managed` : '')
      + `, QC flags ${prov.argo.qc.keptFlags.join('/')}`
    : 'Observations: synthetic';
  const instText = inst
    ? ['glider', 'ctd', 'mooring'].map(k => inst[k].real
        ? `${k} ${inst[k].window[0]}–${inst[k].window[1]}`
        : `${k} SYNTHETIC`).join(', ')
    : 'gliders/CTD/moorings SYNTHETIC';
  const field = fieldReal
    ? `Field: real (${prov.model.dataset}, ${prov.model.levels} levels to ${prov.model.depthRange[1]} m)`
    : 'Field: SYNTHETIC';
  // Green only when nothing in the frame is generated — which now includes the
  // instrument markers, not just the floats and the field.
  c.fillStyle = prov.argo.real && fieldReal && instReal ? '#63e6be' : '#ff8a5c';
  c.fillText(`${obs}   ·   ${field}`, L, y0 + 82);
  c.fillStyle = 'rgba(223,240,239,0.62)';
  c.font = "10px 'IBM Plex Mono', monospace";
  c.fillText(instText, L, y0 + 98);

  c.textAlign = 'right';
  c.fillStyle = 'rgba(223,240,239,0.38)';
  c.fillText(new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC', R, y0 + 82);
  c.textAlign = 'left';

  // A case-study figure travels exactly as far as any other and must not be
  // mistaken for the live basin. The claim and its caveat are burned in with
  // it: an image showing a track over a heat field, with no statement of what
  // that pairing does and does not support, is the failure this strip exists
  // to prevent.
  if (cs) {
    const a = cs.analysis;
    c.fillStyle = '#ff8a5c';
    c.font = "11px 'IBM Plex Mono', monospace";
    c.fillText(
      `CASE STUDY ${cs.storm.name} ${cs.storm.season} (${cs.storm.source})`
      + `   ·   peak ${cs.storm.peakWindKt} kt   ·   NOT the live 2026 view`,
      L, y0 + 118);
    c.fillStyle = 'rgba(223,240,239,0.62)';
    c.font = "10px 'IBM Plex Mono', monospace";
    const sign = v => `${v >= 0 ? '+' : ''}${v}`;
    c.fillText(
      `TCHP (${a.predictorFrame.slice(0, 10)}, pre-genesis) vs next ${a.leadHours} h: `
      + `r ~${a.lead.r >= 0 ? '+' : ''}${a.lead.r.toFixed(1)} `
      + `(${sign(a.lead.r)} by this file's pairing rule)   ·   `
      + `>=${a.thresholdKJcm2}: ${sign(a.lead.above.meanDeltaKt)} kt   ·   `
      + `<${a.thresholdKJcm2}: ${sign(a.lead.below.meanDeltaKt)} kt   ·   `
      + `landfall-free r ${sign(a.leadOffshore.r)} n=${a.leadOffshore.n}`,
      L, y0 + 134);
    caveatLines.forEach((ln, i) => c.fillText(ln, L, y0 + 150 + 14 * i));
  }

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

/**
 * Greedy word wrap against the measured width of the font already set on `c`.
 * A word longer than the line is left to overflow rather than hyphenated: that
 * only happens to a URL, and a broken URL is worse than a wide one.
 */
function _wrapText(c, text, maxWidth) {
  const lines = [];
  let cur = '';
  for (const w of String(text).split(/\s+/)) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && c.measureText(next).width > maxWidth) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

function _wireExport() {
  const btn = document.getElementById('export-btn');
  if (btn) btn.addEventListener('click', () => _exportPNG());
  // Expose for the smoke test; harmless and keeps the export path verifiable
  window.__exportPNG = _exportPNG;
  // Same reason: the profile panel now renders four different instrument
  // classes with different vertical units and different QC provenance, and
  // that is worth being able to exercise without hunting a marker in 3D.
  window.__openProfile = _openProfilePanel;
}

/**
 * TCHP readout, with the operational threshold stated.
 * A number in kJ cm-2 means nothing to most viewers without the ~50-60 figure
 * associated with rapid intensification, so the scale carries it.
 *
 * With the case study loaded it also carries the lead-framed number, which is
 * the one that means something: the heat the storm is about to cross, not the
 * heat under it. See `_tchpLead` in js/scene.js for why those are different
 * quantities and why only one of them separates anything.
 */
function _updateTchpKey() {
  const el = document.getElementById('tchp-key');
  if (!el) return;
  const t = State.get('tchpStats');
  const on = State.get('layers.tchp') !== false && t;
  el.classList.toggle('hidden', !on);
  // Emptied, not just hidden. Leaving the markup in place kept a case-study
  // "water ahead" reading inside a hidden element after the snapshot had been
  // swapped back out — invisible, but it is a stale claim sitting in the DOM.
  if (!on) { el.innerHTML = ''; return; }

  let html =
    `TCHP ${t.min.toFixed(0)}–${t.max.toFixed(0)} ${esc(t.unit)} · fixed 0–160 scale<br>` +
    `<b>&ge;${Number(TCHP_THRESHOLD)}</b> associated with rapid intensification`;

  const L = t.lead;
  if (L && State.get('layers.cyclone') !== false) {
    const off = _offsetParts(L.offsetMs);
    const cls = L.above ? 'tk-above' : 'tk-below';
    // Number(), not esc(): these come out of a fetched JSON document, and a
    // number that is not one should read NaN rather than reach innerHTML as
    // whatever it actually was.
    const verdict = L.above
      ? `above the ${Number(L.threshold)} threshold — favourable for intensification`
      : `below the ${Number(L.threshold)} threshold — not favourable`;
    html +=
      `<span class="tk-lead">` +
      `${esc(L.storm)} ${Number(L.windKt).toFixed(0)} kt at ${esc(L.fixTime.slice(0, 16).replace('T', ' '))}` +
      `${off.txt === 'same day' ? '' : ` (${esc(off.txt)})`}<br>` +
      `Water ahead, next ${Number(L.hours)} h: <span class="${cls}">${L.meanTchp.toFixed(0)} ${esc(t.unit)}</span> · ${verdict}<br>` +
      // How many positions that mean is over, and how many could not be read.
      // A mean over two of eight fixes is a different claim from one over eight.
      `<span class="tk-caveat">mean of ${L.nSampled} fix${L.nSampled === 1 ? '' : 'es'} ahead` +
      `${L.nMissing ? `, ${L.nMissing} outside the field` : ''}` +
      `${L.frame ? ` · frame ${esc(L.frame.slice(0, 10))}` : ''}<br>` +
      // The only other encoding on screen. Marker area is proportional to
      // wind, which is the convention, but a size scale with nothing stating
      // it is a quantity the viewer has to guess at.
      `Track fix area ∝ wind speed.<br>` +
      `Means, not steps: sub-threshold fixes did intensify.</span></span>`;
  } else if (!L && t.favourable) {
    const f = t.favourable;
    const pct = Math.round(f.coverage * 100);
    const of = f.ofWater ? 'of the water' : 'of the region';
    const cls = pct > 0 ? 'tk-above' : 'tk-below';
    html +=
      `<span class="tk-lead">` +
      `Favourable for intensification: <span class="${cls}">${pct}% ${esc(of)}</span><br>` +
      `<span class="tk-caveat">TCHP &ge; ${Number(f.thresholdTchp)} ${esc(t.unit)} and D26 &ge; ${Number(f.thresholdD26)} m · ${f.nFavourable} of ${f.wet} ocean cells</span>` +
      `</span>`;
  }
  el.innerHTML = html;
}

// The intensification corridor, not the whole track. Centred on 13°N 88°E,
// where Mocha ran north from a depression to 145 kt, and carried far enough
// north to show it cross onto the low-heat shelf water where it died. The
// landfall tail reaches past the corner of the analysed domain and is left
// off-view rather than drawn on the boundary.
const MOCHA_VIEW = { lonMin: 81, lonMax: 95, latMin: 4, latMax: 22 };

/**
 * Cyclone Mocha, May 2023 — one control that swaps the whole snapshot.
 *
 * The live view is a rolling six months and has no cyclone in it: the 2026
 * North Indian season has produced none at all, which is a fact about the
 * basin rather than a gap in the pipeline. So the case study travels to a
 * storm, and it travels as a *complete* snapshot — its own field frames, its
 * own floats, its own date bounds — rather than as an overlay borrowing the
 * live one's credibility. Everything the provenance badge and the export strip
 * say re-reads from the swapped documents for exactly that reason.
 */
function _wireCaseStudy() {
  const btn = document.getElementById('case-toggle');
  const readout = document.getElementById('case-readout');
  const note = document.getElementById('case-note');
  if (!btn) return;

  // Everything below is interpolated into innerHTML out of a fetched document.
  // Strings go through esc(); numbers go through these two, so a value that is
  // not a number reads NaN instead of arriving as markup.
  const pct = v => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}`);
  const num = v => (v == null ? '—' : String(Number(v)));
  // Two decimals, not one: a correlation rounded to +0.9 cannot be told from
  // +0.85, and the difference between the full-track and landfall-free figures
  // is the whole point of printing both.
  const rho = v => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}`);
  // One decimal for the headline claim. The exact correlation moves with the
  // 24 h pairing rule (0.87-0.91 across reasonable choices), so two decimals
  // in the sentence a reader quotes would be a precision the method lacks.
  const approxRho = v => (v == null ? '—' : `≈ ${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}`);

  const render = () => {
    const cs = getCaseStudy();
    btn.classList.toggle('active', !!cs);
    readout.classList.toggle('is-case', !!cs);
    if (!cs) {
      readout.textContent = 'Live · 2026';
      btn.textContent = 'Cyclone Mocha 2023';
      note.innerHTML =
        'Swaps the field and the floats for a May 2023 snapshot. ' +
        'The live view is untouched.';
      return;
    }
    const a = cs.analysis, s = cs.storm;
    readout.textContent = `${esc(s.name)} · ${s.season}`;
    btn.textContent = 'Back to live 2026';
    // Both framings, because the negative one is what makes the positive one
    // worth stating: the same field, the same threshold, the same storm.
    note.innerHTML =
      `${esc(s.name)}, peak ${num(s.peakWindKt)} kt. ` +
      `TCHP under the storm at the moment it intensified separates nothing — ` +
      `RI steps ${num(a.lag.riSteps.meanTchp)} vs ${num(a.lag.otherSteps.meanTchp)} kJ cm⁻², ` +
      `and it peaked over ${num(a.peak.tchpPre)}.<br><br>` +
      `Read <b>ahead</b> instead — pre-genesis TCHP against the next ` +
      `${num(a.leadHours)} h — <b>r ${approxRho(a.lead.r)}</b> (n ${num(a.lead.n)}): ` +
      `≥${num(a.thresholdKJcm2)} → ${pct(a.lead.above.meanDeltaKt)} kt (n ${num(a.lead.above.n)}), ` +
      `&lt;${num(a.thresholdKJcm2)} → ${pct(a.lead.below.meanDeltaKt)} kt (n ${num(a.lead.below.n)}).<br><br>` +
      `Excluding every ${num(a.leadHours)} h window within ` +
      `${num(a.leadOffshore.minDist2LandKm)} km of land, so the landfall decay ` +
      `cannot carry it: r ${rho(a.leadOffshore.r)} ` +
      `(n ${num(a.leadOffshore.n)}), ${pct(a.leadOffshore.above.meanDeltaKt)} vs ` +
      `${pct(a.leadOffshore.below.meanDeltaKt)} kt.<br><br>` +
      // The exact figure depends on how the 24 h partner is picked, so the
      // rule travels with it. Without that, a reader who recomputes with a
      // slightly different window gets 0.87 and the headline looks inflated.
      `<span class="tk-caveat">Quoted to one decimal because the exact value ` +
      `depends on the pairing rule: ${rho(a.lead.r)} with ` +
      `${esc(a.pairing?.rule || 'the nearest fix to t + 24 h')}, ` +
      `${esc(a.pairing?.rSensitivityNote || '0.87-0.91 across reasonable pairing rules')}.` +
      `</span><br><br>` +
      `<span class="ctrl-note warn">${esc(a.caveat)}</span>`;
  };

  let busy = false;
  btn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    try {
      const entering = !isCaseStudy();
      const cs = await setCaseStudy(entering);

      // Temperature first: TCHP is only defined on it, and the case study
      // opening on the salinity tab would show an empty heat layer.
      State.set('activeVariable', 'temperature');
      _syncColorbarInputsToVariable('temperature');
      _updateTabBar();
      State.set('layers.tchp', entering);
      State.set('layers.cyclone', entering);

      if (entering) setViewBounds(MOCHA_VIEW); else resetViewBounds();
      // Re-bound the date control to the snapshot now in place, then open on
      // the fix where the run to 145 kt began rather than on the newest frame.
      await _constrainDateToObservations(entering ? cs.storm.focusDate : null);
      await rebuildForBounds(true);
      State.set('viewMode', 'volume');
      await refreshMarkers();

      // Both of these read the swapped documents, so neither may be left
      // describing the snapshot that is no longer loaded.
      await _renderProvenanceBadge();
      _updateScaleBadge();
      document.getElementById('area-reset-btn')
        ?.classList.toggle('hidden', !isSubRegion());
      render();
    } catch (err) {
      console.error('[INCOIS] Case study failed:', err);
      note.innerHTML = `<span class="ctrl-note warn">Could not load the case ` +
        `study: ${esc(err.message)}. Run tools/fetch_cyclone.py.</span>`;
    } finally {
      busy = false;
      btn.disabled = false;
    }
  });

  render();
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
    // "of the water", not "of the region": with a real field about a fifth of
    // the box is land, and counting that as somewhere the isotherm is missing
    // would report a hole in the data where there is a coastline.
    const of = s.ofWater ? 'of the water' : 'of the region';
    note.textContent =
      `${Math.round(s.minDepth)}–${Math.round(s.maxDepth)} m` +
      (pct < 100 ? ` · present over ${pct}% ${of}` : ` · all ${of.slice(3)}`);
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
 *
 * Both halves are now stated from the provenance record rather than asserted in
 * a literal: the model field became real for temperature and salinity but
 * stayed synthetic for currents and chlorophyll, and a badge that generalises
 * either way would be wrong about half the app.
 */
async function _renderProvenanceBadge() {
  const el = document.getElementById('provenance-badge');
  if (!el) return;
  const p = await getDataProvenance();
  if (p.argo.real) {
    // Distinct platforms, not core + BGC: several floats carry both sensor
    // sets and appear in each list, so the sum claimed floats that do not
    // exist and disagreed with the count in the exported strip.
    el.textContent = `ARGO LIVE · ${p.argo.distinctFloats} FLOATS`;
    el.classList.add('is-real');
    el.title =
      `Core Argo: ${p.argo.profiles} QC'd T/S profiles from ${p.argo.floats} floats\n` +
      (p.bgc?.real
        ? `BGC: ${p.bgc.profiles} chlorophyll profiles from ${p.bgc.floats} floats\n`
        : '') +
      _instrumentLines(p.instruments) +
      `Source: ${p.argo.source}\n` +
      `Window: ${p.argo.timeRange.join(' to ')}\n` +
      `QC: kept flags ${p.argo.qc.keptFlags.join(', ')}\n` +
      _censusLines(p.argo) +
      _modelProvenanceLines(p.model) +
      `\n${p.argo.attribution}` +
      (p.model.real ? `\n\n${p.model.attribution}` : '');
  } else {
    el.textContent = 'SYNTHETIC DATA';
    el.title = 'Real Argo data could not be loaded; showing synthetic floats.';
  }
}

/**
 * The three instrument classes that used to be generated, and what they are now.
 *
 * Each is listed with its own window, because they do not share one: the
 * moorings are current, the last glider left this basin in 2022 and the CTD
 * casts are research cruises. Collapsing that into a single "real" would hide
 * the thing a reader most needs to know before comparing one to a 2026 field.
 */
function _instrumentLines(inst) {
  if (!inst) return 'Gliders, CTD, moorings: synthetic (no data loaded)\n';
  const label = { glider: 'Gliders', ctd: 'CTD casts', mooring: 'Moorings' };
  return Object.entries(inst).map(([k, v]) => {
    if (!v.real) return `${label[k]}: synthetic\n`;
    const w = v.window[0] === v.window[1] ? v.window[0] : `${v.window[0]} to ${v.window[1]}`;
    return `${label[k]}: real — ${v.platforms} platforms, ${v.profiles} profiles, ${w}` +
           `${v.qcFlags ? '' : ' (no per-level QC flags)'}\n`;
  }).join('');
}

/**
 * The float population, and India's share of it.
 *
 * The bundled floats are a stratified sample, not the network: quoting "16
 * floats" alone understates the basin by an order of magnitude, while quoting
 * the census alone would imply all of them are drawn. Both, together, with the
 * sample shown to match the population it came from.
 */
function _censusLines(argo) {
  const c = argo.census;
  if (!c) return '';
  const pct = Math.round(100 * c.incois / Math.max(1, c.floats));
  const mine = Object.entries(argo.byDataCentre || {})
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  return `Basin: ${c.floats} floats reported in this window, ` +
         `${c.incois} INCOIS-managed (${pct}%)\n` +
         `  shown: ${argo.floats}, sampled per data centre (${mine})\n`;
}

/** The model half of the provenance tooltip, per variable. */
function _modelProvenanceLines(m) {
  if (!m?.real) return 'Model field: synthetic\n';
  const g = m.grid;
  return `Model field: real for ${m.realVariables.join(', ')} — ${m.source}\n` +
    `  grid ${g.nx}×${g.ny}×${m.levels} levels, ${m.depthRange[0]}–${m.depthRange[1]} m\n` +
    `  ${m.frames} frames, ${m.timeRange[0].slice(0, 10)} to ${m.timeRange[1].slice(0, 10)}\n` +
    (m.syntheticVariables.length
      ? `  still synthetic: ${m.syntheticVariables.join(', ')}\n` : '');
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
  const regEntry = PLUGIN_REGISTRY.find(e => e.id === platform.type);

  // Not every registry entry describes something with a water column. A storm
  // track has no profile to draw, and opening a panel that offers a
  // temperature profile of a cyclone would be inventing an observation. Driven
  // off `profileVariables` rather than off the id, so a future non-profiling
  // layer needs no edit here.
  if (regEntry && !regEntry.profileVariables?.length) return;

  State.set('selectedPlatform', platform);
  State.set('profilePanelOpen', true);

  // Update header. The identifier is named for what it actually is: a WMO
  // number belongs to a float or a GTS buoy, but a glider carries a deployment
  // name and a CTD cast carries a cruise ExpoCode, and calling either of those
  // a WMO number would be inventing a registration that does not exist.
  const typeLabel = regEntry?.label || platform.type;
  const idLabel = platform.real ? (regEntry?.idLabel || '') : '';
  DOM.profileTitle.textContent =
    `${typeLabel} — ${idLabel ? idLabel + ' ' : ''}${platform.platformId}`;

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
  // The type matters: a float can be in both the core and BGC lists, and an
  // id alone would resolve to whichever source is checked first.
  const pd = await getProfile(platform.platformId, _selectedModelTimeISO(), platform.type);
  // Co-located model column at the same geographic coordinate and timestamp
  pd.modelColumn = sampleModelColumn(pd?.lat ?? platform.lat, pd?.lon ?? platform.lon, _selectedModelTimeISO());
  State.set('profileData', pd);
  _renderProfileMeta(platform, pd);

  // A variable with no surviving levels gets a disabled button rather than one
  // that silently draws an empty chart.
  DOM.profileVarToggle.querySelectorAll('[data-var]').forEach(b => {
    const series = pd.variables?.[b.dataset.var];
    const empty = !series || !series.some(v => v !== null && Number.isFinite(v));
    b.classList.toggle('depleted', empty);
    // Only meaningful where the source ships per-level flags; a glider or a
    // moored buoy with no salinity simply never reported any.
    b.title = empty
      ? (pd.qcFlags ? 'No levels survived quality control'
                    : 'Not reported by this platform')
      : '';
  });

  drawProfileChart(DOM.profileChart, pd, _profileActiveVar);
}

/**
 * How far apart two instants are, in the coarsest unit that stays honest, plus
 * a class grading it: a same-day comparison means something, a year apart does
 * not. Shared by the profile chips and the exported provenance strip, which
 * both have to say how far the thing on screen is from the frame behind it.
 */
function _offsetParts(ms) {
  // Belt and braces alongside the date-input guard: every comparison below is
  // false against NaN, so an unguarded non-finite offset falls through to the
  // year branch and reads "NaN yr before".
  if (!Number.isFinite(ms)) return { txt: 'offset unknown', cls: 'is-mock' };
  const days = ms / 86400000;
  const mag = Math.abs(days);
  const dir = days >= 0 ? 'after' : 'before';
  if (mag < 1)   return { txt: 'same day',                    cls: 'is-real' };
  if (mag <= 5)  return { txt: `${mag.toFixed(1)} d ${dir}`,  cls: 'is-real' };
  if (mag <= 31) return { txt: `${Math.round(mag)} d ${dir}`, cls: '' };
  return { txt: `${(mag / 365).toFixed(1)} yr ${dir}`, cls: 'is-mock' };
}

function _offsetLabel(ms) { return _offsetParts(ms).txt; }

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
    const { txt: base, cls } = _offsetParts(offset);
    const txt = base === 'same day' ? 'Same day as model frame' : `${base} model frame`;
    bits.push(`<span class="meta-item ${cls}" title="Offset between this profile and the selected model timestep"><i class="ph ph-arrows-left-right"></i>${esc(txt)}</span>`);
  }

  // Model column frame offset chip (stating the model timestamp offset)
  if (pd?.modelColumn?.real) {
    const mOff = _offsetParts(pd.modelColumn.offsetMs);
    const mTxt = mOff.txt === 'same day' ? 'Model: same day' : `Model: ${mOff.txt}`;
    bits.push(`<span class="meta-item is-real" title="Co-located grid cell from INCOIS VAM model analysis"><i class="ph ph-grid-four"></i>${esc(mTxt)}</span>`);
  }

  // The vertical coordinate is whichever the instrument actually reported.
  // A moored buoy reports depth in metres and carries no pressure at all.
  const levels = pd?.pressureDbar || pd?.depths;
  const vUnit = pd?.pressureDbar ? 'dbar' : 'm';

  if (pd?.real && pd.dataMode) {
    // Argo, core or BGC: data mode and cycle number are Argo-specific.
    const modeLabel = { R: 'Real-time', A: 'Adjusted', D: 'Delayed mode' }[pd.dataMode] || pd.dataMode;
    bits.push(
      `<span class="meta-item is-real"><i class="ph ph-seal-check"></i>Argo GDAC</span>`,
      // CYCLE_NUMBER counts every profile since deployment, so it is not an
      // index into the cycles bundled here. Reporting "cycle 323 of 18" would
      // be nonsense; these are two separate facts.
      `<span class="meta-item" title="Argo CYCLE_NUMBER: profiles since deployment"><i class="ph ph-arrows-clockwise"></i>Cycle ${esc(pd.cycle)}</span>`,
      `<span class="meta-item" title="Cycles bundled in this build">${esc(pd.cycleCount)} in track</span>`,
      `<span class="meta-item" title="Argo data mode">${esc(modeLabel)}${pd.adjusted ? ' · adjusted' : ' · raw'}</span>`,
      `<span class="meta-item"><i class="ph ph-gauge"></i>${levels.length} levels to ${Math.round(Math.max(...levels))} dbar</span>`
    );
  } else if (pd?.real) {
    // A glider dive, a ship CTD cast or a moored-buoy profile.
    bits.push(`<span class="meta-item is-real"><i class="ph ph-seal-check"></i>${esc(pd.sourceShort || 'Observed')}</span>`);
    if (pd.station) {
      bits.push(`<span class="meta-item" title="Cruise station and cast"><i class="ph ph-map-pin"></i>Stn ${esc(pd.station)}/${esc(pd.cast)}</span>`);
    }
    if (pd.country && pd.country !== 'UNKNOWN') {
      bits.push(`<span class="meta-item">${esc(pd.country)}</span>`);
    }
    bits.push(`<span class="meta-item" title="Profiles bundled for this platform">${esc(pd.cycleCount)} in track</span>`);
    // Two of the three sources ship no per-level flags. Saying so is the
    // difference between "quality controlled" and "range checked", and the
    // panel should not let the reader assume the stronger one.
    bits.push(pd.qcFlags
      ? `<span class="meta-item is-real" title="Per-level quality flags applied (WOCE flag 2)"><i class="ph ph-check-circle"></i>QC flags</span>`
      : `<span class="meta-item" title="Source ships no per-level QC flags; range and ordering checks only"><i class="ph ph-warning"></i>Range-checked only</span>`);
    bits.push(`<span class="meta-item"><i class="ph ph-gauge"></i>${levels.length} levels to ${Math.round(Math.max(...levels))} ${vUnit}</span>`);
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
    `at ${Math.round(vs.depthM)} m<br>length &prop; &radic;speed &middot; ${vs.glyphs} glyphs, decimated`;
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
