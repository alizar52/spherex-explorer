"""
hint from agent:

live search server.

GET /api/frames?ra=&dec=&fov=&detector=&max_frames=   frames for any position, from IRSA
GET /api/resolve?name=                                 object name to coordinates (CDS Sesame)
GET /api/catalog?cat=gaia|allwise&ra=&dec=&radius=     catalogue sources around a position
GET /api/health

Run: uvicorn backend.app:app --port 8000
"""
from __future__ import annotations

import os
import io
import logging
import re
import sys
import time
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from starlette.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
import spherex as sx

app = FastAPI(title="ASPAN EON API", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])

MAX_FITS_BYTES = 16 * 1024 * 1024


@lru_cache(maxsize=1)
def _classifier():
    import torch
    from backend.predict import FitsClassifier

    torch.set_num_threads(1)
    return FitsClassifier(ROOT / "backend" / "best_cnn.pt")


def _classify_cutout(payload):
    try:
        classifier = _classifier()
    except Exception:
        logging.exception("Could not load the classification model")
        raise HTTPException(503, "The classification model is unavailable.") from None
    try:
        content = payload.getvalue()
        result = classifier.predict([io.BytesIO(content)])
    
        import numpy as np
        from astropy.io import fits

        with fits.open(io.BytesIO(content), memmap=False) as hdus:
            image = np.asarray(hdus['IMAGE'].data, dtype=np.float64)
        valid = np.isfinite(image)
        low, high = np.percentile(image[valid], [1, 99.5])
        display = np.zeros(image.shape)
        
        
        
        
        
        
        if high > low:
            display[valid] = np.arcsinh(10 * np.clip(
                (image[valid] - low) / (high - low), 0, 1)) / np.arcsinh(10)
        result['preview'] = {
            'width': image.shape[1], 'height': image.shape[0],
            'pixels': np.rint(display * 255).astype(np.uint8).ravel().tolist(),
        }
        return result
    except (ValueError, KeyError, OSError, TypeError, IndexError):
        raise HTTPException(422, "Use a readable SPHEREx FITS cutout with a 2D IMAGE extension, up to 84×84 pixels") from None


@app.post("/api/classify")
async def classify(request: Request):

    with io.BytesIO() as payload:
        async for chunk in request.stream():
            if payload.tell() + len(chunk) > MAX_FITS_BYTES:
                raise HTTPException(413, "The FITS file must be 16 MB or smaller")
            payload.write(chunk)
        if not payload.tell():
            raise HTTPException(400, "Select a FITS file.")
        
        
        if payload.getbuffer()[:9] != b"SIMPLE  =":
            raise HTTPException(422, "Please upload an uncompressed FITS file")
        
        
        payload.seek(0)
        return await run_in_threadpool(_classify_cutout, payload)


@lru_cache(maxsize=64)
def _frames_cached(ra: float, dec: float, fov: int, detector: int, max_frames: int):
    t0 = time.time()
    payload = sx.fetch_live(ra, dec, size_px=fov, detector=detector or None, max_frames=max_frames)
    payload["elapsed_s"] = round(time.time() - t0, 1)
    return payload


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/frames")
def frames(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
           fov: int = Query(64, ge=24, le=200), detector: int = Query(0, ge=0, le=6),
           max_frames: int = Query(30, ge=2, le=80)):
    key = (round(ra, 5), round(dec, 5), int(fov), int(detector), int(max_frames))
    try:
        data = _frames_cached(*key)
    except Exception as e:
        raise HTTPException(502, f"IRSA request HAS failed, NOOB: {type(e).__name__}: {e}")
    if not data["frames"]:
        raise HTTPException(404, "No SPHEREx images cover this position yet (or IRSA returned none)")
    return JSONResponse(data, headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/resolve")
def resolve(name: str = Query(..., min_length=1, max_length=80)):
    import httpx
    from urllib.parse import quote
    url = "https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV?" + quote(name)
    try:
        txt = httpx.get(url, timeout=20).text
    except Exception as e:
        raise HTTPException(502, f"name resolver unavailable: {e}")
    m = re.search(r"^%J\s+([\d.+-]+)\s+([\d.+-]+)", txt, re.M)
    if not m:
        raise HTTPException(404, f"'{name}' not found")
    return {"name": name, "ra": float(m.group(1)), "dec": float(m.group(2))}


CATALOGS = {
    "gaia": ("I/355/gaiadr3", "RA_ICRS", "DE_ICRS", "Gmag", "Gaia DR3 (epoch 2016.0)"),
    "allwise": ("II/328/allwise", "RAJ2000", "DEJ2000", "W1mag", "AllWISE (epoch ~2010.5)"),
}


@lru_cache(maxsize=128)
def _catalog(cat: str, ra: float, dec: float, radius_arcsec: float):
    import httpx
    table, rac, decc, magc, label = CATALOGS[cat]
    params = {"-source": table, "-c": f"{ra} {dec}", "-c.rs": f"{radius_arcsec:.0f}",
              "-out": f"{rac},{decc},{magc}", "-out.max": "800", "-sort": magc}
    txt = httpx.get("https://vizier.cds.unistra.fr/viz-bin/asu-tsv", params=params, timeout=30).text
    rows = []
    for line in txt.splitlines():
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        parts = line.split("\t")
        try:
            rows.append([float(parts[0]), float(parts[1]), float(parts[2]) if parts[2].strip() else None])
        except (ValueError, IndexError):
            continue
    return {"catalog": cat, "label": label, "mag": magc, "sources": rows}


@app.get("/api/catalog")
def catalog(cat: str = Query("gaia", pattern="^(gaia|allwise)$"), ra: float = Query(..., ge=0, lt=360),
            dec: float = Query(..., ge=-90, le=90), radius: float = Query(300, ge=10, le=900)):
    try:
        return _catalog(cat, round(ra, 5), round(dec, 5), round(radius))
    except Exception as e:
        raise HTTPException(502, f"VizieR request failed: {e}")


SITE = ROOT / "site"
if SITE.exists() and os.environ.get("SERVE_SITE", "1") == "1":
    app.mount("/", StaticFiles(directory=SITE, html=True), name="site")
