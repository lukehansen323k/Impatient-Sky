# Independent check of pass timing/geometry with Skyfield (same element sets).
#   python3 test/crosscheck.py passes.json
import json, sys, warnings
warnings.filterwarnings('ignore')
from skyfield.api import load, wgs84, EarthSatellite
from skyfield_data import get_skyfield_data_path
from datetime import datetime, timezone

ts = load.timescale(builtin=True)
eph = load.File(get_skyfield_data_path() + '/de421.bsp') if hasattr(load, 'File') else None
from skyfield.iokit import Loader
eph = Loader(get_skyfield_data_path())('de421.bsp')
cat = json.load(open('data/catalog.json'))
ix = {k: i for i, k in enumerate(cat['fields'])}
rows = {r[ix['id']]: r for r in cat['sats']}
job = json.load(open(sys.argv[1]))
lat, lon = job['lat'], job['lon']
site = wgs84.latlon(lat, lon, elevation_m=300)

def sat_of(r):
    omm = dict(OBJECT_NAME=r[ix['name']], OBJECT_ID=r[ix['cospar']], EPOCH=r[ix['epoch']],
               MEAN_MOTION=r[ix['n']], ECCENTRICITY=r[ix['e']], INCLINATION=r[ix['i']],
               RA_OF_ASC_NODE=r[ix['raan']], ARG_OF_PERICENTER=r[ix['argp']], MEAN_ANOMALY=r[ix['ma']],
               EPHEMERIS_TYPE=0, CLASSIFICATION_TYPE='U', NORAD_CAT_ID=r[ix['id']], ELEMENT_SET_NO=999,
               REV_AT_EPOCH=0, BSTAR=r[ix['bstar']], MEAN_MOTION_DOT=r[ix['ndot']], MEAN_MOTION_DDOT=r[ix['nddot']])
    return EarthSatellite.from_omm(ts, omm)

worst = dict(dt_start=0, dt_peak=0, del_peak=0)
for p in job['passes']:
    s = sat_of(rows[p['id']])
    def t_of(ms): return ts.from_datetime(datetime.fromtimestamp(ms / 1000, tz=timezone.utc))
    out = []
    for key in ('start', 'peak', 'end'):
        t = t_of(p[key]['t'])
        alt, az, _ = (s - site).at(t).altaz()
        lit = s.at(t).is_sunlit(eph)
        out.append((key, alt.degrees, az.degrees, bool(lit)))
    # peak time: maximise elevation finely inside the visible span
    import numpy as np
    t0, t1 = p['start']['t'], p['end']['t']
    grid = np.linspace(t0, t1, 400)
    tt = ts.from_datetimes([datetime.fromtimestamp(g / 1000, tz=timezone.utc) for g in grid])
    alt = (s - site).at(tt).altaz()[0].degrees
    i = int(alt.argmax())
    dpk = (grid[i] - p['peak']['t']) / 1000
    del_ = alt[i] - p['peak']['el']
    # where does Skyfield say visibility starts? (alt>=10 & sunlit) around the start
    win = np.linspace(t0 - 60000, t0 + 60000, 241)
    tw = ts.from_datetimes([datetime.fromtimestamp(g / 1000, tz=timezone.utc) for g in win])
    a = (s - site).at(tw).altaz()[0].degrees
    l = s.at(tw).is_sunlit(eph)
    vis = (a >= job['minEl']) & l
    k = int(np.argmax(vis)) if vis.any() else -1
    dst = (win[k] - t0) / 1000 if k >= 0 else float('nan')
    worst['dt_start'] = max(worst['dt_start'], abs(dst)); worst['dt_peak'] = max(worst['dt_peak'], abs(dpk)); worst['del_peak'] = max(worst['del_peak'], abs(del_))
    print(f"{p['name'][:22]:22} start Δ{dst:+5.1f}s  peak Δt {dpk:+5.1f}s Δel {del_:+.2f}°  ends: alt {out[2][1]:5.1f} lit={out[2][3]}  starts lit={out[0][3]} alt {out[0][1]:.1f}")
print('worst', worst)
