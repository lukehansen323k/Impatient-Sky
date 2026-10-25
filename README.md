# Impatient Sky

A phone-first web app that shows the brightest satellite passes over you tonight and for the next week, plus a live AR **Sky View** that labels every satellite overhead with its real-time brightness. It rebuilds its orbit data every 2 hours and computes everything on the phone, so passes are exact for wherever you're standing.

**Tabs**
- **Tonight**: countdown to the next pass, dark window, Moon, and a table of every pass brighter than your limit (start time, satellite, peak magnitude, max altitude, direction). Tap a pass for its sky chart, appear/peak/disappear times, brightness curve, an .ics calendar reminder, and links to Heavens-Above and N2YO for cross-checking.
- **Upcoming**: the next 7 nights, each computed in the background, plus the brightest passes of the week.
- **Settings**: brightness limit (−2 to 7), minimum altitude, how dark the sky must be, Starlink / megaconstellation toggles, atmospheric dimming, manual location, Liquid Glass clear ↔ tinted, red night-vision mode, 24-hour time, Sky View options.
- **Sky View** (round button): camera + gyro + compass. Satellites, the Moon, planets and bright stars at their live positions; brightness tags, motion tails, arrows to bright satellites off screen, and a green arrow to a pass you chose to watch. **Align** fixes compass error: tap the label of something you can see, centre the real object, tap **Lock**.

## How it works

```
GitHub Action (every 2 h)
  └─ scripts/build-data.mjs
       ├─ CelesTrak GP elements (OMM JSON): visual, stations, active, last-30-days
       ├─ Space-Track full catalog (optional, see below)
       ├─ McCants qs.mag intrinsic magnitudes (daily)
       ├─ CelesTrak SATCAT radar cross-sections (daily, fallback brightness estimate)
       └─ data/catalog.json (~16k objects, ~800 KB gzipped) + data/meta.json
  └─ deploys Pages; keeps the last good catalog on the data-snapshot branch

Phone
  ├─ polls data/meta.json every 10 min and reloads the catalog when it changes
  ├─ 2–4 Web Workers run SGP4 for every object that could beat your limit
  │    (horizon-gap skipping + coarse grid + 10 s refinement, conical Earth shadow,
  │     phase-angle magnitude, optional extinction)
  └─ one more worker streams live positions to Sky View twice a second
```

Heavens-Above has no API and N2YO's allows 100 pass requests an hour per satellite, so neither can feed "every satellite brighter than X". Impatient Sky does what they do internally (SGP4 on the official element sets plus intrinsic magnitudes) and links each pass to both sites so you can compare.

Brightness: McCants intrinsic magnitude (1000 km range, full phase) → `m = M + 5·log10(range/1000) − 2.5·log10(illuminated fraction)`, dimmed in Earth's penumbra and, optionally, by atmospheric extinction (0.2 mag/airmass). Starlink, OneWeb, Qianfan, Guowang and BlueBird use published photometry (Mallama et al. 2025).

## Optional: full catalog via Space-Track

CelesTrak's public groups cover active satellites plus the ~150 brightest rocket bodies. To include every tracked rocket body and object, make a free account at [space-track.org](https://www.space-track.org) and add two repo secrets: `SPACETRACK_USER` and `SPACETRACK_PASS` (Settings → Secrets and variables → Actions).

## Run locally

```bash
node scripts/build-data.mjs     # pull real data into ./data (Node 20+)
python3 -m http.server 8080     # http://localhost:8080
node test/engine-test.mjs 39.74 -83.81 3.5   # print tonight's passes for a location
```
Sky View needs HTTPS for the camera and motion sensors, so test it on the deployed site.

## Files
| Path | What it does |
|---|---|
| `index.html`, `css/app.css` | Shell and Liquid Glass styling |
| `js/app.js` | Data, location, nights, tables, settings, detail sheet |
| `js/engine.js`, `js/worker.js` | Worker pool |
| `js/passes.js` | Pass search and live-sky propagation |
| `js/astro.js` | Frames, Sun/Moon, shadow, magnitude, twilight |
| `js/ar.js`, `js/sky-objects.js` | Sky View, stars, planets |
| `js/vendor/` | satellite.js (SGP4) and WMM2025 declination, bundled |
| `scripts/build-data.mjs` | Data builder used by the Action |
| `test/` | Engine check and a Skyfield cross-check |

Orbital data: CelesTrak (T.S. Kelso). Intrinsic magnitudes: Mike McCants. Not affiliated with Heavens-Above or N2YO.
