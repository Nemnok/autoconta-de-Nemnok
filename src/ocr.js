/**
 * ocr.js
 *
 * Thin wrapper around Tesseract.js that runs OCR inside a web worker.
 *
 * Languages included: Spanish + English (covers most invoice text).
 * The Tesseract worker is created once and reused for the session to
 * avoid repeatedly downloading the language data.
 */

import { createWorker } from 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.esm.min.js';

let _worker = null;

async function getWorker() {
  if (_worker) return _worker;
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
