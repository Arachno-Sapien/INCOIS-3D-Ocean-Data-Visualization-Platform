/**
 * main.js — Application entry point
 *
 * Boots the scene, wires up the UI, connects click handling.
 * Error handling is done directly via DOM (no dependency on ui.js DOM cache).
 */

import { initScene, handleCanvasClick } from './scene.js';
import { initUI } from './ui.js';

// ---------------------------------------------------------------------------
// Helpers — work directly on DOM so they don't need ui.js to be initialised
// ---------------------------------------------------------------------------

function showLoadingMsg(msg) {
  const el = document.querySelector('#loading-overlay .loading-msg');
  if (el) el.textContent = msg;
}

function showError(msg) {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) {
    const msgEl = overlay.querySelector('.loading-msg');
    if (msgEl) {
      msgEl.textContent = msg;
      msgEl.style.color = '#ff6b4a';
      msgEl.style.maxWidth = '420px';
      msgEl.style.textAlign = 'center';
      msgEl.style.lineHeight = '1.6';
    }
    // Stop sonar animation
    overlay.querySelectorAll('.sonar-ring').forEach(r => r.style.animation = 'none');
  }
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) {
    overlay.style.transition = 'opacity 0.6s';
    overlay.style.opacity = '0';
    overlay.style.pointerEvents = 'none';
    setTimeout(() => overlay.classList.add('hidden'), 700);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const canvas = document.getElementById('ocean-canvas');

  // ── WebGL2 check ──
  const testCtx = document.createElement('canvas').getContext('webgl2');
  if (!testCtx) {
    document.getElementById('webgl-error').classList.remove('hidden');
    document.getElementById('loading-overlay').classList.add('hidden');
    return;
  }

  // Resize canvas to fill window BEFORE passing to Three.js
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;

  try {
    showLoadingMsg('Loading Three.js and CDN modules…');
    await initScene(canvas);

    showLoadingMsg('Building UI…');
    initUI((event) => handleCanvasClick(event, canvas));

    // Small delay to let the first frame render before hiding overlay
    await new Promise(r => setTimeout(r, 120));
    hideLoadingOverlay();

  } catch (err) {
    console.error('[INCOIS] Boot error:', err);

    // Show human-readable error
    let message = err?.message || String(err);
    if (message.includes('Failed to fetch') || message.includes('NetworkError') || message.includes('import')) {
      message = 'Could not load Three.js from CDN. Check your internet connection and refresh.';
    } else if (message.includes('WebGL')) {
      message = 'WebGL2 initialisation failed. Try updating your browser or graphics drivers.';
    }

    showError(`⚠ Loading failed: ${message}\n\nOpen DevTools (F12 → Console) for full details.`);
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
