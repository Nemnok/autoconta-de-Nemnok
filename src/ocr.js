/**
 * ocr.js
 *
 * Thin wrapper around Tesseract.js that runs OCR inside a web worker.
 *
 * Languages included: Spanish + English (covers most invoice text).
 * The Tesseract worker is created once and reused for the session to
 * avoid repeatedly downloading the language data.
 *
 * All Tesseract assets (ESM bundle, worker, core WASM, language data) are
 * vendored inside the repository under vendor/ so the app works on GitHub
 * Pages with zero external CDN dependencies.
 */

let _worker = null;

/** @returns {Promise<Function>} The createWorker function from Tesseract.js */
async function loadCreateWorker() {
  const mod = await import(new URL('../vendor/tesseract/tesseract.esm.min.js', import.meta.url).href);
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
  const base = new URL('../vendor/tesseract/', import.meta.url).href;
  const tessdata = new URL('../vendor/tessdata/', import.meta.url).href;
  _worker = await createWorker(['spa', 'eng'], 1, {
    langPath: tessdata,
    workerPath: new URL('worker.min.js', base).href,
    corePath: new URL('tesseract-core-simd-lstm.wasm.js', base).href,
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
