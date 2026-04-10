/**
 * ocr.js
 *
 * Thin wrapper around Tesseract.js that runs OCR inside a web worker.
 *
 * Languages included: Spanish + English (covers most invoice text).
 * The Tesseract worker is created once and reused for the session to
 * avoid repeatedly downloading the language data.
 *
 * The Tesseract ESM bundle on jsDelivr uses a default export rather than
 * named exports, so we load it via a dynamic import and extract createWorker
 * from the result.  This also means a CDN failure causes a graceful runtime
 * error instead of crashing module initialisation (and taking the whole UI
 * with it).
 */

let _worker = null;

/** @returns {Promise<Function>} The createWorker function from Tesseract.js */
async function loadCreateWorker() {
  const mod = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.esm.min.js');
  // The ESM bundle exposes a default export object; fall back to named export
  // in case a future version switches to proper named exports.
  const createWorker = mod.default?.createWorker ?? mod.createWorker;
  if (typeof createWorker !== 'function') {
    throw new Error('Tesseract.js ESM bundle did not export createWorker');
  }
  return createWorker;
}

async function getWorker() {
  if (_worker) return _worker;
  const createWorker = await loadCreateWorker();
  _worker = await createWorker(['spa', 'eng'], 1, {
    // Use CDN-hosted language data so no local file serving is required.
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    workerPath:
      'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.0/worker.min.js',
    corePath:
      'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js-core/5.1.0/tesseract-core-simd-lstm.wasm.js',
    logger: () => { /* suppress progress logs in production */ },
  });
  return _worker;
}

/**
 * Perform OCR on a canvas element (e.g. a rendered PDF page) or an
 * HTMLImageElement / Blob / URL string.
 *
 * @param {HTMLCanvasElement|HTMLImageElement|Blob|string} source
 * @returns {Promise<string>} The recognised plain text.
 */
export async function ocrImage(source) {
  const worker = await getWorker();
  const { data } = await worker.recognize(source);
  return data.text;
}

/**
 * Release the shared Tesseract worker.  Call this when the app is being
 * destroyed or when you know no more OCR will be performed.
 *
 * @returns {Promise<void>}
 */
export async function terminateOcrWorker() {
  if (_worker) {
    await _worker.terminate();
    _worker = null;
  }
}
