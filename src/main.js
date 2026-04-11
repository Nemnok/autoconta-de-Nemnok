/**
 * main.js — SPA entry point
 *
 * Orchestrates the full processing pipeline:
 *   file upload → PDF/image text extraction → OCR → invoice parsing → display → CSV export
 *
 * PDF policy: 1 page = 1 invoice row (filename shown as "file.pdf#p1", "#p2", …)
 */

import { extractPdfPages } from './pdfTextExtract.js';
import { ocrImage, ocrImageWithRetry, DEFAULT_CONFIDENCE_THRESHOLD } from './ocr.js';
import { parseInvoice } from './parseInvoiceV2.js';
import { invoicesToCsv, downloadCsv } from './formatCsv.js';

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {{ name: string, nif: string }} */
let settings = loadSettings();

/**
 * @typedef {'pending'|'processing'|'done'|'error'} ProcessingStatus
 *
 * @typedef {Object} InvoiceRow
 * @property {string} id
 * @property {string} filename
 * @property {ProcessingStatus} status
 * @property {string} [error]
 * @property {import('./parseInvoice.js').ParsedInvoice} [parsed]
 * @property {boolean} showRaw
 * @property {number}  [ocrConfidence]   Tesseract mean-text confidence (0-100)
 * @property {number}  [ocrAttempts]     Number of OCR passes performed
 * @property {string}  [ocrPipeline]     Name of the preprocessing pipeline used
 * @property {boolean} [ocrThresholdMet] Whether confidence ≥ threshold
 */

/** @type {InvoiceRow[]} */
const rows = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadSettings() {
  try {
    const raw = localStorage.getItem('autoconta_settings');
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { name: '', nif: '' };
}

function saveSettings(s) {
  localStorage.setItem('autoconta_settings', JSON.stringify(s));
}

function uid() {
  return Math.random().toString(36).slice(2);
}

// ─── DOM refs ────────────────────────────────────────────────────────────────

const fileInput = document.getElementById('file-input');
const dropZone = document.getElementById('drop-zone');
const tableBody = document.getElementById('table-body');
const exportBtn = document.getElementById('export-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsClose = document.getElementById('settings-close');
const settingsSave = document.getElementById('settings-save');
const inputName = document.getElementById('input-name');
const inputNif = document.getElementById('input-nif');

// Pre-fill settings inputs
inputName.value = settings.name;
inputNif.value = settings.nif;

// ─── Settings modal ───────────────────────────────────────────────────────────

settingsBtn.addEventListener('click', () => {
  settingsModal.classList.remove('hidden');
});
settingsClose.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.classList.add('hidden');
});
settingsSave.addEventListener('click', () => {
  settings = { name: inputName.value.trim(), nif: inputNif.value.trim().toUpperCase() };
  saveSettings(settings);
  settingsModal.classList.add('hidden');
  showToast('Configuración guardada');
});

// ─── File upload ──────────────────────────────────────────────────────────────

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files) handleFiles(fileInput.files);
  fileInput.value = '';
});

/**
 * @param {FileList} files
 */
async function handleFiles(files) {
  for (const file of Array.from(files)) {
    if (file.type === 'application/pdf') {
      // Create a placeholder row immediately while we load the PDF
      const placeholderRow = {
        id: uid(),
        filename: file.name,
        status: 'processing',
        showRaw: false,
      };
      rows.push(placeholderRow);
      renderRow(placeholderRow);

      // Process PDF per page asynchronously
      processPdf(file, placeholderRow).catch((err) => {
        placeholderRow.status = 'error';
        placeholderRow.error = err instanceof Error ? err.message : String(err);
        updateRow(placeholderRow);
      });
    } else if (file.type.startsWith('image/')) {
      const row = {
        id: uid(),
        filename: file.name,
        status: 'pending',
        showRaw: false,
      };
      rows.push(row);
      renderRow(row);
      processImage(file, row).catch((err) => {
        row.status = 'error';
        row.error = err instanceof Error ? err.message : String(err);
        updateRow(row);
      });
    } else {
      const row = {
        id: uid(),
        filename: file.name,
        status: 'error',
        error: `Tipo de archivo no soportado: ${file.type}`,
        showRaw: false,
      };
      rows.push(row);
      renderRow(row);
    }
  }
  updateExportButton();
}

// ─── Processing pipeline ──────────────────────────────────────────────────────

/**
 * Process a PDF file: one row per page.
 * The placeholder row becomes the first page's row; additional pages get new rows.
 *
 * @param {File} file
 * @param {InvoiceRow} placeholderRow - pre-existing row to reuse for page 1
 */
async function processPdf(file, placeholderRow) {
  const buffer = await file.arrayBuffer();
  const pages = await extractPdfPages(buffer);

  if (pages.length === 0) {
    placeholderRow.status = 'error';
    placeholderRow.error = 'No se encontraron páginas en el PDF';
    updateRow(placeholderRow);
    return;
  }

  for (let idx = 0; idx < pages.length; idx++) {
    const page = pages[idx];
    const pageLabel = pages.length === 1
      ? file.name
      : `${file.name}#p${page.pageNum}`;

    // Reuse the placeholder row for the first page; create new rows for the rest
    let row;
    if (idx === 0) {
      row = placeholderRow;
      row.filename = pageLabel;
    } else {
      row = { id: uid(), filename: pageLabel, status: 'processing', showRaw: false };
      rows.push(row);
      renderRow(row);
    }

    row.status = 'processing';
    updateRow(row);

    try {
      let rawText;
      if (page.needsOcr && page.canvas) {
        // Auto-rescan OCR until confidence ≥ 90% (or pipelines exhausted)
        const ocrResult = await ocrImageWithRetry(page.canvas, {
          threshold: DEFAULT_CONFIDENCE_THRESHOLD,
          onProgress: (info) => {
            row.ocrAttempts = info.attempt;
            row.ocrConfidence = info.confidence;
            row.ocrPipeline = info.pipeline;
            updateRow(row);
          },
        });
        rawText = ocrResult.text;
        row.ocrConfidence = ocrResult.confidence;
        row.ocrAttempts = ocrResult.attempts;
        row.ocrPipeline = ocrResult.pipeline;
        row.ocrThresholdMet = ocrResult.thresholdMet;
      } else {
        rawText = page.text;
      }

      row.parsed = parseInvoice(rawText, pageLabel, settings);
      row.status = 'done';
    } catch (err) {
      row.status = 'error';
      row.error = err instanceof Error ? err.message : String(err);
    }

    updateRow(row);
    updateExportButton();
  }
}

/**
 * Process a single image file.
 *
 * @param {File} file
 * @param {InvoiceRow} row
 */
async function processImage(file, row) {
  row.status = 'processing';
  updateRow(row);

  // Auto-rescan OCR until confidence ≥ 90% (or pipelines exhausted)
  const ocrResult = await ocrImageWithRetry(file, {
    threshold: DEFAULT_CONFIDENCE_THRESHOLD,
    onProgress: (info) => {
      row.ocrAttempts = info.attempt;
      row.ocrConfidence = info.confidence;
      row.ocrPipeline = info.pipeline;
      updateRow(row);
    },
  });
  row.ocrConfidence = ocrResult.confidence;
  row.ocrAttempts = ocrResult.attempts;
  row.ocrPipeline = ocrResult.pipeline;
  row.ocrThresholdMet = ocrResult.thresholdMet;

  row.parsed = parseInvoice(ocrResult.text, file.name, settings);
  row.status = 'done';
  updateRow(row);
  updateExportButton();
}

// ─── Table rendering ──────────────────────────────────────────────────────────

/**
 * @param {InvoiceRow} row
 */
function renderRow(row) {
  // Remove the empty-state placeholder row on first insert
  const emptyRow = document.getElementById('empty-row');
  if (emptyRow) emptyRow.remove();

  const tr = document.createElement('tr');
  tr.id = `row-${row.id}`;
  tableBody.appendChild(tr);
  updateRow(row);
}

/**
 * @param {InvoiceRow} row
 */
function updateRow(row) {
  const tr = document.getElementById(`row-${row.id}`);
  if (!tr) return;

  const p = row.parsed;

  // ── Status icon with OCR confidence badge ────────────────────────────────
  let statusIcon;
  if (row.status === 'processing') {
    const confLabel = row.ocrConfidence != null
      ? ` OCR ${Math.round(row.ocrConfidence)}% (${row.ocrAttempts ?? 1}/${6})`
      : '';
    statusIcon = `<span class="spinner"></span><span class="ocr-progress">${escapeHtml(confLabel)}</span>`;
  } else if (row.status === 'done') {
    statusIcon = row.parsed?.needsReview ? '⚠️' : '✅';
  } else if (row.status === 'error') {
    statusIcon = '❌';
  } else {
    statusIcon = '⏳';
  }

  // ── OCR quality badge (shown after processing is done) ───────────────────
  let ocrBadge = '';
  if (row.status === 'done' && row.ocrConfidence != null) {
    const pct = Math.round(row.ocrConfidence);
    const cls = pct >= 90 ? 'ocr-good' : pct >= 70 ? 'ocr-fair' : 'ocr-poor';
    const tip = `Confianza OCR: ${pct}% · ${row.ocrAttempts ?? 1} intento(s) · ${row.ocrPipeline ?? 'original'}`;
    ocrBadge = `<span class="ocr-badge ${cls}" title="${escapeHtml(tip)}">${pct}%</span>`;
  }

  const reviewTip = p?.reviewReasons.join('\n') ?? '';

  tr.innerHTML = `
    <td>${escapeHtml(row.filename)}</td>
    <td>${statusIcon} ${ocrBadge}</td>
    <td>${escapeHtml(p?.fecha ?? '')}</td>
    <td><span class="badge badge-${p?.tipo ?? ''}">${escapeHtml(p?.tipo ?? '')}</span></td>
    <td title="${escapeHtml(p?.contraparte ?? '')}">${escapeHtml(truncate(p?.contraparte ?? '', 40))}</td>
    <td>${escapeHtml(p?.total ?? '')}</td>
    <td>${escapeHtml(p?.igicPercent ?? '')}</td>
    <td>${escapeHtml(p?.igicAmount ?? '')}</td>
    <td>${escapeHtml(p?.base ?? '')}</td>
    <td>
      ${p?.needsReview ? `<span class="review-flag" title="${escapeHtml(reviewTip)}">⚠ Revisar</span>` : ''}
      ${row.error ? `<span class="error-msg">${escapeHtml(row.error)}</span>` : ''}
    </td>
    <td>
      ${p ? `<button class="btn-sm" data-id="${row.id}" data-action="toggle-raw">Texto</button>` : ''}
    </td>
  `;

  // Raw text panel (inserted below the row when expanded)
  const existingRaw = document.getElementById(`raw-${row.id}`);
  if (row.showRaw && p) {
    if (!existingRaw) {
      const rawTr = document.createElement('tr');
      rawTr.id = `raw-${row.id}`;
      rawTr.innerHTML = `<td colspan="11" class="raw-text-cell"><pre>${escapeHtml(p.rawText)}</pre></td>`;
      tr.after(rawTr);
    }
  } else {
    existingRaw?.remove();
  }
}

tableBody.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset['action'];
  const id = btn.dataset['id'];
  if (action === 'toggle-raw' && id) {
    const row = rows.find((r) => r.id === id);
    if (row) {
      row.showRaw = !row.showRaw;
      updateRow(row);
    }
  }
});

// ─── Export ───────────────────────────────────────────────────────────────────

exportBtn.addEventListener('click', () => {
  const done = rows.filter((r) => r.status === 'done' && r.parsed).map((r) => r.parsed);
  if (done.length === 0) return;
  const csv = invoicesToCsv(done);
  downloadCsv(csv, 'facturas.csv');
});

function updateExportButton() {
  const hasDone = rows.some((r) => r.status === 'done' && r.parsed);
  exportBtn.disabled = !hasDone;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function truncate(s, max) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * @param {string} message
 */
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-show'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 400);
  }, 2500);
}
