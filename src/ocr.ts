/**
 * ocr.ts
 *
 * Thin wrapper around Tesseract.js that runs OCR inside a web worker.
 *
 * Languages included: Spanish + English (covers most invoice text).
 * The Tesseract worker is created once and reused for the session to
 * avoid repeatedly downloading the language data.
 */

import { createWorker, type Worker } from 'tesseract.js';

let _worker: Worker | null = null;

async function getWorker(): Promise<Worker> {
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
 * @returns The recognised plain text.
 */
export async function ocrImage(
  source: HTMLCanvasElement | HTMLImageElement | Blob | string,
): Promise<string> {
  const worker = await getWorker();
  const { data } = await worker.recognize(source);
  return data.text;
}

/**
 * OCR multiple canvases (one per PDF page) and concatenate the results.
 */
export async function ocrCanvases(canvases: HTMLCanvasElement[]): Promise<string> {
  const parts: string[] = [];
  for (const canvas of canvases) {
    parts.push(await ocrImage(canvas));
  }
  return parts.join('\n');
}

/**
 * Release the shared Tesseract worker.  Call this when the app is being
 * destroyed or when you know no more OCR will be performed.
 */
export async function terminateOcrWorker(): Promise<void> {
  if (_worker) {
    await _worker.terminate();
    _worker = null;
  }
}
