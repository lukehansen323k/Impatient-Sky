// Impatient Sky — compute worker. Several of these run in parallel for pass
// searches; one more drives the live AR view.
import { buildSats, nightPasses, liveSky, resetLive, LIVE_STRIDE } from './passes.js';
import { Observer } from './astro.js';

let sats = [];
let offset = 0;          // index of our first satellite in the full catalog
let liveObs = null;

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'catalog') {
      sats = buildSats(m.catalog);
      offset = m.offset || 0;
      self.postMessage({ type: 'ready', id: m.id, count: sats.length });
    } else if (m.type === 'night') {
      const t = performance.now();
      const { passes, tested } = nightPasses(sats, m.lat, m.lon, m.hKm, m.win, m.opts);
      self.postMessage({ type: 'night', id: m.id, passes, tested, ms: performance.now() - t });
    } else if (m.type === 'live-start') {
      liveObs = new Observer(m.lat, m.lon, m.hKm);
      resetLive(sats);
      self.postMessage({ type: 'live-ok', id: m.id });
    } else if (m.type === 'live') {
      if (!liveObs) return;
      const rows = liveSky(sats, liveObs, m.t, m.opts, m.maxMag);
      // translate local indexes to catalog ids for the page
      const ids = new Int32Array(rows.length / LIVE_STRIDE);
      for (let k = 0; k < ids.length; k++) ids[k] = sats[rows[k * LIVE_STRIDE]].id;
      self.postMessage({ type: 'live', id: m.id, t: m.t, rows, ids }, [rows.buffer, ids.buffer]);
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, message: String(e && e.stack || e) });
  }
};
