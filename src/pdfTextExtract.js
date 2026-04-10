/**
 * pdfTextExtract.js
 *
 * Extracts text from a PDF file, one result per page.
 *  1. Try to read embedded text via PDF.js (works for digital/born-digital PDFs).
 *  2. If the embedded text on a page is too sparse (< MIN_CHARS_PER_PAGE),
 *     render that page to a canvas so the OCR layer can process it.
 *
 * Policy: 1 PDF page = 1 invoice row.
 * Each call to extractPdfPages returns an array with one entry per page.
 *
 * PDF.js is vendored inside the repository under vendor/pdfjs/ so the app
 * works on GitHub Pages with zero external CDN dependencies.
 */

import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';

// Configure the PDF.js worker using the vendored local copy.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

/** Minimum characters per page to consider embedded text "good". */
const MIN_CHARS_PER_PAGE = 50;

/**
 * @typedef {Object} PdfPageResult
 * @property {number} pageNum - 1-based page number
 * @property {string} text - Embedded text (empty string if needs OCR)
 * @property {HTMLCanvasElement|null} canvas - Rendered canvas when OCR is needed
 * @property {boolean} needsOcr - true when OCR is needed for this page
 */

/**
 * Extract text from each page of a PDF.
 * Returns one PdfPageResult per page.
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<PdfPageResult[]>}
 */
export async function extractPdfPages(buffer) {
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const pageCount = pdf.numPages;
  const results = [];
  const scale = 2; // higher resolution → better OCR accuracy

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);

    // ── Try embedded text first ──────────────────────────────────────────────
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');

    const charCount = pageText.replace(/\s/g, '').length;

    if (charCount >= MIN_CHARS_PER_PAGE) {
      results.push({ pageNum: i, text: pageText, canvas: null, needsOcr: false });
      continue;
    }

    // ── Render to canvas for OCR ─────────────────────────────────────────────
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      await page.render({ canvasContext: ctx, viewport }).promise;
    }
    results.push({ pageNum: i, text: '', canvas, needsOcr: true });
  }

  return results;
}
