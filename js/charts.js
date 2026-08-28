/**
 * charts.js — Canvas 2D depth-profile chart renderer
 *
 * Renders a depth-vs-variable line chart on a <canvas> element.
 * No external charting library — pure Canvas 2D API.
 * Designed to accept multiple variables and render a toggle inside the chart.
 */

import { VARIABLE_META } from './dataService.js';
import { valueToColor, clamp, lerp, DIVERGING_PALETTES } from './utils.js';

/**
 * Draw a depth-profile chart onto a canvas element.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Object} profileData  — getProfile() response
 * @param {string} activeVar    — 'temperature' | 'salinity' | 'chlorophyll'
 * @param {Object} opts
 */
export function drawProfileChart(canvas, profileData, activeVar = 'temperature', opts = {}) {
  const { depths, variables } = profileData;
  if (!depths || !variables) return;

  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth  || 280;
  const H = canvas.clientHeight || 320;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // ── Background ──
  ctx.fillStyle = '#04141f';
  ctx.fillRect(0, 0, W, H);

  const pad = { top: 28, right: 18, bottom: 36, left: 58 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top  - pad.bottom;

  const data = variables[activeVar];
  const valid = data ? data.filter(v => v !== null && Number.isFinite(v)) : [];

  if (!valid.length) {
    ctx.fillStyle = 'rgba(255,138,92,0.9)';
    ctx.font = '11.5px Geist, system-ui, sans-serif';
    ctx.textAlign = 'center';
    // Say why there is nothing to draw. "No data" reads as a broken app; a
    // QC rejection is a real, meaningful property of this float.
    const msg = profileData.salinityRejected && activeVar === 'salinity'
      ? 'Salinity rejected by QC'
      : 'No data for this variable';
    ctx.fillText(msg, W / 2, H / 2 - 6);
    ctx.fillStyle = 'rgba(223,240,239,0.45)';
    ctx.font = '9.5px Geist, system-ui, sans-serif';
    ctx.fillText(profileData.salinityRejected && activeVar === 'salinity'
      ? 'Every level flagged bad on this float'
      : 'Not reported for this platform', W / 2, H / 2 + 10);
    return;
  }

  const meta = VARIABLE_META[activeVar] || { label: activeVar, unit: '', defaultMin: 0, defaultMax: 1 };
  const maxD = Math.max(...depths);
  // Range over valid levels only. Math.min over an array holding null coerces
  // it to 0, which would scale the axis to a salinity the ocean never has.
  const minV = Math.min(...valid) * 0.97;
  const maxV = Math.max(...valid) * 1.03;

  function xPos(v) { return pad.left + ((v - minV) / (maxV - minV)) * plotW; }
  function yPos(d) { return pad.top  + (d / maxD) * plotH; }

  // ── Grid lines ──
  ctx.strokeStyle = 'rgba(99,230,190,0.12)';
  ctx.lineWidth = 0.8;
  const vTicks = 5;
  for (let i = 0; i <= vTicks; i++) {
    const v = lerp(minV, maxV, i / vTicks);
    const x = xPos(v);
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();
    // Tick label
    ctx.fillStyle = 'rgba(99,230,190,0.5)';
    ctx.font = "9px \'IBM Plex Mono\', monospace";
    ctx.textAlign = 'center';
    ctx.fillText(v.toFixed(1), x, pad.top + plotH + 14);
  }

  const dTicks = [0, 200, 500, 1000, 1500, 2000].filter(d => d <= maxD);
  for (const d of dTicks) {
    const y = yPos(d);
    ctx.strokeStyle = 'rgba(99,230,190,0.12)';
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(99,230,190,0.55)';
    ctx.font = "9px \'IBM Plex Mono\', monospace";
    ctx.textAlign = 'right';
    // Argo measures pressure, not depth. 1 dbar ~ 1 m is fine for display, but
    // the axis must not print metres for a decibar.
    const u = profileData.pressureDbar ? '' : 'm';
    ctx.fillText(d === 0 ? `0${u}` : d >= 1000 ? `${d / 1000}k${u}` : `${d}${u}`,
                 pad.left - 6, y + 3);
  }

  // ── Gradient fill under line ──
  const lineColor = _varColor(activeVar);
  const grad = ctx.createLinearGradient(pad.left, 0, pad.left + plotW, 0);
  grad.addColorStop(0,   lineColor + '10');
  grad.addColorStop(0.5, lineColor + '55');
  grad.addColorStop(1,   lineColor + '10');

  // Split into runs of consecutive valid levels. A QC gap must break the line,
  // not be bridged: a bridge draws a measurement that was rejected.
  const runs = [];
  let run = [];
  for (let i = 0; i < depths.length; i++) {
    const v = data[i];
    if (v === null || !Number.isFinite(v)) {
      if (run.length) { runs.push(run); run = []; }
    } else {
      run.push(i);
    }
  }
  if (run.length) runs.push(run);

  for (const r of runs) {
    if (r.length > 1) {
      ctx.beginPath();
      ctx.moveTo(xPos(data[r[0]]), yPos(depths[r[0]]));
      for (const i of r.slice(1)) ctx.lineTo(xPos(data[i]), yPos(depths[i]));
      ctx.lineTo(pad.left + plotW, yPos(depths[r[r.length - 1]]));
      ctx.lineTo(pad.left + plotW, yPos(depths[r[0]]));
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(xPos(data[r[0]]), yPos(depths[r[0]]));
      for (const i of r.slice(1)) ctx.lineTo(xPos(data[i]), yPos(depths[i]));
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2.2;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  // ── Level markers ──
  // Real Argo profiles run to ~140 levels; a dot per level becomes a solid bar.
  ctx.fillStyle = lineColor;
  const validIdx = runs.flat();
  const stride = Math.max(1, Math.ceil(validIdx.length / 40));
  for (let k = 0; k < validIdx.length; k += stride) {
    const i = validIdx[k];
    ctx.beginPath();
    ctx.arc(xPos(data[i]), yPos(depths[i]), 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Axis labels ──
  ctx.fillStyle = 'rgba(99,230,190,0.75)';
  ctx.font = '10px Geist, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${meta.label} (${meta.unit})`, pad.left, pad.top - 10);

  ctx.save();
  ctx.translate(12, pad.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(99,230,190,0.55)';
  ctx.font = '9px Geist, system-ui, sans-serif';
  ctx.fillText(profileData.pressureDbar ? 'Pressure (dbar)' : 'Depth (m)', 0, 0);
  ctx.restore();

  // ── Border ──
  ctx.strokeStyle = 'rgba(99,230,190,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.left, pad.top, plotW, plotH);
}

/**
 * Profile line colour is sampled from the variable's own colormap rather than
 * hardcoded, so the chart and the 3D field always speak the same colour
 * language. Adding a variable needs no edit here.
 */
function _varColor(variable) {
  const palette = VARIABLE_META[variable]?.palette || 'thermal';
  const [r, g, b] = valueToColor(0.68, palette);
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

/**
 * Draw the colorbar legend strip onto a canvas element.
 * @param {HTMLCanvasElement} canvas
 * @param {string} palette
 * @param {number} minVal
 * @param {number} maxVal
 * @param {string} unit
 */
export function drawColorbar(canvas, palette, minVal, maxVal, unit, scale = 'linear') {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth  || 200;
  const H = canvas.clientHeight || 34;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const barH = 12;
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [r, g, b] = valueToColor(t, palette);
    grad.addColorStop(t, `rgb(${r},${g},${b})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, barH);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(0.5, 0.5, W - 1, barH - 1);

  // Interior ticks as well as endpoints — "blue to red" is not information.
  // On a log scale the ticks sit at their true positions, not evenly spaced.
  const N = 4;
  const at = i => {
    const f = i / N;
    if (scale === 'log') {
      const lo = Math.log(Math.max(minVal, 1e-6)), hi = Math.log(Math.max(maxVal, 1e-5));
      return Math.exp(lerp(lo, hi, f));
    }
    return lerp(minVal, maxVal, f);
  };

  ctx.font = "9px \'IBM Plex Mono\', monospace";
  for (let i = 0; i <= N; i++) {
    const x = (i / N) * W;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath();
    ctx.moveTo(x === 0 ? 0.5 : x === W ? W - 0.5 : x, barH);
    ctx.lineTo(x === 0 ? 0.5 : x === W ? W - 0.5 : x, barH + 3);
    ctx.stroke();

    const v = at(i);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = i === 0 ? 'left' : i === N ? 'right' : 'center';
    ctx.fillText(Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1), x, barH + 13);
  }

  // Diverging scales must show where the neutral value sits, or the reader
  // assumes it is the arithmetic midpoint when it may not be.
  if (DIVERGING_PALETTES.has(palette) && minVal < 0 && maxVal > 0) {
    const zx = ((0 - minVal) / (maxVal - minVal)) * W;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(zx, 0); ctx.lineTo(zx, barH); ctx.stroke();
  }

  // A log colorbar read as linear misstates magnitudes by orders of magnitude.
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText(scale === 'log' ? `${unit} · log₁₀` : unit, W, H - 1);
}

/**
 * Draw the sonar depth gauge dial on a canvas element.
 * @param {HTMLCanvasElement} canvas
 * @param {number} depthM  — current depth in metres
 * @param {number} maxDepth
 */
export function drawDepthGauge(canvas, depthM, maxDepth = 2000) {
  const S = Math.min(canvas.clientWidth, canvas.clientHeight);
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const cx = S / 2, cy = S / 2, R = S * 0.42;

  // Background
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = 'rgba(5,11,24,0.92)';
  ctx.beginPath();
  ctx.arc(cx, cy, R + 6, 0, Math.PI * 2);
  ctx.fill();

  // Outer rim glow
  const rimGrad = ctx.createRadialGradient(cx, cy, R - 4, cx, cy, R + 6);
  rimGrad.addColorStop(0, 'rgba(99,230,190,0.5)');
  rimGrad.addColorStop(1, 'rgba(99,230,190,0)');
  ctx.fillStyle = rimGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, R + 6, 0, Math.PI * 2);
  ctx.fill();

  // Tick marks (arc from 210° to -30°, 0 at top = 270°... map 0→210 depth→-30)
  const startAngle = (210 / 180) * Math.PI;
  const endAngle   = (-30 / 180) * Math.PI;  // = 330°
  const sweepAngle = (300 / 180) * Math.PI;

  const nMajor = 10;
  for (let i = 0; i <= nMajor; i++) {
    const a = startAngle + (i / nMajor) * sweepAngle;
    const isMajor = i % 2 === 0;
    const innerR = isMajor ? R * 0.75 : R * 0.82;
    ctx.strokeStyle = isMajor ? 'rgba(99,230,190,0.8)' : 'rgba(99,230,190,0.4)';
    ctx.lineWidth = isMajor ? 1.5 : 0.8;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * innerR, cy + Math.sin(a) * innerR);
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.stroke();

    if (isMajor) {
      const depthLabel = Math.round((i / nMajor) * maxDepth);
      const lx = cx + Math.cos(a) * (R * 0.64);
      const ly = cy + Math.sin(a) * (R * 0.64);
      ctx.fillStyle = 'rgba(99,230,190,0.6)';
      ctx.font = `${S * 0.065}px 'IBM Plex Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(depthLabel >= 1000 ? `${depthLabel/1000}k` : depthLabel, lx, ly);
    }
  }

  // Sonar sweep arcs (ambient decoration)
  for (let ri = 0; ri < 3; ri++) {
    const rFrac = 0.3 + ri * 0.18;
    ctx.strokeStyle = `rgba(99,230,190,${0.06 - ri * 0.015})`;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.arc(cx, cy, R * rFrac, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Needle
  const t = clamp(depthM / maxDepth, 0, 1);
  const needleAngle = startAngle + t * sweepAngle;
  const nx = cx + Math.cos(needleAngle) * R * 0.72;
  const ny = cy + Math.sin(needleAngle) * R * 0.72;

  const needleGrad = ctx.createLinearGradient(cx, cy, nx, ny);
  needleGrad.addColorStop(0, 'rgba(99,230,190,0)');
  needleGrad.addColorStop(1, '#63e6be');
  ctx.strokeStyle = needleGrad;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(nx, ny);
  ctx.stroke();

  // Center pip
  ctx.fillStyle = 'rgba(99,230,190,0.75)';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();

  // Readout. The label sits above the value so the two never collide as the
  // value grows from "0m" to "2.0km".
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.font = `500 ${S * 0.068}px Geist, system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(223,240,239,0.42)';
  ctx.fillText('DEPTH', cx, cy + R * 0.26);

  ctx.fillStyle = '#dff0ef';
  ctx.font = `600 ${S * 0.145}px 'IBM Plex Mono', monospace`;
  ctx.fillText(depthM < 1000 ? `${Math.round(depthM)} m` : `${(depthM/1000).toFixed(2)} km`, cx, cy + R * 0.48);
}
