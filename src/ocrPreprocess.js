/**
 * ocrPreprocess.js — Client-side image preprocessing for OCR quality improvement.
 *
 * All operations run on an OffscreenCanvas / regular Canvas — zero external
 * dependencies.  Each function takes a canvas and returns a new canvas with
 * the transformation applied.
 *
 * Used by ocrImageWithRetry() to progressively improve OCR confidence.
 */

/**
 * Create a canvas copy (so we never mutate the original).
 * @param {HTMLCanvasElement} src
 * @returns {HTMLCanvasElement}
 */
function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  return c;
}

/**
 * Get ImageData from a canvas.
 * @param {HTMLCanvasElement} canvas
 * @returns {{ ctx: CanvasRenderingContext2D, imageData: ImageData }}
 */
function getPixels(canvas) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { ctx, imageData };
}

/**
 * Convert to greyscale.
 * @param {HTMLCanvasElement} src
 * @returns {HTMLCanvasElement}
 */
export function greyscale(src) {
  const out = cloneCanvas(src);
  const { ctx, imageData } = getPixels(out);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const grey = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = grey;
  }
  ctx.putImageData(imageData, 0, 0);
  return out;
}

/**
 * Increase contrast.  factor > 1 boosts contrast, < 1 reduces it.
 * @param {HTMLCanvasElement} src
 * @param {number} factor  e.g. 1.5
 * @returns {HTMLCanvasElement}
 */
export function contrast(src, factor = 1.5) {
  const out = cloneCanvas(src);
  const { ctx, imageData } = getPixels(out);
  const d = imageData.data;
  const intercept = 128 * (1 - factor);
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = Math.max(0, Math.min(255, factor * d[i]     + intercept));
    d[i + 1] = Math.max(0, Math.min(255, factor * d[i + 1] + intercept));
    d[i + 2] = Math.max(0, Math.min(255, factor * d[i + 2] + intercept));
  }
  ctx.putImageData(imageData, 0, 0);
  return out;
}

/**
 * Otsu-style adaptive binarisation (black & white threshold).
 * @param {HTMLCanvasElement} src
 * @returns {HTMLCanvasElement}
 */
export function binarize(src) {
  const grey = greyscale(src);
  const { ctx, imageData } = getPixels(grey);
  const d = imageData.data;

  // Compute Otsu threshold
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) histogram[d[i]]++;
  const total = d.length / 4;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let sumB = 0, wB = 0, wF, max = 0, threshold = 128;
  for (let i = 0; i < 256; i++) {
    wB += histogram[i];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;
    sumB += i * histogram[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) { max = between; threshold = i; }
  }

  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] >= threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imageData, 0, 0);
  return grey;
}

/**
 * Apply an unsharp-mask sharpen.
 * Uses a simple 3×3 kernel convolution.
 * @param {HTMLCanvasElement} src
 * @param {number} amount   Strength 0..2 (default 1)
 * @returns {HTMLCanvasElement}
 */
export function sharpen(src, amount = 1) {
  const out = cloneCanvas(src);
  const { ctx, imageData: srcData } = getPixels(cloneCanvas(src));
  const { imageData: dstData } = getPixels(out);
  const s = srcData.data;
  const dd = dstData.data;
  const w = src.width;
  const h = src.height;
  // sharpen kernel: centre = 1+4a, edges = -a
  const a = amount;
  const kernel = [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            v += s[((y + ky) * w + (x + kx)) * 4 + c] * kernel[(ky + 1) * 3 + (kx + 1)];
          }
        }
        dd[(y * w + x) * 4 + c] = Math.max(0, Math.min(255, v));
      }
    }
  }
  const outCtx = out.getContext('2d');
  outCtx.putImageData(dstData, 0, 0);
  return out;
}

/**
 * Scale the canvas up by the given factor (e.g. 1.5× → 50% bigger).
 * Larger images generally give better OCR results.
 * @param {HTMLCanvasElement} src
 * @param {number} factor
 * @returns {HTMLCanvasElement}
 */
export function scaleUp(src, factor = 1.5) {
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * factor);
  c.height = Math.round(src.height * factor);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/**
 * Pre-defined preprocessing pipelines, ordered from lightest to heaviest.
 * Each is a function that takes a canvas and returns a preprocessed canvas.
 *
 * The OCR retry loop applies these one at a time until confidence ≥ threshold.
 * @type {Array<{ name: string, fn: (c: HTMLCanvasElement) => HTMLCanvasElement }>}
 */
export const PREPROCESS_PIPELINES = [
  {
    name: 'greyscale + contrast',
    fn: (c) => contrast(greyscale(c), 1.4),
  },
  {
    name: 'greyscale + high contrast + sharpen',
    fn: (c) => sharpen(contrast(greyscale(c), 1.8), 0.8),
  },
  {
    name: 'binarize (Otsu)',
    fn: (c) => binarize(c),
  },
  {
    name: 'scale 1.5× + binarize',
    fn: (c) => binarize(scaleUp(c, 1.5)),
  },
  {
    name: 'scale 2× + sharpen + binarize',
    fn: (c) => binarize(sharpen(scaleUp(c, 2), 1)),
  },
];
