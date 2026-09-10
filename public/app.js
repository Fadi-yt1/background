/**
 * ClearCut front-end.
 *
 * The browser never sees an API key: it posts the image to this site's own
 * /api/remove-background endpoint and gets a transparent PNG back. Everything
 * after that — colours, gradients, custom backdrops, the download — is
 * composited locally on a canvas, so changing a background costs nothing.
 */

(() => {
  'use strict';

  // Overwritten by /api/health at load, since a serverless deployment caps
  // request bodies lower than a self-hosted server does.
  let maxUploadBytes = 12 * 1024 * 1024;
  const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];

  const BACKGROUNDS = [
    { id: 'transparent', label: 'Transparent', type: 'transparent' },
    { id: 'white', label: 'White', type: 'color', value: '#FFFFFF' },
    { id: 'light', label: 'Light grey', type: 'color', value: '#F1F3F8' },
    { id: 'slate', label: 'Slate', type: 'color', value: '#334155' },
    { id: 'black', label: 'Black', type: 'color', value: '#111111' },
    { id: 'indigo', label: 'Indigo', type: 'color', value: '#4F46E5' },
    { id: 'sky', label: 'Sky', type: 'color', value: '#38BDF8' },
    { id: 'mint', label: 'Mint', type: 'color', value: '#34D399' },
    { id: 'sand', label: 'Sand', type: 'color', value: '#E7D8C0' },
    { id: 'rose', label: 'Rose', type: 'color', value: '#FB7185' },
    { id: 'dusk', label: 'Dusk gradient', type: 'gradient', value: ['#6366F1', '#EC4899'] },
    { id: 'ocean', label: 'Ocean gradient', type: 'gradient', value: ['#0EA5E9', '#14B8A6'] },
    { id: 'ember', label: 'Ember gradient', type: 'gradient', value: ['#F97316', '#FACC15'] },
    { id: 'graphite', label: 'Graphite gradient', type: 'gradient', value: ['#1F2937', '#4B5563'] },
    { id: 'blush', label: 'Blush gradient', type: 'gradient', value: ['#FDE68A', '#FCA5A5'] },
  ];

  const el = (id) => document.getElementById(id);

  const dom = {
    viewUpload: el('view-upload'),
    viewProgress: el('view-progress'),
    viewEditor: el('view-editor'),
    dropzone: el('dropzone'),
    fileInput: el('file-input'),
    uploadError: el('upload-error'),
    dropzoneMeta: el('dropzone-meta'),
    progressTitle: el('progress-title'),
    progressBar: el('progress-bar'),
    cancelButton: el('cancel-button'),
    resetButton: el('reset-button'),
    tabResult: el('tab-result'),
    tabCompare: el('tab-compare'),
    stageCanvasWrap: document.querySelector('.stage-canvas-wrap'),
    canvas: el('preview-canvas'),
    compare: el('compare'),
    compareOriginal: el('compare-original'),
    compareResult: el('compare-result'),
    compareCanvas: el('compare-canvas'),
    compareSlider: el('compare-slider'),
    compareHandle: el('compare-handle'),
    swatches: el('swatches'),
    customColor: el('custom-color'),
    customHex: el('custom-hex'),
    bgUploadButton: el('bg-upload-button'),
    bgFileInput: el('bg-file-input'),
    bgClearButton: el('bg-clear-button'),
    downloadButton: el('download-button'),
    downloadNote: el('download-note'),
    toast: el('toast'),
  };

  const state = {
    /** @type {HTMLImageElement|null} the transparent cutout returned by the API */
    cutout: null,
    /** @type {string|null} object URL for the untouched upload */
    originalUrl: null,
    /** @type {string|null} object URL for the cutout PNG */
    cutoutUrl: null,
    /** @type {HTMLImageElement|null} a user-supplied backdrop */
    backdrop: null,
    background: BACKGROUNDS[0],
    filename: 'image',
    request: null,
  };

  /* ---------------------------------------------------------------- views */

  function showView(name) {
    dom.viewUpload.hidden = name !== 'upload';
    dom.viewProgress.hidden = name !== 'progress';
    dom.viewEditor.hidden = name !== 'editor';
  }

  let toastTimer;
  function toast(message, { error = false } = {}) {
    dom.toast.textContent = message;
    dom.toast.classList.toggle('is-error', error);
    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      dom.toast.hidden = true;
    }, 4200);
  }

  function showUploadError(message) {
    dom.uploadError.textContent = message;
    dom.uploadError.hidden = false;
  }

  function clearUploadError() {
    dom.uploadError.hidden = true;
    dom.uploadError.textContent = '';
  }

  /* -------------------------------------------------------------- helpers */

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('That image could not be read.'));
      image.src = src;
    });
  }

  function baseName(filename) {
    return (filename || 'image').replace(/\.[^./\\]+$/, '').slice(0, 60) || 'image';
  }

  function normaliseHex(value) {
    const hex = String(value).trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(hex)) {
      return `#${hex.replace(/./g, (c) => c + c).toUpperCase()}`;
    }
    return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
  }

  function validateFile(file) {
    if (!file) return 'Choose an image to get started.';
    if (!ACCEPTED_TYPES.includes(file.type)) {
      return 'That file type is not supported. Use a PNG, JPEG, WebP, or HEIC image.';
    }
    if (file.size > maxUploadBytes) {
      const limit = Math.round(maxUploadBytes / 1024 / 1024);
      return `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${limit} MB.`;
    }
    return null;
  }

  /* ------------------------------------------------------------ rendering */

  /** Paints the chosen background across the full canvas, beneath the cutout. */
  function paintBackground(ctx, width, height) {
    const { background, backdrop } = state;

    if (background.type === 'transparent') return;

    if (background.type === 'color') {
      ctx.fillStyle = background.value;
      ctx.fillRect(0, 0, width, height);
      return;
    }

    if (background.type === 'gradient') {
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, background.value[0]);
      gradient.addColorStop(1, background.value[1]);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      return;
    }

    if (background.type === 'image' && backdrop) {
      // Cover-fit the backdrop so it fills the frame without distortion.
      const scale = Math.max(width / backdrop.naturalWidth, height / backdrop.naturalHeight);
      const drawWidth = backdrop.naturalWidth * scale;
      const drawHeight = backdrop.naturalHeight * scale;
      ctx.drawImage(backdrop, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    }
  }

  function composite(canvas) {
    if (!state.cutout) return;
    const { naturalWidth: width, naturalHeight: height } = state.cutout;

    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    paintBackground(ctx, width, height);
    ctx.drawImage(state.cutout, 0, 0, width, height);
  }

  function render() {
    if (!state.cutout) return; // Background swatches can be set before any upload.
    composite(dom.canvas);
    if (!dom.compare.hidden) composite(dom.compareCanvas);

    const transparent = state.background.type === 'transparent';
    dom.downloadNote.textContent = transparent
      ? 'Transparent PNG · full resolution'
      : `PNG with background · ${state.cutout.naturalWidth} × ${state.cutout.naturalHeight}`;
  }

  /* -------------------------------------------------------------- upload */

  async function handleFile(file) {
    const error = validateFile(file);
    if (error) {
      showUploadError(error);
      return;
    }

    clearUploadError();
    state.filename = baseName(file.name);
    revokeUrls();
    state.originalUrl = URL.createObjectURL(file);

    showView('progress');
    dom.progressTitle.textContent = 'Uploading your image…';
    dom.progressBar.style.width = '0%';

    try {
      const blob = await uploadForCutout(file);
      state.cutoutUrl = URL.createObjectURL(blob);
      state.cutout = await loadImage(state.cutoutUrl);

      dom.compareOriginal.src = state.originalUrl;
      setCompareMode(false);
      render();
      showView('editor');
      dom.viewEditor.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (failure) {
      if (failure.name === 'AbortError') {
        showView('upload');
        return;
      }
      showView('upload');
      showUploadError(failure.message);
    }
  }

  /**
   * POSTs the file as a raw body and reports real upload progress, which fetch
   * cannot do. The raw form is what the serverless deployment receives too.
   */
  function uploadForCutout(file) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      state.request = request;
      request.open('POST', '/api/remove-background');
      request.responseType = 'blob';
      request.timeout = 90000;
      request.setRequestHeader('Content-Type', file.type);
      request.setRequestHeader('X-File-Name', asciiFilename(file.name));

      request.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable) return;
        // Upload is the first 60% of the bar; the rest covers server-side work.
        const ratio = event.loaded / event.total;
        dom.progressBar.style.width = `${Math.round(ratio * 60)}%`;
        if (ratio >= 1) {
          dom.progressTitle.textContent = 'Removing the background…';
          dom.progressBar.style.width = '78%';
        }
      });

      request.addEventListener('load', async () => {
        state.request = null;
        dom.progressBar.style.width = '100%';

        if (request.status >= 200 && request.status < 300) {
          resolve(request.response);
          return;
        }
        reject(new Error(await readErrorMessage(request)));
      });

      request.addEventListener('error', () => {
        state.request = null;
        reject(new Error('The connection dropped before we could finish. Please try again.'));
      });

      request.addEventListener('timeout', () => {
        state.request = null;
        reject(new Error('That took too long to process. Try a smaller image.'));
      });

      request.addEventListener('abort', () => {
        state.request = null;
        const aborted = new Error('Cancelled.');
        aborted.name = 'AbortError';
        reject(aborted);
      });

      request.send(file);
    });
  }

  /** Header values must be Latin-1, so non-ASCII filenames are transliterated away. */
  function asciiFilename(name) {
    // eslint-disable-next-line no-control-regex
    return String(name || 'upload.png').replace(/[^\u0020-\u007e]/g, '_').slice(0, 100);
  }

  async function readErrorMessage(request) {
    const fallback = `Something went wrong (${request.status}). Please try again.`;
    try {
      const text = await request.response.text();
      return JSON.parse(text).error || fallback;
    } catch {
      return fallback;
    }
  }

  /* ------------------------------------------------------------ swatches */

  function buildSwatches() {
    BACKGROUNDS.forEach((background) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.dataset.id = background.id;
      button.title = background.label;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', background.label);
      button.setAttribute('aria-checked', String(background.id === state.background.id));

      if (background.type === 'transparent') {
        button.classList.add('swatch-transparent');
      } else if (background.type === 'color') {
        button.style.background = background.value;
      } else {
        button.style.background = `linear-gradient(135deg, ${background.value[0]}, ${background.value[1]})`;
      }

      if (background.id === state.background.id) button.classList.add('is-selected');

      button.addEventListener('click', () => selectBackground(background));
      dom.swatches.append(button);
    });
  }

  function selectBackground(background) {
    state.background = background;

    for (const swatch of dom.swatches.children) {
      const selected = swatch.dataset.id === background.id;
      swatch.classList.toggle('is-selected', selected);
      swatch.setAttribute('aria-checked', String(selected));
    }

    if (background.type === 'color') {
      dom.customColor.value = background.value;
      dom.customHex.value = background.value;
    }

    render();
  }

  function applyCustomColor(value) {
    const hex = normaliseHex(value);
    if (!hex) return false;
    dom.customColor.value = hex;
    dom.customHex.value = hex;
    selectBackground({ id: 'custom', label: 'Custom colour', type: 'color', value: hex });
    return true;
  }

  /* ------------------------------------------------------------- compare */

  function setCompareMode(active) {
    dom.compare.hidden = !active;
    dom.stageCanvasWrap.hidden = active;
    dom.tabResult.classList.toggle('is-active', !active);
    dom.tabCompare.classList.toggle('is-active', active);
    dom.tabResult.setAttribute('aria-pressed', String(!active));
    dom.tabCompare.setAttribute('aria-pressed', String(active));

    if (active) {
      composite(dom.compareCanvas);
      updateCompareSplit(Number(dom.compareSlider.value));
    }
  }

  function updateCompareSplit(percent) {
    // Everything to the right of the handle shows the cutout; the left stays original.
    dom.compareResult.style.clipPath = `inset(0 0 0 ${percent}%)`;
    dom.compareHandle.style.left = `${percent}%`;
  }

  /* ------------------------------------------------------------ download */

  function download() {
    if (!state.cutout) return;

    const canvas = document.createElement('canvas');
    composite(canvas);

    canvas.toBlob((blob) => {
      if (!blob) {
        toast('The download could not be prepared. Please try again.', { error: true });
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${state.filename}-clearcut.png`;
      document.body.append(link);
      link.click();
      link.remove();
      // Give the browser a moment to start the download before releasing the URL.
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('Saved to your downloads.');
    }, 'image/png');
  }

  /* --------------------------------------------------------------- reset */

  function revokeUrls() {
    if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
    if (state.cutoutUrl) URL.revokeObjectURL(state.cutoutUrl);
    state.originalUrl = null;
    state.cutoutUrl = null;
  }

  function reset() {
    revokeUrls();
    state.cutout = null;
    state.backdrop = null;
    dom.bgClearButton.hidden = true;
    dom.fileInput.value = '';
    dom.bgFileInput.value = '';
    selectBackground(BACKGROUNDS[0]);
    clearUploadError();
    showView('upload');
    dom.viewUpload.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* -------------------------------------------------------------- wiring */

  function wireDropzone() {
    dom.dropzone.addEventListener('click', () => dom.fileInput.click());

    dom.dropzone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        dom.fileInput.click();
      }
    });

    dom.fileInput.addEventListener('change', () => {
      if (dom.fileInput.files?.[0]) handleFile(dom.fileInput.files[0]);
    });

    ['dragenter', 'dragover'].forEach((type) => {
      dom.dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dom.dropzone.classList.add('is-dragging');
      });
    });

    ['dragleave', 'drop'].forEach((type) => {
      dom.dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dom.dropzone.classList.remove('is-dragging');
      });
    });

    dom.dropzone.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (file) handleFile(file);
    });

    // Dropping anywhere else on the page should not navigate away from the site.
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => event.preventDefault());

    document.addEventListener('paste', (event) => {
      if (dom.viewUpload.hidden) return; // Only paste-to-upload while the dropzone is showing.
      const file = [...(event.clipboardData?.files || [])][0];
      if (file) handleFile(file);
    });
  }

  function wireEditor() {
    dom.cancelButton.addEventListener('click', () => state.request?.abort());
    dom.resetButton.addEventListener('click', reset);

    dom.tabResult.addEventListener('click', () => setCompareMode(false));
    dom.tabCompare.addEventListener('click', () => setCompareMode(true));
    dom.compareSlider.addEventListener('input', (event) => updateCompareSplit(Number(event.target.value)));

    dom.customColor.addEventListener('input', (event) => applyCustomColor(event.target.value));
    dom.customHex.addEventListener('change', (event) => {
      if (!applyCustomColor(event.target.value)) {
        event.target.value = dom.customColor.value;
        toast('That is not a valid hex colour.', { error: true });
      }
    });

    dom.bgUploadButton.addEventListener('click', () => dom.bgFileInput.click());
    dom.bgFileInput.addEventListener('change', async () => {
      const file = dom.bgFileInput.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      try {
        state.backdrop = await loadImage(url);
        dom.bgClearButton.hidden = false;
        selectBackground({ id: 'backdrop', label: 'Custom backdrop', type: 'image' });
      } catch {
        toast('That background image could not be read.', { error: true });
      } finally {
        URL.revokeObjectURL(url);
      }
    });

    dom.bgClearButton.addEventListener('click', () => {
      state.backdrop = null;
      dom.bgFileInput.value = '';
      dom.bgClearButton.hidden = true;
      selectBackground(BACKGROUNDS[0]);
    });

    dom.downloadButton.addEventListener('click', download);
  }

  async function syncLimitsWithServer() {
    try {
      const response = await fetch('/api/health');
      if (!response.ok) return;
      const health = await response.json();
      if (!health.maxUploadBytes) return;
      maxUploadBytes = health.maxUploadBytes;
      const megabytes = Math.round(maxUploadBytes / 1024 / 1024);
      dom.dropzoneMeta.textContent = `PNG, JPEG, WebP or HEIC · up to ${megabytes} MB`;
      if (health.mode === 'sandbox') {
        toast('Sandbox mode: results are watermarked previews.');
      }
    } catch {
      // A failed health check is not worth bothering the visitor about.
    }
  }

  buildSwatches();
  wireDropzone();
  wireEditor();
  syncLimitsWithServer();
})();
