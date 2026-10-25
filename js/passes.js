// Impatient Sky — visible-pass search and live sky positions.
// Runs inside Web Workers (and Node for tests). No DOM.

import { json2satrec, sgp4 } from './vendor/satellite.min.mjs';
import {
  RE, DEG, TWO_PI, Observer, look, enu, sunEci, sunAltitude, sunlitFraction, phaseAngle, magnitude,
  jdFromMs,
} from './astro.js';

const MU = 398600.4418;           // km^3 s^-2
const W_EARTH = 7.2921159e-5 * 60; // rad/min
const GRID_S = 30;                // coarse search grid, seconds
const FINE_S = 10;                // fine step inside a candidate pass, seconds
const SUNLIT_MIN = 0.1;           // fraction of the solar disk that counts as "lit"

// ------------------------------------------------------------------ catalog

export function buildSats(catalog) {
  const ix = Object.fromEntries(catalog.fields.map((k, i) => [k, i]));
  const sats = [];
  for (const r of catalog.sats) {
    let satrec;
    try {
      satrec = json2satrec({
        NORAD_CAT_ID: r[ix.id], EPOCH: r[ix.epoch], MEAN_MOTION: r[ix.n], ECCENTRICITY: r[ix.e],
        INCLINATION: r[ix.i], RA_OF_ASC_NODE: r[ix.raan], ARG_OF_PERICENTER: r[ix.argp],
        MEAN_ANOMALY: r[ix.ma], BSTAR: r[ix.bstar], MEAN_MOTION_DOT: r[ix.ndot], MEAN_MOTION_DDOT: r[ix.nddot],
      });
    } catch { continue; }
    if (!satrec || satrec.error) continue;
    const nRadMin = (r[ix.n] * TWO_PI) / 1440;
    const a = Math.cbrt(MU / Math.pow(nRadMin / 60, 2));
    const e = r[ix.e];
    sats.push({
      id: r[ix.id], name: r[ix.name], type: r[ix.type], grp: r[ix.grp] || '', M: r[ix.mag], msrc: r[ix.msrc],
      satrec, epochJd: satrec.jdsatepoch + (satrec.jdsatepochF || 0),
      perigee: a * (1 - e) - RE, apogee: a * (1 + e) - RE, inc: r[ix.i] * DEG,
      // fastest the satellite can sweep across the sky, rad/min (perigee speed + Earth spin)
      wMax: (nRadMin * Math.pow(1 + e, 2)) / Math.pow(1 - e * e, 1.5) * 1.08 + W_EARTH,
      period: 1440 / r[ix.n],
      // live-view scheduling
      next: 0,
    });
  }
  return sats;
}

// ECI position at ms (TEME, km) into out; false if the propagator fails (decayed).
const _pos = [0, 0, 0];
const _vel = [0, 0, 0]; // velocity of the most recent propagate() call
export function propagate(sat, ms, out = _pos) {
  const tsince = (jdFromMs(ms) - sat.epochJd) * 1440;
  const r = sgp4(sat.satrec, tsince);
  if (!r || !r.position || Number.isNaN(r.position.x)) return false;
  out[0] = r.position.x; out[1] = r.position.y; out[2] = r.position.z;
  _vel[0] = r.velocity.x; _vel[1] = r.velocity.y; _vel[2] = r.velocity.z;
  return out;
}

// How long (min) until this satellite could possibly get above the horizon.
// Two lower bounds, take the larger:
//  1. it must close its geocentric gap at no more than its fastest angular rate;
//  2. the observer must first rotate (with the Earth) to within reach of the
//     orbit plane, which happens only twice a day.
function minutesToReach(sat, f, x, y, z, gap) {
  let skip = (gap - 0.02) / sat.wMax;
  const hx = y * _vel[2] - z * _vel[1], hy = z * _vel[0] - x * _vel[2], hz = x * _vel[1] - y * _vel[0];
  const hn = Math.sqrt(hx * hx + hy * hy + hz * hz);
  const ro = Math.sqrt(f.px * f.px + f.py * f.py + f.pz * f.pz);
  const beta = Math.asin(Math.min(1, Math.abs(hx * f.px + hy * f.py + hz * f.pz) / (hn * ro)));
  const reach = Math.acos(Math.min(1, ro / (RE + sat.apogee))) + 0.03;
  if (beta > reach) {
    const wPlane = W_EARTH * Math.sqrt(f.px * f.px + f.py * f.py) / ro + 3e-4;
    skip = Math.max(skip, (beta - reach) / wPlane);
  }
  return skip;
}

// Geocentric angle by which the satellite still has to "close" before it can
// rise; > 0 means it's below the horizon by at least that much.
function horizonGap(f, x, y, z) {
  const rs = Math.sqrt(x * x + y * y + z * z);
  const ro = Math.sqrt(f.px * f.px + f.py * f.py + f.pz * f.pz);
  const cpsi = (x * f.px + y * f.py + z * f.pz) / (rs * ro);
  const psi = Math.acos(Math.max(-1, Math.min(1, cpsi)));
  const lam = Math.acos(Math.min(1, ro / rs));
  return psi - lam;
}

// Can this satellite ever beat `limit` and ever climb above minEl at this latitude?
export function canQualify(sat, latRad, limit, minElRad) {
  if (sat.M + 5 * Math.log10(Math.max(sat.perigee, 150) / 1000) > limit) return false;
  const incEff = sat.inc > Math.PI / 2 ? Math.PI - sat.inc : sat.inc;
  const rs = RE + sat.apogee;
  const reach = Math.acos((RE / rs) * Math.cos(minElRad)) - minElRad; // geocentric reach at minEl
  return Math.abs(latRad) <= incEff + reach + 0.02;
}

// ------------------------------------------------------------------ pass search

// Precompute observer frames, sun vectors and sun altitude on the coarse grid.
export function makeGrid(obs, t0, t1) {
  const n = Math.ceil((t1 - t0) / (GRID_S * 1000)) + 2;
  const frames = new Array(n), suns = new Array(n), sunAlt = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const jd = jdFromMs(t0 + k * GRID_S * 1000);
    frames[k] = obs.frame(jd, {});
    suns[k] = sunEci(jd, [0, 0, 0]);
    sunAlt[k] = sunAltitude(frames[k], suns[k]);
  }
  return { t0, t1, n, frames, suns, sunAlt };
}

/**
 * Visible passes of one satellite within the grid's window.
 * opts: { limit, minEl (rad), sunAltMax (rad), extinction, track (bool) }
 */
export function satPasses(sat, obs, grid, opts) {
  const out = [];
  const { t0, n, frames, suns, sunAlt } = grid;
  const p = [0, 0, 0], la = [0, 0, 0];
  let k = 0;
  let guard = 0;
  while (k < n - 1 && guard++ < 100000) {
    const t = t0 + k * GRID_S * 1000;
    if (!propagate(sat, t, p)) return out;
    const f = frames[k];
    const gap = horizonGap(f, p[0], p[1], p[2]);
    if (gap > 0.03 && !opts.bruteForce) {
      const skipMin = minutesToReach(sat, f, p[0], p[1], p[2], gap);
      k += Math.max(1, Math.floor((skipMin * 60) / GRID_S));
      continue;
    }
    look(f, p[0], p[1], p[2], la);
    if (la[1] < -1 * DEG) { k++; continue; }
    // Candidate. Walk it on the coarse grid first; most night passes are in
    // Earth's shadow or too faint, and those never need the fine scan.
    const kFirst = Math.max(0, k - 1);
    let kk = k, promising = false;
    for (; kk < n; kk++) {
      if (kk > k && !propagate(sat, t0 + kk * GRID_S * 1000, p)) break;
      const fk = frames[kk];
      look(fk, p[0], p[1], p[2], la);
      if (la[1] < -1 * DEG) break;
      if (promising || la[1] < opts.minEl - 3 * DEG || sunAlt[kk] > opts.sunAltMax + 1 * DEG) continue;
      const lit = sunlitFraction(p[0], p[1], p[2], suns[kk]);
      if (lit <= 0) continue;
      const m = magnitude(sat.M, la[2], phaseAngle(p[0], p[1], p[2], fk, suns[kk]), Math.max(lit, 0.5), la[1], opts.extinction);
      if (m <= opts.limit + 0.75) promising = true;
    }
    if (promising || (kk - kFirst) * GRID_S < 90) {
      // short passes can hide between grid points; always scan those
      const endK = scanPass(sat, obs, grid, kFirst, opts, out);
      k = Math.max(k + 1, endK);
    } else {
      k = kk + 1;
    }
  }
  return out;
}

function scanPass(sat, obs, grid, kStart, opts, out) {
  const { t0, frames, suns, sunAlt, n } = grid;
  const tEnd = t0 + (n - 1) * GRID_S * 1000;
  const p = [0, 0, 0], la = [0, 0, 0], f = {};
  const step = FINE_S * 1000 * Math.min(6, Math.max(1, sat.period / 100));
  const visCut = Math.max(opts.limit, opts.eyeLimit ?? 5);
  let t = t0 + kStart * GRID_S * 1000;
  let seg = null, wasUp = false;
  let prev = null;
  const track = [];

  const sample = (tt) => {
    if (!propagate(sat, tt, p)) return null;
    const kf = (tt - t0) / (GRID_S * 1000);
    const k0 = Math.min(n - 2, Math.max(0, Math.floor(kf)));
    const w = kf - k0;
    const s = suns[k0];
    obs.frame(jdFromMs(tt), f);
    look(f, p[0], p[1], p[2], la);
    const sAlt = sunAlt[k0] * (1 - w) + sunAlt[k0 + 1] * w;
    const lit = sunlitFraction(p[0], p[1], p[2], s);
    const ph = phaseAngle(p[0], p[1], p[2], f, s);
    const mag = magnitude(sat.M, la[2], ph, lit, la[1], opts.extinction);
    // "visible" = high enough, sunlit, dark enough, and bright enough to actually see
    const vis = la[1] >= opts.minEl && lit >= SUNLIT_MIN && sAlt <= opts.sunAltMax && mag <= visCut;
    return { t: tt, az: la[0], el: la[1], range: la[2], lit, sAlt, mag, vis };
  };

  // Bisect the visibility edge between a (state A) and b (state B) to ~1 s.
  const edge = (a, b) => {
    let lo = a, hi = b;
    for (let i = 0; i < 4; i++) {
      const mid = sample((lo.t + hi.t) / 2);
      if (!mid) break;
      if (mid.vis === lo.vis) lo = mid; else hi = mid;
    }
    return lo.vis ? lo : hi; // the visible side of the edge
  };

  for (; t <= tEnd; t += step) {
    const s = sample(t);
    if (!s) break;
    if (s.el > -1.5 * DEG) wasUp = true;
    if (s.vis) {
      if (!seg) {
        const first = prev && !prev.vis ? edge(prev, s) : s;
        seg = { start: first, peak: first, best: first, end: first,
          startWhy: prev ? why(prev, first, opts) : (first.t - t0 < 60000 ? 'twilight' : 'rise') };
        track.length = 0;
        track.push(first);
      }
      if (s.el > seg.peak.el) seg.peak = s;
      if (s.mag < seg.best.mag) seg.best = s;
      seg.end = s;
      track.push(s);
    } else if (seg) {
      const last = edge(seg.end, s);
      seg.end = last;
      if (last.el > seg.peak.el) seg.peak = last;
      if (last.mag < seg.best.mag) seg.best = last;
      if (last !== track[track.length - 1]) track.push(last);
      seg.endWhy = why(s, last, opts, true);
      refinePeak(seg, sample);
      emit(sat, seg, track, opts, out);
      seg = null;
    }
    prev = s;
    if (wasUp && s.el < -1.5 * DEG) break;
  }
  if (seg) { seg.endWhy = 'window'; refinePeak(seg, sample); emit(sat, seg, track, opts, out); }
  return Math.ceil((t - t0) / (GRID_S * 1000));
}

// Ternary-search the highest point to ~1 s (samples are 10 s apart).
function refinePeak(seg, sample) {
  const pk = seg.peak;
  if (pk === seg.start || pk === seg.end) return;
  let lo = Math.max(seg.start.t, pk.t - FINE_S * 1000), hi = Math.min(seg.end.t, pk.t + FINE_S * 1000);
  let best = pk;
  for (let i = 0; i < 7; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    const a = sample(m1), b = sample(m2);
    if (!a || !b) return;
    if (a.el > best.el) best = a;
    if (b.el > best.el) best = b;
    if (a.el < b.el) lo = m1; else hi = m2;
  }
  seg.peak = best;
  if (best.mag < seg.best.mag) seg.best = best;
}

// Why visibility starts/ends at this sample: horizon, Earth's shadow or twilight.
function why(other, s, opts, ending = false) {
  if (!other) return ending ? 'set' : 'rise';
  if (other.el < opts.minEl) return ending ? 'set' : 'rise';
  if (other.lit < SUNLIT_MIN) return ending ? 'shadow' : 'emerges';
  if (other.sAlt > opts.sunAltMax) return 'twilight';
  return ending ? 'dims' : 'brightens';
}

function emit(sat, seg, track, opts, out) {
  if (seg.best.mag > opts.limit) return;
  if (seg.end.t - seg.start.t < 5000) return;
  const pt = (s) => ({ t: s.t, az: +(s.az / DEG).toFixed(1), el: +(s.el / DEG).toFixed(1) });
  // keep ~40 points for the sky chart
  const stride = Math.max(1, Math.ceil(track.length / 40));
  const tr = [];
  for (let i = 0; i < track.length; i += stride) tr.push(track[i]);
  if (tr[tr.length - 1] !== track[track.length - 1]) tr.push(track[track.length - 1]);
  out.push({
    id: sat.id, name: sat.name, grp: sat.grp, type: sat.type, msrc: sat.msrc, M: sat.M,
    start: pt(seg.start), peak: pt(seg.peak), end: pt(seg.end),
    mag: +seg.best.mag.toFixed(1), magT: seg.best.t,
    startWhy: seg.startWhy, endWhy: seg.endWhy,
    range: Math.round(seg.peak.range),
    track: tr.map((s) => [s.t, +(s.az / DEG).toFixed(1), +(s.el / DEG).toFixed(1), +s.mag.toFixed(1)]),
  });
}

export function nightPasses(sats, lat, lon, hKm, win, opts) {
  const obs = new Observer(lat, lon, hKm);
  const grid = makeGrid(obs, win.start, win.end);
  const all = [];
  let tested = 0;
  for (const sat of sats) {
    if (opts.skipGroups && opts.skipGroups.includes(sat.grp)) continue;
    if (!canQualify(sat, lat * DEG, opts.limit, opts.minEl)) continue;
    tested++;
    const ps = satPasses(sat, obs, grid, opts);
    for (const p of ps) all.push(p);
  }
  all.sort((a, b) => a.start.t - b.start.t);
  return { passes: all, tested };
}

// ------------------------------------------------------------------ live sky

/**
 * Positions of everything near or above the horizon at time t, for the AR view.
 * Uses per-satellite "next check" times so far-below-horizon objects aren't
 * propagated every tick. Returns a Float32Array of rows:
 * [index, e, n, u, de, dn, du (per second), mag, lit, rangeKm]
 */
export const LIVE_STRIDE = 10;
export function liveSky(sats, obs, t, opts, maxMag) {
  const f = obs.frame(jdFromMs(t), {});
  const f2 = obs.frame(jdFromMs(t + 1000), {});
  const s = sunEci(jdFromMs(t), [0, 0, 0]);
  const p = [0, 0, 0], q = [0, 0, 0], v1 = [0, 0, 0], v2 = [0, 0, 0], la = [0, 0, 0];
  const rows = [];
  const latRad = obs.lat;
  for (let i = 0; i < sats.length; i++) {
    const sat = sats[i];
    if (sat.next > t) continue;
    if (sat.liveSkip === undefined) sat.liveSkip = !canQualify(sat, latRad, maxMag, -2 * DEG);
    if (sat.liveSkip) { sat.next = Infinity; continue; }
    if (!propagate(sat, t, p)) { sat.next = Infinity; continue; }
    const gap = horizonGap(f, p[0], p[1], p[2]);
    if (gap > 0.03) { sat.next = t + minutesToReach(sat, f, p[0], p[1], p[2], gap) * 60000; continue; }
    sat.next = 0;
    look(f, p[0], p[1], p[2], la);
    if (la[1] < -3 * DEG) continue;
    const lit = sunlitFraction(p[0], p[1], p[2], s);
    const ph = phaseAngle(p[0], p[1], p[2], f, s);
    const mag = magnitude(sat.M, la[2], ph, lit, la[1], opts.extinction || 0);
    if (mag > maxMag && lit >= SUNLIT_MIN) continue;
    if (lit < SUNLIT_MIN && !(opts.showShadow && sat.M + 5 * Math.log10(la[2] / 1000) < maxMag)) continue;
    enu(f, p[0], p[1], p[2], v1);
    propagate(sat, t + 1000, q);
    enu(f2, q[0], q[1], q[2], v2);
    rows.push(i, v1[0], v1[1], v1[2], v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2], lit >= SUNLIT_MIN ? mag : 99, lit, la[2]);
  }
  return new Float32Array(rows);
}

export function resetLive(sats) { for (const s of sats) { s.next = 0; s.liveSkip = undefined; } }
