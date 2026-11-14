(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const api = () => window.SPX;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const arrivedWithLink = location.search.length > 1;

const TIPS = [
  ['#coordInput', 'Find a place on the sky',
    'Type the right ascension and declination of a spot on the sky, the way astronomers point a telescope, or the name of an object in the list. Degrees (133.795 −7.245) and hours-minutes-seconds (08h55m10s −07d14m42s) both work.'],
  ['#searchForm .btn', 'Show', 'Loads every SPHEREx photograph of that spot and plays them in date order.', 'Enter'],
  ['#guidesBtn', 'Guides', 'Short guided stories that show what the tool can find, step by step.'],
  ['[data-modal=how]', 'How it works', 'What happens to the images between NASA\'s archive and your screen.'],
  ['[data-modal=about]', 'About', 'Who made this and where the data comes from.'],
  ['#shareBtn', 'Share', 'Copy a link that opens exactly this object and view, or code to embed the viewer in another website.'],
  ['#objectFilter', 'Filter the list', 'Type part of a name to shorten the list.'],
  ['.objgroup', 'Groups', 'Challenge targets are the five objects NASA asked to test with. The other groups come from our own dataset.'],
  ['.obj', 'Open this object', 'Shows all SPHEREx photographs of this object. The number on the right is how many there are.'],
  ['#fovSelect', 'Field size', 'How much sky to show. A bigger field can catch fast movers but takes longer to download.'],
  ['#detectorChips', 'Detector array',
    'SPHEREx has six detector arrays, each seeing a different infrared colour. Pick one to compare photos taken in the same colour, which is fairer when looking for brightness changes.'],
  ['#obsA', 'Frame A', 'The first photo to compare. It is marked A in the strip under the image.'],
  ['#obsB', 'Frame B', 'The second photo to compare. It is marked B in the strip under the image.'],
  ['#analyzeBtn', 'Blink A and B', 'Flips quickly between the two photos. Your eye picks up anything that jumps.'],
  ['#zoomIn', 'Zoom in', 'Zoom with the mouse wheel too.', 'Wheel'],
  ['#zoomOut', 'Zoom out', 'Zoom with the mouse wheel too.', 'Wheel'],
  ['#zoomReset', 'Fit', 'Shows the whole image again.', 'Double-click'],
  ['#fullscreenBtn', 'Full screen', 'Fills the screen with the image and the frame strip.'],
  ['#stage', 'The image',
    'One SPHEREx photograph, north up and east left. Drag to move, scroll to zoom. Circles mark changes the computer found; click one to read about it.', 'Drag · Wheel'],
  ['[data-mode=timelapse]', 'Time-lapse', 'Plays every photo in date order, like a flip-book.'],
  ['[data-mode=blink]', 'Blink', 'Flips between photo A and photo B. The classic way to spot something that moved.'],
  ['[data-mode=side]', 'Side by side', 'Shows A and B next to each other.'],
  ['[data-mode=swipe]', 'Swipe', 'Puts B on top of A. Drag across the image to slide the divider.'],
  ['[data-mode=diff]', 'Difference', 'Subtracts B from A. Anything that did not change disappears; red was brighter in A, blue was brighter in B.'],
  ['[data-mode=stack]', 'Stack', 'Combines all photos. The average hides noise and shows faint things; the brightest-pixel option draws a trail behind anything that moves.'],
  ['#prevBtn', 'Previous photo', '', '←'],
  ['#playBtn', 'Play or pause', 'Plays the photos in date order.', 'Space'],
  ['#nextBtn', 'Next photo', '', '→'],
  ['#speedSelect', 'Speed', 'How many photos to show per second.'],
  ['.plate', 'One photograph',
    'Date, detector array and infrared wavelength of this photo. The coloured bar shows the detector array. Click to look at it.'],
  ['#cmapSelect', 'Colours',
    'Plate shows stars dark on light, like the glass plates astronomers used for a century; faint things are easier to see. Grey shows them light on dark.'],
  ['#layerSelect', 'Layer',
    'What to show: the sky with the background glow removed, the raw recording, the glow of zodiacal dust on its own, the noise, or the pixels marked as bad.'],
  ['#stretchSelect', 'Stretch', 'How brightness maps to shade. asinh shows faint and bright stars together; linear is true to the numbers.'],
  ['#clipSelect', 'Clip at', 'Ignores the brightest pixels when setting the shade range, so one bright star does not wash out everything else.'],
  ['#brightness', 'Brightness', 'Moves all shades lighter or darker.'],
  ['#contrast', 'Contrast', 'Spreads the shades apart or pulls them together.'],
  ['#gamma', 'Gamma', 'Brings up faint detail without blowing out bright stars.'],
  ['#lockScale', 'Same scale for every photo', 'Keep this on so a star that looks brighter really is brighter, not just shaded differently.'],
  ['#showDetections', 'Changes found', 'Circles, arrows and tracks for everything the computer flagged.'],
  ['#showCross', 'Target position', 'Crosshair where the object should be on each date.'],
  ['#showFlags', 'Flagged pixels', 'Pixels SPHEREx marked as unreliable: cosmic-ray hits, dead pixels, saturated stars.'],
  ['#showGaia', 'Gaia stars', 'Marks stars from ESA\'s Gaia catalogue, so you can tell a known star from something new.'],
  ['#showWise', 'AllWISE sources', 'Marks infrared sources seen by NASA\'s WISE telescope around 2010.'],
  ['#repairChk', 'Fill cosmic-ray hits', 'Only changes the picture: single bad pixels are filled from their neighbours so they do not look like stars.'],
  ['#smoothChk', 'Smooth', 'Blurs by one pixel. Noise drops and faint smudges stand out.'],
  ['#resetBtn', 'Reset display', 'Puts all image settings back to normal.'],
  ['#aladinBtn', 'Sky atlas', 'Opens the same spot in Aladin, with pictures and catalogues from other telescopes.'],
  ['#detList li', 'A change the computer found', 'Click to see where it is and what was measured. The score is how sure the computer is, out of 100.', 'Enter'],
  ['#lcChart', 'Brightness over time', 'How bright the target was in each photo. Click a point to jump to that photo.'],
  ['#specChart', 'Spectrum', 'Brightness against infrared colour. Every photo is taken at a slightly different wavelength, so together they make a spectrum.'],
  ['#frameMeta', 'This photo', 'Date, detector, wavelength, how many pixels were flagged and the original file name in NASA\'s archive.'],
];

function tipFor(el) {
  for (const [sel, title, body, key] of TIPS) {
    const hit = el.closest && el.closest(sel);
    if (hit) return {hit, title, body, key};
  }
  return null;
}

const tip = document.createElement('div');
tip.className = 'tip hidden'; tip.setAttribute('role', 'tooltip');
document.body.appendChild(tip);
let tipTimer = null; let tipFor_ = null;

function showTip(t) {
  tip.innerHTML = `<b>${t.title}</b>${t.body ? `<p>${t.body}</p>` : ''}${t.key ? `<div class="key">${t.key.split(' · ').map((k) => `<kbd>${k}</kbd>`).join(' ')}</div>` : ''}`;
  tip.classList.remove('hidden');
  const r = t.hit.getBoundingClientRect(); const w = tip.offsetWidth; const h = tip.offsetHeight;
  const big = r.height > 200;
  let x = big ? r.left + 16 : r.left;
  let y = big ? r.top + 16 : r.bottom + 8;
  if (!big && y + h > innerHeight - 8) y = r.top - h - 8;
  x = Math.max(8, Math.min(x, innerWidth - w - 8)); y = Math.max(8, Math.min(y, innerHeight - h - 8));
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
function hideTip() { clearTimeout(tipTimer); tipFor_ = null; tip.classList.add('hidden'); }

document.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch' || document.body.classList.contains('touring')) return;
  const t = tipFor(e.target);
  if (!t) { hideTip(); return; }
  if (tipFor_ === t.hit) return;
  hideTip(); tipFor_ = t.hit;
  tipTimer = setTimeout(() => showTip(t), t.hit.id === 'stage' ? 1200 : 550);
});
document.addEventListener('pointerdown', hideTip);
document.addEventListener('scroll', hideTip, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
document.addEventListener('focusin', (e) => {
  if (!e.target.matches(':focus-visible') || document.body.classList.contains('touring')) return;
  const t = tipFor(e.target); if (t && t.hit.id !== 'stage') { tipFor_ = t.hit; showTip(t); } else hideTip();
});
document.addEventListener('focusout', hideTip);

let tour = null;
const spot = document.createElement('div'); spot.className = 'tour-spot hidden';
const card = document.createElement('div'); card.className = 'tour-card hidden';
card.setAttribute('role', 'dialog'); card.setAttribute('aria-live', 'polite');
document.body.append(spot, card);

function place(el, side) {
  const r = el.getBoundingClientRect(); const pad = 6;
  Object.assign(spot.style, {left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`});
  const w = card.offsetWidth; const h = card.offsetHeight; const gap = 18;
  const room = {right: innerWidth - r.right, left: r.left, bottom: innerHeight - r.bottom, top: r.top};
  const s = side && room[side] > (side === 'left' || side === 'right' ? w : h) + gap ? side
    : Object.entries(room).sort((a, b) => b[1] - a[1])[0][0];
  let x; let y;
  if (s === 'right') { x = r.right + gap; y = r.top; }
  if (s === 'left') { x = r.left - w - gap; y = r.top; }
  if (s === 'bottom') { x = r.left; y = r.bottom + gap; }
  if (s === 'top') { x = r.left; y = r.top - h - gap; }
  if (room[s] < (s === 'left' || s === 'right' ? w : h) + gap) { x = innerWidth - w - 12; y = innerHeight - h - 12; }
  card.style.left = `${Math.max(12, Math.min(x, innerWidth - w - 12))}px`;
  card.style.top = `${Math.max(12, Math.min(y, innerHeight - h - 12))}px`;
}

async function show(i) {
  const steps = tour.steps; tour.i = i; const st = steps[i];
  card.classList.add('hidden');
  if (st.before) { try { await st.before(api()); } catch (e) { console.warn(e); } }
  if (!tour) return;
  const el = document.querySelector(st.el);
  if (!el) { if (i < steps.length - 1) show(i + 1); else endTour(); return; }
  el.scrollIntoView({block: 'nearest', inline: 'nearest'});
  await wait(60);
  const text = typeof st.text === 'function' ? st.text(api().state) : st.text;
  const last = i === steps.length - 1;
  card.innerHTML = `<button class="tour-x" aria-label="Close the guide">×</button><h3>${st.title}</h3>${text.split('\n\n').map((p) => `<p>${p}</p>`).join('')}
    <div class="tour-foot"><span class="tour-count">${i + 1} of ${steps.length}</span>
    ${i ? '<button class="btn small" data-t="back">Back</button>' : ''}
    <button class="btn small primary" data-t="next">${last ? (tour.endLabel || 'Finish') : 'Next'}</button></div>`;
  spot.classList.remove('hidden'); card.classList.remove('hidden');
  place(el, st.side);
  card.querySelector('[data-t=next]').focus();
}
function endTour() {
  if (tour && tour.after) tour.after(api());
  tour = null; document.body.classList.remove('touring');
  spot.classList.add('hidden'); card.classList.add('hidden');
}
async function startTour(t) {
  closeModals(); hideTip();
  await api().ready;
  tour = {...t, i: 0}; document.body.classList.add('touring');
  show(0);
}
card.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || !tour) return;
  if (b.classList.contains('tour-x')) endTour();
  else if (b.dataset.t === 'next') { if (tour.i < tour.steps.length - 1) show(tour.i + 1); else endTour(); }
  else if (b.dataset.t === 'back') show(tour.i - 1);
});
document.addEventListener('keydown', (e) => {
  if (!tour) return;
  if (e.key === 'Escape') { e.stopPropagation(); endTour(); }
  if (e.key === 'ArrowRight' && !e.target.matches('input, select')) { e.preventDefault(); e.stopImmediatePropagation(); card.querySelector('[data-t=next]').click(); }
  if (e.key === 'ArrowLeft' && tour.i && !e.target.matches('input, select')) { e.preventDefault(); e.stopImmediatePropagation(); show(tour.i - 1); }
}, true);
addEventListener('resize', () => { if (tour) { const el = document.querySelector(tour.steps[tour.i].el); if (el) place(el, tour.steps[tour.i].side); } });

const findDet = (S, test) => (S.data && S.data.detections || []).find(test);
const selectDet = (x, test) => { const d = findDet(x.state, test); if (d) x.selectDetection(d.id); return d; };
const lastIndex = (x) => x.state.view.length - 1;

const GUIDES = [
  {
    id: 'barnard', slug: 'barnards-star', title: 'Watch the fastest star move', length: '1 minute',
    text: 'Barnard\'s Star crosses the sky faster than any other star. See it shift between two photos taken seven months apart.',
    steps: [
      {el: '#stageWrap', side: 'right', title: 'A patch of infrared sky',
        before: async (x) => { await x.loadStatic('barnards-star'); x.play(false); x.setMode('timelapse'); x.setFrame(0); },
        text: 'This is a small patch of sky around Barnard\'s Star, photographed by SPHEREx in infrared. Each dark dot is a star.\n\nThe photo is shown as a negative, dark stars on a light background, the way astronomers looked at glass photographic plates. Faint things are easier to see that way.'},
      {el: '#strip', side: 'top', title: 'Eight photos of the same spot',
        text: (S) => `SPHEREx photographed this spot ${S.view.length} times between ${S.view[0].date.slice(0, 7)} and ${S.view[S.view.length - 1].date.slice(0, 7)}. Each square is one photo, in date order. Click any of them to look at it.`},
      {el: '#stageWrap', side: 'right', title: 'Now watch it jump',
        before: async (x) => { x.setMode('blink'); x.setAB(0, lastIndex(x)); x.play(true); },
        text: 'The first and the last photo now flip back and forth. Look at the big dark star near the top: it jumps a little, while every other star stays still.\n\nThat jump is Barnard\'s Star moving through space, about one pixel in seven months.'},
      {el: '#detList', side: 'top', title: 'The computer saw it too',
        before: async (x) => { x.play(false); x.setMode('timelapse'); selectDet(x, (d) => d.kind === 'shifted'); },
        text: (S) => { const d = findDet(S, (q) => q.kind === 'shifted'); return d ? `Nobody told the program where to look. It measured every star in the field and found one drifting by ${d.motion_arcsec_per_year}″ a year.` : 'The program measured every star in the field and flagged the one that drifts.'; }},
      {el: '#inspector', side: 'top', title: 'Checking the answer',
        text: (S) => { const d = findDet(S, (q) => q.kind === 'shifted'); return d ? `Star catalogues give ${d.catalog_motion_arcsec_per_year}″ a year for Barnard's Star. Our ${d.motion_arcsec_per_year}″ is close. Part of the difference is parallax: Earth itself moved around the Sun between the photos.\n\nA star that moves this fast across the sky is usually close to us. Barnard's Star is six light-years away.` : 'The measured motion is close to the value in star catalogues.'; }},
      {el: '.res-col.charts', side: 'top', title: 'When a measurement can\'t be trusted',
        text: 'Barnard\'s Star is so bright that its centre saturates the detector, like an over-exposed photo. Its brightness here is not reliable, so those points are drawn hollow.\n\nThe tool says when a number can\'t be trusted instead of hiding it.'},
    ],
  },
  {
    id: 'wise', slug: 'wise-0855-0714', title: 'Hunt for the coldest brown dwarf', length: '1 minute',
    text: 'WISE 0855−0714 is the coldest brown dwarf known. Try to find it in the SPHEREx photos, and see what an uncertain result looks like.',
    steps: [
      {el: '#stageWrap', side: 'right', title: 'Something very cold',
        before: async (x) => { await x.loadStatic('wise-0855-0714'); x.play(false); x.setMode('timelapse'); x.setFrame(0); },
        text: 'WISE 0855−0714 is a brown dwarf: bigger than a planet, too small to shine like a star. It is about as warm as a cool room, roughly 12 °C, which makes it the coldest object of its kind known. It is 7.4 light-years away.\n\nIt gives off almost no visible light. Only infrared telescopes like SPHEREx can see it.'},
      {el: '#stageWrap', side: 'right', title: 'Where it should be',
        text: 'The blue crosshair marks where star catalogues say it should be on this date. In one photo you will probably see nothing there: it is fainter than the noise.'},
      {el: '#stageWrap', side: 'right', title: 'Add the photos together',
        before: async (x) => { x.setMode('stack'); x.setStack('mean'); },
        text: 'Averaging all photos lowers the noise, the same way a long exposure works. Look for a faint smudge at the crosshair.'},
      {el: '#detList', side: 'top', title: 'A hint, not a discovery',
        before: async (x) => { selectDet(x, (d) => !!d.name); },
        text: (S) => { const s = S.data.target_summary; return s ? `Measuring exactly at the crosshair gives a signal ${s.snr_vs_empty_sky} times stronger than the noise. But ${Math.round(s.fraction_random_brighter * 100)}% of random spots in this field are just as bright.\n\nSo the data hints that something is there, but does not prove it. Each new SPHEREx pass adds more photos and makes the answer clearer.` : 'The signal at the crosshair is weak. The data hints that something is there but does not prove it.'; }},
    ],
  },
  {
    id: 'indi', slug: 'epsilon-indi-b', title: 'Two brown dwarfs travelling with a star', length: '1 minute',
    text: 'Epsilon Indi B is a pair of brown dwarfs. Measure how fast they move and compare with the catalogue.',
    steps: [
      {el: '#stageWrap', side: 'right', title: 'A pair too close to separate',
        before: async (x) => { await x.loadStatic('epsilon-indi-b'); x.play(false); x.setMode('timelapse'); x.setFrame(0); },
        text: 'At the crosshair are two brown dwarfs orbiting each other. They are so close that SPHEREx sees them as one dot. They travel through space together with the star Epsilon Indi A.'},
      {el: '#stageWrap', side: 'right', title: 'A very small shift',
        before: async (x) => { x.setMode('swipe'); x.setAB(0, lastIndex(x)); },
        text: 'Here the first and last photo are shown together: A on the left of the divider, B on the right. Drag across the image to move the divider.\n\nThe shift is less than a pixel, too small to see by eye.'},
      {el: '#inspector', side: 'top', title: 'Measured, not seen',
        before: async (x) => { x.setMode('timelapse'); selectDet(x, (d) => d.kind === 'shifted'); },
        text: (S) => { const d = findDet(S, (q) => q.kind === 'shifted'); return d ? `By finding the centre of the dot in every photo to a fraction of a pixel, the program measured ${d.motion_arcsec_per_year}″ a year. The star catalogue gives ${d.catalog_motion_arcsec_per_year}″.\n\nSo the tool can measure motions much smaller than one pixel.` : 'The program measured the motion to a fraction of a pixel.'; }},
    ],
  },
  {
    id: 'controls', title: 'Learn the controls', length: '2 minutes',
    text: 'A quick look at every part of the screen.',
    steps: [
      {el: '#searchForm', side: 'bottom', title: 'Find a place on the sky',
        text: 'Type a name from the list, or a position on the sky as right ascension and declination.'},
      {el: '.left', side: 'right', title: 'Objects', text: 'Prepared objects, ready to open. The first group holds the five targets NASA asked us to test.'},
      {el: '#stageWrap', side: 'right', title: 'The image',
        before: async (x) => { if (!x.state.data) await x.loadStatic('barnards-star'); },
        text: 'One photograph at a time. Drag to move around, scroll to zoom, double-click to fit. Circles mark changes the computer found.'},
      {el: '.modes', side: 'top', title: 'Ways to compare',
        text: 'Time-lapse plays all photos. Blink, side by side, swipe and difference compare two photos. Stack combines them all.'},
      {el: '.player', side: 'top', title: 'Photos in date order',
        text: 'Play, step through, or click any photo in the strip. Space plays and pauses; the arrow keys step.'},
      {el: '.right', side: 'left', title: 'Display', text: 'Change colours and contrast to bring out faint things. None of this changes the measurements.'},
      {el: '#detList', side: 'top', title: 'Changes found', text: 'Everything the computer flagged in this field. Click one to see what was measured.'},
      {el: '.res-col.charts', side: 'top', title: 'Brightness and colour', text: 'How bright the target was in each photo, and its infrared spectrum.'},
      {el: '#guidesBtn', side: 'bottom', title: 'Need help later?',
        text: 'Hover over anything for a short explanation. The guides are always here.'},
    ],
  },
];

function closeModals() { document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden')); }

function buildGuideList() {
  const ul = $('guideList'); ul.innerHTML = '';
  for (const g of GUIDES) {
    const li = document.createElement('li');
    li.innerHTML = `<button type="button"><span class="g-icon" data-slug="${g.slug || ''}"></span>
      <span><span class="g-title">${g.title}</span><span class="g-text">${g.text}</span></span><span class="g-len">${g.length}</span></button>`;
    li.querySelector('button').onclick = () => startTour(g);
    ul.appendChild(li);
  }
  drawGuideIcons();
}

async function drawGuideIcons() {
  for (const span of document.querySelectorAll('.g-icon[data-slug]')) {
    const slug = span.dataset.slug; if (!slug) continue;
    try {
      const d = await (await fetch(`data/targets/${slug}.json`)).json();
      const f = d.frames[0]; const n = d.size;
      const bin = atob(f.image); const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const img = new Float32Array(buf.buffer);
      const vals = Array.from(img).filter(Number.isFinite).sort((a, b) => a - b);
      const lo = vals[Math.floor(vals.length * 0.3)]; const hi = vals[Math.floor(vals.length * 0.995)];
      const cv = document.createElement('canvas'); cv.width = n; cv.height = n;
      const ctx = cv.getContext('2d'); const id = ctx.createImageData(n, n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const v = img[y * n + x]; const o = ((n - 1 - y) * n + x) * 4;
        const t = Number.isFinite(v) ? Math.asinh(10 * Math.min(1, Math.max(0, (v - lo) / (hi - lo)))) / Math.asinh(10) : 0;
        const c = 227 - t * 211; id.data[o] = c; id.data[o + 1] = c + t * 4; id.data[o + 2] = c + t * 6; id.data[o + 3] = 255;
      }
      ctx.putImageData(id, 0, 0);
      const out = document.createElement('canvas'); out.width = 152; out.height = 112;
      const c2 = out.getContext('2d'); c2.imageSmoothingEnabled = false;
      const k = Math.max(152 / n, 112 / n) * 1.15; c2.drawImage(cv, (152 - n * k) / 2, (112 - n * k) / 2, n * k, n * k);
      span.replaceWith(out);
    } catch (_) { span.classList.add('plain'); }
  }
}

function openWelcome() { closeModals(); hideTip(); $('modal-welcome').classList.remove('hidden'); $('modal-welcome').querySelector('.guides button').focus(); }

$('guidesBtn').addEventListener('click', openWelcome);
buildGuideList();

(async () => {
  await api().ready;
  let seen = false;
  try { seen = localStorage.getItem('spx-welcome') === '1'; localStorage.setItem('spx-welcome', '1'); } catch (_) { seen = false; }
  if (!seen && !arrivedWithLink) openWelcome();
})();
})();
