/**
 * pdfTextExtract.ts
 *
 * Extracts text from a PDF file.
 *  1. Try to read embedded text via PDF.js (works for digital/born-digital PDFs).
 *  2. If the embedded text is too sparse (< MIN_CHARS_PER_PAGE chars/page on average),
 *     render each page to a canvas and return the canvas elements so the OCR layer
 *     can process them with Tesseract.
 */

import * as pdfjs from 'pdfjs-dist';

// Configure the PDF.js worker.  Using a CDN copy avoids Vite worker bundling
// issues while keeping the main bundle small.
pdfjs.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

/** Minimum average characters per page to consider embedded text "good". */
const MIN_CHARS_PER_PAGE = 50;

export interface PdfExtractResult {
  /** Embedded text (may be empty if the PDF is scanned). */
  text: string;
  /**
   * Canvas elements (one per page) when embedded text is insufficient.
   * The caller should OCR these canvases as images.
   */
  canvases: HTMLCanvasElement[];
  /** True when canvases were produced and OCR is required. */
  needsOcr: boolean;
}

/**
 * Extract text from an ArrayBuffer that represents a PDF file.
 */
export async function extractPdfText(buffer: ArrayBuffer): Promise<PdfExtractResult> {
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const pageCount = pdf.numPages;

  // ── Step 1: try embedded text ───────────────────────────────────────────
  let fullText = '';
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    fullText += pageText + '\n';
  }

  const avgCharsPerPage = fullText.replace(/\s/g, '').length / pageCount;
  if (avgCharsPerPage >= MIN_CHARS_PER_PAGE) {
    return { text: fullText, canvases: [], needsOcr: false };
  }

  // ── Step 2: render to canvas for OCR ────────────────────────────────────
  const canvases: HTMLCanvasElement[] = [];
  const scale = 2; // higher resolution → better OCR accuracy

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    await page.render({ canvasContext: ctx, viewport }).promise;
    canvases.push(canvas);
  }

  return { text: '', canvases, needsOcr: true };
}
