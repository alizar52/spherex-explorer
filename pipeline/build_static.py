"""Build the JSON files the website reads (site/data).

Usage:
    python pipeline/build_static.py --metadata DATA/metadata.csv --fits-root DATA \
        --challenge-dir DATA/nasa_demo --out site/data --fresh

--metadata, --fits-root  team dataset; FITS files are matched by file name
--challenge-dir          one sub-folder of FITS per challenge target
--official               download the challenge targets from IRSA instead
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

sys.path.insert(0, str(Path(__file__).resolve().parent))
import spherex as sx

OFFICIAL_TARGETS = [
    {"name": "Barnard's Star", "folder": "Barnards_Star", "kind": "fast-moving star",
     "ra": 269.452079, "dec": 4.693364, "epoch": 2000.0, "pmra": -801.6, "pmdec": 10362.4,
     "note": "It moves across the sky faster than any other star, 10.4″ a year, almost due north"},
    {"name": "Epsilon Indi B", "folder": "Epsilon_Indi_B", "kind": "brown dwarf pair",
     "ra": 331.043833, "dec": -56.782694, "epoch": 1999.86, "pmra": 3961.4, "pmdec": -2538.3,
     "note": "Two brown dwarfs, too close together for SPHEREx to separate. They move 4.7″ a year together with the star ε Indi A"},
    {"name": "WISE 0855−0714", "folder": "WISE_0855", "kind": "fast-moving brown dwarf",
     "ra": 133.795129, "dec": -7.245147, "epoch": 2010.4, "pmra": -8123.0, "pmdec": 673.0,
     "note": "The coordinates in the challenge (08h55m10.831s −07d14m42.53s) are where WISE saw it in 2010. "
             "It moves 8.1″ a year to the west, so by 2026 it is about 2′ away from that spot"},
    {"name": "RW Aurigae", "folder": "RW_Aur", "kind": "variable star (T Tauri)",
     "ra": 76.956068, "dec": 30.401326, "epoch": 2000.0, "note": "A young star whose brightness changes irregularly"},
    {"name": "R Draconis", "folder": "R_Dra", "kind": "variable star (Mira)",
     "ra": 248.1675, "dec": 66.755, "epoch": 2000.0,
     "note": "A pulsating red giant that brightens and fades over about 245 days. Its position here is approximate, to about 3″"},
]
CLASS_ORDER = {"challenge": 0, "moving": 1, "variable": 2, "stable": 3}


def slugify(s: str) -> str:
    s = s.replace("−", "-").replace("'", "")
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def index_fits(root: Path) -> dict:
    idx = {}
    for dp, _, fs in os.walk(root):
        for f in fs:
            if f.lower().endswith((".fits", ".fit", ".fits.gz")):
                idx[f] = Path(dp) / f
    return idx


def cutout_info(path: Path) -> tuple[float, float, int, float]:
    """(ra, dec) of the cutout centre, its smaller side in px, and MJD."""
    with fits.open(path, memmap=False) as h:
        hd = h["IMAGE"].header
        ra, dec = WCS(hd).all_pix2world([[(hd["NAXIS1"] - 1) / 2, (hd["NAXIS2"] - 1) / 2]], 0)[0]
        return float(ra), float(dec), int(min(hd["NAXIS1"], hd["NAXIS2"])), float(hd["MJD-AVG"])


def load_frame(path: Path, ra: float, dec: float, size: int, **kw) -> sx.Frame | None:
    try:
        with fits.open(path, memmap=False) as h:
            return sx.process_hdul(h, ra, dec, size, frame_id=path.stem, meta={"file": path.name}, **kw)
    except Exception as e:
        print(f"  ! {path.name}: {type(e).__name__}: {e}")
        return None


def brightest_source(frames: list[sx.Frame]) -> tuple[float, float, float] | None:
    """Position (px) and S/N of the brightest source that is at the same place in the frames."""
    ims = np.array([sx._nan_smooth(f.image - (f.zodi if f.zodi is not None else 0), 0.8) for f in frames])
    with np.errstate(all="ignore"):
        med = np.nanmedian(ims, axis=0) if len(frames) > 1 else ims[0]
    n = med.shape[0]
    yy, xx = np.mgrid[0:n, 0:n]
    med = np.where(np.hypot(xx - (n - 1) / 2, yy - (n - 1) / 2) <= 8, med, np.nan)
    if not np.isfinite(med).any():
        return None
    iy, ix = np.unravel_index(np.nanargmax(med), med.shape)
    sig = sx.robust_sigma(med)
    snr = float((med[iy, ix] - np.nanmedian(med)) / sig) if sig and np.isfinite(sig) else 0.0
    raw = np.nanmedian(np.array([f.image - (f.zodi if f.zodi is not None else 0) for f in frames]), axis=0)
    cc = sx._centroid(raw, float(ix), float(iy), r=2.0)
    return (cc[0], cc[1], snr) if cc else (float(ix), float(iy), snr)


def build_dataset(metadata: Path, fits_root: Path, out: Path, size: int | None = None,
                  only: list[str] | None = None, demo: bool = False) -> list[dict]:
    rows = list(csv.DictReader(open(metadata, newline="", encoding="utf-8")))
    groups = defaultdict(list)
    for r in rows:
        if only and r["name"] not in only:
            continue
        groups[(r.get("class", ""), r["name"])].append(r)
    idx = index_fits(fits_root)
    (out / "targets").mkdir(parents=True, exist_ok=True)
    entries = []
    for (cls, name), rs in sorted(groups.items()):
        rs.sort(key=lambda r: float(r["epoch_mjd"]))
        paths = [(r, idx.get(Path(r["file"].replace("\\", "/")).name)) for r in rs]
        missing = sum(p is None for _, p in paths)
        paths = [(r, p) for r, p in paths if p is not None]
        if not paths:
            print(f"- {name}: no FITS found")
            continue
        coords = {(round(float(r["ra_deg"]), 5), round(float(r["dec_deg"]), 5)) for r in rs}
        tracked = len(coords) > 1 or cls == "moving"
        ra0, dec0 = float(rs[0]["ra_deg"]), float(rs[0]["dec_deg"])
        n = size or int(np.median([cutout_info(p)[2] for _, p in paths]))
        frames = []
        for r, p in paths:
            ra, dec = (float(r["ra_deg"]), float(r["dec_deg"])) if tracked else (ra0, dec0)
            f = load_frame(p, ra, dec, n, wavelength_hint=float(r["wavelength_um"]) if r.get("wavelength_um") else None)
            if f is not None:
                frames.append(f)
        if not frames:
            print(f"- {name}: no usable frames")
            continue
        shown = name.replace("_", " ")
        notes, target, off_arcsec = [], None, None
        c = (n - 1) / 2
        if tracked:
            notes.append("Each frame is centred on where the asteroid was predicted to be on that date, "
                         "so the asteroid stays in the middle and the background stars change.")
        else:
            b = brightest_source(frames)
            if b and b[2] > 30:
                off_px = math.hypot(b[0] - c, b[1] - c)
                off_arcsec = round(off_px * sx.PIXSCALE_ARCSEC, 1)
                if off_px > 1.5:
                    ra_t, dec_t = sx.target_wcs(ra0, dec0, n).all_pix2world([[b[0], b[1]]], 0)[0]
                    target = {"name": shown, "ra": float(ra_t), "dec": float(dec_t)}
                    notes.append(f"The star sits {off_arcsec}″ ({off_px:.1f} pixels) away from the centre of these images. "
                                 f"The images were centred on its catalogue position from years ago, and the star has "
                                 f"moved since then. Measurements here follow the star, not the old position.")
            else:
                notes.append("There is no clear star in these small images. It has either moved out of the 12-pixel "
                             "square since its catalogue position was measured, or it is so bright that its centre is saturated.")
        if n < 24:
            notes.append(f"These images are only {n}×{n} pixels ({n * sx.PIXSCALE_ARCSEC / 60:.1f}′ across), too small to "
                         f"search for moving objects. Only the brightness of the central object is checked.")
        if rs[0].get("label_status") and not demo:
            notes.append(f"The team dataset labels this object “{cls}”. The label has not been checked scientifically.")
        if demo:
            notes.append("Synthetic test data, not real SPHEREx images.")
        payload = sx.build_payload(frames, ra0, dec0, n, name=shown, notes=notes, tracked=tracked,
                                   source="synthetic demo" if demo else "team dataset (IRSA SPHEREx cutouts)",
                                   run_detection=not tracked, target=target,
                                   extra={"class_label": cls, "demo": demo})
        if n < 24:
            payload["detections"] = [d for d in payload["detections"] if d["kind"] == "variable"]
            for i, d in enumerate(payload["detections"]):
                d["id"] = f"C{i + 1:03d}"
        if tracked:
            payload["detections"] = [{
                "id": "C001", "kind": "moving", "x": c, "y": c, "ra": ra0, "dec": dec0, "name": shown,
                "frames": [f.id for f in frames], "track": [{"frame": f.id, "x": c, "y": c} for f in frames],
                "snr": None, "confidence": None,
                "note": "A known asteroid. Its position comes from its predicted orbit, which was used to centre the "
                        "frames. It was not measured from the images."}]
        slug = slugify(name)
        (out / "targets" / f"{slug}.json").write_text(json.dumps(payload, separators=(",", ":")))
        entries.append({"slug": slug, "name": shown, "class": cls, "ra": ra0, "dec": dec0, "size": n,
                        "frames": len(frames), "tracked": tracked, "detections": len(payload["detections"]),
                        "kinds": sorted({d["kind"] for d in payload["detections"]}),
                        "source_offset_arcsec": off_arcsec, "demo": demo})
        print(f"+ {name:<16} {cls:<9} {n:>3}px frames={len(frames):>2} det={[d['kind'] for d in payload['detections']]}"
              + (f" offset={off_arcsec}″" if off_arcsec and off_arcsec > 9 else "") + (f" missing={missing}" if missing else ""))
    return entries


def describe_target(t: dict, payload: dict) -> None:
    """Add plain-language notes and a catalogue-guided entry for the named target."""
    notes = payload["notes"]
    notes.insert(0, f"{t['note']}.")
    s = payload.get("target_summary")
    tt = payload["target_track"]
    shift = math.hypot(tt[-1]["x"] - tt[0]["x"], tt[-1]["y"] - tt[0]["y"]) if len(tt) > 1 else 0.0
    if t.get("pmra") is not None:
        pm = math.hypot(t["pmra"], t["pmdec"]) / 1000
        notes.append(f"The crosshair shows where the star catalogue says the object should be on each date, given its motion "
                     f"of {pm:.1f}″ a year. Across these frames that is a shift of {shift:.1f} pixels ({shift * sx.PIXSCALE_ARCSEC:.1f}″).")
    found = next((d for d in payload["detections"] if d.get("name") == t["name"]), None)
    if found and found["kind"] == "shifted":
        found["catalog_motion_arcsec_per_year"] = round(math.hypot(t.get("pmra", 0), t.get("pmdec", 0)) / 1000, 2)
        found["note"] = (f"Measured from these images, {t['name']} drifts {found['motion_arcsec_per_year']}″ a year. "
                         f"The star catalogue gives {found['catalog_motion_arcsec_per_year']}″ a year. The two differ because "
                         f"the measurement also picks up parallax (Earth's own orbit) and some error in finding the star's centre.")
    elif not found and s and t.get("pmra") is not None:
        c0 = tt[len(tt) // 2]
        z = s.get("snr_vs_empty_sky")
        payload["detections"].append({
            "id": f"C{len(payload['detections']) + 1:03d}", "kind": "moving", "name": t["name"],
            "x": c0["x"], "y": c0["y"], "frames": [p["frame"] for p in tt],
            "track": [{"frame": p["frame"], "x": p["x"], "y": p["y"]} for p in tt],
            "snr": z, "confidence": None, "speed_arcsec_per_day": None,
            "note": (f"Too faint for the automatic search to find in single images. Measuring exactly where the catalogue "
                     f"says it should be gives {s['mean_flux_mjy']} mJy on average over {s['frames_used']} frames"
                     + (f", {z} times the spread of the same measurement at {s['random_positions']} random spots in this field"
                        if z is not None else "")
                     + (f". {s['fraction_random_brighter'] * 100:.0f}% of those random spots are at least as bright"
                        if s.get("fraction_random_brighter") is not None else "")
                     + f". It should only shift {shift:.1f} pixels across these frames, so the images alone cannot "
                       f"show that this faint smudge is the moving brown dwarf.")})


def build_challenge(folder: Path, out: Path, size: int | None = None) -> list[dict]:
    (out / "targets").mkdir(parents=True, exist_ok=True)
    dirs = {p.name.lower(): p for p in folder.rglob("*") if p.is_dir()}
    entries = []
    for t in OFFICIAL_TARGETS:
        d = dirs.get(t["folder"].lower())
        paths = sorted(d.glob("*.fits")) if d else []
        if not paths:
            print(f"- {t['name']}: folder '{t['folder']}' not found in {folder}")
            continue
        info = [cutout_info(p) for p in paths]
        ra_c, dec_c = float(np.mean([i[0] for i in info])), float(np.mean([i[1] for i in info]))
        n = size or int(np.median([i[2] for i in info]))
        frames = [f for f in (load_frame(p, ra_c, dec_c, n) for p in paths) if f is not None]
        payload = sx.build_payload(frames, round(ra_c, 6), round(dec_c, 6), n, name=t["name"],
                                   source="team download (IRSA SPHEREx cutouts)", notes=[],
                                   target={k: t[k] for k in ("name", "ra", "dec", "epoch", "pmra", "pmdec") if k in t},
                                   extra={"class_label": "challenge", "demo": False, "kind_text": t["kind"]})
        describe_target(t, payload)
        slug = slugify(t["name"])
        (out / "targets" / f"{slug}.json").write_text(json.dumps(payload, separators=(",", ":")))
        mid = sx.predict_position(t, float(np.mean([f.mjd for f in frames])))
        entries.append({"slug": slug, "name": t["name"], "class": "challenge", "ra": round(mid[0], 6),
                        "dec": round(mid[1], 6), "center_ra": round(ra_c, 6), "center_dec": round(dec_c, 6), "size": n, "frames": len(frames), "tracked": False,
                        "detections": len(payload["detections"]),
                        "kinds": sorted({d["kind"] for d in payload["detections"]}), "demo": False})
        print(f"+ {t['name']:<16} {n:>3}px frames={len(frames)} det={[(d['kind'], d.get('name')) for d in payload['detections']]} "
              f"summary={payload['target_summary']}")
    return entries


def build_official_live(out: Path, size: int = 64, max_frames: int = 40) -> list[dict]:
    """Fetch the challenge test targets live from IRSA (needs internet)."""
    (out / "targets").mkdir(parents=True, exist_ok=True)
    entries = []
    for t in OFFICIAL_TARGETS:
        ra, dec = sx.predict_position(t, 61100.0)
        print(f"... {t['name']}: querying IRSA")
        try:
            payload = sx.fetch_live(ra, dec, size_px=size, max_frames=max_frames, name=t["name"])
        except Exception as e:
            print(f"  ! failed: {e}")
            continue
        payload["notes"].insert(0, f"{t['note']}.")
        slug = slugify(t["name"])
        (out / "targets" / f"{slug}.json").write_text(json.dumps(payload, separators=(",", ":")))
        entries.append({"slug": slug, "name": t["name"], "class": "challenge", "ra": ra, "dec": dec, "size": size,
                        "frames": len(payload["frames"]), "tracked": False,
                        "detections": len(payload["detections"]), "demo": False})
    return entries


def write_index(out: Path, entries: list[dict], fresh: bool = False):
    idx_path = out / "index.json"
    old = json.loads(idx_path.read_text()) if idx_path.exists() and not fresh else {}
    by_slug = {e["slug"]: e for e in old.get("objects", [])}
    for e in entries:
        by_slug[e["slug"]] = e
    by_slug = {k: v for k, v in by_slug.items() if (out / "targets" / f"{k}.json").exists()}
    official = []
    for t in OFFICIAL_TARGETS:
        ra, dec = sx.predict_position(t, 61100.0)
        official.append({"name": t["name"], "slug": slugify(t["name"]), "kind": t["kind"], "note": t["note"],
                         "ra": round(ra, 6), "dec": round(dec, 6)})
    data = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "official_targets": official,
        "objects": sorted(by_slug.values(), key=lambda e: (CLASS_ORDER.get(e["class"], 9), e["name"].lower())),
    }
    idx_path.write_text(json.dumps(data, indent=1, ensure_ascii=False))
    print(f"index: {len(data['objects'])} objects -> {idx_path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--metadata", type=Path, help="team dataset metadata.csv")
    ap.add_argument("--fits-root", type=Path, help="folder that contains the dataset FITS files")
    ap.add_argument("--challenge-dir", type=Path, help="folder with sub-folders of FITS for the challenge targets")
    ap.add_argument("--official", action="store_true", help="fetch the challenge targets live from IRSA")
    ap.add_argument("--out", default=Path(__file__).resolve().parents[1] / "site" / "data", type=Path)
    ap.add_argument("--size", type=int, help="frame size in px (default: size of the cutouts)")
    ap.add_argument("--only", nargs="*", help="process only these dataset object names")
    ap.add_argument("--demo", action="store_true", help="mark dataset output as synthetic demo data")
    ap.add_argument("--fresh", action="store_true", help="start a new index instead of merging into the old one")
    a = ap.parse_args()
    if not (a.metadata or a.challenge_dir or a.official):
        ap.error("nothing to do: give --metadata/--fits-root, --challenge-dir and/or --official")
    ents = []
    if a.challenge_dir:
        ents += build_challenge(a.challenge_dir, a.out, a.size)
    if a.official:
        ents += build_official_live(a.out, a.size or 64)
    if a.metadata:
        if not a.fits_root:
            ap.error("--fits-root is required with --metadata")
        ents += build_dataset(a.metadata, a.fits_root, a.out, a.size, a.only, demo=a.demo)
    write_index(a.out, ents, fresh=a.fresh)
