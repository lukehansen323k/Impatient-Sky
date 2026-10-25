// Node check of the pass engine against real data.
//   node test/engine-test.mjs [lat] [lon] [limit] [dayOffset]
import fs from 'node:fs';
import { buildSats, nightPasses } from '../js/passes.js';
import { Observer, darkWindow, DEG, compass } from '../js/astro.js';

const lat = +(process.argv[2] ?? 39.744), lon = +(process.argv[3] ?? -83.809);
const limit = +(process.argv[4] ?? 3.5), dayOff = +(process.argv[5] ?? 0);
const catalog = JSON.parse(fs.readFileSync(new URL('../data/catalog.json', import.meta.url)));

let t = performance.now();
const sats = buildSats(catalog);
console.log(`init ${sats.length} sats in ${(performance.now() - t).toFixed(0)} ms`);

// local noon for the evening of interest (machine runs UTC; compute noon at lon)
const now = new Date();
const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + dayOff * 864e5;
const noon = base + (12 - lon / 15) * 3.6e6 - (now.getUTCHours() < 12 - lon / 15 ? 864e5 : 0);
const obs = new Observer(lat, lon, 0.3);
const win = darkWindow(obs, noon, -6);
console.log('dark window', new Date(win.start).toISOString(), '→', new Date(win.end).toISOString());

const opts = { limit, minEl: 10 * DEG, sunAltMax: -6 * DEG, extinction: 0 };
t = performance.now();
const { passes, tested } = nightPasses(sats, lat, lon, 0.3, win, opts);
console.log(`passes ${passes.length} (tested ${tested} sats) in ${(performance.now() - t).toFixed(0)} ms`);
const fmt = (ms) => new Date(ms - 4 * 3.6e6).toISOString().slice(11, 19); // EDT display
for (const p of passes.filter((p) => p.mag <= Math.min(limit, 3) || /ISS|CSS|HST/.test(p.name)).slice(0, 60)) {
  console.log(`${fmt(p.start.t)} ${p.name.padEnd(22)} ${String(p.mag).padStart(5)}  start ${p.start.el}° ${compass(p.start.az * DEG).padEnd(3)} | max ${fmt(p.peak.t)} ${p.peak.el}° ${compass(p.peak.az * DEG).padEnd(3)} | end ${fmt(p.end.t)} ${p.end.el}° ${compass(p.end.az * DEG).padEnd(3)} ${p.startWhy}/${p.endWhy}`);
}
const byGrp = {};
for (const p of passes) byGrp[p.grp || 'other'] = (byGrp[p.grp || 'other'] || 0) + 1;
console.log(byGrp);
