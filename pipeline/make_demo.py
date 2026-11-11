"""
Generate SYNTHETIC SPHEREx-like FITS files to test the website end-to-end
before real data arrive. Files have the same layout as SPHEREx Level-2
spectral images (IMAGE / FLAGS / VARIANCE / ZODI with a rotated TAN+SIP-free
WCS and MJD-AVG), plus a metadata.csv in the team-dataset format.

    python pipeline/make_demo.py --out demo_data
    python pipeline/build_static.py --metadata demo_data/metadata.csv \
        --fits-root demo_data --out site/data --demo

Nothing here is real data; the website labels it "synthetic demo".
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

PIX = 6.15 / 3600
rng = np.random.default_rng(42)


def make_wcs(ra, dec, n, rot_deg, off_px):
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2 + off_px[0], (n + 1) / 2 + off_px[1]]
    t = np.deg2rad(rot_deg)
    w.wcs.cd = PIX * np.array([[-np.cos(t), np.sin(t)], [np.sin(t), np.cos(t)]])
    return w


def star_field(ra, dec, nstars=70, radius=0.12):
    r = radius * np.sqrt(rng.random(nstars))
    th = rng.random(nstars) * 2 * np.pi
    sra = ra + r * np.cos(th) / np.cos(np.deg2rad(dec))
    sdec = dec + r * np.sin(th)
    flux = 3.0 * rng.pareto(1.6, nstars) + 0.6  # MJy/sr peak
    color = rng.normal(0, 0.25, nstars)         # spectral slope
    return np.c_[sra, sdec, flux, color]


def render(w, n, sources, wl, sigma=0.85):
    img = np.zeros((n, n))
    yy, xx = np.mgrid[0:n, 0:n]
    src_mask = np.zeros((n, n), bool)
    for ra, dec, peak, col in sources:
        x, y = w.all_world2pix([[ra, dec]], 0)[0]
        if -5 < x < n + 5 and -5 < y < n + 5:
            amp = peak * (wl / 2.5) ** col
            g = amp * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma ** 2))
            img += g
            src_mask |= g > 0.15
    return img, src_mask


def write_frame(path, w, n, mjd, wl, sources, cosmic=0, unflagged_cosmic=False):
    sky, src_mask = render(w, n, sources, wl)
    yy, xx = np.mgrid[0:n, 0:n]
    zodi = 0.35 + 0.002 * xx + 0.0015 * yy + 0.05 * np.sin(wl)
    noise_sig = 0.045
    img = sky + zodi + rng.normal(0, noise_sig, (n, n))
    flags = np.zeros((n, n), np.int32)
    flags[src_mask] |= 1 << 21  # SOURCE (informational only)
    for _ in range(cosmic):     # flagged cosmic rays (TRANSIENT bit)
        cy, cx = rng.integers(3, n - 3, 2)
        img[cy, cx] += rng.uniform(3, 8)
        flags[cy, cx] |= 1
    if unflagged_cosmic:        # one hit the flagging missed -> "transient"
        cy, cx = rng.integers(10, n - 10, 2)
        img[cy, cx] += 2.5
        img[cy, cx + 1] += 1.2
    flags[rng.integers(0, n, 6), rng.integers(0, n, 6)] |= 1 << 6  # dead pixels
    var = np.full((n, n), noise_sig ** 2) + 0.002 * np.abs(sky)

    hdr = w.to_header()
    hdr["BUNIT"] = "MJy/sr"
    hdr["MJD-AVG"] = mjd
    prim = fits.PrimaryHDU()
    prim.header["MJD-AVG"] = mjd
    prim.header["COMMENT"] = "SYNTHETIC DEMO FILE - not SPHEREx data"
    hdul = fits.HDUList([prim,
                         fits.ImageHDU(img.astype(np.float32), hdr, name="IMAGE"),
                         fits.ImageHDU(flags, hdr, name="FLAGS"),
                         fits.ImageHDU(var.astype(np.float32), hdr, name="VARIANCE"),
                         fits.ImageHDU(zodi.astype(np.float32), hdr, name="ZODI")])
    hdul.writeto(path, overwrite=True)


DET_WL = {1: 0.92, 2: 1.35, 3: 2.0, 4: 3.1, 5: 4.1, 6: 4.7}


def scenario(out: Path, writer, name, cls, ra, dec, epochs, extra_fn, n=110):
    field = star_field(ra, dec)
    d = out / "raw" / cls / name
    d.mkdir(parents=True, exist_ok=True)
    for k, (mjd, det) in enumerate(epochs):
        wl = DET_WL[det] + rng.normal(0, 0.05)
        srcs = list(field) + extra_fn(mjd, wl)
        w = make_wcs(ra, dec, n, rng.uniform(0, 360), rng.uniform(-8, 8, 2))
        fn = f"demo_{name}_{k:02d}_1D{det}_spx_synthetic.fits"
        write_frame(d / fn, w, n, mjd, wl, srcs, cosmic=rng.integers(1, 4),
                    unflagged_cosmic=(k == 2 and "asteroid" in name))
        writer.writerow({"name": name, "class": cls, "epoch_mjd": f"{mjd:.6f}", "band": f"SPHEREx-D{det}",
                         "ra_deg": f"{ra:.6f}", "dec_deg": f"{dec:.6f}",
                         "file": f"raw/{cls}/{name}/{fn}", "qc_status": "synthetic",
                         "wavelength_um": f"{wl:.4f}", "bandwidth_um": "0.04", "wcs_warning": "False",
                         "label_status": "synthetic_demo"})


def main(out: Path):
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "metadata.csv", "w", newline="") as fh:
        cols = ["name", "class", "epoch_mjd", "band", "ra_deg", "dec_deg", "file", "qc_status",
                "wavelength_um", "bandwidth_um", "wcs_warning", "label_status"]
        wr = csv.DictWriter(fh, cols)
        wr.writeheader()

        # 1) nearby star with large proper motion: ~3 px over 1.3 years
        ra1, dec1 = 150.20, 2.10
        def mover(mjd, wl):
            yrs = (mjd - 60800) / 365.25
            return [(ra1 + 0.0018 + yrs * (-2.0 / 3600), dec1 - 0.002 + yrs * (14.0 / 3600), 9.0, 0.6)]
        ep = [(60800, 3), (60801.5, 3), (60803, 3), (60984, 3), (60986, 3), (61165, 3), (61167, 3), (61350, 3)]
        scenario(out, wr, "DEMO_high_proper_motion", "moving", ra1, dec1, ep, mover)

        # 2) asteroid crossing the field within a day (fixed field, same detector)
        ra2, dec2 = 200.50, -5.30
        def asteroid(mjd, wl):
            t = mjd - 61000
            return [(ra2 - 0.04 + t * 0.075, dec2 - 0.02 + t * 0.03, 4.0, 0.2)]
        ep2 = [(61000.00, 2), (61000.12, 2), (61000.25, 2), (61000.40, 2), (61000.55, 2), (61000.70, 2)]
        scenario(out, wr, "DEMO_asteroid_field", "moving", ra2, dec2, ep2, asteroid)

        # 3) variable star (Mira-like, big infrared amplitude)
        ra3, dec3 = 80.00, 30.00
        def variable(mjd, wl):
            amp = 1.0 + 0.7 * np.sin(2 * np.pi * (mjd - 60800) / 230.0)
            return [(ra3 + 0.0007, dec3 - 0.0004, 7.0 * amp, 0.3)]
        ep3 = [(60800, 4), (60860, 4), (60920, 4), (60990, 4), (61050, 4), (61120, 4), (61180, 4)]
        scenario(out, wr, "DEMO_variable_star", "variable", ra3, dec3, ep3, variable)
    print("synthetic files written to", out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("demo_data"))
    main(ap.parse_args().out)
