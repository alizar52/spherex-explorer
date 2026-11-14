(() => {
'use strict';

const CFG = window.SPX_CONFIG || {};
const API = (CFG.apiBase || '').replace(/\/$/, '');
const $ = (id) => document.getElementById(id);
const PIX_ARCSEC = 6.15;
const DET_RANGE = {1: [0.75, 1.09], 2: [1.10, 1.62], 3: [1.63, 2.41], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.00]};
const DET_COLOR = {1: '#6E8FA3', 2: '#7A9AA0', 3: '#8FA393', 4: '#A8A385', 5: '#B39A80', 6: '#B48C82'};
const KIND_COLOR = {moving: '#E5A03A', shifted: '#5CB3D6', variable: '#B98BDB', transient: '#939DA2'};
const KIND_INK = {moving: '#B86E00', shifted: '#0F6E99', variable: '#7A3FA8', transient: '#55626A'};
const KIND_LABEL = {moving: 'Moving object', shifted: 'Shifted position', variable: 'Brightness change', transient: 'Single-frame spot'};
const KIND_EXPLAIN = {
  moving: 'Something that is not in the usual sky and appears at several places along a straight line, in date order. Asteroids and comets look like this.',
  shifted: 'A star whose centre drifts steadily from date to date. Nearby stars and brown dwarfs do this because they move through space (proper motion) and because Earth moves around the Sun (parallax).',
  variable: 'A star that is clearly brighter in some frames than in others taken at almost the same wavelength, compared with its neighbours. Variable stars, flares and eclipses do this.',
  transient: 'A bright spot in one frame only. Usually a cosmic-ray hit that the quality flags missed, but worth a look.',
};

const S = {
  index: null, data: null, frames: [], view: [], det: 0, cur: 0, A: 0, B: 0,
  mode: 'timelapse', playing: false, timer: null, blinkShowB: false,
  zoom: 1, panX: 0, panY: 0, swipe: 0.5, sel: null, apiOk: false,
  catalogs: {gaia: null, allwise: null}, scaleCache: new Map(), query: null,
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function b64ToTyped(b64, Ctor) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Ctor(buf.buffer);
}
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function loading(on, text) {
  $('loading').classList.toggle('hidden', !on);
  if (text) $('loadingText').textContent = text;
}
function fmtDate(iso) { return iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : '—'; }
function fmtNum(v, d = 3) { return v == null || !isFinite(v) ? '—' : (+v).toFixed(d); }
function hms(raDeg) {
  let h = ((raDeg % 360) + 360) % 360 / 15;
  const H = Math.floor(h); h = (h - H) * 60; const M = Math.floor(h); const Ss = (h - M) * 60;
  return `${String(H).padStart(2, '0')}h${String(M).padStart(2, '0')}m${Ss.toFixed(2).padStart(5, '0')}s`;
}
function dms(decDeg) {
  const sgn = decDeg < 0 ? '−' : '+'; let d = Math.abs(decDeg);
  const D = Math.floor(d); d = (d - D) * 60; const M = Math.floor(d); const Ss = (d - M) * 60;
  return `${sgn}${String(D).padStart(2, '0')}°${String(M).padStart(2, '0')}′${Ss.toFixed(1).padStart(4, '0')}″`;
}
async function fetchJSON(url, opts = {}, timeoutMs = 120000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {...opts, signal: ctl.signal});
    if (!r.ok) {
      let msg = `${r.status}`;
      try { const j = await r.json(); msg = j.detail || msg; } catch (_) { msg = r.statusText || msg; }
      throw new Error(msg);
    }
    return await r.json();
  } finally { clearTimeout(t); }
}

function parseCoords(text) {
  const raw = text.trim().replace(/[−–]/g, '-');
  if (!raw) return null;
  const sexa = /[hms:°′″'"]|\d\s+\d+\s+\d/.test(raw) && !/^[-+]?\d+(\.\d+)?[\s,]+[-+]?\d+(\.\d+)?$/.test(raw);
  const toks = raw.replace(/[hmsd°′″'":,]/gi, ' ').trim().split(/\s+/);
  if (!toks.every((t) => /^[-+]?\d+(\.\d+)?$/.test(t))) return null;
  if (toks.length === 2 && !sexa) {
    const ra = parseFloat(toks[0]); const dec = parseFloat(toks[1]);
    if (ra >= 0 && ra < 360 && dec >= -90 && dec <= 90) return {ra, dec};
    return null;
  }
  if (toks.length === 6) {
    const [h, m, s, d, dm, ds] = toks.map(parseFloat);
    const neg = toks[3].startsWith('-');
    const ra = 15 * (h + m / 60 + s / 3600);
    const dec = (neg ? -1 : 1) * (Math.abs(d) + dm / 60 + ds / 3600);
    if (ra >= 0 && ra < 360 && dec >= -90 && dec <= 90) return {ra, dec};
  }
  return null;
}

function skyToPix(ra, dec, ra0, dec0, n) {
  const r = Math.PI / 180; const a = ra * r, d = dec * r, a0 = ra0 * r, d0 = dec0 * r;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  const xi = Math.cos(d) * Math.sin(a - a0) / cosc;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc;
  const pix = PIX_ARCSEC / 3600 * r; const c = (n - 1) / 2;
  return {x: c - xi / pix, y: c + eta / pix};
}
function pixToSky(x, y, ra0, dec0, n) {
  const r = Math.PI / 180; const pix = PIX_ARCSEC / 3600 * r; const c = (n - 1) / 2;
  const xi = -(x - c) * pix, eta = (y - c) * pix; const d0 = dec0 * r;
  const den = Math.cos(d0) - eta * Math.sin(d0);
  const ra = (ra0 * r + Math.atan2(xi, den)) / r;
  const dec = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, den)) / r;
  return {ra: (ra + 360) % 360, dec};
}

const ctr = () => (S.data.center || S.data.target);
function targetXY(fr) {
  const n = S.data.size; const tt = S.data.target_track;
  if (!tt || !tt.length) return {x: (n - 1) / 2, y: (n - 1) / 2};
  const t = (fr && tt.find((q) => q.frame === fr.id)) || tt[Math.floor(tt.length / 2)];
  return {x: t.x, y: t.y};
}

const CMAPS = {
  plate: [[227, 234, 236], [190, 201, 205], [120, 134, 140], [52, 63, 68], [16, 23, 26]],
  gray: [[0, 0, 0], [255, 255, 255]],
  inferno: [[0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106], [186, 54, 85], [227, 89, 51], [249, 140, 10], [249, 201, 50], [252, 255, 164]],
  viridis: [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]],
  ice: [[4, 6, 19], [20, 38, 78], [33, 82, 133], [55, 132, 172], [117, 182, 200], [196, 227, 232], [255, 255, 255]],
  diverging: [[33, 102, 172], [103, 169, 207], [209, 229, 240], [247, 247, 247], [253, 219, 199], [239, 138, 98], [178, 24, 43]],
};
const LUT = {};
function lut(name) {
  if (LUT[name]) return LUT[name];
  const st = CMAPS[name]; const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const p = i / 255 * (st.length - 1); const k = Math.min(Math.floor(p), st.length - 2); const f = p - k;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = st[k][c] + (st[k + 1][c] - st[k][c]) * f;
  }
  return (LUT[name] = out);
}
function drawColorbar() {
  const name = $('cmapSelect').value; const l = lut(S.mode === 'diff' ? 'diverging' : name);
  const stops = []; for (let i = 0; i <= 10; i++) { const k = Math.round(i * 25.5); stops.push(`rgb(${l[k * 3]},${l[k * 3 + 1]},${l[k * 3 + 2]}) ${i * 10}%`); }
  $('cbar').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
}

function frameArr(fr, key) {
  const cacheKey = '_' + key;
  if (fr[cacheKey]) return fr[cacheKey];
  if (key === 'img') fr[cacheKey] = b64ToTyped(fr.image, Float32Array);
  else if (key === 'bad') fr[cacheKey] = b64ToTyped(fr.bad, Uint8Array);
  else if (key === 'zodi') fr[cacheKey] = fr.zodi ? b64ToTyped(fr.zodi, Float32Array) : null;
  else if (key === 'noise') fr[cacheKey] = fr.noise ? b64ToTyped(fr.noise, Float32Array) : null;
  return fr[cacheKey];
}
function smooth(arr, n) {
  const k = [0.25, 0.5, 0.25]; const tmp = new Float32Array(arr.length); const out = new Float32Array(arr.length);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? arr : tmp; const dst = pass === 0 ? tmp : out;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let s = 0, w = 0;
      for (let j = -1; j <= 1; j++) {
        const xx = pass === 0 ? x + j : x, yy = pass === 0 ? y : y + j;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const v = src[yy * n + xx]; if (!isFinite(v)) continue; s += v * k[j + 1]; w += k[j + 1];
      }
      dst[y * n + x] = w > 0.4 ? s / w : NaN;
    }
  }
  return out;
}
function repair(arr, bad, n) {
  const out = Float32Array.from(arr); const seen = new Uint8Array(n * n); const comp = []; const nb = [];
  for (let s0 = 0; s0 < n * n; s0++) {
    if (!bad[s0] || seen[s0]) continue;
    comp.length = 0; comp.push(s0); seen[s0] = 1;
    for (let k = 0; k < comp.length; k++) {
      const x = comp[k] % n, y = (comp[k] - x) / n;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const q = yy * n + xx; if (bad[q] && !seen[q]) { seen[q] = 1; comp.push(q); }
      }
    }
    if (comp.length > 9) continue;
    for (const c of comp) {
      const x = c % n, y = (c - x) / n; nb.length = 0;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
        const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const v = arr[yy * n + xx]; if (!bad[yy * n + xx] && isFinite(v)) nb.push(v);
      }
      if (nb.length >= 4) { nb.sort((p, q) => p - q); out[c] = nb[nb.length >> 1]; }
    }
  }
  return out;
}
function badGrown(fr, n) {
  if (fr._badG) return fr._badG; const bad = frameArr(fr, 'bad'); const g = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!bad[y * n + x]) continue;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < n && yy < n) g[yy * n + xx] = 1; }
  }
  return (fr._badG = g);
}
function layerOf(fr, layer) {
  layer = layer || $('layerSelect').value;
  const n = S.data.size; const key = `_L_${layer}_${$('smoothChk').checked ? 1 : 0}${$('repairChk').checked ? 1 : 0}`;
  if (fr[key]) return fr[key];
  const img = frameArr(fr, 'img'); const z = frameArr(fr, 'zodi'); let out;
  if (layer === 'image') out = img;
  else if (layer === 'clean') { out = new Float32Array(img.length); for (let i = 0; i < img.length; i++) out[i] = img[i] - (z ? z[i] : 0);
    const bad0 = frameArr(fr, 'bad'); const good = []; for (let i = 0; i < out.length; i++) if (!bad0[i] && isFinite(out[i])) good.push(out[i]);
    if (good.length > 20) { good.sort((p, q) => p - q); const med = good[good.length >> 1]; for (let i = 0; i < out.length; i++) out[i] -= med; }
    if ($('repairChk').checked) out = repair(out, bad0, n); }
  else if (layer === 'zodi') out = z || new Float32Array(img.length).fill(NaN);
  else if (layer === 'noise') out = frameArr(fr, 'noise') || new Float32Array(img.length).fill(NaN);
  else if (layer === 'quality') out = Float32Array.from(frameArr(fr, 'bad'));
  if ($('smoothChk').checked && layer !== 'quality') out = smooth(out, n);
  return (fr[key] = out);
}
function percentiles(values, ps) {
  const a = []; for (const v of values) if (isFinite(v)) a.push(v);
  if (!a.length) return ps.map(() => 0);
  a.sort((x, y) => x - y);
  return ps.map((p) => a[clamp(Math.floor(p / 100 * (a.length - 1)), 0, a.length - 1)]);
}
function sampleOf(arrs, max = 60000) {
  const out = []; const total = arrs.reduce((s, a) => s + a.length, 0); const step = Math.max(1, Math.floor(total / max));
  for (const a of arrs) for (let i = 0; i < a.length; i += step) out.push(a[i]);
  return out;
}
function scaleFor(arr, diverging) {
  const clip = parseFloat($('clipSelect').value);
  if (diverging) { const abs = sampleOf([arr]).map(Math.abs); const [m] = percentiles(abs, [clip === 100 ? 100 : clip]); return {lo: -m || -1, hi: m || 1}; }
  const lock = $('lockScale').checked && ['timelapse', 'blink', 'side', 'swipe'].includes(S.mode);
  if (lock) {
    const key = [$('layerSelect').value, S.det, clip, $('smoothChk').checked, $('repairChk').checked].join('|');
    if (!S.scaleCache.has(key)) {
      const arrs = S.view.map((fr) => layerOf(fr));
      const [lo, hi] = clip === 100 ? percentiles(sampleOf(arrs), [0, 100]) : percentiles(sampleOf(arrs), [1, clip]);
      S.scaleCache.set(key, {lo, hi: hi > lo ? hi : lo + 1e-6});
    }
    return S.scaleCache.get(key);
  }
  const [lo, hi] = clip === 100 ? percentiles(sampleOf([arr]), [0, 100]) : percentiles(sampleOf([arr]), [1, clip]);
  return {lo, hi: hi > lo ? hi : lo + 1e-6};
}
function stretchFn() {
  const s = $('stretchSelect').value;
  if (s === 'sqrt') return Math.sqrt;
  if (s === 'log') return (t) => Math.log10(1 + 1000 * t) / Math.log10(1001);
  if (s === 'asinh') return (t) => Math.asinh(10 * t) / Math.asinh(10);
  return (t) => t;
}
function render(arr, n, diverging = false) {
  const sc = scaleFor(arr, diverging); const st = stretchFn();
  const br = +$('brightness').value, ct = +$('contrast').value, gm = +$('gamma').value;
  const l = lut(diverging ? 'diverging' : $('cmapSelect').value);
  const cv = document.createElement('canvas'); cv.width = n; cv.height = n;
  const ctx = cv.getContext('2d'); const im = ctx.createImageData(n, n); const px = im.data;
  for (let y = 0; y < n; y++) {
    const row = n - 1 - y;
    for (let x = 0; x < n; x++) {
      const v = arr[y * n + x]; const o = (row * n + x) * 4;
      if (!isFinite(v)) { px[o] = 46; px[o + 1] = 53; px[o + 2] = 58; px[o + 3] = 255; continue; }
      let t;
      if (diverging) { const m = sc.hi; const u = clamp(Math.abs(v) / m, 0, 1); t = 0.5 + Math.sign(v) * 0.5 * st(u); }
      else t = st(clamp((v - sc.lo) / (sc.hi - sc.lo), 0, 1));
      t = clamp((t - 0.5) * ct + 0.5 + br, 0, 1); t = Math.pow(t, 1 / gm);
      const k = Math.round(t * 255) * 3; px[o] = l[k]; px[o + 1] = l[k + 1]; px[o + 2] = l[k + 2]; px[o + 3] = 255;
    }
  }
  ctx.putImageData(im, 0, 0);
  cv._scale = sc;
  return cv;
}
function flagsCanvas(fr, n) {
  const bad = frameArr(fr, 'bad'); const cv = document.createElement('canvas'); cv.width = n; cv.height = n;
  const ctx = cv.getContext('2d'); const im = ctx.createImageData(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (bad[y * n + x]) {
    const o = ((n - 1 - y) * n + x) * 4; im.data[o] = 255; im.data[o + 1] = 60; im.data[o + 2] = 60; im.data[o + 3] = 170;
  }
  ctx.putImageData(im, 0, 0); return cv;
}

const stage = $('stage'); const sctx = stage.getContext('2d');
let panels = [];

function resizeStage() {
  const r = stage.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
  stage.width = Math.max(1, Math.round(r.width * dpr)); stage.height = Math.max(1, Math.round(r.height * dpr));
  draw();
}
new ResizeObserver(resizeStage).observe($('stageWrap'));

function curFrame() { return S.view[S.cur]; }
function frameA() { return S.view[S.A]; }
function frameB() { return S.view[S.B]; }

function draw() {
  const W = stage.width, H = stage.height; const dpr = window.devicePixelRatio || 1;
  sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.fillStyle = '#1E2326'; sctx.fillRect(0, 0, W, H);
  panels = [];
  if (!S.data || !S.view.length) { $('frameLabel').textContent = ''; return; }
  $('stageMsg').textContent = '';
  const n = S.data.size; const gap = 12 * dpr;
  const twoUp = S.mode === 'side';
  const fit = twoUp ? Math.min((W - gap * 3) / 2, H - gap * 2) / n : Math.min(W - gap * 2, H - gap * 2) / n;
  const s = fit * S.zoom;
  sctx.imageSmoothingEnabled = false;
  const cx = W / 2 + S.panX * dpr, cy = H / 2 + S.panY * dpr;
  let label = '';

  const put = (cv, ox, oy, fr, tag, clipRect) => {
    sctx.save();
    if (clipRect) { sctx.beginPath(); sctx.rect(...clipRect); sctx.clip(); }
    sctx.drawImage(cv, ox, oy, n * s, n * s);
    if (fr && $('showFlags').checked) sctx.drawImage(flagsCanvas(fr, n), ox, oy, n * s, n * s);
    sctx.restore();
    panels.push({x: ox, y: oy, s, frame: fr, tag});
  };

  if (S.mode === 'timelapse' || S.mode === 'blink') {
    const fr = S.mode === 'blink' ? (S.blinkShowB ? frameB() : frameA()) : curFrame();
    put(render(layerOf(fr), n), cx - n * s / 2, cy - n * s / 2, fr, S.mode === 'blink' ? (S.blinkShowB ? 'B' : 'A') : '');
    const idx = S.view.indexOf(fr);
    label = `${S.mode === 'blink' ? (S.blinkShowB ? 'B: ' : 'A: ') : ''}${fmtDate(fr.date)}\nFrame ${idx + 1} of ${S.view.length}, detector D${fr.detector ?? '?'}, ${fmtNum(fr.wavelength_um, 3)} µm`;
  } else if (S.mode === 'side') {
    const a = frameA(), b = frameB(); const w = n * s;
    put(render(layerOf(a), n), cx - w - gap / 2, cy - w / 2, a, 'A');
    put(render(layerOf(b), n), cx + gap / 2, cy - w / 2, b, 'B');
    label = `A: ${fmtDate(a.date)}, D${a.detector}\nB: ${fmtDate(b.date)}, D${b.detector}`;
  } else if (S.mode === 'swipe') {
    const a = frameA(), b = frameB(); const w = n * s; const ox = cx - w / 2, oy = cy - w / 2;
    const xs = ox + w * S.swipe;
    put(render(layerOf(a), n), ox, oy, a, 'A', [ox, oy, xs - ox, w]);
    put(render(layerOf(b), n), ox, oy, b, 'B', [xs, oy, ox + w - xs, w]);
    sctx.strokeStyle = '#ffb454'; sctx.lineWidth = 2 * dpr; sctx.beginPath(); sctx.moveTo(xs, oy - 6); sctx.lineTo(xs, oy + w + 6); sctx.stroke();
    sctx.fillStyle = '#ffb454'; sctx.font = `${11 * dpr}px sans-serif`; sctx.fillText('A', xs - 16 * dpr, oy + 14 * dpr); sctx.fillText('B', xs + 7 * dpr, oy + 14 * dpr);
    label = `A: ${fmtDate(a.date)}\nB: ${fmtDate(b.date)}. Drag across the image to move the divider.`;
  } else if (S.mode === 'diff') {
    const a = frameA(), b = frameB(); const la = layerOf(a), lb = layerOf(b);
    const d = new Float32Array(la.length); for (let i = 0; i < d.length; i++) d[i] = la[i] - lb[i];
    put(render(d, n, true), cx - n * s / 2, cy - n * s / 2, a, 'A−B');
    label = `A minus B\nRed is brighter in A (${a.date.slice(0, 10)}), blue is brighter in B (${b.date.slice(0, 10)}).`;
    if (a.detector !== b.detector) label += `\nA and B come from different detector arrays, so stars differ in colour too.`;
  } else if (S.mode === 'stack') {
    const kind = document.querySelector('input[name=stackKind]:checked').value;
    const arrs = S.view.map((f) => layerOf(f)); const L = arrs[0].length; const out = new Float32Array(L);
    const bads = $('layerSelect').value === 'quality' ? null : S.view.map((f) => badGrown(f, n));
    for (let i = 0; i < L; i++) {
      let sum = 0, cnt = 0, mx = -Infinity, sumA = 0, cntA = 0, mxA = -Infinity;
      for (let k = 0; k < arrs.length; k++) {
        const v = arrs[k][i]; if (!isFinite(v)) continue;
        sumA += v; cntA++; if (v > mxA) mxA = v;
        if (bads && bads[k][i]) continue;
        sum += v; cnt++; if (v > mx) mx = v;
      }
      if (!cnt) { sum = sumA; cnt = cntA; mx = mxA; }
      out[i] = cnt ? (kind === 'max' ? mx : sum / cnt) : NaN;
    }
    if (kind === 'resid') {
      const c = layerOf(curFrame()); const r = new Float32Array(L); for (let i = 0; i < L; i++) r[i] = c[i] - out[i];
      put(render(r, n, true), cx - n * s / 2, cy - n * s / 2, curFrame(), 'resid');
      label = `${fmtDate(curFrame().date)} minus the average\nRed is brighter than usual, blue is fainter.`;
    } else {
      put(render(out, n), cx - n * s / 2, cy - n * s / 2, null, kind);
      label = `${kind === 'max' ? 'Brightest pixel' : 'Average'} of ${arrs.length} frames\n${S.det ? 'Detector D' + S.det : 'All detector arrays'}`;
    }
  }
  $('frameLabel').textContent = label;
  for (const p of panels) drawOverlays(p);
  drawColorbar();
}

function toScreen(p, x, y) { const n = S.data.size; return [p.x + (x + 0.5) * p.s, p.y + (n - 1 - y + 0.5) * p.s]; }

function onLight() {
  return $('cmapSelect').value === 'plate' || S.mode === 'diff' ||
    (S.mode === 'stack' && document.querySelector('input[name=stackKind]:checked').value === 'resid');
}
function drawOverlays(p) {
  const L = onLight(); const KC = L ? KIND_INK : KIND_COLOR; const FONT = 'Archivo, Arial, sans-serif';
  const n = S.data.size; const dpr = window.devicePixelRatio || 1; const ctx = sctx;
  ctx.save();
  ctx.beginPath(); ctx.rect(p.x, p.y, n * p.s, n * p.s); ctx.clip();
  if ($('showCross').checked) {
    const tq = targetXY(p.frame); const [x, y] = toScreen(p, tq.x, tq.y); const r = 9 * dpr, g = 4 * dpr;
    ctx.strokeStyle = L ? 'rgba(15,110,153,.9)' : 'rgba(92,179,214,.9)'; ctx.lineWidth = 1.4 * dpr; ctx.beginPath();
    ctx.moveTo(x - r - g, y); ctx.lineTo(x - g, y); ctx.moveTo(x + g, y); ctx.lineTo(x + r + g, y);
    ctx.moveTo(x, y - r - g); ctx.lineTo(x, y - g); ctx.moveTo(x, y + g); ctx.lineTo(x, y + r + g); ctx.stroke();
  }
  const cats = [['gaia', $('showGaia').checked, L ? '#0F6E99' : '#5CB3D6'], ['allwise', $('showWise').checked, L ? '#B86E00' : '#E5A03A']];
  for (const [k, on, col] of cats) {
    const c = S.catalogs[k]; if (!on || !c || S.data.tracked) continue;
    ctx.strokeStyle = col; ctx.lineWidth = 1 * dpr;
    for (const [ra, dec] of c.sources) {
      const q = skyToPix(ra, dec, ctr().ra, ctr().dec, n);
      if (q.x < -2 || q.y < -2 || q.x > n + 1 || q.y > n + 1) continue;
      const [x, y] = toScreen(p, q.x, q.y); const r = 3.5 * dpr;
      ctx.beginPath();
      if (k === 'gaia') { ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); }
      else ctx.arc(x, y, r + 2 * dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if ($('showDetections').checked && S.data.detections) {
    const fid = p.frame ? p.frame.id : null;
    for (const d of S.data.detections) {
      const col = KC[d.kind] || '#fff'; const sel = S.sel === d.id;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = (sel ? 2.4 : 1.5) * dpr;
      const here = d.track.find((t) => t.frame === fid);
      const R = clamp(2.6 * p.s, 7 * dpr, 24 * dpr);
      if (d.kind === 'moving') {
        ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.globalAlpha = 0.8; ctx.beginPath();
        d.track.forEach((t, i) => { const [x, y] = toScreen(p, t.x, t.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
        for (const t of d.track) { const [x, y] = toScreen(p, t.x, t.y); ctx.beginPath(); ctx.arc(x, y, 2 * dpr, 0, 7); ctx.fill(); }
        if (here) { const [x, y] = toScreen(p, here.x, here.y); ctx.beginPath(); ctx.arc(x, y, R, 0, 7); ctx.stroke(); }
      } else if (d.kind === 'shifted') {
        const a = d.track[0], b = d.track[d.track.length - 1];
        const [x1, y1] = toScreen(p, a.x, a.y), [x2, y2] = toScreen(p, b.x, b.y);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        const ang = Math.atan2(y2 - y1, x2 - x1); ctx.beginPath(); ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - 6 * dpr * Math.cos(ang - 0.5), y2 - 6 * dpr * Math.sin(ang - 0.5));
        ctx.lineTo(x2 - 6 * dpr * Math.cos(ang + 0.5), y2 - 6 * dpr * Math.sin(ang + 0.5)); ctx.closePath(); ctx.fill();
        const c = here || {x: d.x, y: d.y}; const [x, y] = toScreen(p, c.x, c.y);
        ctx.beginPath(); ctx.arc(x, y, R, 0, 7); ctx.stroke();
      } else {
        const c = here || {x: d.x, y: d.y}; const [x, y] = toScreen(p, c.x, c.y);
        if (d.kind === 'transient') { ctx.setLineDash([3 * dpr, 3 * dpr]); ctx.globalAlpha = here ? 1 : 0.35; }
        ctx.beginPath(); ctx.arc(x, y, R, 0, 7); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
      const c0 = here || d.track[0] || d; const [lx, ly] = toScreen(p, c0.x, c0.y);
      if (sel || d.name) {
        ctx.font = `600 ${12 * dpr}px ${FONT}`; const txt = d.name || KIND_LABEL[d.kind]; const tw = ctx.measureText(txt).width;
        const right = p.x + n * p.s; const tx = lx + R + 4 * dpr + tw > right - 4 * dpr ? lx - R - 4 * dpr - tw : lx + R + 4 * dpr;
        ctx.fillText(txt, tx, ly - R + 6 * dpr);
      }
    }
  }
  ctx.restore();
  const w = n * p.s; const bx = p.x + 10 * dpr, by = p.y + w - 12 * dpr; const bar = 60 / PIX_ARCSEC * p.s;
  const ink = L ? '#10171A' : '#DCE2E4'; ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = 1.5 * dpr; ctx.font = `${11 * dpr}px ${FONT}`;
  if (bar < w * 0.6) { ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + bar, by); ctx.stroke(); ctx.fillText('1′', bx + bar / 2 - 4 * dpr, by - 5 * dpr); }
  const ex = p.x + w - 16 * dpr, ey = p.y + w - 16 * dpr, a = 20 * dpr;
  ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex, ey - a); ctx.moveTo(ex, ey); ctx.lineTo(ex - a, ey); ctx.stroke();
  ctx.fillText('N', ex - 3 * dpr, ey - a - 3 * dpr); ctx.fillText('E', ex - a - 10 * dpr, ey + 4 * dpr);
  if (p.tag && ['side', 'swipe', 'blink'].includes(S.mode)) { ctx.font = `700 ${13 * dpr}px ${FONT}`; ctx.fillStyle = L ? '#B86E00' : '#E5A03A'; ctx.fillText(p.tag, p.x + 8 * dpr, p.y + 18 * dpr); }
}

let drag = null;
stage.addEventListener('pointerdown', (e) => {
  stage.setPointerCapture(e.pointerId);
  drag = {x: e.clientX, y: e.clientY, px: S.panX, py: S.panY, moved: false};
  if (S.mode === 'swipe') setSwipe(e);
  else stage.classList.add('dragging');
});
stage.addEventListener('pointermove', (e) => {
  hover(e);
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.hypot(dx, dy) > 3) drag.moved = true;
  if (S.mode === 'swipe') { setSwipe(e); return; }
  S.panX = drag.px + dx; S.panY = drag.py + dy; draw();
});
stage.addEventListener('pointerup', (e) => {
  stage.classList.remove('dragging');
  if (drag && !drag.moved) clickSelect(e);
  drag = null;
});
stage.addEventListener('pointerleave', () => { $('readout').textContent = ''; });
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = stage.getBoundingClientRect(); const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
  const f = e.deltaY < 0 ? 1.15 : 1 / 1.15; const nz = clamp(S.zoom * f, 0.5, 16); const k = nz / S.zoom;
  S.panX = mx - (mx - S.panX) * k; S.panY = my - (my - S.panY) * k; S.zoom = nz; draw();
}, {passive: false});
stage.addEventListener('dblclick', () => { S.zoom = 1; S.panX = S.panY = 0; draw(); });
function setSwipe(e) {
  const p = panels[0]; if (!p) return; const dpr = window.devicePixelRatio || 1;
  const r = stage.getBoundingClientRect(); const x = (e.clientX - r.left) * dpr;
  S.swipe = clamp((x - p.x) / (S.data.size * p.s), 0, 1); draw();
}
function eventPix(e) {
  const dpr = window.devicePixelRatio || 1; const r = stage.getBoundingClientRect();
  const sx = (e.clientX - r.left) * dpr, sy = (e.clientY - r.top) * dpr; const n = S.data ? S.data.size : 0;
  for (const p of panels) {
    const x = (sx - p.x) / p.s - 0.5, row = (sy - p.y) / p.s - 0.5;
    if (x >= -0.5 && row >= -0.5 && x < n - 0.5 && row < n - 0.5) return {p, x, y: n - 1 - row, sx, sy};
  }
  return null;
}
function hover(e) {
  if (!S.data) return; const q = eventPix(e); if (!q) { $('readout').textContent = ''; return; }
  const n = S.data.size; const ix = Math.round(q.x), iy = Math.round(q.y);
  let val = '';
  if (q.p.frame && ix >= 0 && iy >= 0 && ix < n && iy < n) {
    const v = layerOf(q.p.frame)[iy * n + ix]; val = isFinite(v) ? `${v.toPrecision(4)} MJy/sr` : 'no data';
    if (frameArr(q.p.frame, 'bad')[iy * n + ix]) val += ' · flagged';
  }
  if (S.data.tracked) { $('readout').textContent = `x ${q.x.toFixed(1)} y ${q.y.toFixed(1)}  ${val}`; return; }
  const sky = pixToSky(q.x, q.y, ctr().ra, ctr().dec, n);
  $('readout').textContent = `${hms(sky.ra)} ${dms(sky.dec)}\n${sky.ra.toFixed(5)} ${sky.dec.toFixed(5)}  ${val}`;
}
function clickSelect(e) {
  if (!S.data || !$('showDetections').checked) return; const q = eventPix(e); if (!q) return;
  const dpr = window.devicePixelRatio || 1; let best = null, bd = 18 * dpr;
  for (const d of S.data.detections || []) {
    const pts = d.track.length ? d.track : [d];
    for (const t of pts) { const [x, y] = toScreen(q.p, t.x, t.y); const dd = Math.hypot(x - q.sx, y - q.sy); if (dd < bd) { bd = dd; best = d; } }
  }
  if (best) selectDetection(best.id);
}

function setFrame(i) {
  if (!S.view.length) return;
  S.cur = (i + S.view.length) % S.view.length;
  updateStrip(); updateFrameMeta(); highlightCharts(); draw();
}
function play(on) {
  S.playing = on ?? !S.playing;
  if (S.playing && S.view.length < 2) S.playing = false;
  $('playBtn').classList.toggle('playing', S.playing);
  $('playBtn').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
  clearInterval(S.timer);
  if (S.playing) {
    if (!['timelapse', 'blink', 'stack'].includes(S.mode)) setMode('timelapse');
    const fps = +$('speedSelect').value;
    S.timer = setInterval(() => {
      if (S.mode === 'blink') { S.blinkShowB = !S.blinkShowB; draw(); } else setFrame(S.cur + 1);
    }, 1000 / fps);
  }
}
function buildTimeline() {
  const strip = $('strip'); strip.innerHTML = '';
  S.view.forEach((f, i) => {
    const b = document.createElement('button'); b.className = 'plate'; b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-label', `Frame ${i + 1} of ${S.view.length}, ${fmtDate(f.date)}, detector ${f.detector ?? 'unknown'}, ${fmtNum(f.wavelength_um, 2)} micrometres`);
    b.innerHTML = `<canvas width="${S.data.size}" height="${S.data.size}"></canvas><span class="ab-mark"></span>` +
      `<span class="bar" style="background:${DET_COLOR[f.detector] || '#666'}"></span>` +
      `<span class="d">${f.date.slice(0, 10)}</span><span>D${f.detector ?? '?'}, ${fmtNum(f.wavelength_um, 2)} µm</span>`;
    b.onclick = () => { play(false); if (S.mode !== 'timelapse' && S.mode !== 'stack') setMode('timelapse'); setFrame(i); };
    strip.appendChild(b);
  });
  renderThumbs(); updateStrip();
}
function renderThumbs() {
  if (!S.data) return; const n = S.data.size;
  [...$('strip').children].forEach((b, i) => {
    const fr = S.view[i]; if (!fr) return;
    const c = b.querySelector('canvas'); c.getContext('2d').drawImage(render(layerOf(fr), n), 0, 0);
  });
}
function updateStrip() {
  const kids = [...$('strip').children];
  kids.forEach((b, i) => {
    b.setAttribute('aria-selected', i === S.cur ? 'true' : 'false');
    b.querySelector('.ab-mark').textContent = ['blink', 'side', 'swipe', 'diff'].includes(S.mode) ? (i === S.A ? 'A' : i === S.B ? 'B' : '') : '';
  });
  const cur = kids[S.cur];
  if (cur) { const st = $('strip'); const l = cur.offsetLeft - st.offsetLeft; if (l < st.scrollLeft || l + cur.offsetWidth > st.scrollLeft + st.clientWidth) st.scrollLeft = l - st.clientWidth / 2 + cur.offsetWidth / 2; }
}
const updateTicks = updateStrip;

function frameLabelShort(f, i) { return `${f.date.slice(0, 10)}, D${f.detector ?? '?'}, ${fmtNum(f.wavelength_um, 2)} µm`; }
function applyFilter(keepFrameId) {
  const keep = keepFrameId || (curFrame() && curFrame().id);
  S.view = S.frames.filter((f) => !S.det || f.detector === S.det);
  if (!S.view.length) { S.view = S.frames.slice(); S.det = 0; }
  S.scaleCache.clear();
  const ci = S.view.findIndex((f) => f.id === keep); S.cur = ci >= 0 ? ci : 0;
  S.A = 0; S.B = S.view.length - 1;
  fillAB(); buildTimeline(); updateDetChips(); setFrame(S.cur); drawCharts();
}
function fillAB() {
  for (const [id, key] of [['obsA', 'A'], ['obsB', 'B']]) {
    const sel = $(id); sel.innerHTML = '';
    S.view.forEach((f, i) => { const o = document.createElement('option'); o.value = i; o.textContent = frameLabelShort(f, i); sel.appendChild(o); });
    sel.value = S[key];
  }
}
function updateDetChips() {
  const box = $('detectorChips'); box.innerHTML = '';
  const counts = {}; S.frames.forEach((f) => { counts[f.detector] = (counts[f.detector] || 0) + 1; });
  const mk = (d, text, sub) => {
    const b = document.createElement('button'); b.className = 'chip' + (S.det === d ? ' active' : '') + (d && !counts[d] ? ' off' : '');
    b.textContent = text; b.disabled = !!d && !counts[d];
    if (d) b.style.borderBottomColor = DET_COLOR[d];
    b.setAttribute('aria-pressed', S.det === d ? 'true' : 'false');
    b.title = d ? `Detector ${d}: ${DET_RANGE[d][0]}–${DET_RANGE[d][1]} µm, ${counts[d] || 0} frames` : 'Frames from every detector array';
    b.onclick = () => { S.det = d; applyFilter(); updateURL(); }; box.appendChild(b);
  };
  mk(0, 'All', S.frames.length);
  for (let d = 1; d <= 6; d++) mk(d, `D${d}`, counts[d] ? `${counts[d]}` : '0');
  $('detHint').textContent = S.det ? `D${S.det} covers ${DET_RANGE[S.det][0]} to ${DET_RANGE[S.det][1]} µm.` : 'Six arrays, each covering part of 0.75 to 5 µm.';
}
function updateFrameMeta() {
  const f = curFrame(); if (!f) { $('frameMeta').innerHTML = ''; return; }
  const link = f.url ? `<a href="${f.url}" target="_blank" rel="noopener">${f.file}</a>` : (f.file || f.id);
  const rng = DET_RANGE[f.detector];
  $('frameMeta').innerHTML = `<dl>
    <dt>Date</dt><dd>${fmtDate(f.date)}</dd>
    <dt>MJD</dt><dd>${fmtNum(f.mjd, 5)}</dd>
    <dt>Detector</dt><dd>D${f.detector ?? '?'}${rng ? ` (${rng[0]}–${rng[1]} µm)` : ''}</dd>
    <dt>Wavelength</dt><dd>${fmtNum(f.wavelength_um, 4)} µm${f.bandwidth_um ? ` ± ${fmtNum(f.bandwidth_um / 2, 4)}` : ''}</dd>
    <dt>Flagged</dt><dd>${(100 * (f.flagged_fraction || 0)).toFixed(1)} % of pixels${f.flag_counts ? ` (${Object.entries(f.flag_counts).filter(([k]) => k !== 'SOURCE').map(([k, v]) => `${k.toLowerCase().replace('_', ' ')} ${v}`).join(', ')})` : ''}</dd>
    ${f.psf_fwhm_arcsec ? `<dt>Star width</dt><dd>${f.psf_fwhm_arcsec}″ (one pixel is 6.15″)</dd>` : ''}
    <dt>File</dt><dd>${link}</dd>
    <dt>Source</dt><dd>${S.data.source}</dd></dl>`;
}
function showNotes() {
  const notes = [...(S.data.notes || [])];
  const html = notes.map((t) => `<p class="${/SYNTHETIC|not reliable|No clear source|too small/i.test(t) ? 'warn' : ''}">${t}</p>`).join('');
  $('notes').innerHTML = html;
}

function buildDetList() {
  const ul = $('detList'); ul.innerHTML = ''; const dets = S.data.detections || [];
  $('detCount').textContent = dets.length;
  if (!dets.length) { ul.innerHTML = `<li class="empty">${S.frames.length < 2 ? 'Only one frame here, so there is nothing to compare. Try another object.' : 'Nothing changed enough to be flagged. Play the frames and look for yourself.'}</li>`; return; }
  for (const d of dets) {
    const li = document.createElement('li'); li.dataset.id = d.id; if (S.sel === d.id) li.className = 'sel';
    const extra = d.kind === 'moving' ? (d.speed_arcsec_per_day != null ? `${d.speed_arcsec_per_day}″ a day` : (S.data.tracked ? 'known asteroid' : 'position from catalogue')) :
      d.kind === 'shifted' ? `${d.motion_arcsec_per_year}″ a year` :
      d.kind === 'variable' ? `${d.amplitude_ratio}× brighter at peak` : 'one frame';
    const conf = d.confidence == null ? null : Math.round(d.confidence * 100);
    li.style.borderLeftColor = KIND_COLOR[d.kind]; li.tabIndex = 0;
    li.innerHTML = `<span class="kind">${d.name || KIND_LABEL[d.kind] || d.kind}<small>${d.name ? KIND_LABEL[d.kind].toLowerCase() + ', ' : ''}${extra}, ${d.frames.length} frame${d.frames.length === 1 ? '' : 's'}</small></span>
      <span>${conf == null ? '<div class="conf-txt">no score</div>' : `<div class="conf"><b style="width:${conf}%;background:${KIND_COLOR[d.kind]}"></b></div><div class="conf-txt">score ${conf}</div>`}</span>`;
    li.onclick = () => selectDetection(d.id);
    li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDetection(d.id); } };
    ul.appendChild(li);
  }
}
function selectDetection(id) {
  S.sel = id; const d = (S.data.detections || []).find((x) => x.id === id);
  [...$('detList').children].forEach((li) => li.classList.toggle('sel', li.dataset.id === id));
  if (!d) { $('inspector').innerHTML = ''; draw(); return; }
  const n = S.data.size; const sky = S.data.tracked ? {ra: d.ra, dec: d.dec} : pixToSky(d.x, d.y, ctr().ra, ctr().dec, n);
  const rows = [
    ...(d.name ? [['Object', d.name]] : []),
    ['Type', `<span style="color:${KIND_COLOR[d.kind]}">${KIND_LABEL[d.kind]}</span>`],
    ['Position', `${hms(sky.ra)} ${dms(sky.dec)}<br>${sky.ra.toFixed(5)}°, ${sky.dec.toFixed(5)}°`],
    ['Score', d.confidence == null ? 'none, the position comes from a catalogue' : `${Math.round(d.confidence * 100)} out of 100`],
    ...(d.snr == null ? [] : [['Signal', `${d.snr} times the noise`]]),
    ['Seen in', `${d.frames.length} frame${d.frames.length === 1 ? '' : 's'}`],
  ];
  if (d.speed_arcsec_per_day != null) rows.push(['Speed', `${d.speed_arcsec_per_day}″ a day`]);
  if (d.motion_arcsec_per_year != null) rows.push(['Measured', `${d.motion_arcsec_per_year}″ a year, ${d.displacement_px} px across these frames`]);
  if (d.motion_east_arcsec_per_year != null) rows.push(['Direction', `${Math.abs(d.motion_east_arcsec_per_year)}″ ${d.motion_east_arcsec_per_year >= 0 ? 'E' : 'W'}, ${Math.abs(d.motion_north_arcsec_per_year)}″ ${d.motion_north_arcsec_per_year >= 0 ? 'N' : 'S'} per year`]);
  if (d.catalog_motion_arcsec_per_year != null) rows.push(['Catalogue', `${d.catalog_motion_arcsec_per_year}″ a year`]);
  if (d.comparison_stars != null) rows.push(['Compared to', `${d.comparison_stars} other stars in the field`]);
  if (d.amplitude_ratio != null) rows.push(['Brightness', `${d.amplitude_ratio}× between the faintest and brightest frame`]);
  $('inspector').innerHTML = `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <p class="explain">${d.note || KIND_EXPLAIN[d.kind] || ''}</p>
    <div class="actions">
      <button class="btn small" id="insZoom">Zoom in</button>
      <button class="btn small" id="insBlink">Blink first and last</button>
      <button class="btn small" id="insCopy">Copy position</button>
      ${S.data.tracked || !S.apiOk ? '' : '<button class="btn small" id="insSearch">Search around it</button>'}
    </div>`;
  $('insZoom').onclick = () => zoomTo(d.x, d.y, S.data.size >= 48 ? 4 : 2);
  $('insBlink').onclick = () => {
    const ids = d.track.map((t) => t.frame); const ia = S.view.findIndex((f) => f.id === ids[0]); const ib = S.view.findIndex((f) => f.id === ids[ids.length - 1]);
    if (ia < 0 || ib < 0) { S.det = 0; applyFilter(); }
    S.A = Math.max(0, S.view.findIndex((f) => f.id === ids[0])); S.B = Math.max(0, S.view.findIndex((f) => f.id === ids[ids.length - 1]));
    if (S.A === S.B) S.B = S.view.length - 1;
    fillAB(); updateTicks(); setMode('blink'); play(true);
  };
  $('insCopy').onclick = () => copyText(`${sky.ra.toFixed(6)} ${sky.dec.toFixed(6)}`, 'Position copied');
  if ($('insSearch')) $('insSearch').onclick = () => goCoords(sky.ra, sky.dec, `Near ${S.data.target.name || 'the field'}`);
  draw();
}
function zoomTo(x, y, z) {
  const n = S.data.size; const dpr = window.devicePixelRatio || 1;
  const fit = Math.min(stage.width - 24 * dpr, stage.height - 24 * dpr) / n; S.zoom = z;
  const s = fit * z / dpr; S.panX = -((x + 0.5) - n / 2) * s; S.panY = ((y + 0.5) - n / 2) * s; draw();
}

function chartSVG(el, pts, xKey, yLabel, xFmt, xDomain) {
  const W = el.clientWidth || 300, H = el.clientHeight || 100; const m = {l: 44, r: 8, t: 6, b: 18};
  const good = pts.filter((p) => p.flux != null && isFinite(p.flux) && p[xKey] != null);
  if (good.length < 1) { el.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">${pts.length && pts.every((p) => p.flagged) ? 'The target is saturated in every frame' : 'No usable measurement at the target'}</text></svg>`; return; }
  const xs = good.map((p) => p[xKey]); let x0 = xDomain ? xDomain[0] : Math.min(...xs), x1 = xDomain ? xDomain[1] : Math.max(...xs);
  if (x1 === x0) { x0 -= 1; x1 += 1; }
  const ys = good.flatMap((p) => [p.flux - (p.err || 0), p.flux + (p.err || 0)]); let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = (y1 - y0) * 0.1 || Math.abs(y1) * 0.1 || 1; y0 -= pad; y1 += pad;
  const X = (v) => m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r); const Y = (v) => H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b);
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  s += `<line class="axisline" x1="${m.l}" y1="${H - m.b}" x2="${W - m.r}" y2="${H - m.b}"/><line class="axisline" x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${H - m.b}"/>`;
  for (const v of [y0 + pad, (y0 + y1) / 2, y1 - pad]) s += `<text x="${m.l - 4}" y="${Y(v) + 3}" text-anchor="end">${(+v).toPrecision(3)}</text>`;
  const ticks = 4; for (let i = 0; i <= ticks; i++) { const v = x0 + (x1 - x0) * i / ticks; s += `<text x="${X(v)}" y="${H - 4}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}">${xFmt(v)}</text>`; }
  for (const p of good) {
    const cx = X(p[xKey]), cy = Y(p.flux); const col = '#C9D3D6';
    if (p.err) s += `<line x1="${cx}" x2="${cx}" y1="${Y(p.flux - p.err)}" y2="${Y(p.flux + p.err)}" stroke="${col}" stroke-opacity=".6"/>`;
    s += `<circle data-frame="${p.frame}" cx="${cx}" cy="${cy}" r="3.4" fill="${p.flagged ? 'none' : col}" stroke="${col}" stroke-width="1.4"><title>${fmtNum(p.flux, 3)} ± ${fmtNum(p.err, 3)} mJy${p.flagged ? ', saturated or flagged, not reliable' : ''}</title></circle>`;
  }
  el.innerHTML = s + '</svg>';
  el.querySelectorAll('circle').forEach((c) => { c.onclick = () => jumpToFrame(c.dataset.frame); });
}
function drawCharts() {
  if (!S.data) return; const ph = S.data.photometry || [];
  const mj = ph.map((p) => p.mjd); const span = mj.length ? Math.max(...mj) - Math.min(...mj) : 0;
  const mjd2date = (v) => { const d = new Date((v - 40587) * 86400000).toISOString(); return span < 3 ? d.slice(11, 16) : span < 120 ? d.slice(5, 10) : d.slice(0, 7); };
  chartSVG($('lcChart'), ph, 'mjd', 'mJy', mjd2date);
  chartSVG($('specChart'), ph.map((p) => ({...p, wl: p.wavelength_um})), 'wl', 'mJy', (v) => v.toFixed(1) + 'µm', [0.7, 5.05]);
  const dets = new Set(ph.map((p) => p.detector)); const wl = ph.map((p) => p.wavelength_um).filter((v) => v);
  $('photNote').textContent = `In millijansky, measured in a 2-pixel circle ${S.data.tracked ? 'at the predicted position of the asteroid' : 'at the target'}. Frames span ${wl.length ? Math.min(...wl).toFixed(2) + ' to ' + Math.max(...wl).toFixed(2) + ' µm' : 'several wavelengths'}, so part of the change is colour. Hollow points are saturated.`;
  highlightCharts();
}
function highlightCharts() {
  const f = curFrame(); if (!f) return;
  document.querySelectorAll('.chart circle').forEach((c) => { const on = c.dataset.frame === f.id; c.setAttribute('r', on ? 5.5 : 3.4); c.setAttribute('stroke', on ? '#E5A03A' : '#C9D3D6'); if (c.getAttribute('fill') !== 'none') c.setAttribute('fill', on ? '#E5A03A' : '#C9D3D6'); });
}
function jumpToFrame(id) {
  let i = S.view.findIndex((f) => f.id === id);
  if (i < 0) { S.det = 0; applyFilter(id); i = S.view.findIndex((f) => f.id === id); }
  if (S.mode !== 'timelapse' && S.mode !== 'stack') setMode('timelapse');
  setFrame(i);
}

function onData(data, opts = {}) {
  play(false);
  S.data = data; S.frames = data.frames.slice().sort((a, b) => a.mjd - b.mjd); S.sel = null;
  S.catalogs = {gaia: null, allwise: null}; S.zoom = 1; S.panX = S.panY = 0;
  if (opts.det != null && S.frames.some((f) => f.detector === opts.det)) S.det = opts.det; else S.det = 0;
  $('stageMsg').textContent = S.frames.length ? '' : 'SPHEREx has no images of this position yet.';
  showNotes(); buildDetList();
  $('inspector').innerHTML = '<p class="muted">Pick a change from the list or click its circle on the image.</p>';
  applyFilter();
  if ($('showGaia').checked) loadCatalog('gaia');
  if ($('showWise').checked) loadCatalog('allwise');
  const t = data.target;
  document.title = `${t.name ? t.name + ', ' : ''}SPHEREx Explorer`;
  markCurrentObject();
  updateURL();
}
async function loadStatic(slug, opts = {}) {
  loading(true, 'Loading images');
  try {
    const data = await fetchJSON(`data/targets/${slug}.json`);
    S.query = {slug}; onData(data, opts);
  } catch (e) { toast(`Could not load ${slug}. Check the connection and try again.`); }
  finally { loading(false); }
}
function angDist(ra1, dec1, ra2, dec2) {
  const r = Math.PI / 180; const c = Math.sin(dec1 * r) * Math.sin(dec2 * r) + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.cos((ra1 - ra2) * r);
  return Math.acos(clamp(c, -1, 1)) / r * 3600;
}
async function goCoords(ra, dec, name, opts = {}) {
  const fov = +$('fovSelect').value;
  const hit = (S.index?.objects || []).filter((o) => !o.tracked).map((o) => ({o, d: angDist(o.ra, o.dec, ra, dec),
    dc: o.center_ra != null ? angDist(o.center_ra, o.center_dec, ra, dec) : Infinity}))
    .filter((q) => q.d < 30 || (q.o.size >= 24 && q.dc < 0.4 * q.o.size * PIX_ARCSEC)).sort((a, b) => a.d - b.d).map((q) => q.o)[0];
  if (hit && !opts.forceLive) return loadStatic(hit.slug, opts);
  if (!S.apiOk) {
    S.data = null; S.frames = S.view = []; draw();
    $('stageMsg').innerHTML = `There are no prepared images at ${hms(ra)} ${dms(dec)}.<br><br>Searching any position needs the live search server, and it is not running on this copy of the site. Pick an object from the list, or start the server as described in the README.`; markCurrentObject();
    return;
  }
  loading(true, `Asking NASA's IRSA archive for images of ${name || 'this position'}. This can take a minute.`);
  try {
    const url = `${API}/api/frames?ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}&fov=${fov}&max_frames=30`;
    const data = await fetchJSON(url, {}, 240000);
    if (name) data.target.name = name;
    S.query = {ra, dec, name}; onData(data, opts);
    toast(`Found ${data.frames.length} images`);
  } catch (e) {
    $('stageMsg').textContent = `The archive did not answer (${e.message}). Try again, or pick a prepared object.`; S.data = null; S.frames = S.view = []; draw();
  } finally { loading(false); }
}
async function resolveName(name) {
  const q = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
  const local = q.length >= 3 && [...(S.index?.objects || []), ...(S.index?.official_targets || [])]
    .find((o) => norm(o.name) === q || norm(o.slug || '') === q || (q.length >= 5 && norm(o.name).includes(q)));
  if (local) return local;
  if (S.apiOk) {
    try { return await fetchJSON(`${API}/api/resolve?name=${encodeURIComponent(name)}`, {}, 25000); } catch (_) { S.resolveFailed = true; }
  }
  const txt = await (await fetch(`https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV?${encodeURIComponent(name)}`)).text();
  const m = txt.match(/^%J\s+([\d.+-]+)\s+([\d.+-]+)/m); if (!m) throw new Error('not found');
  return {name, ra: +m[1], dec: +m[2]};
}
async function onSearch(e) {
  e && e.preventDefault(); const text = $('coordInput').value.trim(); if (!text) return;
  const c = parseCoords(text);
  if (c) return goCoords(c.ra, c.dec, null);
  loading(true, `Looking up ${text}`);
  try { const r = await resolveName(text); loading(false); if (r.slug && S.index.objects.some((o) => o.slug === r.slug)) return loadStatic(r.slug); goCoords(r.ra, r.dec, r.name || text); }
  catch (err) { loading(false); toast(`No object called “${text}”. Type a name, or RA and Dec in degrees or as 08h55m10s −07d14m42s.`, 5000); }
}
async function loadCatalog(cat) {
  if (!S.data || S.data.tracked || S.catalogs[cat]) { draw(); return; }
  const {ra, dec} = ctr(); const radius = Math.round(S.data.size * PIX_ARCSEC * 0.75);
  try {
    if (S.apiOk) S.catalogs[cat] = await fetchJSON(`${API}/api/catalog?cat=${cat}&ra=${ra}&dec=${dec}&radius=${radius}`, {}, 40000);
    else {
      const src = cat === 'gaia' ? ['I/355/gaiadr3', 'RA_ICRS', 'DE_ICRS', 'Gmag'] : ['II/328/allwise', 'RAJ2000', 'DEJ2000', 'W1mag'];
      const url = `https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=${src[0]}&-c=${ra}%20${dec}&-c.rs=${radius}&-out=${src[1]},${src[2]},${src[3]}&-out.max=800`;
      const txt = await (await fetch(url)).text();
      const rows = txt.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('-')).map((l) => l.split('\t').map(parseFloat)).filter((r) => isFinite(r[0]) && isFinite(r[1]));
      S.catalogs[cat] = {sources: rows};
    }
    toast(`${cat === 'gaia' ? 'Gaia DR3' : 'AllWISE'}: ${S.catalogs[cat].sources.length} sources shown`);
  } catch (e) { toast(`Could not load the ${cat === 'gaia' ? 'Gaia' : 'AllWISE'} catalogue. It needs an internet connection to CDS.`); $(cat === 'gaia' ? 'showGaia' : 'showWise').checked = false; }
  draw();
}

let thumbTimer = null;
function renderThumbsSoon() { clearTimeout(thumbTimer); thumbTimer = setTimeout(renderThumbs, 120); }
function setMode(m) {
  S.mode = m; document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('stackOpts').classList.toggle('hidden', m !== 'stack');
  if (S.playing && !['timelapse', 'blink', 'stack'].includes(m)) play(false);
  if (S.playing) play(true);
  document.querySelectorAll('.mode').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === m ? 'true' : 'false'));
  S.zoom = 1; S.panX = S.panY = 0; updateURL(); updateStrip(); draw();
}
function updateURL() {
  if (!S.data) return; const p = new URLSearchParams();
  if (S.query && S.query.slug) p.set('obj', S.query.slug);
  else { p.set('ra', S.data.target.ra.toFixed(6)); p.set('dec', S.data.target.dec.toFixed(6)); p.set('fov', $('fovSelect').value); }
  if (S.det) p.set('det', S.det); if (S.mode !== 'timelapse') p.set('mode', S.mode);
  if (document.body.classList.contains('embed')) p.set('embed', '1');
  try { history.replaceState(null, '', `${location.pathname}?${p}`); } catch (_) { return; }
}
function copyText(t, done = 'Copied') { navigator.clipboard?.writeText(t).then(() => toast(done), () => toast(t, 6000)); }
function openModal(id) { $('modal-' + id).classList.remove('hidden'); }
async function openAladin() {
  if (!S.data) return toast('Pick an object first');
  openModal('aladin'); const {ra, dec} = S.data.target; const fov = S.data.size * PIX_ARCSEC / 3600 * 1.6;
  try {
    if (!window.A) {
      await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
      await window.A.init;
    }
    if (!openAladin.al) {
      openAladin.al = window.A.aladin('#aladinDiv', {survey: 'CDS/P/2MASS/color', fov, target: `${ra} ${dec}`, cooFrame: 'ICRS', showReticle: true});
    } else { openAladin.al.gotoRaDec(ra, dec); openAladin.al.setFoV(fov); openAladin.al.removeLayers?.(); }
    openAladin.al.addCatalog(window.A.catalogFromVizieR('I/355/gaiadr3', `${ra} ${dec}`, fov / 2, {name: 'Gaia DR3', color: '#5CB3D6', onClick: 'showTable'}));
    openAladin.al.addCatalog(window.A.catalogFromVizieR('II/328/allwise', `${ra} ${dec}`, fov / 2, {name: 'AllWISE', color: '#E5A03A', onClick: 'showTable'}));
  } catch (e) { $('aladinDiv').innerHTML = '<p class="muted" style="padding:20px">The sky atlas did not load. It needs an internet connection to CDS in Strasbourg.</p>'; }
}
async function checkApi() {
  try { await fetchJSON(`${API}/api/health`, {}, 5000); S.apiOk = true; } catch (_) { S.apiOk = false; }
  document.body.classList.toggle('no-api', !S.apiOk);
  $('coordInput').placeholder = S.apiOk ? 'RA and Dec, or a name. For example 08h55m10.8s −07d14m42s, or 133.795 −7.245'
    : 'Name of an object in the list, or its RA and Dec';
}
const GROUPS = [
  ['challenge', 'Challenge targets'],
  ['moving', 'Asteroids'],
  ['variable', 'Variable stars'],
  ['stable', 'Comparison stars'],
];
function objectBlurb(o) {
  if (o.class === 'challenge') {
    const t = (S.index.official_targets || []).find((q) => q.slug === o.slug);
    return t ? t.kind.charAt(0).toUpperCase() + t.kind.slice(1) : '';
  }
  if (o.kinds && o.kinds.length && o.class !== 'moving') return o.kinds.map((k) => KIND_LABEL[k].toLowerCase()).join(', ');
  return '';
}
function buildObjectList() {
  const box = $('objectList'); const q = $('objectFilter').value.trim().toLowerCase();
  box.innerHTML = '';
  const objs = S.index.objects.filter((o) => !q || o.name.toLowerCase().includes(q));
  const groups = [...GROUPS];
  if (objs.some((o) => o.demo)) groups.push(['__demo', 'Synthetic test data']);
  for (const [key, title] of groups) {
    const list = objs.filter((o) => (key === '__demo' ? o.demo : !o.demo && o.class === key));
    if (!list.length) continue;
    const h = document.createElement('div'); h.className = 'objgroup';
    h.innerHTML = `<span>${title}</span><span>${list.length}</span>`; box.appendChild(h);
    for (const o of list) {
      const b = document.createElement('button'); b.className = 'obj'; b.type = 'button'; b.dataset.slug = o.slug;
      b.setAttribute('role', 'listitem');
      const blurb = objectBlurb(o);
      b.innerHTML = `<span>${o.name}</span><span class="on">${o.frames} frame${o.frames === 1 ? '' : 's'}</span>` +
        (blurb ? `<span class="what">${blurb}</span>` : '');
      b.onclick = () => loadStatic(o.slug);
      box.appendChild(b);
    }
  }
  if (!box.children.length) box.innerHTML = `<p class="hint">Nothing in the list matches “${$('objectFilter').value}”. To look anywhere on the sky, type its position in the search box at the top.</p>`;
  markCurrentObject();
}
function markCurrentObject() {
  const slug = S.query && S.query.slug;
  document.querySelectorAll('#objectList .obj').forEach((b) => b.setAttribute('aria-current', b.dataset.slug === slug ? 'true' : 'false'));
}
async function loadIndex() {
  try { S.index = await fetchJSON('data/index.json', {}, 20000); } catch (_) { S.index = {objects: [], official_targets: []}; }
  buildObjectList();
}

function wire() {
  $('searchForm').addEventListener('submit', onSearch);
  $('objectFilter').addEventListener('input', buildObjectList);
  $('fovSelect').addEventListener('change', () => { if (S.query && !S.query.slug) goCoords(S.query.ra, S.query.dec, S.query.name); });
  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('obsA').addEventListener('change', (e) => { S.A = +e.target.value; updateTicks(); draw(); });
  $('obsB').addEventListener('change', (e) => { S.B = +e.target.value; updateTicks(); draw(); });
  $('analyzeBtn').addEventListener('click', () => {
    if (!S.data) return toast('Pick an object first');
    $('showDetections').checked = true;
    const dets = S.data.detections || []; const a = frameA(), b = frameB();
    const inAB = dets.filter((d) => d.frames.includes(a.id) || d.frames.includes(b.id)).length;
    if (S.mode !== 'blink') setMode('blink'); play(true);
    toast(dets.length ? `Blinking A and B. ${inAB} of ${dets.length} changes involve these two frames.` : 'Blinking A and B. Nothing was flagged in this field.');
    if (dets.length) selectDetection(dets[0].id);
  });
  $('playBtn').addEventListener('click', () => play());
  $('prevBtn').addEventListener('click', () => { play(false); setFrame(S.cur - 1); });
  $('nextBtn').addEventListener('click', () => { play(false); setFrame(S.cur + 1); });
  $('speedSelect').addEventListener('change', () => S.playing && play(true));
  document.querySelectorAll('input[name=stackKind]').forEach((r) => r.addEventListener('change', draw));
  for (const id of ['stretchSelect', 'cmapSelect', 'brightness', 'contrast', 'gamma']) $(id).addEventListener('input', () => { draw(); renderThumbsSoon(); });
  for (const id of ['showDetections', 'showFlags', 'showCross']) $(id).addEventListener('input', draw);
  for (const id of ['layerSelect', 'clipSelect', 'lockScale', 'smoothChk', 'repairChk']) $(id).addEventListener('input', () => { S.scaleCache.clear(); draw(); renderThumbsSoon(); });
  $('showGaia').addEventListener('change', (e) => e.target.checked ? loadCatalog('gaia') : draw());
  $('showWise').addEventListener('change', (e) => e.target.checked ? loadCatalog('allwise') : draw());
  $('resetBtn').addEventListener('click', () => {
    $('stretchSelect').value = 'asinh'; $('clipSelect').value = '99.5'; $('cmapSelect').value = 'plate'; $('layerSelect').value = 'clean';
    $('brightness').value = 0; $('contrast').value = 1; $('gamma').value = 1; $('lockScale').checked = true; $('smoothChk').checked = false; $('repairChk').checked = true;
    S.zoom = 1; S.panX = S.panY = 0; S.scaleCache.clear(); draw(); renderThumbs();
  });
  $('aladinBtn').addEventListener('click', openAladin);
  $('zoomIn').onclick = () => { S.zoom = clamp(S.zoom * 1.4, 0.5, 16); draw(); };
  $('zoomOut').onclick = () => { S.zoom = clamp(S.zoom / 1.4, 0.5, 16); draw(); };
  $('zoomReset').onclick = () => { S.zoom = 1; S.panX = S.panY = 0; draw(); };
  $('fullscreenBtn').onclick = () => { const c = document.querySelector('.center'); document.fullscreenElement ? document.exitFullscreen() : c.requestFullscreen?.(); };
  $('collapseRight').onclick = () => { const c = document.querySelector('.layout').classList.toggle('right-collapsed'); $('collapseRight').setAttribute('aria-label', c ? 'Show display settings' : 'Hide display settings'); };
  document.querySelectorAll('[data-modal]').forEach((b) => b.addEventListener('click', () => openModal(b.dataset.modal)));
  document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m || e.target.hasAttribute('data-close')) m.classList.add('hidden'); }));
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText($(b.dataset.copy).value)));
  $('shareBtn').addEventListener('click', () => {
    updateURL(); const url = location.href.replace(/&?embed=1/, '');
    $('shareLink').value = url;
    $('embedCode').value = `<iframe src="${url}${url.includes('?') ? '&' : '?'}embed=1" width="640" height="560" style="border:0" title="SPHEREx Explorer"></iframe>`;
    openModal('share');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden')); return; }
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === ' ' && e.target.matches('button, [tabindex]')) return;
    if (e.key === ' ') { e.preventDefault(); play(); }
    else if (e.key === 'ArrowRight') { play(false); setFrame(S.cur + 1); }
    else if (e.key === 'ArrowLeft') { play(false); setFrame(S.cur - 1); }
    else if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
  });
  if (CFG.teamName) $('teamName').textContent = CFG.teamName;
}

async function init() {
  wire();
  const p = new URLSearchParams(location.search);
  if (p.get('embed') === '1') document.body.classList.add('embed');
  if (p.get('fov')) $('fovSelect').value = p.get('fov');
  await Promise.all([loadIndex(), checkApi()]);
  const opts = {det: p.get('det') ? +p.get('det') : null};
  if (p.get('mode')) setMode(p.get('mode'));
  if (p.get('obj')) await loadStatic(p.get('obj'), opts);
  else if (p.get('ra') && p.get('dec')) await goCoords(+p.get('ra'), +p.get('dec'), p.get('name'), opts);
  else if (S.index.objects.length) {
    const first = S.index.objects.find((o) => o.class === 'challenge') || S.index.objects.find((o) => !o.demo) || S.index.objects[0];
    await loadStatic(first.slug);
  }
  if (S.data && S.view.length > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && !p.get('mode')) {
    play(true); setTimeout(() => { if (S.playing) { play(false); setFrame(0); } }, 1000 / +$('speedSelect').value * S.view.length + 200);
  }
}
window.SPX = {
  state: S, loadStatic, setMode, setFrame, play, selectDetection, draw,
  setAB(a, b) { S.A = a; S.B = b; fillAB(); updateStrip(); draw(); },
  setStack(kind) { const r = document.querySelector(`input[name=stackKind][value=${kind}]`); if (r) r.checked = true; draw(); },
  ready: init(),
};
})();
