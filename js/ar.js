// Impatient Sky — Sky View. Camera + motion sensors + compass, with every
// satellite near or above the horizon drawn at its live position and brightness.
import { DEG, TWO_PI, Observer, jdFromMs, moonEci, sunEci, enu, moonPhase, gmst, compass } from './astro.js';
import { STARS, LINES, radecToEnu, planets, precessStar } from './sky-objects.js';
import { declination } from './vendor/geomag.min.mjs';

const $ = (s) => document.querySelector(s);
const LIVE_STRIDE = 10;
let sensorsGranted = false;

// ---------------------------------------------------------------- quaternions
const qMul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
const qAxis = (x, y, z, ang) => { const s = Math.sin(ang / 2); return [Math.cos(ang / 2), x * s, y * s, z * s]; };
// W3C DeviceOrientation: R = Rz(alpha) · Rx(beta) · Ry(gamma), device → earth (x east, y north, z up)
const qFromEuler = (a, b, g) => qMul(qMul(qAxis(0, 0, 1, a * DEG), qAxis(1, 0, 0, b * DEG)), qAxis(0, 1, 0, g * DEG));
function qSlerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map((x) => -x); d = -d; }
  if (d > 0.9995) { const r = a.map((x, i) => x + t * (b[i] - x)); const n = Math.hypot(...r); return r.map((x) => x / n); }
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((x, i) => wa * x + wb * b[i]);
}
function qToMat(q) {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

export function openAR(ctx) {
  const { engine, loc, settings, byId, target, fmtMag, pretty, fmtT, countdown } = ctx;
  const root = $('#ar'), video = $('#ar-video'), canvas = $('#ar-canvas');
  const g = canvas.getContext('2d');
  const obs = new Observer(loc.lat, loc.lon, loc.alt || 0);
  const decl = declination(loc.lat, loc.lon, new Date());

  const st = {
    mode: null,            // 'sensor' | 'manual'
    q: null, qTarget: null, gotEvent: false,
    absolute: false,
    yawOffset: null,       // deg: true azimuth = relative azimuth + yawOffset
    offsetSamples: 0, uprightSeen: false, compassAcc: null,
    manualYaw: 180, manualPitch: 35,
    live: null, livePending: false, lastLiveReq: 0,
    selected: target ? { kind: 'sat', id: target.id } : null,
    aligning: false,
    hits: [],
    stream: null,
    running: true,
    W: 0, H: 0, dpr: 1, f: 600,
    lastReadout: 0,
  };
  window.__iskyAR = st;
  if (target) { st.manualYaw = target.start.az; st.manualPitch = Math.max(15, target.peak.el * 0.6); }

  // ------------------------------------------------------------ sizing
  function resize() {
    st.dpr = Math.min(2, window.devicePixelRatio || 1);
    st.W = root.clientWidth; st.H = root.clientHeight;
    canvas.width = Math.round(st.W * st.dpr); canvas.height = Math.round(st.H * st.dpr);
    focal();
  }
  function focal() {
    // focal length in CSS px from the camera's long-side field of view and how the
    // video is scaled to cover the screen
    const fov = (settings.fov || 67) * DEG;
    let longPx = Math.max(st.W, st.H);
    if (st.stream && video.videoWidth) {
      const vw = video.videoWidth, vh = video.videoHeight;
      const sc = Math.max(st.W / vw, st.H / vh);
      longPx = Math.max(vw, vh) * sc;
    }
    st.f = longPx / 2 / Math.tan(fov / 2);
  }
  addEventListener('resize', resize);
  resize();

  // ------------------------------------------------------------ sensors
  function screenAngle() {
    const a = screen.orientation?.angle ?? window.orientation ?? 0;
    return (((a % 360) + 360) % 360) * DEG;
  }
  function onOrient(e) {
    if (e.alpha === null && e.beta === null) return;
    st.gotEvent = true;
    const q = qFromEuler(e.alpha || 0, e.beta || 0, e.gamma || 0);
    st.qTarget = q;
    if (!st.q) st.q = q;
    if (e.type === 'deviceorientationabsolute' || (e.absolute && e.webkitCompassHeading === undefined)) {
      st.absolute = true;
      st.yawOffset = decl; // alpha is referenced to magnetic north
      return;
    }
    const h = e.webkitCompassHeading;
    if (h === undefined || h === null || Number.isNaN(h)) return;
    st.compassAcc = e.webkitCompassAccuracy;
    if (e.webkitCompassAccuracy !== undefined && e.webkitCompassAccuracy < 0) return;
    const R = qToMat(q);
    // device +y (top) and -z (camera) in the relative world frame
    const yx = R[1], yy = R[4], zx = -R[2], zy = -R[5], zz = -R[8];
    const hy = Math.hypot(yx, yy), hz = Math.hypot(zx, zy);
    let relAz = null, upright = false;
    if (hz > 0.8 && Math.abs(zz) < 0.6) { relAz = Math.atan2(zx, zy) / DEG; upright = true; } // camera near the horizon
    else if (hy > 0.9) relAz = Math.atan2(yx, yy) / DEG;                                        // phone lying flat
    if (relAz === null) return;
    if (upright && !st.uprightSeen) { st.uprightSeen = true; st.offsetSamples = 0; } // prefer camera-direction samples
    if (!upright && st.uprightSeen) return;
    const sample = h + decl - relAz;
    if (st.yawOffset === null || st.offsetSamples === 0) st.yawOffset = sample;
    else {
      const d = wrap180(sample - st.yawOffset);
      const k = st.offsetSamples < 40 ? 0.25 : Math.abs(d) > 20 ? 0.01 : 0.04;
      st.yawOffset += k * d;
    }
    st.offsetSamples++;
  }

  async function startSensors() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') throw new Error('Motion & orientation access was denied');
      }
      const evt = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
      addEventListener(evt, onOrient);
      st.evt = evt;
      sensorsGranted = true;
      st.mode = 'sensor';
      setTimeout(() => {
        if (!st.gotEvent && st.running) { st.mode = 'manual'; hint('No motion sensors found, so drag to look around.', 4000); }
      }, 1500);
    } catch (e) {
      st.mode = 'manual';
      hint(`${e.message}. Drag to look around instead.`, 5000);
    }
  }

  async function startCamera() {
    root.classList.toggle('nocam', !settings.camera);
    if (!settings.camera || !navigator.mediaDevices?.getUserMedia) { video.hidden = true; return; }
    try {
      st.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      video.srcObject = st.stream;
      video.hidden = false;
      await video.play().catch(() => {});
      video.onloadedmetadata = focal;
      setTimeout(focal, 600);
    } catch (e) {
      video.hidden = true;
      root.classList.add('nocam');
      hint('Camera unavailable, so showing the sky chart only.', 3500);
    }
  }
  function stopCamera() {
    if (st.stream) for (const t of st.stream.getTracks()) t.stop();
    st.stream = null; video.srcObject = null; video.hidden = true;
  }

  // ------------------------------------------------------------ manual look-around
  let drag = null;
  function onDown(e) {
    const p = e.touches ? e.touches[0] : e;
    drag = { x: p.clientX, y: p.clientY, moved: 0 };
  }
  function onMove(e) {
    if (!drag) return;
    const p = e.touches ? e.touches[0] : e;
    const dx = p.clientX - drag.x, dy = p.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = p.clientX; drag.y = p.clientY;
    if (st.mode === 'manual') {
      const k = (1 / st.f) / DEG;
      st.manualYaw = (st.manualYaw - dx * k + 360) % 360;
      st.manualPitch = Math.max(-20, Math.min(89.9, st.manualPitch + dy * k));
    }
    if (e.cancelable) e.preventDefault();
  }
  function onUp(e) {
    if (drag && drag.moved < 8) {
      const p = e.changedTouches ? e.changedTouches[0] : e;
      const r = canvas.getBoundingClientRect();
      pick(p.clientX - r.left, p.clientY - r.top);
    }
    drag = null;
  }
  canvas.addEventListener('touchstart', onDown, { passive: true });
  canvas.addEventListener('touchmove', onMove, { passive: false });
  canvas.addEventListener('touchend', onUp);
  canvas.addEventListener('mousedown', onDown);
  addEventListener('mousemove', onMove);
  addEventListener('mouseup', onUp);

  function pick(x, y) {
    let best = null, bd = 40 * 40;
    for (const h of st.hits) {
      const d = (h.x - x) ** 2 + (h.y - y) ** 2;
      if (d < bd) { bd = d; best = h; }
    }
    st.selected = best ? { kind: best.kind, id: best.id } : null;
    renderCard(true);
  }

  // ------------------------------------------------------------ live satellite positions
  const liveMax = () => Math.min(8, settings.limit + 1.5);
  async function pollLive() {
    if (!st.running || st.livePending) return;
    st.livePending = true;
    try {
      const t = Date.now() + 150;
      const m = await engine.liveTick(t, { extinction: settings.extinction ? 0.2 : 0, showShadow: settings.showShadow }, liveMax());
      if (!st.running) return;
      st.live = { t: m.t, rows: m.rows, ids: m.ids };
    } catch (e) { console.error(e); }
    st.livePending = false;
  }

  // ------------------------------------------------------------ projection
  let M = null; // world(true ENU) → device
  function buildMatrix() {
    let R;
    let off;
    if (st.mode === 'sensor' && st.q) {
      st.q = qSlerp(st.q, st.qTarget, 0.35);
      R = qToMat(st.q);
      off = (st.yawOffset ?? decl) + (settings.yawTrim || 0);
    } else {
      // manual: camera looks at (yaw, pitch); device upright in portrait
      const yaw = st.manualYaw * DEG, pit = st.manualPitch * DEG;
      const q = qMul(qAxis(0, 0, 1, -yaw), qAxis(1, 0, 0, Math.PI / 2 + pit));
      R = qToMat(q);
      off = 0;
    }
    const co = Math.cos(off * DEG), so = Math.sin(off * DEG);
    // w_rel = Yaw(-off) · w_true ; device = Rᵀ · w_rel
    // Rᵀ rows = R columns
    const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
    const Y = [co, -so, 0, so, co, 0, 0, 0, 1];
    M = [
      Rt[0] * Y[0] + Rt[1] * Y[3], Rt[0] * Y[1] + Rt[1] * Y[4], Rt[2],
      Rt[3] * Y[0] + Rt[4] * Y[3], Rt[3] * Y[1] + Rt[4] * Y[4], Rt[5],
      Rt[6] * Y[0] + Rt[7] * Y[3], Rt[6] * Y[1] + Rt[7] * Y[4], Rt[8],
    ];
    st.sa = st.mode === 'sensor' ? screenAngle() : 0;
    st.cs = Math.cos(st.sa); st.sn = Math.sin(st.sa);
  }
  // project ENU unit vector → [x, y, depth]  (depth > 0 means in front)
  const P = [0, 0, 0];
  function project(e, n, u) {
    const dx = M[0] * e + M[1] * n + M[2] * u;
    const dy = M[3] * e + M[4] * n + M[5] * u;
    const dz = M[6] * e + M[7] * n + M[8] * u;
    const depth = -dz;
    const sx = dx * st.cs - dy * st.sn, sy = dx * st.sn + dy * st.cs;
    const k = st.f / Math.max(depth, 1e-3);
    P[0] = st.W / 2 + sx * k; P[1] = st.H / 2 - sy * k; P[2] = depth;
    return P;
  }
  // camera direction in true ENU (third row of M, negated)
  function cameraDir() {
    const e = -M[6], n = -M[7], u = -M[8];
    let az = Math.atan2(e, n) / DEG; if (az < 0) az += 360;
    return { az, el: Math.asin(Math.max(-1, Math.min(1, u))) / DEG, e, n, u };
  }
  const azelToEnu = (az, el) => [Math.cos(el * DEG) * Math.sin(az * DEG), Math.cos(el * DEG) * Math.cos(az * DEG), Math.sin(el * DEG)];

  // ------------------------------------------------------------ drawing
  const FONT = '-apple-system, "SF Pro Text", system-ui, sans-serif';
  function label(x, y, text, sub, color, bold = true) {
    g.font = `${bold ? 600 : 500} 13px ${FONT}`;
    const w = g.measureText(text).width + (sub ? g.measureText(' ' + sub).width + 4 : 0) + 16;
    const lx = x + 12, ly = y - 26;
    g.fillStyle = 'rgba(8,12,26,0.55)';
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 0.75;
    g.beginPath(); g.roundRect ? g.roundRect(lx, ly, w, 22, 11) : g.rect(lx, ly, w, 22); g.fill(); g.stroke();
    g.fillStyle = color;
    g.fillText(text, lx + 8, ly + 15.5);
    if (sub) {
      const tw = g.measureText(text).width;
      g.font = `700 13px ui-rounded, ${FONT}`;
      g.fillStyle = 'rgba(255,217,119,0.95)';
      g.fillText(sub, lx + 8 + tw + 6, ly + 15.5);
    }
    return { x: lx, y: ly, w, h: 22 };
  }
  const overlaps = (a, list) => list.some((b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);

  function drawSky(now) {
    const W = st.W, H = st.H;
    g.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    st.hits = [];
    const placed = [];

    // altitude rings + horizon
    g.lineWidth = 1;
    for (const el of [0, 30, 60]) {
      g.strokeStyle = el === 0 ? 'rgba(120,200,255,0.55)' : 'rgba(255,255,255,0.12)';
      g.lineWidth = el === 0 ? 1.5 : 1;
      if (el) g.setLineDash([4, 6]); else g.setLineDash([]);
      g.beginPath();
      let pen = false;
      for (let az = 0; az <= 360; az += 3) {
        const v = azelToEnu(az, el);
        const p = project(v[0], v[1], v[2]);
        if (p[2] > 0.08 && Math.abs(p[0]) < W * 4 && Math.abs(p[1]) < H * 4) { if (pen) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); pen = true; } else pen = false;
      }
      g.stroke();
    }
    g.setLineDash([]);
    // ground tint below the horizon
    const dn = project(0, 0, -1);
    if (dn[2] > 0.05) {
      const grd = g.createRadialGradient(dn[0], dn[1], 0, dn[0], dn[1], st.f * 1.6);
      grd.addColorStop(0, 'rgba(2,6,14,0.55)'); grd.addColorStop(1, 'rgba(2,6,14,0)');
      g.fillStyle = grd; g.fillRect(0, 0, W, H);
    }
    // compass points
    g.font = `700 15px ${FONT}`; g.textAlign = 'center';
    for (let i = 0; i < 8; i++) {
      const az = i * 45, v = azelToEnu(az, 1.5), p = project(v[0], v[1], v[2]);
      if (p[2] > 0.1 && p[0] > -40 && p[0] < W + 40 && p[1] > -20 && p[1] < H + 20) {
        g.fillStyle = i === 0 ? '#ff6b6b' : i % 2 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.9)';
        g.fillText(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][i], p[0], p[1] - 4);
      }
    }
    const z = project(0, 0, 1);
    if (z[2] > 0.1) { g.fillStyle = 'rgba(255,255,255,0.35)'; g.font = `600 11px ${FONT}`; g.fillText('ZENITH', z[0], z[1] + 4); }
    g.textAlign = 'left';

    // stars & asterisms
    const jd = jdFromMs(now);
    const lst = gmst(jd) + obs.lon;
    const starPos = {};
    for (const s of STARS) {
      const [ra, dec] = precessStar(s[1], s[2], jd);
      const v = radecToEnu(ra, dec, lst, obs.lat);
      if (v[2] < -0.05) continue;
      const p = project(v[0], v[1], v[2]);
      if (p[2] <= 0.05) continue;
      starPos[s[0]] = [p[0], p[1]];
      if (p[0] < -10 || p[0] > W + 10 || p[1] < -10 || p[1] > H + 10) continue;
      const r = Math.max(0.8, 2.6 - s[3] * 0.6);
      g.fillStyle = 'rgba(220,230,255,0.85)';
      g.beginPath(); g.arc(p[0], p[1], r, 0, TWO_PI); g.fill();
      st.hits.push({ kind: 'star', id: s[0], x: p[0], y: p[1], az: Math.atan2(v[0], v[1]) / DEG, el: Math.asin(v[2]) / DEG, mag: s[3] });
      if (s[3] < 1.0) { g.font = `500 11px ${FONT}`; g.fillStyle = 'rgba(200,215,255,0.5)'; g.fillText(s[0], p[0] + 6, p[1] + 12); }
    }
    g.strokeStyle = 'rgba(150,180,255,0.18)'; g.lineWidth = 1;
    g.beginPath();
    for (const [a, b] of LINES) { const A = starPos[a], B = starPos[b]; if (A && B) { g.moveTo(A[0], A[1]); g.lineTo(B[0], B[1]); } }
    g.stroke();

    // sun, moon, planets
    const f = obs.frame(jd, {});
    const sun = sunEci(jd), moon = moonEci(jd);
    const sv = enu(f, sun[0], sun[1], sun[2], []);
    const mv = enu(f, moon[0], moon[1], moon[2], []);
    const bodies = [];
    if (mv[2] > -0.05) bodies.push({ name: 'Moon', v: mv, mag: -12, sub: `${Math.round(moonPhase(sun, moon) * 100)}%`, color: '#fff7e0', r: 9 });
    if (sv[2] > -0.05) bodies.push({ name: 'Sun', v: sv, mag: -26, sub: '', color: '#ffcf6b', r: 10 });
    for (const pl of planets(jd)) {
      const v = radecToEnu(pl.ra, pl.dec, lst, obs.lat);
      if (v[2] > -0.05) bodies.push({ name: pl.name, v, mag: pl.mag, sub: fmtMag(pl.mag), color: '#ffe3b0', r: Math.max(2.5, 4.5 - pl.mag * 0.5) });
    }
    for (const b of bodies) {
      const p = project(b.v[0], b.v[1], b.v[2]);
      if (p[2] <= 0.05 || p[0] < -30 || p[0] > W + 30 || p[1] < -30 || p[1] > H + 30) continue;
      g.fillStyle = b.color;
      g.shadowColor = b.color; g.shadowBlur = 12;
      g.beginPath(); g.arc(p[0], p[1], b.r, 0, TWO_PI); g.fill();
      g.shadowBlur = 0;
      const box = label(p[0], p[1], b.name, b.sub, 'rgba(255,236,200,0.95)', false);
      placed.push(box);
      st.hits.push({ kind: 'body', id: b.name, x: p[0], y: p[1], az: Math.atan2(b.v[0], b.v[1]) / DEG, el: Math.asin(b.v[2]) / DEG, mag: b.mag });
    }

    // satellites
    const L = st.live;
    let up = 0, brightest = null;
    const offscreen = [];
    if (L) {
      const dt = (now - L.t) / 1000;
      const n = L.ids.length;
      const order = [];
      for (let k = 0; k < n; k++) order.push(k);
      const R = L.rows;
      order.sort((a, b) => R[a * LIVE_STRIDE + 7] - R[b * LIVE_STRIDE + 7]); // brightest first for label priority
      for (const k of order) {
        const o = k * LIVE_STRIDE;
        let e = R[o + 1] + R[o + 4] * dt, nn = R[o + 2] + R[o + 5] * dt, u = R[o + 3] + R[o + 6] * dt;
        const len = Math.hypot(e, nn, u); e /= len; nn /= len; u /= len;
        const mag = R[o + 7], lit = R[o + 8], id = L.ids[k];
        if (st.selected?.kind === 'sat' && st.selected.id === id) {
          st.selInfo = { kind: 'sat', id, mag, lit, az: (Math.atan2(e, nn) / DEG + 360) % 360, el: Math.asin(u) / DEG, range: R[o + 9], t: now, off: true };
        }
        if (u < 0) continue;
        const visible = lit >= 0.1 && mag <= settings.limit;
        const near = lit >= 0.1 && !visible;
        if (visible) { up++; if (!brightest || mag < brightest.mag) brightest = { id, mag }; }
        const p = project(e, nn, u);
        const x = p[0], y = p[1];
        const isSel = st.selected?.kind === 'sat' && st.selected.id === id;
        const inView = p[2] > 0.05 && x > -20 && x < W + 20 && y > -20 && y < H + 20;
        if (!inView) {
          if ((visible && mag <= settings.limit - 0.5) || isSel) offscreen.push({ id, mag, e, n: nn, u, isSel });
          continue;
        }
        // motion tail (last ~20 s)
        const te = e - R[o + 4] * 20, tn = nn - R[o + 5] * 20, tu = u - R[o + 6] * 20;
        const tp = (visible || isSel) ? project(te, tn, tu) : null;
        if (tp && tp[2] > 0.05) {
          const grd = g.createLinearGradient(tp[0], tp[1], x, y);
          grd.addColorStop(0, 'rgba(160,200,255,0)');
          grd.addColorStop(1, visible ? 'rgba(160,200,255,0.55)' : 'rgba(160,200,255,0.18)');
          g.strokeStyle = grd; g.lineWidth = visible ? 2 : 1;
          g.beginPath(); g.moveTo(tp[0], tp[1]); g.lineTo(x, y); g.stroke();
        }
        const r = lit < 0.1 ? 2.5 : Math.max(1.6, Math.min(7, 4.4 - 0.65 * mag));
        if (lit < 0.1) {
          g.strokeStyle = 'rgba(160,170,200,0.45)'; g.lineWidth = 1;
          g.beginPath(); g.arc(x, y, r, 0, TWO_PI); g.stroke();
        } else {
          const col = mag <= -1 ? '#ffd977' : mag <= 1.5 ? '#ffffff' : visible ? '#cfe0ff' : 'rgba(170,190,240,0.6)';
          g.fillStyle = col;
          if (mag <= 2) { g.shadowColor = col; g.shadowBlur = 10; }
          g.beginPath(); g.arc(x, y, r, 0, TWO_PI); g.fill();
          g.shadowBlur = 0;
        }
        if (isSel) {
          g.strokeStyle = '#63e6a5'; g.lineWidth = 2;
          g.beginPath(); g.arc(x, y, r + 8, 0, TWO_PI); g.stroke();
        }
        const az = Math.atan2(e, nn) / DEG, el = Math.asin(u) / DEG;
        st.hits.push({ kind: 'sat', id, x, y, mag, lit, az: (az + 360) % 360, el, range: R[o + 9] });
        if (visible || isSel || (near && mag <= settings.limit + 0.5 && placed.length < 6)) {
          const sat = byId.get(id);
          const name = sat ? pretty(sat.name) : String(id);
          const tryBox = { x: x + 12, y: y - 26, w: (name.length + 6) * 7.4 + 16, h: 22 };
          if (isSel || placed.length < 28 && !overlaps(tryBox, placed)) {
            placed.push(label(x, y, name, lit < 0.1 ? 'shadow' : fmtMag(mag), isSel ? '#63e6a5' : visible ? '#ffffff' : 'rgba(210,220,255,0.7)'));
          }
        }
      }
    }
    st.count = up; st.brightest = brightest;

    // edge arrows for bright satellites outside the frame
    offscreen.sort((a, b) => (b.isSel - a.isSel) || a.mag - b.mag);
    for (const o of offscreen.slice(0, 6)) edgeArrow(o.e, o.n, o.u, o.isSel ? '#63e6a5' : 'rgba(255,255,255,0.8)', `${pretty(byId.get(o.id)?.name || '')} ${fmtMag(o.mag)}`);

    // pass target that hasn't risen yet
    if (target && target.start.t > now) {
      const v = azelToEnu(target.start.az, Math.max(target.start.el, 2));
      const p = project(v[0], v[1], v[2]);
      const txt = `${pretty(target.name)} appears in ${countdown(target.start.t - now)}`;
      if (p[2] > 0.05 && p[0] > 0 && p[0] < W && p[1] > 0 && p[1] < H) {
        g.strokeStyle = '#63e6a5'; g.lineWidth = 2; g.setLineDash([5, 5]);
        g.beginPath(); g.arc(p[0], p[1], 22, 0, TWO_PI); g.stroke(); g.setLineDash([]);
        label(p[0] + 14, p[1], txt, '', '#63e6a5');
      } else edgeArrow(v[0], v[1], v[2], '#63e6a5', txt);
    }

    // reticle
    g.strokeStyle = st.aligning ? '#63e6a5' : 'rgba(255,255,255,0.35)';
    g.lineWidth = st.aligning ? 2 : 1;
    g.beginPath(); g.arc(W / 2, H / 2, st.aligning ? 26 : 16, 0, TWO_PI); g.stroke();
  }

  function edgeArrow(e, n, u, color, text) {
    const W = st.W, H = st.H;
    // direction on screen: project a point and if behind, flip
    const dx = M[0] * e + M[1] * n + M[2] * u, dy = M[3] * e + M[4] * n + M[5] * u;
    let sx = dx * st.cs - dy * st.sn, sy = -(dx * st.sn + dy * st.cs);
    const L = Math.hypot(sx, sy) || 1; sx /= L; sy /= L;
    const m = 34, cx = W / 2, cy = H / 2;
    const tx = sx > 0 ? (W - m - cx) / sx : sx < 0 ? (m - cx) / sx : Infinity;
    const ty = sy > 0 ? (H - 150 - cy) / sy : sy < 0 ? (110 - cy) / sy : Infinity;
    const t = Math.min(tx, ty);
    const x = cx + sx * t, y = cy + sy * t;
    const a = Math.atan2(sy, sx);
    g.fillStyle = color;
    g.beginPath(); g.moveTo(x + 12 * Math.cos(a), y + 12 * Math.sin(a));
    g.lineTo(x + 8 * Math.cos(a + 2.4), y + 8 * Math.sin(a + 2.4));
    g.lineTo(x + 8 * Math.cos(a - 2.4), y + 8 * Math.sin(a - 2.4)); g.closePath(); g.fill();
    g.font = `600 12px ${FONT}`;
    const w = g.measureText(text).width;
    const lx = Math.max(8, Math.min(W - w - 8, x - (sx > 0.3 ? w + 18 : sx < -0.3 ? -18 : w / 2)));
    const ly = y + (sy > 0.3 ? -16 : sy < -0.3 ? 26 : 4);
    g.fillStyle = 'rgba(8,12,26,0.6)'; g.fillRect(lx - 6, ly - 13, w + 12, 18);
    g.fillStyle = color; g.fillText(text, lx, ly);
  }

  // ------------------------------------------------------------ readout & card
  const card = $('#ar-card'), readout = $('#ar-readout');
  function renderCard(force) {
    const now = Date.now();
    if (!force && now - st.lastReadout < 250) return;
    st.lastReadout = now;
    if (M) {
      const c = cameraDir();
      const calib = st.mode === 'sensor' && !st.absolute && st.yawOffset === null ? ' · finding north…' : '';
      readout.textContent = `${compass(c.az * DEG)} ${Math.round(c.az)}° · ${Math.round(c.el)}° up${calib}`;
    }
    let sel = st.selected && st.hits.find((h) => h.kind === st.selected.kind && h.id === st.selected.id);
    if (!sel && st.selInfo && st.selected?.id === st.selInfo.id && now - st.selInfo.t < 1500) sel = st.selInfo;
    if (st.aligning) {
      const name = sel ? (sel.kind === 'sat' ? pretty(byId.get(sel.id)?.name || '') : sel.id) : null;
      card.innerHTML = `<div class="an">Align the sky</div><div class="as">${name
        ? `Put the real <b>${name}</b> in the green circle, then tap <b>Lock</b>.`
        : 'First tap the label of something you can see in the sky: the Moon, a planet, a bright star or a satellite.'}</div>`;
      return;
    }
    if (sel && sel.kind === 'sat') {
      const sat = byId.get(sel.id) || {};
      card.innerHTML = `<div class="an"><span>${pretty(sat.name || String(sel.id))}</span><span class="mag ${sel.lit < 0.1 ? 'm4' : sel.mag <= -1 ? 'm0' : sel.mag <= 1.5 ? 'm1' : sel.mag <= 3 ? 'm2' : 'm3'}">${sel.lit < 0.1 ? 'in shadow' : fmtMag(sel.mag)}</span></div>
        <div class="as">${sel.el < 0 ? 'Below the horizon' : `${Math.round(sel.el)}° up`} · ${compass(sel.az * DEG)} ${Math.round(sel.az)}° · ${Math.round(sel.range).toLocaleString()} km away${sat.n ? ` · ${Math.round(1440 / sat.n)} min orbit` : ''}${sel.off && sel.el >= 0 ? ' · follow the arrow' : ''}</div>`;
    } else if (sel) {
      card.innerHTML = `<div class="an"><span>${sel.id}</span><span class="mag m1">${sel.kind === 'body' && sel.mag < -20 ? '' : fmtMag(sel.mag)}</span></div><div class="as">${Math.round(sel.el)}° up · ${compass(sel.az * DEG)} ${Math.round(sel.az)}°</div>`;
    } else if (st.selected?.kind === 'sat' && target && target.id === st.selected.id) {
      card.innerHTML = `<div class="an"><span>${pretty(target.name)}</span><span class="mag m1">${fmtMag(target.mag)}</span></div>
        <div class="as">${target.start.t > now ? `Appears ${fmtT(target.start.t)} in the ${compass(target.start.az * DEG)} · follow the green arrow` : target.end.t < now ? 'This pass is over.' : 'Below the horizon or out of sight right now.'}</div>`;
    } else {
      const b = st.brightest;
      card.innerHTML = `<div class="an"><span>${st.count ?? 0} satellite${st.count === 1 ? '' : 's'} visible</span><span class="as">brighter than ${fmtMag(settings.limit)}</span></div>
        <div class="as">${b ? `Brightest now: ${pretty(byId.get(b.id)?.name || '')} ${fmtMag(b.mag)} · ` : ''}Tap anything to identify it.</div>`;
    }
  }

  let hintTimer = 0;
  function hint(text, ms = 3000) {
    const h = $('#ar-hint');
    h.textContent = text; h.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { h.hidden = true; }, ms);
  }

  // ------------------------------------------------------------ align & trim
  const alignBtn = $('#ar-align');
  function onAlign() {
    if (!st.aligning) {
      st.aligning = true; alignBtn.textContent = 'Lock'; alignBtn.classList.add('on');
      if (st.mode !== 'sensor') hint('Align works with the motion sensors on.', 3000);
      renderCard(true);
      return;
    }
    const sel = st.selected && st.hits.find((h) => h.kind === st.selected.kind && h.id === st.selected.id);
    if (sel && st.mode === 'sensor') {
      const c = cameraDir();
      const d = wrap180(sel.az - c.az);
      settings.yawTrim = Math.round(wrap180((settings.yawTrim || 0) + d) * 10) / 10;
      ctx.save();
      hint(`Aligned: turned the sky ${d > 0 ? '+' : ''}${d.toFixed(1)}°`, 2500);
    }
    st.aligning = false; alignBtn.textContent = 'Align'; alignBtn.classList.remove('on');
    renderCard(true);
  }
  const trim = (d) => () => {
    if (st.mode === 'manual') { st.manualYaw = (st.manualYaw - d + 360) % 360; return; }
    settings.yawTrim = Math.round(((settings.yawTrim || 0) + d) * 10) / 10; ctx.save();
    hint(`Compass correction ${settings.yawTrim > 0 ? '+' : ''}${settings.yawTrim.toFixed(1)}°`, 1200);
  };
  const trimL = trim(-1), trimR = trim(1);
  alignBtn.onclick = onAlign;
  $('#ar-trim-l').onclick = trimL;
  $('#ar-trim-r').onclick = trimR;
  $('#ar-cam').onclick = () => {
    settings.camera = !settings.camera; ctx.save();
    if (settings.camera) startCamera(); else { stopCamera(); root.classList.add('nocam'); }
  };

  // ------------------------------------------------------------ loop
  let raf = 0, liveTimer = 0;
  function frame() {
    if (!st.running) return;
    raf = requestAnimationFrame(frame);
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    buildMatrix();
    drawSky(now);
    renderCard(false);
  }

  async function begin() {
    $('#ar-start').hidden = true;
    await startSensors();
    startCamera();
    await engine.startLive(loc.lat, loc.lon, loc.alt || 0);
    pollLive();
    liveTimer = setInterval(pollLive, 500);
    if (target) hint(`Tracking ${pretty(target.name)}. Follow the green arrow.`, 3500);
    frame();
  }

  function close() {
    st.running = false;
    cancelAnimationFrame(raf);
    clearInterval(liveTimer);
    if (st.evt) removeEventListener(st.evt, onOrient);
    removeEventListener('resize', resize);
    removeEventListener('mousemove', onMove);
    removeEventListener('mouseup', onUp);
    canvas.removeEventListener('touchstart', onDown);
    canvas.removeEventListener('touchmove', onMove);
    canvas.removeEventListener('touchend', onUp);
    canvas.removeEventListener('mousedown', onDown);
    stopCamera();
    root.hidden = true;
    document.body.style.overflow = '';
  }

  root.hidden = false;
  document.body.style.overflow = 'hidden';
  resize();
  $('#ar-close').onclick = close;
  alignBtn.textContent = 'Align'; alignBtn.classList.remove('on');
  card.innerHTML = '';
  readout.textContent = 'Sky View';
  if (sensorsGranted) begin();
  else {
    $('#ar-start').hidden = false;
    $('#ar-go').onclick = () => begin();
    $('#ar-nosensor').onclick = async () => {
      $('#ar-start').hidden = true;
      st.mode = 'manual';
      settings.camera = false;
      root.classList.add('nocam');
      await engine.startLive(loc.lat, loc.lon, loc.alt || 0);
      pollLive();
      liveTimer = setInterval(pollLive, 500);
      hint('Drag to look around.', 2500);
      frame();
    };
  }
  return close;
}
