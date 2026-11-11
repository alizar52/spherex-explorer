---
title: SPHEREx Explorer
emoji: 🔭
colorFrom: indigo
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# SPHEREx Explorer

**NASA Space Apps Challenge 2026 · Planet X and SPHEREx**

A public web tool: enter the coordinates of a patch of sky (RA, Dec) and watch NASA SPHEREx infrared images of that patch play like a little video. Things that move or change stand out, and an algorithm marks them for you.

## Features (mapped to the challenge)

| Challenge asks for | Where in the tool |
|---|---|
| Enter RA/Dec, show a series of images like a little video | Search box (degrees, `h m s d m s`, or a name) + **Time-lapse** player |
| Test on Barnard's Star, ε Indi B, WISE 0855, RW Aur, R Dra | One-click chips under *Challenge test targets* (results below) |
| Easy to update with new data releases | Live mode queries IRSA every time; `build_static.py` re-builds prepared data |
| Use the 102 bands creatively; co-add each detector array | **D1–D6** filter + **Stack** (mean) per array; **Target spectrum** built on the fly from every frame |
| Add or subtract images taken at different times | **Difference** (A−B), **Stack** mean / max ("trail") / current−mean |
| Let users choose the field of view | *Field of view* 3.3′–13.1′ |
| Overlay Gaia / WISE | Gaia DR3 and AllWISE markers on the image + Aladin Lite sky atlas |
| Query by coordinates in the URL / embed | `?ra=…&dec=…&fov=…`, **Share / embed** button, `&embed=1` |
| Show metadata like contamination flags | Flagged-pixel overlay, quality-mask layer, flag counts by name per frame (transient, overflow, …), PSF width, file names |
| Use Astropy / Aladin | Astropy pipeline; Aladin Lite atlas |

Also: blink A/B, side-by-side, swipe, zodiacal-light removal, noise map, stretch (linear/sqrt/log/asinh), colour maps, light curve, change list with object inspector.

## Results on the challenge test targets (real SPHEREx data, detector D6, 4.4–5.0 µm)

| Target | Frames | What the tool shows |
|---|---|---|
| Barnard's Star | 8 (Aug 2025 – Mar 2026) | Found automatically as *shifted position*: measured drift 11.9″/yr, 1.2 px in these frames (catalogue proper motion 10.4″/yr; the measured value also contains parallax). Core is saturated, so its brightness is not reliable. |
| Epsilon Indi B | 8 (Apr – Sep 2025) | Found automatically as *shifted position*: 4.5″/yr (catalogue 4.7″/yr), 0.3 px in these frames. Spectrum 16–26 mJy across 4.4–5.0 µm. |
| WISE 0855−0714 | 8 (May 2025 – Apr 2026) | Too faint for the automatic search. Forced measurement at the catalogue-predicted position: 0.52 mJy, 4.3× the empty-sky scatter; 6 % of random places in the field are as bright. Predicted shift in these frames is 1.3 px — the images alone do not prove the motion. The challenge coordinates are its 2010 position; by 2026 it is about 2′ west of them. |
| RW Aurigae | 8 | Core flagged (overflow) in every frame → no reliable light curve from D6. |
| R Draconis | 8 (12 days) | Heavily saturated (22 % of pixels flagged) → no measurement. |

No change is reported in any of the 50 comparison / variable-star fields of the team dataset (12×12 px cutouts): there the tool only checks the central source, and most of those stars have flagged (saturated) cores.

## How it works

1. **Find images** – IRSA TAP query on `spherex.plane`/`spherex.artifact` for every spectral image whose footprint contains the position.
2. **Cut out** – IRSA cutout service (`…fits?center=ra,dec&size=deg`) downloads only a small square.
3. **Align** – every cutout is resampled with its WCS (TAN-SIP) onto one north-up grid (6.15″ pixels), so stars stay still and movers move.
4. **Clean** – FLAGS bits TRANSIENT, OVERFLOW, SUR_ERROR, NONFUNC, DICHROIC, MISSING_DATA, HOT, COLD, NONLINEAR (0,1,2,6,7,9,10,11,15) mark bad pixels; SOURCE, PERSIST, OUTLIER, BLOOM are shown but not masked. ZODI is subtracted; VARIANCE gives the noise. Wavelength at the target comes from the spectral WCS (`WCS-WAVE` table).
5. **Measure** – 2 px aperture at the target → light curve and spectrum (each frame sits at its own wavelength).
6. **Detect changes** (`pipeline/spherex.py: detect_changes`), per detector array:
   - *moving*: sources absent from the median sky that lie on one straight line in time order (≥3 frames) → asteroids, comets
   - *shifted*: a source whose centroid drifts linearly with time: ≥2.5″/yr, >6σ, fit rms <0.25 px → proper motion
   - *variable*: flux ratio between two frames of nearly the same wavelength differs from the same ratio of the other field stars by >6σ and >25 % (differential photometry); a lone source needs wavelengths within 1 %
   - *transient*: strong one-frame spot (often a cosmic ray the flags missed)
   - for a named target with catalogue proper motion: forced photometry at the predicted positions, compared with ~400 random places of the same field

   Scores are heuristic, not probabilities. An ML model can write the same JSON fields (see below).

## Project layout

```
site/            static website (HTML/CSS/JS, no build step)
  data/          prepared JSON (index.json + targets/*.json)
  js/config.js   apiBase = URL of the live API
pipeline/
  spherex.py       core: IRSA query, cutouts, alignment, photometry, change detection
  build_static.py  FITS (team dataset + challenge targets) → site/data
  make_demo.py     synthetic SPHEREx-like FITS for testing (clearly labelled as synthetic)
backend/app.py   FastAPI: /api/frames, /api/resolve, /api/catalog (+ serves the site)
Dockerfile       for Hugging Face Spaces
```

## Run locally

```bash
pip install -r backend/requirements.txt
# prepared data: team dataset (metadata.csv + FITS) and the challenge targets (nasa_demo folder)
python pipeline/build_static.py --metadata DATASET/metadata.csv --fits-root DATASET \
       --challenge-dir DATASET/nasa_demo --out site/data --fresh
# alternative for the challenge targets: fetch them live from IRSA (all six detectors, needs internet)
python pipeline/build_static.py --official --out site/data
# website + live API on http://localhost:8000
uvicorn backend.app:app --port 8000
```

Synthetic test data only: `python pipeline/make_demo.py --out demo_data && python pipeline/build_static.py --metadata demo_data/metadata.csv --fits-root demo_data --out site/data --demo`

## Deploy for free

**Option A — everything on Hugging Face Spaces (recommended).** Create a Space → SDK *Docker* → push this repository (this README's header already configures it). Site and live API run together at `https://<user>-<space>.hf.space`. Free CPU Spaces sleep when unused; the first request after sleep takes ~30 s.

**Option B — site on GitHub Pages, API on Hugging Face.** Publish the `site/` folder with GitHub Pages and set `apiBase` in `site/js/config.js` to the Space URL. Without an API the site still works with prepared objects.

## Data format (for adding ML results)

`site/data/targets/<slug>.json` → `detections` is a list of:

```json
{"id": "C001", "kind": "moving|shifted|variable|transient", "x": 31.2, "y": 40.8,
 "ra": 133.79, "dec": -7.24, "frames": ["frame_id", "..."],
 "track": [{"frame": "frame_id", "x": 31.2, "y": 40.8}],
 "confidence": 0.87, "snr": 12.3, "note": "optional text"}
```

`x, y` are pixels of the aligned frame (0-based, `y` up = north, `x` increases to the west). `center` is the sky position of the frame centre, `target` / `target_track` the object of interest and its position in every frame. Any model that writes this format shows up in the UI without code changes.

## Credits

SPHEREx Quick Release data: NASA/IPAC Infrared Science Archive (IRSA) — cite the release DOIs listed by IRSA. Gaia DR3 (ESA), AllWISE (NASA/JPL/IPAC) via CDS VizieR. Aladin Lite and Sesame by CDS, Strasbourg. Astropy, NumPy, SciPy, FastAPI.
