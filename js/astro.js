// Impatient Sky — astronomy core. Pure functions shared by the page, the
// workers and the Node tests. Units: km, radians, Julian days unless noted.

export const RE = 6378.137;               // WGS-84 equatorial radius, km
export const FLAT = 1 / 298.257223563;
export const E2 = FLAT * (2 - FLAT);
export const AU = 149597870.7;
export const R_SUN = 696000;
export const DEG = Math.PI / 180;
export const TWO_PI = Math.PI * 2;
export const MIN_PER_DAY = 1440;

export const jdFromMs = (ms) => ms / 86400000 + 2440587.5;
export const msFromJd = (jd) => (jd - 2440587.5) * 86400000;

// Greenwich mean sidereal time (IAU 1982), same as satellite.js gstime.
export function gmst(jd) {
  const t = (jd - 2451545.0) / 36525.0;
  let g = (-6.2e-6 * t * t * t + 0.093104 * t * t + (876600.0 * 3600 + 8640184.812866) * t + 67310.54841) * DEG / 240.0;
  g %= TWO_PI;
  return g < 0 ? g + TWO_PI : g;
}

// Low-precision Sun (Astronomical Almanac), equatorial of date, km. ~0.01°.
export function sunEci(jd, out = [0, 0, 0]) {
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 4e-7 * n) * DEG;
  const R = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * AU;
  out[0] = R * Math.cos(lam);
  out[1] = R * Math.cos(eps) * Math.sin(lam);
  out[2] = R * Math.sin(eps) * Math.sin(lam);
  return out;
}

// Moon, truncated Meeus ch.47 (largest terms). ~0.1–0.3°, geocentric equatorial km.
export function moonEci(jd, out = [0, 0, 0]) {
  const T = (jd - 2451545.0) / 36525;
  const Lp = (218.3164477 + 481267.88123421 * T) * DEG;
  const D = (297.8501921 + 445267.1114034 * T) * DEG;
  const M = (357.5291092 + 35999.0502909 * T) * DEG;
  const Mp = (134.9633964 + 477198.8675055 * T) * DEG;
  const F = (93.272095 + 483202.0175233 * T) * DEG;
  const lon = Lp + DEG * (6.288774 * Math.sin(Mp) + 1.274027 * Math.sin(2 * D - Mp) + 0.658314 * Math.sin(2 * D)
    + 0.213618 * Math.sin(2 * Mp) - 0.185116 * Math.sin(M) - 0.114332 * Math.sin(2 * F)
    + 0.058793 * Math.sin(2 * D - 2 * Mp) + 0.057066 * Math.sin(2 * D - M - Mp) + 0.053322 * Math.sin(2 * D + Mp)
    + 0.045758 * Math.sin(2 * D - M) - 0.040923 * Math.sin(M - Mp) - 0.03472 * Math.sin(D) - 0.030383 * Math.sin(M + Mp));
  const lat = DEG * (5.128122 * Math.sin(F) + 0.280602 * Math.sin(Mp + F) + 0.277693 * Math.sin(Mp - F)
    + 0.173237 * Math.sin(2 * D - F) + 0.055413 * Math.sin(2 * D - Mp + F) + 0.046271 * Math.sin(2 * D - Mp - F));
  const dist = 385000.56 - 20905.355 * Math.cos(Mp) - 3699.111 * Math.cos(2 * D - Mp) - 2955.968 * Math.cos(2 * D)
    - 569.925 * Math.cos(2 * Mp);
  const eps = (23.439291 - 0.0130042 * T) * DEG;
  const x = dist * Math.cos(lat) * Math.cos(lon);
  const y = dist * Math.cos(lat) * Math.sin(lon);
  const z = dist * Math.sin(lat);
  out[0] = x;
  out[1] = y * Math.cos(eps) - z * Math.sin(eps);
  out[2] = y * Math.sin(eps) + z * Math.cos(eps);
  return out;
}

// Moon illuminated fraction from geocentric sun & moon vectors.
export function moonPhase(sun, moon) {
  const ds = Math.hypot(sun[0], sun[1], sun[2]);
  const dm = Math.hypot(moon[0], moon[1], moon[2]);
  const cosE = (sun[0] * moon[0] + sun[1] * moon[1] + sun[2] * moon[2]) / (ds * dm);
  const elong = Math.acos(Math.max(-1, Math.min(1, cosE)));
  const i = Math.atan2(ds * Math.sin(elong), dm - ds * Math.cos(elong));
  return (1 + Math.cos(i)) / 2;
}

// An observer frame at one instant: position and local East/North/Up in ECI.
export class Observer {
  constructor(latDeg, lonDeg, hKm = 0) { this.set(latDeg, lonDeg, hKm); }
  set(latDeg, lonDeg, hKm = 0) {
    this.lat = latDeg * DEG; this.lon = lonDeg * DEG; this.h = hKm;
    const sl = Math.sin(this.lat), cl = Math.cos(this.lat);
    const N = RE / Math.sqrt(1 - E2 * sl * sl);
    this.rxy = (N + hKm) * cl;            // distance from spin axis
    this.z = (N * (1 - E2) + hKm) * sl;
    this.sl = sl; this.cl = cl;
  }
  // Fills frame f (reusable object) for Julian date jd.
  frame(jd, f = {}) {
    const th = gmst(jd) + this.lon;
    const ct = Math.cos(th), st = Math.sin(th);
    f.jd = jd;
    f.px = this.rxy * ct; f.py = this.rxy * st; f.pz = this.z;
    f.ux = this.cl * ct; f.uy = this.cl * st; f.uz = this.sl;           // up (geodetic)
    f.ex = -st; f.ey = ct; f.ez = 0;                                     // east
    f.nx = -this.sl * ct; f.ny = -this.sl * st; f.nz = this.cl;          // north
    return f;
  }
}

// Topocentric look from frame f to an ECI point. Returns [az, el, range] (rad, rad, km).
export function look(f, x, y, z, out = [0, 0, 0]) {
  const dx = x - f.px, dy = y - f.py, dz = z - f.pz;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const u = (dx * f.ux + dy * f.uy + dz * f.uz) / r;
  const e = dx * f.ex + dy * f.ey + dz * f.ez;
  const n = dx * f.nx + dy * f.ny + dz * f.nz;
  let az = Math.atan2(e, n);
  if (az < 0) az += TWO_PI;
  out[0] = az; out[1] = Math.asin(u); out[2] = r;
  return out;
}

// Local ENU unit vector to an ECI point (for AR).
export function enu(f, x, y, z, out = [0, 0, 0]) {
  const dx = x - f.px, dy = y - f.py, dz = z - f.pz;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  out[0] = (dx * f.ex + dy * f.ey + dz * f.ez) / r;
  out[1] = (dx * f.nx + dy * f.ny + dz * f.nz) / r;
  out[2] = (dx * f.ux + dy * f.uy + dz * f.uz) / r;
  return out;
}

// Altitude of the Sun as seen from frame f (radians), with sun vector s.
export function sunAltitude(f, s) {
  const r = Math.hypot(s[0], s[1], s[2]);
  return Math.asin((s[0] * f.ux + s[1] * f.uy + s[2] * f.uz) / r);
}

// Fraction of the solar disk visible from the satellite (conical Earth shadow,
// Earth radius padded ~25 km for the opaque lower atmosphere). 0 = umbra, 1 = full sun.
export const SHADOW_RE = RE + 25;
export function sunlitFraction(x, y, z, s) {
  const ds = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
  const sx = s[0] / ds, sy = s[1] / ds, sz = s[2] / ds;
  const along = -(x * sx + y * sy + z * sz);          // distance behind Earth along the anti-sun axis
  if (along <= 0) return 1;
  const px = x + along * sx, py = y + along * sy, pz = z + along * sz;
  const perp = Math.sqrt(px * px + py * py + pz * pz);
  const aU = Math.asin((R_SUN - SHADOW_RE) / ds);
  const aP = Math.asin((R_SUN + SHADOW_RE) / ds);
  const rU = SHADOW_RE / Math.cos(aU) - along * Math.tan(aU);
  const rP = SHADOW_RE / Math.cos(aP) + along * Math.tan(aP);
  if (perp >= rP) return 1;
  if (perp <= rU) return 0;
  const t = (perp - rU) / (rP - rU);
  return t * t * (3 - 2 * t); // smooth limb-darkened-ish ramp
}

// Phase angle (sun–satellite–observer) in radians.
export function phaseAngle(x, y, z, f, s) {
  const ox = f.px - x, oy = f.py - y, oz = f.pz - z;
  const sx = s[0] - x, sy = s[1] - y, sz = s[2] - z;
  const c = (ox * sx + oy * sy + oz * sz) / (Math.sqrt(ox * ox + oy * oy + oz * oz) * Math.sqrt(sx * sx + sy * sy + sz * sz));
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

// Apparent magnitude from a McCants intrinsic magnitude (1000 km, full phase).
// Quicksat-style: m = M + 5 log10(r/1000) − 2.5 log10(illuminated fraction).
export function magnitude(M, rangeKm, phase, sunlit = 1, el = Math.PI / 2, extinction = 0) {
  const frac = Math.max(0.02, (1 + Math.cos(phase)) / 2) * Math.max(sunlit, 1e-4);
  let m = M + 5 * Math.log10(rangeKm / 1000) - 2.5 * Math.log10(frac);
  if (extinction > 0) m += extinction * (airmass(el) - 1);
  return m;
}

// Kasten & Young airmass, el in radians.
export function airmass(el) {
  const h = Math.max(el / DEG, 0);
  return 1 / (Math.sin(el > 0 ? el : 0) + 0.50572 * Math.pow(h + 6.07995, -1.6364));
}

// Times (ms) the Sun crosses `altDeg` between t0 and t1, sampled every 5 min and
// refined by bisection. Returns [{t, rising}].
export function sunCrossings(obs, t0, t1, altDeg) {
  const target = altDeg * DEG;
  const f = {}, s = [0, 0, 0];
  const altAt = (t) => { const jd = jdFromMs(t); obs.frame(jd, f); sunEci(jd, s); return sunAltitude(f, s) - target; };
  const res = [];
  const step = 5 * 60000;
  let ta = t0, va = altAt(ta);
  for (let tb = t0 + step; ta < t1; tb += step) {
    const tt = Math.min(tb, t1);
    const vb = altAt(tt);
    if ((va < 0) !== (vb < 0)) {
      let lo = ta, hi = tt, vlo = va;
      for (let k = 0; k < 30 && hi - lo > 500; k++) {
        const mid = (lo + hi) / 2, vm = altAt(mid);
        if ((vm < 0) === (vlo < 0)) { lo = mid; vlo = vm; } else hi = mid;
      }
      res.push({ t: (lo + hi) / 2, rising: vb > va });
    }
    ta = tt; va = vb;
  }
  return res;
}

// The dark window for the night that begins on the local calendar evening
// containing `noonMs` (any time between local noon and the next local noon).
// Returns {start, end, alwaysDark, neverDark}.
export function darkWindow(obs, noonMs, sunAltDeg) {
  const t1 = noonMs + 24 * 3.6e6;
  const f = {}, s = [0, 0, 0];
  const jd0 = jdFromMs(noonMs); obs.frame(jd0, f); sunEci(jd0, s);
  const darkAtStart = sunAltitude(f, s) < sunAltDeg * DEG;
  const xs = sunCrossings(obs, noonMs, t1, sunAltDeg);
  if (!xs.length) return darkAtStart
    ? { start: noonMs, end: t1, alwaysDark: true } : { start: noonMs, end: noonMs, neverDark: true };
  let start = darkAtStart ? noonMs : null, end = null;
  for (const x of xs) {
    if (!x.rising && start === null) start = x.t;
    else if (x.rising && start !== null && end === null) end = x.t;
  }
  if (start === null) return { start: noonMs, end: noonMs, neverDark: true };
  return { start, end: end ?? t1 };
}

// 16-point compass names.
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (azRad) => POINTS[Math.round(((azRad / DEG) % 360) / 22.5) % 16];
