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
 *
 * ── Auto-rescan feature ──────────────────────────────────────────────────
 * ocrImageWithRetry() repeatedly re-OCRs the source with progressively
 * heavier image preprocessing until the Tesseract mean-text confidence
 * reaches the target threshold (default 90%) or the attempt limit is hit.
 */

import { PREPROCESS_PIPELINES } from './ocrPreprocess.js';

/** Default confidence threshold (0-100).  90 = "good quality" for invoices. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 90;

/** Maximum number of rescan attempts (1 = original only, +N for pipelines). */
export const MAX_RESCAN_ATTEMPTS = 1 + PREPROCESS_PIPELINES.length; // original + each pipeline

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
 * @typedef {Object} OcrResult
 * @property {string} text         Recognised plain text
 * @property {number} confidence   Mean text confidence 0–100
 */

/**
 * Perform OCR on a source, returning both text and confidence.
 *
 * @param {HTMLCanvasElement|HTMLImageElement|Blob|string} source
 * @returns {Promise<OcrResult>}
 */
export async function ocrImageFull(source) {
  const worker = await getWorker();
  const { data } = await worker.recognize(source);
  return {
    text: data.text,
    confidence: data.confidence ?? 0,
  };
}

/**
 * Perform OCR on a canvas element (e.g. a rendered PDF page) or an
 * HTMLImageElement / Blob / URL string.
 *
 * @param {HTMLCanvasElement|HTMLImageElement|Blob|string} source
 * @returns {Promise<string>} The recognised plain text.
 */
export async function ocrImage(source) {
  const result = await ocrImageFull(source);
  return result.text;
}

/**
 * @typedef {Object} OcrRetryResult
 * @property {string}  text            Best recognised text
 * @property {number}  confidence      Best confidence achieved (0-100)
 * @property {number}  attempts        Total number of OCR passes performed
 * @property {string}  pipeline        Name of the pipeline that produced the best result
 * @property {boolean} thresholdMet    Whether confidence ≥ threshold
 */

/**
 * @callback OnRescanProgress
 * @param {{ attempt: number, total: number, confidence: number, pipeline: string }} info
 */

/**
 * Auto-rescan OCR with progressive image preprocessing until the
 * confidence reaches the target threshold or all pipelines are exhausted.
 *
 * When the source is a Blob/File (not a canvas), it is first converted
 * to a canvas so preprocessing pipelines can be applied.
 *
 * @param {HTMLCanvasElement|HTMLImageElement|Blob|string} source
 * @param {Object} [opts]
 * @param {number} [opts.threshold=90]  Target confidence (0-100)
 * @param {OnRescanProgress} [opts.onProgress]  Progress callback per attempt
 * @returns {Promise<OcrRetryResult>}
 */
export async function ocrImageWithRetry(source, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const onProgress = opts.onProgress ?? (() => {});

  // ── Attempt 0: raw source ─────────────────────────────────────────────────
  let best = await ocrImageFull(source);
  let bestPipeline = 'original';
  let attempts = 1;

  onProgress({
    attempt: 1,
    total: MAX_RESCAN_ATTEMPTS,
    confidence: best.confidence,
    pipeline: bestPipeline,
  });

  if (best.confidence >= threshold) {
    return {
      text: best.text,
      confidence: best.confidence,
      attempts,
      pipeline: bestPipeline,
      thresholdMet: true,
    };
  }

  // ── Can we preprocess? Only if source is a canvas ─────────────────────────
  const isCanvas = (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement);
  if (!isCanvas) {
    // For non-canvas sources (Blob, File, Image, string URL) convert to canvas
    // so preprocessing pipelines can work on pixel data.
    const canvas = await sourceToCanvas(source);
    if (canvas) {
      return ocrImageWithRetry(canvas, opts);
    }
    // If we cannot convert, return what we have
    return {
      text: best.text,
      confidence: best.confidence,
      attempts,
      pipeline: bestPipeline,
      thresholdMet: best.confidence >= threshold,
    };
  }

  // ── Progressive rescan with preprocessing ─────────────────────────────────
  for (let i = 0; i < PREPROCESS_PIPELINES.length; i++) {
    const pipeline = PREPROCESS_PIPELINES[i];
    attempts++;

    let processed;
    try {
      processed = pipeline.fn(source);
    } catch {
      // Skip broken pipeline
      continue;
    }

    const result = await ocrImageFull(processed);

    onProgress({
      attempt: attempts,
      total: MAX_RESCAN_ATTEMPTS,
      confidence: result.confidence,
      pipeline: pipeline.name,
    });

    if (result.confidence > best.confidence) {
      best = result;
      bestPipeline = pipeline.name;
    }

    if (best.confidence >= threshold) break;
  }

  return {
    text: best.text,
    confidence: best.confidence,
    attempts,
    pipeline: bestPipeline,
    thresholdMet: best.confidence >= threshold,
  };
}

/**
 * Convert a non-canvas source (Blob, File, Image, URL) to a canvas.
 * Returns null if conversion is not possible.
 *
 * @param {Blob|HTMLImageElement|string} source
 * @returns {Promise<HTMLCanvasElement|null>}
 */
async function sourceToCanvas(source) {
  try {
    let img;

    if (source instanceof Blob) {
      img = new Image();
      const url = URL.createObjectURL(source);
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      URL.revokeObjectURL(url);
    } else if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
      img = source;
      if (!img.complete) {
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });
      }
    } else if (typeof source === 'string') {
      img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = source;
      });
    } else {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return canvas;
  } catch {
    return null;
  }
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
