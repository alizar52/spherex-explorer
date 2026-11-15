(() => {
  const form = document.getElementById('fitsUpload');
  const input = document.getElementById('fitsFile');
  const status = document.getElementById('fitsStatus');
  const button = form.querySelector('button');
  const api = (window.SPX_CONFIG?.apiBase || '').trim().replace(/\/$/, '');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = input.files[0];
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
    } catch {
      status.textContent = 'Could not reach the classifier. Try again shortly.';
    } finally {
      clearTimeout(timeout);
      button.disabled = input.disabled = false;
    }
  });
})();
