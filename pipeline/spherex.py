"""
SPHEREx Explorer — core data pipeline.

Turns SPHEREx Level-2 Spectral Image MEFs (full images or IRSA cutouts) into
small, aligned "frames" the web app can play as a time-lapse:

  * every frame is resampled onto the same north-up grid centred on the
    requested RA/Dec, so moving objects really move and stars stay put;
  * IMAGE, ZODI, sqrt(VARIANCE) and a bad-pixel mask (from FLAGS) are kept;
  * the central wavelength at the target comes from the spectral WCS ("W");
  * a simple aperture measurement at the target gives a light curve / spectrum;
  * a change detector compares frames and lists what moved / brightened.

The same code is used by:
  build_static.py  — offline, from local FITS (e.g. the team dataset)
  backend/app.py   — live, querying IRSA for any coordinates
"""
from __future__ import annotations

import base64
import concurrent.futures as cf
import csv
import io
import math
import re
from dataclasses import dataclass, field
from typing import Iterable

import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS, FITSFixedWarning
from scipy import ndimage
import warnings

warnings.simplefilter("ignore", FITSFixedWarning)
warnings.filterwarnings("ignore", message="All-NaN slice encountered")
from astropy import log as _aplog
_aplog.setLevel("WARNING")  # the spectral WCS ("W") re-uses a header with SIP terms; astropy INFO is noise

IRSA = "https://irsa.ipac.caltech.edu"
TAP_SYNC = f"{IRSA}/TAP/sync"
PIXSCALE_ARCSEC = 6.15  # SPHEREx native pixel

# SPHEREx detector arrays and their approximate wavelength coverage (µm)
DETECTORS = {
    1: (0.75, 1.09), 2: (1.10, 1.62), 3: (1.63, 2.41),
    4: (2.42, 3.82), 5: (3.83, 4.41), 6: (4.42, 5.00),
}

# FLAGS bits treated as "bad pixel". Bit 21 (SOURCE) only marks pixels that
# contain known sources and must NOT be masked. Check against the table of
# flags in the SPHEREx Explanatory Supplement if IRSA changes the definitions.
FLAG_NAMES = {0: "TRANSIENT", 1: "OVERFLOW", 2: "SUR_ERROR", 4: "PHANTOM", 5: "REFERENCE", 6: "NONFUNC",
              7: "DICHROIC", 9: "MISSING_DATA", 10: "HOT", 11: "COLD", 12: "FULLSAMPLE", 14: "PHANMISS",
              15: "NONLINEAR", 17: "PERSIST", 19: "OUTLIER", 21: "SOURCE", 26: "BLOOM"}
BAD_BITS = [0, 1, 2, 6, 7, 9, 10, 11, 15]
BAD_MASK = sum(1 << b for b in BAD_BITS)
MIN_PM_ARCSEC_YR = 2.5   # smallest proper motion reported (about 0.4 px per year)


# ----------------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------------
def detector_from_name(name: str | None) -> int | None:
    """level2_2026W38_1A_0606_1D6_spx... -> 6 ; 'SPHEREx-D3' -> 3"""
    if not name:
        return None
    m = re.search(r"_\d+D(\d)_spx", name) or re.search(r"D(\d)\b", name)
    return int(m.group(1)) if m else None


def detector_from_wavelength(wl: float | None) -> int | None:
    if wl is None or not np.isfinite(wl):
        return None
    for d, (lo, hi) in DETECTORS.items():
        if lo - 0.01 <= wl <= hi + 0.01:
            return d
    return None


def b64(arr: np.ndarray, dtype) -> str:
    return base64.b64encode(np.ascontiguousarray(arr, dtype=dtype).tobytes()).decode()


def mjd_to_iso(mjd: float) -> str:
    return Time(mjd, format="mjd").isot[:19] + "Z"


def target_wcs(ra: float, dec: float, size_px: int, pixscale: float = PIXSCALE_ARCSEC) -> WCS:
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(size_px + 1) / 2, (size_px + 1) / 2]
    w.wcs.cdelt = [-pixscale / 3600.0, pixscale / 3600.0]
    return w


def robust_sigma(a: np.ndarray) -> float:
    a = a[np.isfinite(a)]
    if a.size < 10:
        return float("nan")
    med = np.median(a)
    return float(1.4826 * np.median(np.abs(a - med)))


# ----------------------------------------------------------------------------
# One observation -> one aligned frame
# ----------------------------------------------------------------------------
@dataclass
class Frame:
    id: str
    mjd: float
    detector: int | None
    wavelength_um: float | None
    bandwidth_um: float | None
    image: np.ndarray          # MJy/sr, resampled, NaN = no data
    zodi: np.ndarray | None    # MJy/sr
    noise: np.ndarray | None   # sqrt(variance), MJy/sr
    bad: np.ndarray            # bool, flagged pixels
    meta: dict = field(default_factory=dict)
    image_masked: np.ndarray | None = None  # image with flagged input pixels removed before resampling

    @property
    def clean(self) -> np.ndarray:
        """zodi-subtracted image with flagged pixels set to NaN"""
        base = self.image_masked if self.image_masked is not None else self.image
        im = base - (self.zodi if self.zodi is not None else 0.0)
        im = np.where(self.bad, np.nan, im)
        return im


def _ext(hdul: fits.HDUList, name: str):
    try:
        return hdul[name]
    except KeyError:
        return None


def process_hdul(hdul: fits.HDUList, ra: float, dec: float, size_px: int,
                 frame_id: str, mjd: float | None = None,
                 wavelength_hint: float | None = None,
                 detector_hint: int | None = None,
                 meta: dict | None = None, min_coverage: float = 0.2) -> Frame | None:
    """Resample one SPHEREx spectral image (MEF) onto a north-up grid."""
    img_hdu = _ext(hdul, "IMAGE")
    if img_hdu is None:
        img_hdu = hdul[1 if len(hdul) > 1 else 0]
    hdr = img_hdu.header
    data = np.asarray(img_hdu.data, dtype=np.float64)
    if data.ndim != 2:
        return None
    wcs_in = WCS(hdr)

    out_wcs = target_wcs(ra, dec, size_px)
    yy, xx = np.mgrid[0:size_px, 0:size_px]
    sky_ra, sky_dec = out_wcs.all_pix2world(xx, yy, 0)
    try:
        px, py = wcs_in.all_world2pix(sky_ra, sky_dec, 0, quiet=True)
    except Exception:
        px, py = wcs_in.wcs_world2pix(sky_ra, sky_dec, 0)
    coords = np.array([py, px])

    def resample(arr, order=1, fill=np.nan):
        arr = np.asarray(arr, dtype=np.float64)
        finite = np.isfinite(arr)
        filled = np.where(finite, arr, 0.0)
        val = ndimage.map_coordinates(filled, coords, order=order, mode="constant", cval=0.0)
        wt = ndimage.map_coordinates(finite.astype(float), coords, order=order, mode="constant", cval=0.0)
        out = np.where(wt > 0.5, val / np.maximum(wt, 1e-9), fill)
        return out

    image = resample(data)
    if np.isfinite(image).mean() < min_coverage:
        return None  # this image barely overlaps the requested frame

    fl_hdu = _ext(hdul, "FLAGS")
    image_masked = None
    if fl_hdu is not None and fl_hdu.data is not None:
        badsrc = (np.asarray(fl_hdu.data).astype(np.int64) & BAD_MASK) != 0
        # the image is interpolated bilinearly, so a flagged input pixel leaks into up to four
        # output pixels: mark every output pixel that takes more than 15 % of its value from one
        bad = ndimage.map_coordinates(badsrc.astype(float), coords, order=1, mode="constant", cval=1.0) > 0.15
        image_masked = resample(np.where(badsrc, np.nan, data))
    else:
        bad = np.zeros_like(image, dtype=bool)
    bad |= ~np.isfinite(image)

    zodi = None
    z_hdu = _ext(hdul, "ZODI")
    if z_hdu is not None and z_hdu.data is not None:
        zodi = resample(z_hdu.data)
    noise = None
    v_hdu = _ext(hdul, "VARIANCE")
    if v_hdu is not None and v_hdu.data is not None:
        noise = np.sqrt(np.clip(resample(v_hdu.data), 0, None))

    # Central wavelength at the target from the spectral WCS (key "W")
    wl, bw = wavelength_hint, None
    try:
        swcs = WCS(hdr, fobj=hdul, key="W")
        swcs.sip = None
        tx, ty = wcs_in.all_world2pix([[ra, dec]], 0)[0]
        w, b = swcs.pixel_to_world_values(tx, ty)
        if np.isfinite(w):
            wl, bw = float(w), float(b)
    except Exception:
        pass

    if mjd is None:
        for key in ("MJD-AVG", "MJD-OBS", "MJD_AVG", "MJD-BEG"):
            if key in hdr or key in hdul[0].header:
                mjd = float(hdr.get(key, hdul[0].header.get(key)))
                break
    if mjd is None:
        return None

    det = hdr.get("DETECTOR") or detector_hint or detector_from_wavelength(wl)
    det = int(det) if det else None
    meta = dict(meta or {})
    for key, name in (("OBSID", "obsid"), ("PSF_FWHM", "psf_fwhm_arcsec"), ("EXPTIME", "exptime_s")):
        if key in hdr:
            meta[name] = round(float(hdr[key]), 2) if isinstance(hdr[key], float) else hdr[key]
    flag_counts = {}
    if fl_hdu is not None and fl_hdu.data is not None:
        fl = np.asarray(fl_hdu.data).astype(np.int64)
        for bit, fname in FLAG_NAMES.items():
            c = int(((fl >> bit) & 1).sum())
            if c:
                flag_counts[fname] = c
    meta["flag_counts"] = flag_counts
    return Frame(id=frame_id, mjd=float(mjd), detector=det, wavelength_um=wl, bandwidth_um=bw,
                 image=image, zodi=zodi, noise=noise, bad=bad, meta=meta, image_masked=image_masked)


# ----------------------------------------------------------------------------
# Photometry at the target position
# ----------------------------------------------------------------------------
def aperture_flux(frame: Frame, x: float, y: float, r: float = 2.0,
                  r_in: float = 5.0, r_out: float = 9.0) -> dict:
    half = frame.image.shape[0] / 2
    if r_out > half:                      # small cutouts: shrink the sky annulus
        r_out = max(half, r + 2.5)
        r_in = max(r + 1.0, r_out - 2.5)
    base = frame.image_masked if frame.image_masked is not None else frame.image
    im = base - (frame.zodi if frame.zodi is not None else 0.0)
    n = im.shape[0]
    yy, xx = np.mgrid[0:n, 0:n]
    d = np.hypot(xx - x, yy - y)
    ap = d <= r
    ann = (d >= r_in) & (d <= r_out) & ~frame.bad & np.isfinite(im)
    flagged = bool(frame.bad[ap].any())
    good = ap & np.isfinite(im)
    if good.sum() < 3 or ann.sum() < 8:
        return {"flux": None, "err": None, "flagged": True}
    bg = float(np.median(im[ann]))
    s = float(np.nansum(im[good] - bg))
    if frame.noise is not None:
        var = float(np.nansum(frame.noise[good] ** 2))
    else:
        var = good.sum() * robust_sigma(im[ann]) ** 2
    # MJy/sr * pixel solid angle -> mJy (no aperture correction: relative flux)
    pix_sr = (PIXSCALE_ARCSEC / 206264.806) ** 2
    k = pix_sr * 1e6 * 1e3
    return {"flux": s * k, "err": math.sqrt(max(var, 0)) * k, "flagged": flagged}


# ----------------------------------------------------------------------------
# Change detection (heuristic; the ML model can replace or complement it)
# ----------------------------------------------------------------------------
def _peaks(z: np.ndarray, thresh: float, min_sep: int = 3, edge: int = 2):
    zz = np.where(np.isfinite(z), z, 0.0)
    mx = ndimage.maximum_filter(zz, size=2 * min_sep + 1)
    cand = (zz == mx) & (zz > thresh)
    cand[:edge, :] = cand[-edge:, :] = cand[:, :edge] = cand[:, -edge:] = False
    ys, xs = np.nonzero(cand)
    out = []
    for y, x in zip(ys, xs):
        # sub-pixel centroid in a 3x3 box
        y0, y1, x0, x1 = max(y - 1, 0), y + 2, max(x - 1, 0), x + 2
        w = np.clip(zz[y0:y1, x0:x1], 0, None)
        gy, gx = np.mgrid[y0:y1, x0:x1]
        tot = w.sum() or 1.0
        out.append((float((gx * w).sum() / tot), float((gy * w).sum() / tot), float(zz[y, x])))
    return out


def _nan_smooth(im: np.ndarray, sigma: float = 1.0) -> np.ndarray:
    m = np.isfinite(im)
    a = ndimage.gaussian_filter(np.where(m, im, 0.0), sigma)
    w = ndimage.gaussian_filter(m.astype(float), sigma)
    return np.where(w > 0.3, a / np.maximum(w, 1e-9), np.nan)


def _centroid(im: np.ndarray, x: float, y: float, r: float = 2.5, iters: int = 3):
    n = im.shape[0]
    yy, xx = np.mgrid[0:n, 0:n]
    for _ in range(iters):
        d = np.hypot(xx - x, yy - y)
        ann = (d > r + 2) & (d < r + 6) & np.isfinite(im)
        if ann.sum() < 8:                       # small cutout: use everything outside the aperture
            ann = (d > r + 0.5) & np.isfinite(im)
        if ann.sum() < 8:
            return None
        bg = np.median(im[ann])
        ap = (d <= r) & np.isfinite(im)
        if ap.sum() < 6:
            return None
        w = np.clip(im[ap] - bg, 0, None)
        if w.sum() <= 0:
            return None
        x, y = float((xx[ap] * w).sum() / w.sum()), float((yy[ap] * w).sum() / w.sum())
    return x, y


def _ap(im, noise, bad, x, y, r=2.0):
    n = im.shape[0]
    yy, xx = np.mgrid[0:n, 0:n]
    d = np.hypot(xx - x, yy - y)
    ap = d <= r
    ann = (d >= r + 3) & (d <= r + 7) & np.isfinite(im) & ~bad
    if ann.sum() < 8:
        ann = (d >= r + 1) & np.isfinite(im) & ~bad
    if bad[ap].any() or not np.isfinite(im[ap]).all() or ann.sum() < 8:
        return None, None
    bg = np.median(im[ann])
    f = float(np.sum(im[ap] - bg))
    if noise is not None and np.isfinite(noise[ap]).all():
        e = float(np.sqrt(np.sum(noise[ap] ** 2)))
    else:
        e = float(np.sqrt(ap.sum()) * robust_sigma(im[ann]))
    return f, e


def detect_changes(frames: list[Frame], nsig: float = 6.0) -> list[dict]:
    """Compare frames of the same detector array and list candidate changes.

    kinds:
      moving    – a source not present in the reference sky that appears at
                  >=3 places lying on one straight line in time order
                  (asteroid, comet)
      shifted   – a known source whose centre drifts steadily with time
                  (proper motion of a nearby star / brown dwarf)
      variable  – a known source whose brightness differs significantly
                  between frames taken at nearly the same wavelength
      transient – a strong new spot in a single frame only (cosmic ray,
                  artefact or real transient — needs a human look)
    The scores are heuristic (0–1), not probabilities.
    """
    if len(frames) < 2:
        return []
    n = frames[0].image.shape[0]
    edge = 4 if n >= 24 else 2
    by_det: dict = {}
    for f in frames:
        by_det.setdefault(f.detector, []).append(f)

    fresh = []      # (frame, x, y, z, on_reference_source)
    dets: list[dict] = []
    for det, group in by_det.items():
        if len(group) < 2:
            continue
        group = sorted(group, key=lambda g: g.mjd)
        clean = [g.clean for g in group]
        sm = np.array([_nan_smooth(c, 1.0) for c in clean])
        ref = np.nanmedian(sm, axis=0)
        rsig = robust_sigma(ref)
        if not np.isfinite(rsig) or rsig <= 0:
            continue

        # --- reference sources: measure position and flux in every frame --------
        raw = [g.image - (g.zodi if g.zodi is not None else 0.0) for g in group]
        yy, xx = np.mgrid[0:n, 0:n]
        srcs = _peaks(ref / rsig, 8.0, min_sep=3, edge=edge)
        meas = []
        for (sx0, sy0, sz) in srcs:
            near = np.hypot(xx - sx0, yy - sy0) <= 2.0
            cents, fluxes = [], {}
            for k, (g, c) in enumerate(zip(group, clean)):
                # a flagged core (saturated star) leaves a hole in the cleaned image:
                # centroid on the unmasked image in that case
                cc = _centroid(raw[k] if g.bad[near].any() else c, sx0, sy0)
                if cc is None or math.hypot(cc[0] - sx0, cc[1] - sy0) > 3:
                    continue
                cents.append((g, cc[0], cc[1]))
                f, e = _ap(c, g.noise, g.bad, cc[0], cc[1])
                if f is not None and e and f / e > 10:
                    fluxes[k] = (f, e)
            meas.append(dict(x=sx0, y=sy0, cents=cents, fluxes=fluxes))

        # --- proper motion: the centre drifts linearly with time ---------------
        for m in meas:
            cents = m["cents"]
            if len(cents) < 4:
                continue
            t = np.array([c[0].mjd for c in cents]) / 365.25
            xs = np.array([c[1] for c in cents]); ys = np.array([c[2] for c in cents])
            if np.ptp(t) < 0.05:
                continue
            keep = np.ones(len(t), bool)
            for _ in range(2):          # linear fit, drop the single worst point once
                tt = t[keep] - t[keep].mean()
                A = np.c_[tt, np.ones_like(tt)]
                (vx, x0), *_ = np.linalg.lstsq(A, xs[keep], rcond=None)
                (vy, y0), *_ = np.linalg.lstsq(A, ys[keep], rcond=None)
                res = np.hypot(xs[keep] - (vx * tt + x0), ys[keep] - (vy * tt + y0))
                rms = float(np.sqrt(np.mean(res ** 2)))
                if rms < 0.25 or keep.sum() < 6 or not keep.all():
                    break
                keep[np.flatnonzero(keep)[np.argmax(res)]] = False
            rms = max(rms, 0.03)
            speed = math.hypot(vx, vy) * PIXSCALE_ARCSEC            # arcsec / yr
            disp = math.hypot(vx, vy) * np.ptp(t[keep])
            zv = math.hypot(vx, vy) / (rms / math.sqrt(max(np.sum(tt ** 2), 1e-9)))
            if zv > 6 and rms < 0.25 and disp > 0.25 and speed >= MIN_PM_ARCSEC_YR:
                kept = [c for c, k in zip(cents, keep) if k]
                m["shifted"] = True
                dets.append(dict(kind="shifted", x=float(x0), y=float(y0), snr=float(zv),
                                 track=[{"frame": c[0].id, "x": c[1], "y": c[2]} for c in kept],
                                 frames=[c[0].id for c in kept],
                                 motion_arcsec_per_year=round(speed, 2),
                                 motion_east_arcsec_per_year=round(-vx * PIXSCALE_ARCSEC, 2),
                                 motion_north_arcsec_per_year=round(vy * PIXSCALE_ARCSEC, 2),
                                 displacement_px=round(disp, 2), fit_rms_px=round(rms, 3)))

        # --- variability: differential photometry against the other stars -------
        for mi, m in enumerate(meas):
            if m.get("shifted"):
                continue
            best = None
            ks = sorted(m["fluxes"])
            for a_i in range(len(ks)):
                for b_i in range(a_i + 1, len(ks)):
                    i, j = ks[a_i], ks[b_i]
                    wi, wj = group[i].wavelength_um, group[j].wavelength_um
                    dw = abs(wi - wj) / max(wi, wj) if wi and wj else 0.0
                    if dw > 0.025:
                        continue
                    (fi, ei), (fj, ej) = m["fluxes"][i], m["fluxes"][j]
                    comp = [math.log(o["fluxes"][i][0] / o["fluxes"][j][0]) for oi, o in enumerate(meas)
                            if oi != mi and i in o["fluxes"] and j in o["fluxes"]]
                    if len(comp) >= 4:      # frame-to-frame colour / calibration term from the field
                        zero = float(np.median(comp))
                        scat = max(1.4826 * float(np.median(np.abs(np.array(comp) - zero))), 0.03)
                    elif dw <= 0.01:        # lone source: only nearly identical wavelengths
                        zero, scat = 0.0, 0.08
                    else:
                        continue
                    dln = math.log(fi / fj) - zero
                    z = abs(dln) / math.sqrt(scat ** 2 + (ei / fi) ** 2 + (ej / fj) ** 2)
                    amp = math.exp(abs(dln))
                    if z > nsig and amp > (1.25 if len(comp) >= 4 else 1.3) and (best is None or z > best[0]):
                        best = (z, i, j, amp, dln, len(comp))
            if best:
                z, i, j, amp, dln, ncomp = best
                hi, lo = (group[i], group[j]) if dln > 0 else (group[j], group[i])
                dets.append(dict(kind="variable", x=m["x"], y=m["y"], snr=float(z),
                                 track=[{"frame": group[k].id, "x": m["x"], "y": m["y"]} for k in ks],
                                 frames=[group[k].id for k in ks], amplitude_ratio=round(amp, 2),
                                 brightest_frame=hi.id, faintest_frame=lo.id, comparison_stars=ncomp))

        # --- new sources (not in the reference sky) ------------------------
        refmask = ref / rsig > 5
        refmask = ndimage.binary_dilation(refmask, iterations=2)
        for i, g in enumerate(group):
            others = np.delete(sm, i, axis=0)
            r = np.nanmedian(others, axis=0) if len(others) > 1 else others[0]
            resid = sm[i] - r
            sig = robust_sigma(resid)
            if not np.isfinite(sig) or sig <= 0:
                continue
            z = resid / np.sqrt(sig ** 2 + (0.15 * np.abs(np.nan_to_num(r))) ** 2)
            z = np.where(ndimage.binary_dilation(g.bad, iterations=1), np.nan, z)
            for (x, y, zz) in _peaks(z, nsig, min_sep=3, edge=edge):
                fresh.append((g, x, y, zz, bool(refmask[int(round(y)), int(round(x))])))

    # --- link new sources into straight-line tracks -----------------------
    fresh.sort(key=lambda p: p[0].mjd)
    taken = set()
    for a in range(len(fresh)):
        if a in taken:
            continue
        A = fresh[a]
        best = None
        for b in range(a + 1, len(fresh)):
            B = fresh[b]
            if b in taken or B[0] is A[0] or B[0].mjd <= A[0].mjd:
                continue
            dt = B[0].mjd - A[0].mjd
            if math.hypot(B[1] - A[1], B[2] - A[2]) < 1.0:
                continue
            vx, vy = (B[1] - A[1]) / dt, (B[2] - A[2]) / dt
            chain = [a, b]
            used_frames = {A[0].id, B[0].id}
            for c in range(len(fresh)):
                C = fresh[c]
                if c in chain or c in taken or C[0].id in used_frames:
                    continue
                tt = C[0].mjd - A[0].mjd
                if math.hypot(A[1] + vx * tt - C[1], A[2] + vy * tt - C[2]) < 1.5:
                    chain.append(c)
                    used_frames.add(C[0].id)
            # a real mover must be off-source in most of its points
            if len(chain) >= 3 and sum(fresh[k][4] for k in chain) <= len(chain) // 2 \
                    and (best is None or len(chain) > len(best)):
                best = (chain, vx, vy)
        if best:
            best, bvx, bvy = best
            taken.update(best)
            pts = sorted((fresh[k] for k in best), key=lambda p: p[0].mjd)
            dt = pts[-1][0].mjd - pts[0][0].mjd
            speed = math.hypot(pts[-1][1] - pts[0][1], pts[-1][2] - pts[0][2]) * PIXSCALE_ARCSEC / max(dt, 1e-6)
            dets.append(dict(kind="moving", x=pts[0][1], y=pts[0][2], snr=float(np.median([p[3] for p in pts])),
                             frames=[p[0].id for p in pts],
                             track=[{"frame": p[0].id, "x": p[1], "y": p[2]} for p in pts],
                             speed_arcsec_per_day=round(speed, 1),
                             _path=[(pts[0][1] + bvx * (f.mjd - pts[0][0].mjd), pts[0][2] + bvy * (f.mjd - pts[0][0].mjd))
                                    for f in frames]))
    for k, (g, x, y, zz, on_src) in enumerate(fresh):
        if k not in taken and not on_src and zz > nsig + 4:
            dets.append(dict(kind="transient", x=x, y=y, snr=float(zz), frames=[g.id],
                             track=[{"frame": g.id, "x": x, "y": y}]))

    # a mover crossing a star makes that star look "variable" -> drop those
    movers = [pt for d in dets if d["kind"] == "moving" for pt in d.pop("_path")]
    dets = [d for d in dets if not (d["kind"] == "variable" and any(
        math.hypot(px - d["x"], py - d["y"]) < 4 for px, py in movers))]

    # --- merge duplicates (same place, e.g. several detector groups) -------
    prio = {"moving": 0, "shifted": 1, "variable": 2, "transient": 3}
    dets.sort(key=lambda d: (prio[d["kind"]], -d["snr"]))
    merged: list[dict] = []
    for d in dets:
        for m in merged:
            if m["kind"] != "moving" and d["kind"] != "moving" and math.hypot(m["x"] - d["x"], m["y"] - d["y"]) < 2.5:
                m["frames"] = sorted(set(m["frames"]) | set(d["frames"]))
                break
        else:
            merged.append(d)

    for d in merged:
        z, nfr = d["snr"], len(set(d["frames"]))
        if d["kind"] == "moving":
            c = 0.55 + 0.08 * (nfr - 3) + 0.25 * (1 - math.exp(-(z - nsig) / 8))
        elif d["kind"] == "shifted":
            c = 0.5 + 0.45 * (1 - math.exp(-(z - 5) / 6))
        elif d["kind"] == "variable":
            c = 0.45 + 0.5 * (1 - math.exp(-(z - nsig) / 6))
        else:
            c = 0.15 + 0.15 * (1 - math.exp(-(z - nsig) / 10))
        d["confidence"] = round(float(np.clip(c, 0.05, 0.97)), 2)
        d["snr"] = round(float(d["snr"]), 1)
    merged.sort(key=lambda d: (-d["confidence"]))
    for i, d in enumerate(merged):
        d["id"] = f"C{i + 1:03d}"
    return merged


# ----------------------------------------------------------------------------
# Package frames for the web app
# ----------------------------------------------------------------------------
def forced_summary(frames: list[Frame], track: list[tuple[float, float]], n_random: int = 400,
                   seed: int = 1) -> dict | None:
    """Combine aperture fluxes measured at given positions (one per frame) and compare
    the result with the same measurement at random places of the field."""
    def combine(pts):
        fl, er = [], []
        for f, (x, y) in zip(frames, pts):
            p = aperture_flux(f, x, y)
            if p["flux"] is not None and p["err"] and not p["flagged"]:
                fl.append(p["flux"]); er.append(p["err"])
        if len(fl) < max(2, len(frames) // 2):
            return None
        w = 1 / np.array(er) ** 2
        return float(np.sum(w * np.array(fl)) / np.sum(w)), float(1 / math.sqrt(np.sum(w))), len(fl)
    got = combine(track)
    if got is None:
        return None
    n = frames[0].image.shape[0]
    rng = np.random.default_rng(seed)
    xs = np.array([t[0] for t in track]); ys = np.array([t[1] for t in track])
    null = []
    for _ in range(n_random):
        dx = rng.uniform(6 - xs.min(), n - 7 - xs.max()) if n - 7 - xs.max() > 6 - xs.min() else 0
        dy = rng.uniform(6 - ys.min(), n - 7 - ys.max()) if n - 7 - ys.max() > 6 - ys.min() else 0
        if math.hypot(dx, dy) < 4:
            continue
        r = combine(list(zip(xs + dx, ys + dy)))
        if r:
            null.append(r[0])
    out = {"mean_flux_mjy": round(got[0], 3), "formal_err_mjy": round(got[1], 3), "frames_used": got[2]}
    if len(null) >= 50:
        med = float(np.median(null)); sig = robust_sigma(np.array(null))
        out.update(empty_sky_scatter_mjy=round(sig, 3), snr_vs_empty_sky=round((got[0] - med) / sig, 1),
                   random_positions=len(null),
                   fraction_random_brighter=round(float(np.mean(np.array(null) >= got[0])), 3))
    return out


def year_of(mjd: float) -> float:
    return 2000.0 + (mjd - 51544.5) / 365.25


def predict_position(target: dict, mjd: float) -> tuple[float, float]:
    """Sky position of a target at a date. target: ra, dec [deg] at 'epoch' [year],
    optional pmra (already * cos dec) and pmdec in mas/yr."""
    dt = year_of(mjd) - target.get("epoch", 2000.0)
    ra = target["ra"] + dt * target.get("pmra", 0.0) / 3.6e6 / math.cos(math.radians(target["dec"]))
    return ra, target["dec"] + dt * target.get("pmdec", 0.0) / 3.6e6


def build_payload(frames: list[Frame], ra: float, dec: float, size_px: int,
                  name: str | None = None, source: str = "local",
                  notes: list[str] | None = None, extra: dict | None = None,
                  run_detection: bool = True, tracked: bool = False,
                  target: dict | None = None) -> dict:
    """ra, dec = centre of the frames. target (optional) = the object of interest when it
    is not at the frame centre and/or moves (see predict_position)."""
    frames = sorted(frames, key=lambda f: f.mjd)
    c = (size_px - 1) / 2
    w = target_wcs(ra, dec, size_px)
    phot, target_track = [], []
    for f in frames:
        px = py = c
        if target:
            px, py = (float(v) for v in w.all_world2pix([predict_position(target, f.mjd)], 0)[0])
        mx, my, recentred = px, py, False
        if not tracked:   # follow the real source if there is a clear one within 2.5 px
            cc = _centroid(f.image - (f.zodi if f.zodi is not None else 0.0), px, py)
            if cc and math.hypot(cc[0] - px, cc[1] - py) <= 2.5:
                t = aperture_flux(f, cc[0], cc[1])
                if t["flux"] is not None and t["err"] and t["flux"] / t["err"] > 8:
                    mx, my, recentred = cc[0], cc[1], True
        p = aperture_flux(f, mx, my)
        phot.append({"frame": f.id, "mjd": f.mjd, "wavelength_um": f.wavelength_um,
                     "detector": f.detector, **p})
        target_track.append({"frame": f.id, "x": round(px, 2), "y": round(py, 2),
                             "mx": round(mx, 2), "my": round(my, 2), "measured": recentred})
    dets = detect_changes(frames) if run_detection else []
    summary = None
    if target and not tracked and len(frames) >= 2:
        summary = forced_summary(frames, [(t["mx"], t["my"]) for t in target_track])
        hit = None
        for d in dets:
            if d["kind"] != "transient" and min(math.hypot(d["x"] - t["mx"], d["y"] - t["my"]) for t in target_track) < 3:
                hit = d
                break
        if hit:
            hit["name"] = target.get("name")
        if summary is not None:
            summary["found_by_automatic_search"] = bool(hit)
    for d in dets:
        r_, d_ = w.all_pix2world([[d["x"], d["y"]]], 0)[0]
        d["ra"], d["dec"] = round(float(r_), 6), round(float(d_), 6)
        d["x"], d["y"] = round(d["x"], 2), round(d["y"], 2)
        for t in d["track"]:
            t["x"], t["y"] = round(t["x"], 2), round(t["y"], 2)

    out_frames = []
    for f in frames:
        fr = {
            "id": f.id, "mjd": round(f.mjd, 6), "date": mjd_to_iso(f.mjd),
            "detector": f.detector,
            "wavelength_um": None if f.wavelength_um is None else round(f.wavelength_um, 4),
            "bandwidth_um": None if f.bandwidth_um is None else round(f.bandwidth_um, 4),
            "flagged_fraction": round(float((f.bad & np.isfinite(f.image)).sum() / max(np.isfinite(f.image).sum(), 1)), 4),
            "image": b64(np.where(np.isfinite(f.image), f.image, np.nan), np.float32),
            "bad": b64(f.bad.astype(np.uint8), np.uint8),
            **f.meta,
        }
        if f.zodi is not None:
            fr["zodi"] = b64(f.zodi, np.float32)
        if f.noise is not None:
            fr["noise"] = b64(f.noise, np.float32)
        out_frames.append(fr)

    notes = list(notes or [])
    n_flag = sum(1 for p in phot if p["flagged"])
    if not tracked and len(phot) and n_flag >= max(1, len(phot) // 2) and any(
            (f.meta.get("flag_counts") or {}).get("OVERFLOW", 0) >= 2 for f in frames):
        notes.append(f"This object is so bright that the centre of its image is saturated in {n_flag} of {len(phot)} frames. "
                     f"Its brightness values here are not reliable; they show as hollow points in the charts.")
    payload = {
        "version": 2,
        "target": {"name": name, "ra": target["ra"] if target else ra, "dec": target["dec"] if target else dec,
                   **({k: target[k] for k in ("epoch", "pmra", "pmdec") if k in target} if target else {})},
        "center": {"ra": ra, "dec": dec},
        "target_track": target_track,
        "target_summary": summary,
        "flag_names": {str(b): FLAG_NAMES[b] for b in BAD_BITS},
        "size": size_px,
        "pixscale_arcsec": PIXSCALE_ARCSEC,
        "fov_arcmin": round(size_px * PIXSCALE_ARCSEC / 60, 2),
        "source": source,
        "tracked": tracked,
        "frames": out_frames,
        "photometry": phot,
        "detections": dets,
        "detector_ranges_um": {str(k): v for k, v in DETECTORS.items()},
        "bad_bits": BAD_BITS,
        "notes": notes or [],
    }
    if extra:
        payload.update(extra)
    return payload


# ----------------------------------------------------------------------------
# Live access to IRSA (used by the backend)
# ----------------------------------------------------------------------------
def query_observations(ra: float, dec: float, detector: int | None = None,
                       timeout: float = 60.0, client=None) -> list[dict]:
    """All SPHEREx spectral images whose footprint contains (ra, dec)."""
    import httpx
    q = (
        "SELECT a.uri, p.time_bounds_lower, p.time_bounds_upper, p.energy_bandpassname "
        "FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid "
        f"WHERE 1 = CONTAINS(POINT('ICRS', {ra:.7f}, {dec:.7f}), p.poly) "
    )
    if detector:
        q += f"AND p.energy_bandpassname = 'SPHEREx-D{int(detector)}' "
    q += "ORDER BY p.time_bounds_lower"
    cl = client or httpx.Client(timeout=timeout, follow_redirects=True)
    r = cl.get(TAP_SYNC, params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": q})
    r.raise_for_status()
    rows = list(csv.DictReader(io.StringIO(r.text)))
    out = []
    for row in rows:
        uri = row.get("uri", "")
        if not uri.endswith(".fits"):
            continue
        t0 = row.get("time_bounds_lower")
        t1 = row.get("time_bounds_upper")
        try:
            mjd = (float(t0) + float(t1)) / 2 if t1 else float(t0)
        except (TypeError, ValueError):
            continue
        out.append({"uri": uri, "mjd": mjd, "band": row.get("energy_bandpassname"),
                    "detector": detector_from_name(row.get("energy_bandpassname")) or detector_from_name(uri)})
    # drop duplicates (same file listed twice)
    seen, uniq = set(), []
    for o in out:
        if o["uri"] not in seen:
            seen.add(o["uri"])
            uniq.append(o)
    return uniq


def pick_spread(obs: list[dict], max_frames: int) -> list[dict]:
    """Keep at most max_frames, spread evenly in time (always keep first/last)."""
    if len(obs) <= max_frames:
        return obs
    idx = np.unique(np.round(np.linspace(0, len(obs) - 1, max_frames)).astype(int))
    return [obs[i] for i in idx]


def cutout_url(uri: str, ra: float, dec: float, size_deg: float) -> str:
    base = uri if uri.startswith("http") else f"{IRSA}/{uri.lstrip('/')}"
    return f"{base}?center={ra:.7f},{dec:.7f}d&size={size_deg:.5f}"


def fetch_live(ra: float, dec: float, size_px: int = 64, detector: int | None = None,
               max_frames: int = 30, workers: int = 8, timeout: float = 60.0,
               name: str | None = None) -> dict:
    import httpx
    notes = []
    with httpx.Client(timeout=timeout, follow_redirects=True) as cl:
        obs = query_observations(ra, dec, detector, client=cl)
        total = len(obs)
        obs = pick_spread(obs, max_frames)
        if total > len(obs):
            notes.append(f"SPHEREx has {total} images of this point. Showing {len(obs)} of them, spread evenly in time.")
        size_deg = size_px * PIXSCALE_ARCSEC / 3600 * 1.45  # margin for rotated detectors

        def job(o):
            url = cutout_url(o["uri"], ra, dec, size_deg)
            r = cl.get(url)
            r.raise_for_status()
            with fits.open(io.BytesIO(r.content)) as h:
                fid = re.sub(r"\.fits$", "", o["uri"].rsplit("/", 1)[-1])
                return process_hdul(h, ra, dec, size_px, fid, mjd=o["mjd"], detector_hint=o["detector"],
                                    meta={"file": o["uri"].rsplit("/", 1)[-1],
                                          "url": (o["uri"] if o["uri"].startswith("http") else f"{IRSA}/{o['uri'].lstrip('/')}")})

        frames = []
        with cf.ThreadPoolExecutor(workers) as ex:
            for fut in cf.as_completed([ex.submit(job, o) for o in obs]):
                try:
                    f = fut.result()
                    if f is not None:
                        frames.append(f)
                except Exception as e:  # one bad cutout should not kill the request
                    notes.append(f"One image could not be downloaded ({type(e).__name__}) and was skipped.")
    return build_payload(frames, ra, dec, size_px, name=name, source="IRSA live", notes=notes)
