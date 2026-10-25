// Impatient Sky — app shell: data, location, pass tables, settings, detail sheet.
import { Engine } from './engine.js';
import { Observer, darkWindow, DEG, compass, jdFromMs, moonEci, sunEci, moonPhase, look } from './astro.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MINUS = '−';

// ------------------------------------------------------------------ settings
const DEFAULTS = {
  limit: 3.5, minEl: 10, sunAlt: -6, starlink: true, mega: true, extinction: true,
  h24: false, red: false, glass: 0.35, camera: true, fov: 67, showShadow: false, yawTrim: 0,
  manual: null, // {lat, lon, alt}
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('isky.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('isky.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const S = {
  settings: { ...DEFAULTS, ...store.get('settings', {}) },
  loc: store.get('loc', null),
  meta: null,
  catalog: null,
  byId: new Map(),
  nights: [],
  nightsBase: '',
  runId: 0,
  computedLimit: null,
  view: 'tonight',
  sort: 'time',
  weekSel: 0,
  showPast: false,
  shown: { t: 150, w: 150 },
  error: null,
  busy: false,
};
const saveSettings = () => store.set('settings', S.settings);

const engine = new Engine();
window.__isky = S; // handy for debugging from the console

// ------------------------------------------------------------------ formatting
const tf = () => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hour12: !S.settings.h24 });
const tfs = () => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: !S.settings.h24 });
const fmtT = (ms) => tf().format(ms).replace(/\s?([AP]M)/i, ' $1');
const fmtTs = (ms) => tfs().format(ms).replace(/\s?([AP]M)/i, ' $1');
const fmtMag = (m) => (m < 0 ? MINUS + Math.abs(m).toFixed(1) : m.toFixed(1));
const fmtDur = (ms) => { const s = Math.round(ms / 1000); const m = Math.floor(s / 60); return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
const magClass = (m) => (m <= -1 ? 'm0' : m <= 1.5 ? 'm1' : m <= 3 ? 'm2' : m <= 4.5 ? 'm3' : 'm4');
// "HULIANWANG DIGUI-155" → "Guowang 155", "COSMOS 2455" → "Cosmos 2455", keeps "SL-16 R/B", "CZ-2C R/B"
const NAME_FIX = [
  [/^ISS \(ZARYA\)$/, 'ISS'], [/^CSS \(TIANHE\)$/, 'Tiangong'], [/^HST$/, 'Hubble'],
  [/^HULIANWANG DIGUI-?/, 'GUOWANG '], [/^HULIANWANG JISHU SHIYAN\s*/, 'HULIANWANG TEST '],
  [/^STARLINK-/, 'STARLINK '], [/^QIANFAN-/, 'QIANFAN '], [/^SPACEMOBILE-/, 'BLUEBIRD '],
];
const prettyCache = new Map();
function pretty(name) {
  if (prettyCache.has(name)) return prettyCache.get(name);
  let s = name.replace(/\s+\[.*?\]/, '');
  for (const [re, to] of NAME_FIX) s = s.replace(re, to);
  s = s.split(' ').map((w) => {
    const letters = w.replace(/[^A-Z]/g, '').length;
    if (/[0-9/]/.test(w) && letters <= 4) return w;            // SL-16, R/B, 4B, CZ-2C, IRS-P6
    if (w.length <= 4 && !/^(THE|AND|TEST|BLUE|STAR|SAT)$/.test(w)) return w; // ISS, NOAA, AQUA, HXMT
    return w.toLowerCase().replace(/(^|[-(])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }).join(' ').trim();
  prettyCache.set(name, s);
  return s;
}
const dirText = (p) => `${compass(p.start.az * DEG)} → ${compass(p.end.az * DEG)}`;
const dayFmt = (ms, o) => new Intl.DateTimeFormat(undefined, o).format(ms);
function countdown(ms) {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(r).padStart(2, '0')}`;
}
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
const TYPE = { P: 'Satellite', R: 'Rocket body', D: 'Debris', U: 'Object' };
const MSRC = {
  Q: 'McCants catalog', C: 'constellation photometry', R: 'estimated from radar size', S: 'estimated from size class',
  O: 'observed brightness', V: 'listed among brightest', D: 'assumed (no data)',
};

// ------------------------------------------------------------------ glass & theme
function applyAppearance() {
  const g = S.settings.glass; // 0 clear … 1 tinted
  const r = document.documentElement.style;
  r.setProperty('--g-top', `rgba(255,255,255,${(0.13 - 0.07 * g).toFixed(3)})`);
  r.setProperty('--g-bot', `rgba(255,255,255,${(0.05 - 0.03 * g).toFixed(3)})`);
  r.setProperty('--g-tint', `rgba(14,20,42,${(0.08 + 0.72 * g).toFixed(3)})`);
  r.setProperty('--g-blur', `${Math.round(12 + 22 * g)}px`);
  r.setProperty('--g-spec', `rgba(255,255,255,${(0.36 - 0.14 * g).toFixed(3)})`);
  document.documentElement.classList.toggle('red', !!S.settings.red);
}

function drawStarfield() {
  const c = $('#starfield');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = innerWidth, h = innerHeight;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < Math.round((w * h) / 2600); i++) {
    const x = rnd() * w, y = rnd() * h * 0.95, m = rnd();
    const r = m > 0.985 ? 1.4 : m > 0.9 ? 0.9 : 0.55;
    g.globalAlpha = 0.25 + rnd() * (m > 0.9 ? 0.7 : 0.35);
    g.fillStyle = m > 0.97 ? '#cfe0ff' : m > 0.94 ? '#ffe9c7' : '#ffffff';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
}

// ------------------------------------------------------------------ location
function haversineKm(a, b) {
  const dl = (b.lat - a.lat) * DEG, dn = (b.lon - a.lon) * DEG;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dn / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
function currentLoc() {
  const m = S.settings.manual;
  if (m) return { lat: m.lat, lon: m.lon, alt: (m.alt || 0) / 1000, source: 'manual' };
  return S.loc;
}
function requestGps(quiet = false) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c = pos.coords;
        const loc = { lat: c.latitude, lon: c.longitude, alt: Number.isFinite(c.altitude) ? c.altitude / 1000 : 0.2, acc: c.accuracy, ts: Date.now(), source: 'gps' };
        const prev = S.loc;
        S.loc = loc; store.set('loc', loc);
        S.error = S.error === 'location' ? null : S.error;
        resolve(loc);
        if (!S.settings.manual && (!prev || haversineKm(prev, loc) > 3)) recompute();
        else renderAll();
      },
      (err) => {
        if (!S.loc && !quiet) { S.error = 'location'; renderAll(); }
        resolve(null);
        console.warn('geolocation', err.message);
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60000 },
    );
  });
}

// ------------------------------------------------------------------ data
async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
async function loadData(force = false) {
  const meta = await fetchJson(`data/meta.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!force && S.catalog && S.catalog.v === meta.v) { S.meta = meta; return false; }
  const catalog = await fetchJson(`data/catalog.json?v=${meta.v}`);
  S.meta = meta;
  S.catalog = catalog;
  const ix = Object.fromEntries(catalog.fields.map((k, i) => [k, i]));
  S.byId = new Map(catalog.sats.map((r) => [r[ix.id], {
    id: r[ix.id], name: r[ix.name], cospar: r[ix.cospar], type: r[ix.type], M: r[ix.mag], msrc: r[ix.msrc], grp: r[ix.grp],
    n: r[ix.n], e: r[ix.e], i: r[ix.i], epoch: r[ix.epoch],
  }]));
  await engine.load(catalog);
  return true;
}

// ------------------------------------------------------------------ nights
function tonightNoon(loc, now = Date.now()) {
  // local *solar* noon at the observer, so this works for any location/time zone
  const off = (loc.lon / 15) * 3.6e6;
  const solar = now + off;
  let day = Math.floor(solar / 864e5);
  const hour = (solar - day * 864e5) / 3.6e6;
  if (hour < 12) day -= 1;
  return day * 864e5 + 12 * 3.6e6 - off;
}
function passOpts(limit) {
  const st = S.settings;
  const skip = [];
  if (!st.starlink) skip.push('starlink');
  if (!st.mega) skip.push('mega');
  return { limit, minEl: st.minEl * DEG, sunAltMax: st.sunAlt * DEG, extinction: st.extinction ? 0.2 : 0, skipGroups: skip };
}

let recomputeTimer = 0;
function recompute(delay = 0) {
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(runNights, delay);
}

async function runNights() {
  const loc = currentLoc();
  if (!loc || !S.catalog) { renderAll(); return; }
  const st = S.settings;
  const base = baseKey(loc);
  // Lowering the limit only filters what's already computed; anything else recomputes.
  if (S.nights.length && S.nightsBase === base && st.limit <= S.computedLimit) { renderAll(); return; }
  const run = ++S.runId;
  S.nightsBase = base;
  S.computedLimit = st.limit;
  const obs = new Observer(loc.lat, loc.lon, loc.alt || 0);
  const noon0 = tonightNoon(loc);
  const prevSel = S.nights[S.weekSel]?.noon;
  S.nights = Array.from({ length: 7 }, (_, i) => {
    const noon = noon0 + i * 864e5;
    return { i, noon, win: darkWindow(obs, noon, st.sunAlt), passes: null, ms: 0 };
  });
  if (prevSel !== undefined) S.weekSel = Math.max(0, S.nights.findIndex((n) => n.noon === prevSel));
  S.busy = true;
  renderAll();
  const opts = passOpts(st.limit);
  for (const night of S.nights) {
    if (S.runId !== run) return; // superseded by newer settings/data
    if (night.win.neverDark) { night.passes = []; renderAll(); continue; }
    try {
      const res = await engine.night({ lat: loc.lat, lon: loc.lon, hKm: loc.alt || 0, win: { start: night.win.start, end: night.win.end }, opts });
      if (S.runId !== run) return;
      night.passes = res.passes;
      night.ms = res.ms;
      if (night.i === 0) console.info(`tonight: ${res.passes.length} passes, ${res.tested} sats searched in ${res.ms.toFixed(0)} ms`);
    } catch (e) {
      console.error(e);
      night.passes = [];
      night.error = e.message;
    }
    renderAll();
  }
  S.busy = false;
  renderAll();
}
const baseKey = (loc) => {
  const st = S.settings;
  return [S.catalog?.v, tonightNoon(loc), loc.lat.toFixed(2), loc.lon.toFixed(2), st.minEl, st.sunAlt, st.extinction, st.starlink, st.mega].join('|');
};

const visiblePasses = (night) => (night?.passes || []).filter((p) => p.mag <= S.settings.limit);

// ------------------------------------------------------------------ sky dome
function domeXY(az, el, R, cx, cy) {
  const r = (R * (90 - Math.max(el, 0))) / 90;
  return [cx + r * Math.sin(az * DEG), cy - r * Math.cos(az * DEG)];
}
function magColor(m) {
  if (m <= -1) return '#ffd977';
  if (m <= 1.5) return '#ffffff';
  if (m <= 3) return '#bcd0ff';
  if (m <= 4.5) return '#8ea3e0';
  return '#6f7ea8';
}
function skyDome(p, size = 300, labels = true) {
  const pad = labels ? 22 : 6, R = size / 2 - pad, c = size / 2;
  let s = `<svg class="skyplot" viewBox="0 0 ${size} ${size}" role="img" aria-label="Sky chart of the pass">`;
  s += `<defs><radialGradient id="dg${size}" r="0.6"><stop offset="0" stop-color="#15295a"/><stop offset="1" stop-color="#070c1c"/></radialGradient></defs>`;
  s += `<circle cx="${c}" cy="${c}" r="${R}" fill="url(#dg${size})" stroke="rgba(255,255,255,.22)"/>`;
  for (const el of [30, 60]) s += `<circle cx="${c}" cy="${c}" r="${(R * (90 - el)) / 90}" fill="none" stroke="rgba(255,255,255,.1)"/>`;
  s += `<path d="M${c} ${c - R}V${c + R}M${c - R} ${c}H${c + R}" stroke="rgba(255,255,255,.07)"/>`;
  if (labels) {
    const L = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
    for (const [t, az] of L) { const [x, y] = domeXY(az, -8, R, c, c); s += `<text x="${x}" y="${y + 4}" fill="rgba(235,238,255,.6)" font-size="12" font-weight="600" text-anchor="middle" font-family="-apple-system,system-ui">${t}</text>`; }
    s += `<text x="${c + 3}" y="${c - (R * 60) / 90 + 11}" fill="rgba(235,238,255,.3)" font-size="9" font-family="-apple-system,system-ui">30°</text>`;
    s += `<text x="${c + 3}" y="${c - (R * 30) / 90 + 11}" fill="rgba(235,238,255,.3)" font-size="9" font-family="-apple-system,system-ui">60°</text>`;
  }
  const tr = p.track;
  for (let i = 1; i < tr.length; i++) {
    const [x1, y1] = domeXY(tr[i - 1][1], tr[i - 1][2], R, c, c), [x2, y2] = domeXY(tr[i][1], tr[i][2], R, c, c);
    const w = labels ? Math.max(2, 6 - tr[i][3] * 0.8) : Math.max(1.6, 4 - tr[i][3] * 0.5);
    s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${magColor(tr[i][3])}" stroke-width="${w.toFixed(1)}" stroke-linecap="round"/>`;
  }
  const [sx, sy] = domeXY(p.start.az, p.start.el, R, c, c), [ex, ey] = domeXY(p.end.az, p.end.el, R, c, c);
  const [px, py] = domeXY(p.peak.az, p.peak.el, R, c, c);
  s += `<circle cx="${sx}" cy="${sy}" r="${labels ? 5 : 3.5}" fill="#63e6a5"/>`;
  // arrow head at end
  const a = tr.length > 1 ? domeXY(tr[tr.length - 2][1], tr[tr.length - 2][2], R, c, c) : [sx, sy];
  const ang = Math.atan2(ey - a[1], ex - a[0]);
  const ah = labels ? 9 : 6;
  s += `<path d="M${ex} ${ey}L${ex - ah * Math.cos(ang - 0.5)} ${ey - ah * Math.sin(ang - 0.5)}L${ex - ah * Math.cos(ang + 0.5)} ${ey - ah * Math.sin(ang + 0.5)}Z" fill="${p.endWhy === 'shadow' ? '#ff8a7a' : '#ffffff'}"/>`;
  if (labels) {
    s += `<circle cx="${px}" cy="${py}" r="3" fill="none" stroke="#fff" stroke-width="1.5"/>`;
    const tl = (x, y, t, dy) => `<text x="${x}" y="${y + dy}" fill="rgba(255,255,255,.85)" font-size="10.5" font-weight="600" text-anchor="middle" font-family="-apple-system,system-ui">${t}</text>`;
    s += tl(sx, sy, fmtT(p.start.t), sy < c ? 16 : -9);
    s += tl(ex, ey, fmtT(p.end.t), ey < c ? 18 : -10);
  }
  return s + '</svg>';
}

function magCurve(p) {
  const tr = p.track;
  if (tr.length < 2) return '';
  const W = 320, H = 70, t0 = tr[0][0], t1 = tr[tr.length - 1][0];
  const ms = tr.map((x) => x[3]);
  const lo = Math.min(...ms), hi = Math.max(...ms, lo + 0.5);
  const X = (t) => 8 + ((t - t0) / (t1 - t0 || 1)) * (W - 16), Y = (m) => 10 + ((m - lo) / (hi - lo)) * (H - 26);
  let d = '';
  tr.forEach((x, i) => { d += `${i ? 'L' : 'M'}${X(x[0]).toFixed(1)} ${Y(x[3]).toFixed(1)}`; });
  const bi = ms.indexOf(lo);
  return `<svg class="curve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs><linearGradient id="cg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ffd977"/><stop offset="1" stop-color="#5ea2ff"/></linearGradient></defs>
    <path d="${d}" fill="none" stroke="url(#cg)" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${X(tr[bi][0])}" cy="${Y(lo)}" r="3.5" fill="#ffd977"/>
    <text x="8" y="${H - 2}" fill="rgba(235,238,255,.45)" font-size="10" font-family="-apple-system,system-ui">brighter ↑ · peak ${fmtMag(lo)} at ${fmtTs(tr[bi][0])}</text></svg>`;
}

// ------------------------------------------------------------------ table
function rowHtml(p, now) {
  const past = p.end.t < now, live = p.start.t <= now && p.end.t >= now;
  const dur = fmtDur(p.end.t - p.start.t);
  const shadow = p.endWhy === 'shadow' ? ' · fades' : p.startWhy === 'emerges' ? ' · appears' : '';
  return `<div class="row${past ? ' past' : ''}${live ? ' now' : ''}" data-pass="${p.uid}">
    <div class="t">${fmtT(p.start.t)}<small>${dur}</small></div>
    <div class="n"><b>${esc(pretty(p.name))}</b><small>${dirText(p)}${shadow}</small></div>
    <div><span class="mag ${magClass(p.mag)}">${fmtMag(p.mag)}</span></div>
    <div class="el">${Math.round(p.peak.el)}°</div>
  </div>`;
}

function tableHtml(passes, which, opts = {}) {
  const now = Date.now();
  if (!passes.length) return '';
  let list = passes;
  if (S.sort === 'mag') list = [...passes].sort((a, b) => a.mag - b.mag);
  const head = `<div class="thead"><span>Start</span><span>Satellite</span><span>Mag</span><span>Max</span></div>`;
  let html = head;
  let rows = list;
  if (opts.splitPast && S.sort === 'time') {
    const past = list.filter((p) => p.end.t < now);
    rows = list.filter((p) => p.end.t >= now);
    if (past.length) {
      html += `<div class="group${S.showPast ? ' open' : ''}" data-toggle-past><span>Earlier tonight · ${past.length}</span><svg viewBox="0 0 24 24"><use href="#i-chev"/></svg></div>`;
      if (S.showPast) html += past.map((p) => rowHtml(p, now)).join('');
    }
  }
  const lim = S.shown[which];
  html += rows.slice(0, lim).map((p) => rowHtml(p, now)).join('');
  if (rows.length > lim) html += `<button class="more" data-more="${which}">Show ${Math.min(150, rows.length - lim)} more of ${rows.length - lim}</button>`;
  return html;
}

function skeleton(n = 6) { return `<div class="thead"><span>Start</span><span>Satellite</span><span>Mag</span><span>Max</span></div>` + '<div class="skeleton"></div>'.repeat(n); }

// ------------------------------------------------------------------ render: tonight
let uidSeq = 0;
function tagPasses() {
  for (const n of S.nights) for (const p of n.passes || []) if (!p.uid) { p.uid = ++uidSeq; p.night = n.i; }
}
function findPass(uid) {
  for (const n of S.nights) for (const p of n.passes || []) if (p.uid === uid) return p;
  return null;
}

function moonSummary(loc, win) {
  if (!win || win.neverDark) return '';
  const obs = new Observer(loc.lat, loc.lon, loc.alt || 0);
  const f = {}, la = [0, 0, 0];
  const alt = (t) => { const jd = jdFromMs(t); obs.frame(jd, f); const m = moonEci(jd); look(f, m[0], m[1], m[2], la); return la[1]; };
  const jd = jdFromMs((win.start + win.end) / 2);
  const illum = Math.round(moonPhase(sunEci(jd), moonEci(jd)) * 100);
  const step = 10 * 60000;
  const up0 = alt(win.start) > 0;
  let change = null;
  for (let t = win.start + step; t <= win.end; t += step) if ((alt(t) > 0) !== up0) { change = t; break; }
  let txt;
  if (up0 && change) txt = `sets ${fmtT(change)}`;
  else if (up0) txt = 'up all night';
  else if (change) txt = `rises ${fmtT(change)}`;
  else txt = 'below horizon';
  return `Moon ${illum}% · ${txt}`;
}

function renderTonight() {
  const loc = currentLoc();
  const night = S.nights[0];
  const now = Date.now();
  $('#t-eyebrow').textContent = loc
    ? `${dayFmt(night?.noon ?? now, { weekday: 'short', month: 'short', day: 'numeric' })} · ${Math.abs(loc.lat).toFixed(2)}°${loc.lat >= 0 ? 'N' : 'S'} ${Math.abs(loc.lon).toFixed(2)}°${loc.lon >= 0 ? 'E' : 'W'}`
    : 'Finding you…';
  $('#limit-chip').innerHTML = `brighter than <b>${fmtMag(S.settings.limit)}</b>`;

  // status banners
  let status = '';
  if (!loc && S.error === 'location') {
    status = `<div class="glass banner"><div class="bi"><svg viewBox="0 0 24 24"><use href="#i-location"/></svg></div><div>
      <b>Location needed</b><p>Passes depend on exactly where you're standing. Allow location access, or enter coordinates in Settings.</p>
      <button class="link-btn" data-act="gps">Try again</button> &nbsp; <button class="link-btn" data-act="manual">Enter manually</button></div></div>`;
  } else if (!loc) {
    status = `<div class="glass banner"><div class="bi"><svg viewBox="0 0 24 24"><use href="#i-location"/></svg></div><div>
      <b>Where are you?</b><p>Impatient Sky needs your location to work out which passes you can see.</p>
      <button class="primary-btn" data-act="gps">Use my location</button></div></div>`;
  } else if (S.error && S.error !== 'location') {
    status = `<div class="glass banner"><div class="bi">!</div><div><b>Couldn't load satellite data</b><p>${esc(S.error)}</p><button class="link-btn" data-act="reload">Retry</button></div></div>`;
  }
  if (S.busy && night && !night.passes) status += '<div class="progress"><i></i></div>';
  $('#t-status').innerHTML = status;

  // chips
  const chips = [];
  if (night?.win) {
    const w = night.win;
    if (w.neverDark) chips.push(`<span class="chip glass">The sky never gets dark enough tonight</span>`);
    else chips.push(`<span class="chip glass"><b>Dark</b> ${fmtT(w.start)} – ${fmtT(w.end)}</span>`);
    const ms = moonSummary(loc, w);
    if (ms) chips.push(`<span class="chip glass">${ms}</span>`);
  }
  const vis = visiblePasses(night);
  if (night?.passes) {
    chips.push(`<span class="chip glass"><b>${vis.length}</b> pass${vis.length === 1 ? '' : 'es'}</span>`);
    const best = vis.reduce((a, p) => (!a || p.mag < a.mag ? p : a), null);
    if (best) chips.push(`<span class="chip glass">Brightest <b>${esc(pretty(best.name))} ${fmtMag(best.mag)}</b> at ${fmtT(best.magT)}</span>`);
  }
  $('#t-chips').innerHTML = chips.join('');

  renderHero(vis, now);

  const tbl = $('#t-table');
  if (!night || !night.passes) tbl.innerHTML = loc ? skeleton() : '';
  else if (!vis.length) tbl.innerHTML = `<div class="empty"><b>Nothing brighter than ${fmtMag(S.settings.limit)} tonight</b>Try a fainter limit in Settings, or check Upcoming.</div>`;
  else tbl.innerHTML = tableHtml(vis, 't', { splitPast: true });
  tbl.hidden = !loc;
  $('#sort-seg').parentElement.hidden = !loc;

  const m = S.meta;
  $('#t-foot').innerHTML = m
    ? `Orbits updated ${ago(Date.parse(m.built))} · ${m.count.toLocaleString()} objects · tap a pass for its sky chart.${night?.ms ? ` Computed in ${(night.ms / 1000).toFixed(1)} s.` : ''}`
    : '';
}

let heroPass = null;
function renderHero(vis, now) {
  const hero = $('#hero');
  const next = vis.find((p) => p.end.t >= now);
  heroPass = next || null;
  if (!next) { hero.hidden = true; return; }
  hero.hidden = false;
  hero.dataset.pass = next.uid;
  const live = next.start.t <= now;
  hero.innerHTML = `<div>
      <div class="k">${live ? '<span class="live"></span>Overhead now' : 'Next pass in'}</div>
      <div class="count"><span id="hero-count">${live ? fmtMag(liveMag(next, now)) : countdown(next.start.t - now)}</span>${live ? '<small class="unit">mag now</small>' : ''}</div>
      <div class="name">${esc(pretty(next.name))} <span class="mag ${magClass(next.mag)}">${fmtMag(next.mag)}</span></div>
      <div class="sub">${live ? `Look ${compass(next.peak.az * DEG)}, ${Math.round(next.peak.el)}° up · ends ${fmtT(next.end.t)}` : `${fmtT(next.start.t)} from the ${compass(next.start.az * DEG)} · up to ${Math.round(next.peak.el)}°`}</div>
    </div>
    <div class="dome">${skyDome(next, 112, false)}</div>`;
}
function liveMag(p, now) {
  let best = p.track[0];
  for (const x of p.track) if (Math.abs(x[0] - now) < Math.abs(best[0] - now)) best = x;
  return best[3];
}

// ------------------------------------------------------------------ render: week
function renderWeek() {
  const strip = $('#day-strip');
  strip.innerHTML = S.nights.map((n) => {
    const vis = visiblePasses(n);
    const label = n.i === 0 ? 'Tonight' : dayFmt(n.noon, { weekday: 'short' });
    const dc = n.passes ? `${vis.length} · ${vis.length ? fmtMag(Math.min(...vis.map((p) => p.mag))) : '–'}` : '…';
    return `<button class="day glass${n.i === S.weekSel ? ' on' : ''}" data-day="${n.i}">
      <div class="dn">${label}</div><div class="dd">${dayFmt(n.noon, { day: 'numeric' })}</div><div class="dc">${dc}</div></button>`;
  }).join('');

  // brightest of the week
  const done = S.nights.filter((n) => n.passes);
  const all = done.flatMap((n) => visiblePasses(n)).filter((p) => p.end.t >= Date.now());
  const best = all.sort((a, b) => a.mag - b.mag).slice(0, 5);
  $('#w-best').innerHTML = best.length && done.length > 1 ? `<div class="section-label">Brightest this week${done.length < 7 ? ' so far' : ''}</div>
    <div class="glass card table">${best.map((p) => `<div class="best-row" data-pass="${p.uid}">
      <div><b>${esc(pretty(p.name))}</b><small>${dayFmt(p.start.t, { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmtT(p.start.t)} · ${dirText(p)} · ${Math.round(p.peak.el)}°</small></div>
      <span class="mag ${magClass(p.mag)}">${fmtMag(p.mag)}</span></div>`).join('')}</div>` : '';

  const n = S.nights[S.weekSel];
  if (!n) { $('#w-label').textContent = ''; $('#w-table').innerHTML = ''; return; }
  const vis = visiblePasses(n);
  $('#w-label').textContent = `${dayFmt(n.noon, { weekday: 'long', month: 'long', day: 'numeric' })} night${n.win?.neverDark ? '' : ` · dark ${fmtT(n.win.start)}–${fmtT(n.win.end)}`}`;
  const tbl = $('#w-table');
  if (!n.passes) tbl.innerHTML = skeleton(5);
  else if (!vis.length) tbl.innerHTML = `<div class="empty"><b>No passes brighter than ${fmtMag(S.settings.limit)}</b>Raise the limit in Settings to see fainter ones.</div>`;
  else tbl.innerHTML = tableHtml(vis, 'w');
  if (S.weekSel >= 4) tbl.insertAdjacentHTML('beforeend', `<p class="footnote" style="padding:0 16px 10px">Several days out, low satellites can drift by a minute or more as their orbits decay. Times sharpen as fresh orbit data arrives.</p>`);
}

// ------------------------------------------------------------------ render: settings
function settingsHtml() {
  const st = S.settings, loc = currentLoc(), m = S.meta;
  const segBtns = (name, opts, val) => `<div class="seg-small" data-seg="${name}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(v) === String(val) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const sw = (name, on) => `<input type="checkbox" class="switch" data-sw="${name}" ${on ? 'checked' : ''}>`;
  const pct = (v, lo, hi) => `--p:${(((v - lo) / (hi - lo)) * 100).toFixed(1)}%`;
  const locLine = loc
    ? `${loc.lat.toFixed(4)}°, ${loc.lon.toFixed(4)}° · ${loc.source === 'manual' ? 'set manually' : `GPS ±${Math.round(loc.acc || 0)} m · ${ago(loc.ts)}`}`
    : 'Not set';
  return `
  <div class="group-title">Brightness limit</div>
  <div class="glass list"><div class="item stack">
    <div class="row2"><span>Show satellites brighter than</span><span class="big-val" id="lim-val">${fmtMag(st.limit)}</span></div>
    <input type="range" id="lim" min="-2" max="7" step="0.1" value="${st.limit}" style="${pct(st.limit, -2, 7)}">
    <div class="scale-hint"><span>Only the brightest</span><span>Faint (dark sky)</span></div>
  </div></div>
  <p class="help">Lower numbers are brighter. Venus is about ${MINUS}4, the ISS ${MINUS}1 to ${MINUS}4, and from a suburb the faintest stars you can see are around 4. Under a dark rural sky you can see 6.</p>

  <div class="group-title">Which passes</div>
  <div class="glass list">
    <div class="item"><div class="lbl">Minimum altitude</div>${segBtns('minEl', [[0, '0°'], [10, '10°'], [20, '20°'], [30, '30°']], st.minEl)}</div>
    <div class="item"><div class="lbl">Sun below<small>How dark it has to be</small></div>${segBtns('sunAlt', [[-4, '4°'], [-6, '6°'], [-9, '9°'], [-12, '12°']], st.sunAlt)}</div>
    <div class="item"><div class="lbl">Starlink<small>About 11,000 satellites, mostly magnitude 4–6</small></div>${sw('starlink', st.starlink)}</div>
    <div class="item"><div class="lbl">Other megaconstellations<small>OneWeb, Kuiper, Qianfan, Guowang, BlueBird</small></div>${sw('mega', st.mega)}</div>
    <div class="item"><div class="lbl">Atmospheric dimming<small>Passes low in the sky look fainter, as they really do</small></div>${sw('extinction', st.extinction)}</div>
  </div>

  <div class="group-title">Location</div>
  <div class="glass list">
    <div class="item"><div class="lbl">${esc(locLine)}</div>${st.manual ? '' : '<button class="link-btn" data-act="gps">Update</button>'}</div>
    <div class="item"><div class="lbl">Set location manually</div>${sw('manualOn', !!st.manual)}</div>
    ${st.manual ? `<div class="item"><div class="inputs">
      <div><label>Latitude</label><input type="number" inputmode="decimal" step="any" id="m-lat" value="${st.manual.lat}"></div>
      <div><label>Longitude</label><input type="number" inputmode="decimal" step="any" id="m-lon" value="${st.manual.lon}"></div>
      <div><label>Alt (m)</label><input type="number" inputmode="decimal" step="any" id="m-alt" value="${st.manual.alt || 0}"></div>
    </div></div>
    <div class="item"><button class="link-btn" data-act="save-manual">Save location</button></div>` : ''}
  </div>

  <div class="group-title">Appearance</div>
  <div class="glass list">
    <div class="item stack"><div class="row2"><span>Liquid Glass</span><span class="val" id="glass-val">${st.glass < 0.2 ? 'Clear' : st.glass > 0.8 ? 'Tinted' : 'Balanced'}</span></div>
      <input type="range" id="glass" min="0" max="1" step="0.01" value="${st.glass}" style="${pct(st.glass, 0, 1)}">
      <div class="scale-hint"><span>Clear</span><span>Tinted</span></div></div>
    <div class="item"><div class="lbl">Night vision<small>Red screen that keeps your eyes dark-adapted</small></div>${sw('red', st.red)}</div>
    <div class="item"><div class="lbl">24-hour time</div>${sw('h24', st.h24)}</div>
  </div>

  <div class="group-title">Sky View</div>
  <div class="glass list">
    <div class="item"><div class="lbl">Camera background</div>${sw('camera', st.camera)}</div>
    <div class="item"><div class="lbl">Show satellites in Earth's shadow<small>Dim outlines for objects you can't see right now</small></div>${sw('showShadow', st.showShadow)}</div>
    <div class="item stack"><div class="row2"><span>Camera field of view</span><span class="val" id="fov-val">${st.fov}°</span></div>
      <input type="range" id="fov" min="45" max="90" step="1" value="${st.fov}" style="${pct(st.fov, 45, 90)}">
      <div class="scale-hint"><span>Labels spread out</span><span>Labels bunch up</span></div></div>
    <div class="item"><div class="lbl">Compass correction<small>${st.yawTrim ? `${st.yawTrim > 0 ? '+' : ''}${st.yawTrim.toFixed(1)}° from Align or the ⟲ ⟳ buttons` : 'None. Use Align in Sky View if labels sit off their objects.'}</small></div>${st.yawTrim ? '<button class="link-btn" data-act="reset-trim">Reset</button>' : ''}</div>
  </div>

  <div class="group-title">Data</div>
  <div class="glass list">
    <div class="item"><div class="lbl">Orbits updated<small>${m ? `${new Date(m.built).toLocaleString()} · refreshed every 2 hours` : '–'}</small></div><span class="val">${m ? ago(Date.parse(m.built)) : ''}</span></div>
    <div class="item"><div class="lbl">Objects tracked<small>${m ? `${(m.sources?.qsmag || 0).toLocaleString()} intrinsic magnitudes on file` : ''}</small></div><span class="val">${m ? m.count.toLocaleString() : '–'}</span></div>
    <div class="item"><button class="link-btn" data-act="reload">Check for new data</button></div>
  </div>
  <p class="help">Passes are computed on your phone with the SGP4 orbit model, a conical Earth-shadow test and a phase-angle brightness model, the same approach Heavens-Above uses. Orbital elements come from <a href="https://celestrak.org" target="_blank" rel="noopener">CelesTrak</a>. Intrinsic magnitudes come from Mike McCants' <a href="https://www.mmccants.org/tles/intrmagdef.html" target="_blank" rel="noopener">qs.mag</a>, and constellation brightness from Mallama et al. (2025). Every pass links to <a href="https://www.heavens-above.com" target="_blank" rel="noopener">Heavens-Above</a> and <a href="https://www.n2yo.com" target="_blank" rel="noopener">N2YO</a> so you can cross-check it.</p>
  <p class="help" style="text-align:center;margin-top:18px">Impatient Sky · build ${document.documentElement.dataset.build}</p>`;
}
function renderSettings() { $('#settings').innerHTML = settingsHtml(); }

// ------------------------------------------------------------------ detail sheet
function ics(p) {
  const d = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const body = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Impatient Sky//EN', 'BEGIN:VEVENT',
    `UID:isky-${p.id}-${p.start.t}@impatient-sky`, `DTSTAMP:${d(Date.now())}`, `DTSTART:${d(p.start.t)}`, `DTEND:${d(p.end.t)}`,
    `SUMMARY:${pretty(p.name)} pass (mag ${p.mag.toFixed(1)})`,
    `DESCRIPTION:Look ${compass(p.start.az * DEG)} at ${fmtTs(p.start.t)}\\, highest ${Math.round(p.peak.el)}° in the ${compass(p.peak.az * DEG)} at ${fmtTs(p.peak.t)}\\, ends ${compass(p.end.az * DEG)} at ${fmtTs(p.end.t)}.`,
    'BEGIN:VALARM', 'TRIGGER:-PT5M', 'ACTION:DISPLAY', 'DESCRIPTION:Satellite pass in 5 minutes', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'text/calendar' }));
  a.download = `${pretty(p.name).replace(/[^\w-]+/g, '-')}-pass.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function openSheet(p) {
  const sat = S.byId.get(p.id) || {};
  const loc = currentLoc();
  const whyStart = { rise: 'Rises above your minimum altitude', emerges: 'Emerges from Earth’s shadow', twilight: 'Sky gets dark enough' }[p.startWhy] || '';
  const whyEnd = { set: 'Drops below your minimum altitude', shadow: 'Fades into Earth’s shadow', twilight: 'Sky gets too bright', window: 'Dawn' }[p.endWhy] || '';
  const ev = (label, sub, s) => `<div class="ev"><div class="tm">${fmtTs(s.t)}</div><div class="what">${label}<small>${sub}</small></div><div class="pos">${Math.round(s.el)}° ${compass(s.az * DEG)}<br><small>${Math.round(s.az)}° az</small></div></div>`;
  const ha = `https://www.heavens-above.com/PassSummary.aspx?satid=${p.id}&lat=${loc.lat.toFixed(4)}&lng=${loc.lon.toFixed(4)}&loc=Here&alt=${Math.round((loc.alt || 0) * 1000)}&tz=UCT`;
  const n2 = `https://www.n2yo.com/satellite/?s=${p.id}`;
  $('#sheet-body').innerHTML = `
    <h2>${esc(pretty(p.name))}</h2>
    <div class="subtitle">${TYPE[sat.type] || 'Object'} · NORAD ${p.id}${sat.cospar ? ` · ${esc(sat.cospar)}` : ''} · ${dayFmt(p.start.t, { weekday: 'long', month: 'short', day: 'numeric' })}</div>
    <div class="stats">
      <div class="stat"><div class="v">${fmtMag(p.mag)}</div><div class="l">Brightest</div></div>
      <div class="stat"><div class="v">${Math.round(p.peak.el)}°</div><div class="l">Highest</div></div>
      <div class="stat"><div class="v">${fmtDur(p.end.t - p.start.t)}</div><div class="l">Visible</div></div>
    </div>
    ${skyDome(p, 300, true)}
    <div class="events">
      ${ev('Appears', whyStart, p.start)}
      ${ev('Highest', `${p.range.toLocaleString()} km away`, p.peak)}
      ${ev('Disappears', whyEnd, p.end)}
    </div>
    ${magCurve(p)}
    <div class="sheet-actions">
      <button class="primary-btn" data-act="watch" data-pass="${p.uid}">Watch in Sky View</button>
      <div class="sheet-links">
        <button data-act="ics" data-pass="${p.uid}">Add to Calendar</button>
        <a href="${ha}" target="_blank" rel="noopener">Heavens-Above ↗</a>
        <a href="${n2}" target="_blank" rel="noopener">N2YO ↗</a>
      </div>
    </div>
    <p class="meta-line">Intrinsic magnitude ${fmtMag(sat.M ?? p.M)} (${MSRC[sat.msrc || p.msrc] || 'estimate'}) · orbit ${sat.n ? Math.round((1440 / sat.n)) + ' min' : ''} · elements ${sat.epoch ? ago(Date.parse(sat.epoch + 'Z')) : ''}</p>`;
  $('#scrim').hidden = false;
  const sheet = $('#sheet');
  sheet.hidden = false;
  sheet.scrollTop = 0;
}
function closeSheet() { $('#sheet').hidden = true; $('#scrim').hidden = true; }

// drag the sheet down to dismiss
(() => {
  let y0 = null, dy = 0;
  const sheet = $('#sheet');
  sheet.addEventListener('touchstart', (e) => { if (sheet.scrollTop <= 0) { y0 = e.touches[0].clientY; dy = 0; } }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (y0 === null) return;
    sheet.style.transition = 'transform .25s';
    if (dy > 110) { sheet.style.transform = 'translateY(100%)'; setTimeout(() => { closeSheet(); sheet.style.transform = ''; sheet.style.transition = ''; }, 230); }
    else { sheet.style.transform = ''; setTimeout(() => { sheet.style.transition = ''; }, 260); }
    y0 = null;
  });
})();

// ------------------------------------------------------------------ AR
async function openSky(target = null) {
  const loc = currentLoc();
  if (!loc) { S.error = 'location'; renderAll(); return; }
  if (!S.catalog) return;
  const { openAR } = await import('./ar.js');
  openAR({ engine, loc, settings: S.settings, save: () => { saveSettings(); }, byId: S.byId, target, fmtMag, pretty, fmtT, countdown });
}

// ------------------------------------------------------------------ navigation
function setView(v) {
  S.view = v;
  for (const sec of $$('.view')) sec.hidden = sec.dataset.view !== v;
  const tabs = $$('#tabbar button');
  tabs.forEach((b, i) => {
    b.classList.toggle('on', b.dataset.tab === v);
    if (b.dataset.tab === v) $('#tab-pill').style.transform = `translateX(${i * 84}px)`;
  });
  $('#navbar-title').textContent = { tonight: 'Tonight', week: 'Upcoming', settings: 'Settings' }[v];
  window.scrollTo({ top: 0 });
  renderAll();
}

function renderAll() {
  tagPasses();
  if (S.view === 'tonight') renderTonight();
  else if (S.view === 'week') renderWeek();
  else if (S.view === 'settings' && !document.activeElement?.closest?.('#settings input[type=number]')) renderSettings();
}

// ------------------------------------------------------------------ events
document.addEventListener('click', (e) => {
  const t = e.target;
  const tab = t.closest('#tabbar button');
  if (tab) { setView(tab.dataset.tab); return; }
  if (t.closest('#btn-sky')) { openSky(); return; }
  const row = t.closest('[data-pass]');
  const act = t.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'gps') requestGps();
    else if (a === 'manual') { setView('settings'); S.settings.manual = S.loc ? { lat: +S.loc.lat.toFixed(4), lon: +S.loc.lon.toFixed(4), alt: 0 } : { lat: 0, lon: 0, alt: 0 }; renderSettings(); }
    else if (a === 'reload') refreshData(true);
    else if (a === 'reset-trim') { S.settings.yawTrim = 0; saveSettings(); renderSettings(); }
    else if (a === 'save-manual') {
      const lat = parseFloat($('#m-lat').value), lon = parseFloat($('#m-lon').value), alt = parseFloat($('#m-alt').value) || 0;
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) { S.settings.manual = { lat, lon, alt }; saveSettings(); recompute(); renderSettings(); }
    } else if (a === 'watch') { const p = findPass(+act.dataset.pass); closeSheet(); openSky(p); }
    else if (a === 'ics') { const p = findPass(+act.dataset.pass); if (p) ics(p); }
    return;
  }
  if (row && !t.closest('a')) { const p = findPass(+row.dataset.pass); if (p) openSheet(p); return; }
  if (t.closest('#scrim')) { closeSheet(); return; }
  const more = t.closest('[data-more]');
  if (more) { S.shown[more.dataset.more] += 150; renderAll(); return; }
  if (t.closest('[data-toggle-past]')) { S.showPast = !S.showPast; renderAll(); return; }
  const sortBtn = t.closest('#sort-seg button');
  if (sortBtn) { S.sort = sortBtn.dataset.sort; $$('#sort-seg button').forEach((b) => b.classList.toggle('on', b === sortBtn)); renderAll(); return; }
  const day = t.closest('[data-day]');
  if (day) { S.weekSel = +day.dataset.day; S.shown.w = 150; renderWeek(); return; }
  if (t.closest('#btn-refresh')) { refreshData(true); requestGps(true); return; }
  const seg = t.closest('[data-seg] button');
  if (seg) {
    const name = seg.parentElement.dataset.seg;
    S.settings[name] = +seg.dataset.v; saveSettings(); renderSettings(); recompute(300);
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.sw) {
    const k = t.dataset.sw, on = t.checked;
    if (k === 'manualOn') {
      S.settings.manual = on ? (S.loc ? { lat: +S.loc.lat.toFixed(4), lon: +S.loc.lon.toFixed(4), alt: Math.round((S.loc.alt || 0) * 1000) } : { lat: 0, lon: 0, alt: 0 }) : null;
      saveSettings(); renderSettings(); recompute(); if (!on) requestGps(true);
      return;
    }
    S.settings[k] = on; saveSettings();
    if (k === 'red') applyAppearance();
    if (['starlink', 'mega', 'extinction'].includes(k)) recompute(250);
    if (k === 'h24' || k === 'showShadow' || k === 'camera') renderSettings();
    return;
  }
  if (t.id === 'lim') {
    const v = +t.value;
    const raise = v > (S.computedLimit ?? -9);
    S.settings.limit = v; saveSettings();
    if (raise) recompute(150); else renderAll();
  }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.type === 'range') {
    const lo = +t.min, hi = +t.max;
    t.style.setProperty('--p', `${(((+t.value - lo) / (hi - lo)) * 100).toFixed(1)}%`);
  }
  if (t.id === 'lim') $('#lim-val').textContent = fmtMag(+t.value);
  if (t.id === 'glass') {
    S.settings.glass = +t.value; applyAppearance(); saveSettings();
    $('#glass-val').textContent = S.settings.glass < 0.2 ? 'Clear' : S.settings.glass > 0.8 ? 'Tinted' : 'Balanced';
  }
  if (t.id === 'fov') { S.settings.fov = +t.value; $('#fov-val').textContent = `${t.value}°`; saveSettings(); }
});

addEventListener('scroll', () => { $('#navbar').classList.toggle('show', scrollY > 52); }, { passive: true });
addEventListener('resize', () => drawStarfield());

// ------------------------------------------------------------------ refresh loop
async function refreshData(force = false) {
  const btn = $('#btn-refresh');
  btn.classList.add('spin');
  try {
    const changed = await loadData(force);
    S.error = S.error === 'location' ? 'location' : null;
    if (changed) recompute(); else renderAll();
  } catch (e) {
    console.error(e);
    if (!S.catalog) S.error = e.message;
    renderAll();
  } finally {
    btn.classList.remove('spin');
  }
}

let lastTick = 0;
function tick() {
  const now = Date.now();
  // countdown on the hero card every second
  if (heroPass && S.view === 'tonight') {
    const el = $('#hero-count');
    if (el) {
      if (heroPass.start.t > now) el.textContent = countdown(heroPass.start.t - now);
      else if (heroPass.end.t >= now) el.textContent = fmtMag(liveMag(heroPass, now));
    }
    if (heroPass.end.t < now || (heroPass.start.t <= now && !$('#hero .live'))) renderAll();
  }
  // a new night has begun (solar noon passed) → shift the week
  const loc = currentLoc();
  if (loc && S.nights[0] && tonightNoon(loc, now) !== S.nights[0].noon) recompute();
  if (now - lastTick > 20000) { lastTick = now; if (S.view !== 'settings') renderAll(); }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { refreshData(); if (!S.settings.manual && (!S.loc || Date.now() - S.loc.ts > 15 * 60000)) requestGps(true); }
});

// ------------------------------------------------------------------ boot
applyAppearance();
drawStarfield();
setView('tonight');
refreshData();
if (!S.settings.manual) requestGps(!!S.loc);
setInterval(tick, 1000);
setInterval(() => { if (document.visibilityState === 'visible') refreshData(); }, 10 * 60000);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
