// Impatient Sky — Moon, planets and bright stars for the sky view.
import { DEG, TWO_PI, gmst, moonEci, sunEci, moonPhase } from './astro.js';

// Brightest stars: name, RA (h), Dec (deg), V mag (J2000).
export const STARS = [
  ['Sirius', 6.7525, -16.716, -1.46], ['Canopus', 6.3992, -52.696, -0.74], ['Arcturus', 14.261, 19.182, -0.05],
  ['Rigil Kentaurus', 14.66, -60.834, -0.27], ['Vega', 18.6156, 38.784, 0.03], ['Capella', 5.2782, 45.998, 0.08],
  ['Rigel', 5.2423, -8.202, 0.13], ['Procyon', 7.655, 5.225, 0.34], ['Achernar', 1.6286, -57.237, 0.46],
  ['Betelgeuse', 5.9195, 7.407, 0.5], ['Hadar', 14.0637, -60.373, 0.61], ['Altair', 19.8464, 8.868, 0.76],
  ['Acrux', 12.4433, -63.099, 0.76], ['Aldebaran', 4.5987, 16.509, 0.86], ['Antares', 16.4901, -26.432, 0.96],
  ['Spica', 13.4199, -11.161, 0.97], ['Pollux', 7.7553, 28.026, 1.14], ['Fomalhaut', 22.9608, -29.622, 1.16],
  ['Deneb', 20.6905, 45.28, 1.25], ['Mimosa', 12.7954, -59.689, 1.25], ['Regulus', 10.1395, 11.967, 1.35],
  ['Adhara', 6.9771, -28.972, 1.5], ['Castor', 7.5767, 31.888, 1.58], ['Shaula', 17.5601, -37.104, 1.62],
  ['Bellatrix', 5.4189, 6.35, 1.64], ['Elnath', 5.4382, 28.608, 1.65], ['Alnilam', 5.6036, -1.202, 1.69],
  ['Alnitak', 5.6793, -1.943, 1.77], ['Alioth', 12.9005, 55.96, 1.77], ['Dubhe', 11.0621, 61.751, 1.79],
  ['Mirfak', 3.4054, 49.861, 1.79], ['Wezen', 7.1399, -26.393, 1.83], ['Kaus Australis', 18.4029, -34.385, 1.85],
  ['Alkaid', 13.7923, 49.313, 1.86], ['Menkalinan', 5.9921, 44.948, 1.9], ['Alhena', 6.6285, 16.399, 1.92],
  ['Polaris', 2.5303, 89.264, 1.98], ['Mirzam', 6.3783, -17.956, 1.98], ['Alphard', 9.4598, -8.659, 1.98],
  ['Hamal', 2.1196, 23.463, 2.0], ['Diphda', 0.7265, -17.987, 2.04], ['Nunki', 18.9211, -26.297, 2.05],
  ['Mirach', 1.1622, 35.621, 2.05], ['Alpheratz', 0.1398, 29.091, 2.06], ['Rasalhague', 17.5822, 12.56, 2.07],
  ['Kochab', 14.8451, 74.156, 2.08], ['Saiph', 5.7959, -9.67, 2.09], ['Almach', 2.065, 42.33, 2.1],
  ['Algol', 3.1361, 40.956, 2.12], ['Denebola', 11.8177, 14.572, 2.13], ['Navi', 0.9451, 60.717, 2.15],
  ['Mintaka', 5.5334, -0.299, 2.23], ['Mizar', 13.3988, 54.925, 2.23], ['Sadr', 20.3705, 40.257, 2.23],
  ['Alphecca', 15.5781, 26.715, 2.23], ['Schedar', 0.6751, 56.537, 2.24], ['Eltanin', 17.9434, 51.489, 2.24],
  ['Caph', 0.1529, 59.15, 2.28], ['Merak', 11.0307, 56.382, 2.37], ['Enif', 21.7364, 9.875, 2.39],
  ['Scheat', 23.0629, 28.083, 2.42], ['Phecda', 11.8972, 53.695, 2.44], ['Markab', 23.0793, 15.205, 2.48],
  ['Gienah', 20.7702, 33.97, 2.48], ['Ruchbah', 1.4302, 60.235, 2.68], ['Algenib', 0.2206, 15.183, 2.83],
  ['Fawaris', 19.7496, 45.131, 2.87], ['Albireo', 19.512, 27.96, 3.08], ['Megrez', 12.2571, 57.033, 3.31],
  ['Segin', 1.9066, 63.67, 3.37],
];

// A few asterisms to help find your bearings in the sky view.
export const LINES = [
  ['Dubhe', 'Merak'], ['Merak', 'Phecda'], ['Phecda', 'Megrez'], ['Megrez', 'Dubhe'], ['Megrez', 'Alioth'],
  ['Alioth', 'Mizar'], ['Mizar', 'Alkaid'],
  ['Betelgeuse', 'Bellatrix'], ['Betelgeuse', 'Alnitak'], ['Bellatrix', 'Mintaka'], ['Mintaka', 'Alnilam'],
  ['Alnilam', 'Alnitak'], ['Alnitak', 'Saiph'], ['Mintaka', 'Rigel'],
  ['Caph', 'Schedar'], ['Schedar', 'Navi'], ['Navi', 'Ruchbah'], ['Ruchbah', 'Segin'],
  ['Vega', 'Deneb'], ['Deneb', 'Altair'], ['Altair', 'Vega'],
  ['Alpheratz', 'Scheat'], ['Scheat', 'Markab'], ['Markab', 'Algenib'], ['Algenib', 'Alpheratz'],
  ['Deneb', 'Sadr'], ['Sadr', 'Albireo'], ['Gienah', 'Sadr'], ['Sadr', 'Fawaris'],
];

// Unit ENU vector for RA/Dec (radians) at local sidereal time lst, latitude lat.
export function radecToEnu(ra, dec, lst, lat, out = [0, 0, 0]) {
  const H = lst - ra;
  const sd = Math.sin(dec), cd = Math.cos(dec), sl = Math.sin(lat), cl = Math.cos(lat);
  const ch = Math.cos(H), sh = Math.sin(H);
  out[2] = sl * sd + cl * cd * ch;         // up
  out[1] = cl * sd - sl * cd * ch;         // north
  out[0] = -cd * sh;                       // east
  return out;
}

// Planet positions from Standish's approximate Keplerian elements (1800–2050).
const EL = {
  Mercury: [0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 252.2503235, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081, -0.6, 0.038],
  Venus: [0.72333566, 0.0000039, 0.00677672, -0.00004107, 3.39467605, -0.0007889, 181.9790995, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418, -4.47, 0.013],
  Earth: [1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0, 0, 0, 0],
  Mars: [1.52371034, 0.00001847, 0.0933941, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343, -1.52, 0.016],
  Jupiter: [5.202887, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106, -9.4, 0.005],
  Saturn: [9.53667594, -0.0012506, 0.05386179, -0.00050991, 2.48599187, 0.00193609, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794, -8.88, 0.044],
};

// Mallama & Hilton (2018) phase laws, α in degrees.
const PHASE_MAG = {
  Mercury: (a) => -0.613 + 6.328e-2 * a - 1.6336e-3 * a ** 2 + 3.3644e-5 * a ** 3 - 3.4265e-7 * a ** 4 + 1.6893e-9 * a ** 5 - 3.0334e-12 * a ** 6,
  Venus: (a) => (a <= 163.7
    ? -4.384 - 1.044e-3 * a + 3.687e-4 * a ** 2 - 2.814e-6 * a ** 3 + 8.938e-9 * a ** 4
    : 236.05828 - 2.81914 * a + 8.39034e-3 * a ** 2),
  Mars: (a) => -1.601 + 2.267e-2 * a - 1.302e-4 * a ** 2,
  Jupiter: (a) => -9.395 - 3.7e-4 * a + 6.16e-4 * a ** 2,
  Saturn: () => -8.95,
};

// J2000 → date precession for star coordinates (good to a few arcsec over decades).
export function precessStar(raH, decDeg, jd) {
  const yrs = (jd - 2451545.0) / 365.25;
  const ra = raH * 15 * DEG, dec = decDeg * DEG;
  const dra = (3.075 + 1.336 * Math.sin(ra) * Math.tan(dec)) * 15 * yrs / 3600 * DEG;
  const ddec = 20.04 * Math.cos(ra) * yrs / 3600 * DEG;
  return [ra + dra, dec + ddec];
}

function helio(name, T) {
  const e0 = EL[name];
  const a = e0[0] + e0[1] * T, e = e0[2] + e0[3] * T, I = (e0[4] + e0[5] * T) * DEG;
  const L = (e0[6] + e0[7] * T) * DEG, w = (e0[8] + e0[9] * T) * DEG, O = (e0[10] + e0[11] * T) * DEG;
  const om = w - O;
  let M = (L - w) % TWO_PI;
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 6; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const co = Math.cos(om), so = Math.sin(om), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
  return [
    (co * cO - so * sO * cI) * xp + (-so * cO - co * sO * cI) * yp,
    (co * sO + so * cO * cI) * xp + (-so * sO + co * cO * cI) * yp,
    so * sI * xp + co * sI * yp,
  ];
}

export function planets(jd) {
  const T = (jd - 2451545.0) / 36525;
  const eps = 23.43928 * DEG;
  const earth = helio('Earth', T);
  const out = [];
  for (const name of ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']) {
    const p = helio(name, T);
    const g0 = [p[0] - earth[0], p[1] - earth[1], p[2] - earth[2]];
    // precess ecliptic longitude from J2000 to the date (1.397°/century)
    const pr = 1.3970 * DEG * T, cp = Math.cos(pr), sp = Math.sin(pr);
    const g = [g0[0] * cp - g0[1] * sp, g0[0] * sp + g0[1] * cp, g0[2]];
    const x = g[0], y = g[1] * Math.cos(eps) - g[2] * Math.sin(eps), z = g[1] * Math.sin(eps) + g[2] * Math.cos(eps);
    const ra = Math.atan2(y, x), dec = Math.atan2(z, Math.hypot(x, y));
    const r = Math.hypot(...p), d = Math.hypot(...g), R = Math.hypot(...earth);
    const ph = Math.acos(Math.max(-1, Math.min(1, (r * r + d * d - R * R) / (2 * r * d)))) / DEG;
    const mag = 5 * Math.log10(r * d) + PHASE_MAG[name](ph);
    out.push({ name, ra, dec, mag });
  }
  return out;
}

export function moonAndSun(jd, lat, lonRad) {
  const m = moonEci(jd), s = sunEci(jd);
  return { moon: m, sun: s, phase: moonPhase(s, m), lst: gmst(jd) + lonRad };
}
