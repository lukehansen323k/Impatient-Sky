#!/usr/bin/env node
// Impatient Sky — data builder.
// Runs in the GitHub Action every 2 hours. Pulls current orbital elements and
// intrinsic brightness data, merges them into one compact catalog the phone
// downloads (data/catalog.json) plus a tiny data/meta.json it polls.
//
//   Orbital elements : CelesTrak GP (OMM JSON). Optional Space-Track full catalog
//                      if SPACETRACK_USER / SPACETRACK_PASS secrets are set.
//   Brightness       : Mike McCants' qs.mag intrinsic magnitudes (1000 km, full phase),
//                      CelesTrak SATCAT radar cross-section as a fallback estimate,
//                      and published constellation photometry for Starlink & co.
//
// Env:
//   DATA_DIR        output folder (default ./data)
//   CACHE_DIR       slow-changing downloads (default ./.cache)
//   PREVIOUS_URL    URL of the currently deployed catalog.json, used as a fallback
//                   if a source is down (default: none)
//   OFFLINE=1       skip network, rebuild from cache/previous only (testing)

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA_DIR = process.env.DATA_DIR || 'data';
const CACHE_DIR = process.env.CACHE_DIR || '.cache';
const PREVIOUS_URL = process.env.PREVIOUS_URL || '';
const OFFLINE = process.env.OFFLINE === '1';
const UA = 'ImpatientSky/1.0 (+https://github.com/lukehansen323k/impatient-sky)';

const MU = 398600.4418;       // km^3/s^2
const RE = 6378.137;          // km
const MAX_STD_MAG_KEEP = 7.6; // anything that can never beat mag ~7.5 is dropped
const MAX_EPOCH_AGE_D = 21;   // elements older than this are stale
const CELESTRAK_GROUPS = ['visual', 'stations', 'active', 'last-30-days'];

const log = (...a) => console.log('[data]', ...a);

async function fetchText(url, { tries = 3, headers = {}, timeoutMs = 120000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      last = e;
      log(`  ${url} failed (${e.message}), try ${i + 1}/${tries}`);
      await new Promise((res) => setTimeout(res, 4000 * (i + 1)));
    }
  }
  throw last;
}

async function readJson(p, fallback = null) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}

async function fileAgeHours(p) {
  try { const s = await fs.stat(p); return (Date.now() - s.mtimeMs) / 3.6e6; } catch { return Infinity; }
}

// ---------------------------------------------------------------- elements

async function celestrakGroups() {
  const out = new Map();
  const status = {};
  for (const g of CELESTRAK_GROUPS) {
    const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=json`;
    try {
      const txt = await fetchText(url);
      if (!txt.trim().startsWith('[')) throw new Error(txt.slice(0, 120));
      const arr = JSON.parse(txt);
      for (const o of arr) mergeOmm(out, o, g);
      status[g] = arr.length;
      log(`celestrak ${g}: ${arr.length}`);
    } catch (e) {
      status[g] = `error: ${e.message}`;
    }
    await new Promise((r) => setTimeout(r, 1500)); // be polite
  }
  return { map: out, status };
}

async function spaceTrack() {
  const user = process.env.SPACETRACK_USER, pass = process.env.SPACETRACK_PASS;
  if (!user || !pass) return null;
  const base = 'https://www.space-track.org';
  const login = await fetch(`${base}/ajaxauth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({ identity: user, password: pass }),
  });
  if (!login.ok) throw new Error(`space-track login HTTP ${login.status}`);
  const cookie = (login.headers.getSetCookie?.() || [login.headers.get('set-cookie')]).filter(Boolean)
    .map((c) => c.split(';')[0]).join('; ');
  // Every object with a recent element set that isn't geosynchronous-or-higher.
  const q = `${base}/basicspacedata/query/class/gp/decay_date/null-val/epoch/%3Enow-14/MEAN_MOTION/%3E1.5/format/json`;
  const txt = await fetchText(q, { headers: { Cookie: cookie }, timeoutMs: 300000, tries: 2 });
  const arr = JSON.parse(txt);
  const map = new Map();
  for (const o of arr) mergeOmm(map, o, 'spacetrack');
  log(`space-track: ${arr.length}`);
  return map;
}

function mergeOmm(map, o, src) {
  const id = Number(o.NORAD_CAT_ID);
  if (!id || !o.EPOCH || !o.MEAN_MOTION) return;
  const prev = map.get(id);
  if (prev && prev.EPOCH >= o.EPOCH) { prev._groups.add(src); return; }
  const rec = {
    NORAD_CAT_ID: id,
    OBJECT_NAME: String(o.OBJECT_NAME || '').trim(),
    OBJECT_ID: o.OBJECT_ID || '',
    OBJECT_TYPE: o.OBJECT_TYPE || '',
    RCS_SIZE: o.RCS_SIZE || '',
    EPOCH: o.EPOCH,
    MEAN_MOTION: Number(o.MEAN_MOTION),
    ECCENTRICITY: Number(o.ECCENTRICITY),
    INCLINATION: Number(o.INCLINATION),
    RA_OF_ASC_NODE: Number(o.RA_OF_ASC_NODE),
    ARG_OF_PERICENTER: Number(o.ARG_OF_PERICENTER),
    MEAN_ANOMALY: Number(o.MEAN_ANOMALY),
    BSTAR: Number(o.BSTAR),
    MEAN_MOTION_DOT: Number(o.MEAN_MOTION_DOT),
    MEAN_MOTION_DDOT: Number(o.MEAN_MOTION_DDOT),
    _groups: new Set([src, ...(prev?._groups || [])]),
  };
  map.set(id, rec);
}

// ---------------------------------------------------------------- magnitudes

// qs.mag columns are fixed-width; locate "Mag." from the header line so a
// future layout change (6-digit catalog numbers) doesn't break parsing.
export function parseQsMag(text) {
  const mags = new Map();
  const lines = text.split(/\r?\n/);
  let magCol = 33;
  for (const line of lines) {
    const h = line.indexOf('Mag.');
    if (h > 0 && /Name/.test(line)) { magCol = h; break; }
  }
  for (const line of lines) {
    const m = /^\s*(\d{1,6})\s/.exec(line);
    if (!m || line.includes('Mag.')) continue;
    const field = line.slice(magCol - 1, magCol + 5).trim();
    const v = parseFloat(field);
    if (!Number.isFinite(v) || v < -6 || v > 16) continue;
    mags.set(Number(m[1]), v);
  }
  return mags;
}

async function loadQsMag() {
  const cached = path.join(CACHE_DIR, 'qs.mag');
  if (!OFFLINE && (await fileAgeHours(cached)) > 20) {
    try {
      const r = await fetch('https://www.mmccants.org/programs/qsmag.zip', { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const zip = path.join(CACHE_DIR, 'qsmag.zip');
      await fs.writeFile(zip, Buffer.from(await r.arrayBuffer()));
      const txt = execFileSync('unzip', ['-p', zip], { maxBuffer: 64 << 20 }).toString('latin1');
      if (parseQsMag(txt).size < 1000) throw new Error('qs.mag looks truncated');
      await fs.writeFile(cached, txt);
      log('qs.mag refreshed');
    } catch (e) {
      log(`qs.mag download failed (${e.message}); using cache`);
    }
  }
  try { return parseQsMag(await fs.readFile(cached, 'latin1')); } catch { return new Map(); }
}

// SATCAT gives object type and (for older objects) a numeric radar cross-section.
async function loadSatcat() {
  const cached = path.join(CACHE_DIR, 'satcat-lite.json');
  if (!OFFLINE && (await fileAgeHours(cached)) > 20) {
    try {
      const csv = await fetchText('https://celestrak.org/pub/satcat.csv', { timeoutMs: 300000, tries: 2 });
      const lines = csv.split(/\r?\n/);
      const head = lines[0].split(',');
      const iId = head.indexOf('NORAD_CAT_ID'), iType = head.indexOf('OBJECT_TYPE'),
        iRcs = head.indexOf('RCS'), iDecay = head.indexOf('DECAY_DATE');
      const lite = {};
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(',');
        if (c.length < head.length || (iDecay >= 0 && c[iDecay])) continue;
        const rcs = parseFloat(c[iRcs]);
        lite[c[iId]] = [c[iType] || '', Number.isFinite(rcs) ? rcs : null];
      }
      if (Object.keys(lite).length < 5000) throw new Error('satcat looks truncated');
      await fs.writeFile(cached, JSON.stringify(lite));
      log(`satcat refreshed: ${Object.keys(lite).length}`);
    } catch (e) {
      log(`satcat download failed (${e.message}); using cache`);
    }
  }
  return (await readJson(cached, {})) || {};
}

// Published photometry (Mallama et al. 2025, "Satellite constellations exceed the
// limits of acceptable brightness") gives mean 1000-km magnitudes. Mean values are
// roughly 1.4 mag fainter than McCants' "full phase, brightest likely" convention,
// so we convert to keep one scale.
const MEAN_TO_MCCANTS = -1.4;
const CONSTELLATION_RULES = [
  [/^STARLINK.*(DTC|DIRECT)/i, 6.47],
  [/^STARLINK/i, 7.15],
  [/^ONEWEB/i, 7.05],
  [/^(QIANFAN|G60)/i, 5.24],
  [/^(BLUEBIRD|BLUE WALKER|BW3|SPACEMOBILE)/i, 3.77],
  [/^(GUOWANG|HULIANWANG|SATNET)/i, 4.21],
  [/^KUIPER/i, 6.7], // no published survey yet; assumed similar to Starlink Mini
];

// Hand-set values (McCants scale) for bright objects qs.mag doesn't cover yet.
const OVERRIDES = {
  48274: -0.5, // CSS (Tianhe) with Wentian & Mengtian docked; observed to about mag -2.5
  59588: 2.0,  // ACS3 solar sail (80 m^2)
};

export function assignMagnitude(rec, qs, satcat) {
  const id = rec.NORAD_CAT_ID;
  if (id in OVERRIDES) return [OVERRIDES[id], 'O'];
  if (qs.has(id)) return [qs.get(id), 'Q'];
  for (const [re, m] of CONSTELLATION_RULES) if (re.test(rec.OBJECT_NAME)) return [+(m + MEAN_TO_MCCANTS).toFixed(2), 'C'];
  const sc = satcat[String(id)];
  if (sc && sc[1] > 0) return [+(6.29 - 2.5 * Math.log10(sc[1])).toFixed(2), 'R']; // fit to qs.mag vs RCS
  const size = (rec.RCS_SIZE || '').toUpperCase();
  if (size === 'LARGE') return [5.5, 'S'];
  if (size === 'MEDIUM') return [7.5, 'S'];
  if (size === 'SMALL') return [9.0, 'S'];
  // CelesTrak's "visual" group is curated from the brightest objects.
  if (rec._groups?.has('visual')) return [4.0, 'V'];
  const type = (rec.OBJECT_TYPE || sc?.[0] || '').toUpperCase();
  if (type.startsWith('R')) return [5.5, 'D'];       // rocket body
  if (type.startsWith('DEB') || type === 'DEBRIS') return [8.5, 'D'];
  return [7.0, 'D'];                                   // unknown payload
}

function perigeeKm(rec) {
  const n = (rec.MEAN_MOTION * 2 * Math.PI) / 86400; // rad/s
  const a = Math.cbrt(MU / (n * n));
  return a * (1 - rec.ECCENTRICITY) - RE;
}

const typeCode = (t) => {
  t = (t || '').toUpperCase();
  return t.startsWith('PAY') ? 'P' : t.startsWith('R') ? 'R' : t.startsWith('DEB') ? 'D' : 'U';
};

// ---------------------------------------------------------------- previous catalog

async function loadPrevious() {
  const local = await readJson(path.join(DATA_DIR, 'catalog.json'));
  if (local?.sats?.length) return local;
  if (!PREVIOUS_URL || OFFLINE) return null;
  try { return JSON.parse(await fetchText(PREVIOUS_URL, { tries: 1 })); } catch { return null; }
}

function previousToMap(prev) {
  const map = new Map();
  if (!prev?.sats) return map;
  const f = prev.fields;
  const ix = Object.fromEntries(f.map((k, i) => [k, i]));
  for (const s of prev.sats) {
    map.set(s[ix.id], {
      NORAD_CAT_ID: s[ix.id], OBJECT_NAME: s[ix.name], OBJECT_ID: s[ix.cospar] || '', OBJECT_TYPE: s[ix.type],
      EPOCH: s[ix.epoch], MEAN_MOTION: s[ix.n], ECCENTRICITY: s[ix.e], INCLINATION: s[ix.i],
      RA_OF_ASC_NODE: s[ix.raan], ARG_OF_PERICENTER: s[ix.argp], MEAN_ANOMALY: s[ix.ma], BSTAR: s[ix.bstar],
      MEAN_MOTION_DOT: s[ix.ndot], MEAN_MOTION_DDOT: s[ix.nddot], RCS_SIZE: '', _groups: new Set(['previous']),
      _prevMag: [s[ix.mag], s[ix.msrc]],
    });
  }
  return map;
}

// ---------------------------------------------------------------- main

const FIELDS = ['id', 'name', 'cospar', 'type', 'epoch', 'n', 'e', 'i', 'raan', 'argp', 'ma', 'bstar', 'ndot', 'nddot', 'mag', 'msrc', 'grp'];

function round(x, d) { const p = 10 ** d; return Math.round(x * p) / p; }
function sig(x, s = 6) { return x === 0 ? 0 : Number(x.toPrecision(s)); }

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const started = new Date();

  const prev = await loadPrevious();
  const merged = previousToMap(prev);
  const sources = { previous: merged.size };

  if (!OFFLINE) {
    const ct = await celestrakGroups();
    sources.celestrak = ct.status;
    for (const rec of ct.map.values()) {
      const old = merged.get(rec.NORAD_CAT_ID);
      if (!old || old.EPOCH <= rec.EPOCH) merged.set(rec.NORAD_CAT_ID, rec);
      else old._groups = new Set([...old._groups, ...rec._groups]);
    }
    try {
      const st = await spaceTrack();
      if (st) {
        sources.spacetrack = st.size;
        for (const rec of st.values()) {
          const old = merged.get(rec.NORAD_CAT_ID);
          if (!old || old.EPOCH < rec.EPOCH) {
            if (old) rec._groups = new Set([...old._groups, ...rec._groups]);
            merged.set(rec.NORAD_CAT_ID, rec);
          }
        }
      }
    } catch (e) { sources.spacetrack = `error: ${e.message}`; log(sources.spacetrack); }
  }

  const fresh = [...merged.values()].some((r) => !r._groups.has('previous') || r._groups.size > 1);
  if (!fresh && prev) log('no source answered; republishing previous catalog');

  const qs = await loadQsMag();
  const satcat = await loadSatcat();
  sources.qsmag = qs.size;
  sources.satcat = Object.keys(satcat).length;

  // Docked vehicles (Soyuz, Dragon, Tianzhou, station modules...) share their
  // station's element set; keep one object per identical orbit.
  const orbitKey = (r) => `${r.MEAN_MOTION.toFixed(6)}|${r.RA_OF_ASC_NODE.toFixed(3)}|${((r.ARG_OF_PERICENTER + r.MEAN_ANOMALY) % 360).toFixed(2)}|${r.EPOCH}`;
  const PRIMARY = new Set([25544, 48274]);
  const seen = new Set();
  let docked = 0;
  const ordered = [...merged.values()].sort((a, b) =>
    (PRIMARY.has(b.NORAD_CAT_ID) - PRIMARY.has(a.NORAD_CAT_ID)) || a.NORAD_CAT_ID - b.NORAD_CAT_ID);
  for (const rec of ordered) {
    const k = orbitKey(rec);
    if (seen.has(k)) { merged.delete(rec.NORAD_CAT_ID); docked++; continue; }
    seen.add(k);
  }

  const now = Date.now();
  const rows = [];
  const counts = { kept: 0, stale: 0, faint: 0, decaying: 0, geo: 0, docked };
  let newestEpoch = '';
  for (const rec of merged.values()) {
    const epochMs = Date.parse(rec.EPOCH.endsWith('Z') ? rec.EPOCH : rec.EPOCH + 'Z');
    if (!Number.isFinite(epochMs) || (now - epochMs) / 864e5 > MAX_EPOCH_AGE_D) { counts.stale++; continue; }
    const hp = perigeeKm(rec);
    if (hp < 130) { counts.decaying++; continue; }
    if (rec.MEAN_MOTION < 1.2) { counts.geo++; continue; } // geosynchronous objects never pass
    let [mag, msrc] = assignMagnitude(rec, qs, satcat);
    if ((msrc === 'D' || msrc === 'V') && rec._prevMag && rec._prevMag[1] === 'Q') [mag, msrc] = rec._prevMag; // qs.mag temporarily unavailable
    const best = mag + 5 * Math.log10(Math.max(hp, 150) / 1000);
    if (best > MAX_STD_MAG_KEEP) { counts.faint++; continue; }
    if (rec.EPOCH > newestEpoch) newestEpoch = rec.EPOCH;
    const g = rec._groups;
    const grp = /^STARLINK/i.test(rec.OBJECT_NAME) ? 'starlink'
      : /^(ONEWEB|KUIPER|QIANFAN|G60|GUOWANG|HULIANWANG|SATNET)/i.test(rec.OBJECT_NAME) ? 'mega'
      : g.has('stations') ? 'station' : g.has('visual') ? 'visual' : '';
    rows.push([
      rec.NORAD_CAT_ID, rec.OBJECT_NAME, rec.OBJECT_ID, typeCode(rec.OBJECT_TYPE || satcat[String(rec.NORAD_CAT_ID)]?.[0]),
      rec.EPOCH, round(rec.MEAN_MOTION, 8), round(rec.ECCENTRICITY, 7), round(rec.INCLINATION, 4),
      round(rec.RA_OF_ASC_NODE, 4), round(rec.ARG_OF_PERICENTER, 4), round(rec.MEAN_ANOMALY, 4),
      sig(rec.BSTAR), sig(rec.MEAN_MOTION_DOT), sig(rec.MEAN_MOTION_DDOT), round(mag, 2), msrc, grp,
    ]);
    counts.kept++;
  }
  rows.sort((a, b) => a[14] - b[14] || a[0] - b[0]);

  const version = started.toISOString().replace(/[-:]/g, '').slice(0, 13) + 'Z';
  const catalog = { v: version, built: started.toISOString(), fields: FIELDS, sats: rows };
  const json = JSON.stringify(catalog);
  await fs.writeFile(path.join(DATA_DIR, 'catalog.json'), json);
  const meta = {
    v: version, built: started.toISOString(), count: rows.length, newestEpoch, bytes: json.length,
    sources, counts,
    note: 'Elements: CelesTrak (and Space-Track if configured). Intrinsic magnitudes: M. McCants qs.mag; constellation values from Mallama et al. 2025.',
  };
  await fs.writeFile(path.join(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 1));
  log(`wrote ${rows.length} objects (${(json.length / 1e6).toFixed(2)} MB)`, counts, sources);
  if (!rows.length) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
