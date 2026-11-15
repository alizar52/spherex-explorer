(() => {
  const form = document.getElementById('fitsUpload');
  const input = document.getElementById('fitsFile');
  const status = document.getElementById('fitsStatus');
  const button = form.querySelector('button');
  const preview = document.getElementById('fitsPreview');
  const canvas = document.getElementById('fitsCanvas');
  const caption = document.getElementById('fitsCaption');
  const enlarge = document.getElementById('fitsEnlarge');
  const api = (window.SPX_CONFIG?.apiBase || '').trim().replace(/\/$/, '');

  input.addEventListener('change', () => {
    preview.hidden = true;
    status.textContent = '';
  });
  enlarge.addEventListener('click', async () => {
    if (canvas.requestFullscreen) {
      try { await canvas.requestFullscreen(); } catch { /* Keep the inline preview. */ }
    }
  });

  function showPreview(image, filename) {
    if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)
        || image.width < 1 || image.height < 1 || image.width > 84 || image.height > 84
        || image.pixels?.length !== image.width * image.height) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    const frame = context.createImageData(image.width, image.height);
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        // FITS row zero is shown at the bottom, as in astronomical image viewers.
        const value = image.pixels[y * image.width + x];
        const index = ((image.height - 1 - y) * image.width + x) * 4;
        frame.data.set([value, value, value, 255], index);
      }
    }
    context.putImageData(frame, 0, 0);
    canvas.setAttribute('aria-label', `Uploaded FITS image: ${filename}`);
    caption.textContent = `${filename} · ${image.width} × ${image.height} pixels`;
    enlarge.hidden = !canvas.requestFullscreen;
    preview.hidden = false;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = input.files[0];
    preview.hidden = true;
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) {
      status.textContent = 'Choose a FITS file of 16 MiB or smaller.';
      return;
    }

    button.disabled = input.disabled = true;
    status.textContent = 'Classifying… The first request may take a minute while the server starts.';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch(`${api}/api/classify`, {
        method: 'POST',
        headers: {'Content-Type': 'application/octet-stream'},
        body: file,
        signal: controller.signal,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.scores) {
        status.textContent = result?.detail || 'The classifier is unavailable. Try again shortly.';
        return;
      }
      const scores = Object.entries(result.scores)
        .map(([category, score]) => `${category} ${Math.round(score * 100)}%`).join(' · ');
      status.textContent = `Prediction: ${result.category}. Model scores: ${scores}`;
      showPreview(result.preview, file.name);
    } catch {
      status.textContent = 'Could not reach the classifier. Try again shortly.';
    } finally {
      clearTimeout(timeout);
      button.disabled = input.disabled = false;
    }
  });
})();
