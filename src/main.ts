/**
 * main.ts — SPA entry point
 *
 * Orchestrates the full processing pipeline:
 *   file upload → PDF/image text extraction → OCR → invoice parsing → display → CSV export
 */

import { extractPdfText } from './pdfTextExtract.js';
import { ocrImage, ocrCanvases } from './ocr.js';
import { parseInvoice } from './parseInvoice.js';
import { invoicesToCsv, downloadCsv } from './formatCsv.js';
import type { CompanySettings, InvoiceRow, ParsedInvoice } from './types.js';
import './styles.css';

// ─── State ────────────────────────────────────────────────────────────────────

let settings: CompanySettings = loadSettings();
const rows: InvoiceRow[] = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadSettings(): CompanySettings {
  try {
    const raw = localStorage.getItem('autoconta_settings');
    if (raw) return JSON.parse(raw) as CompanySettings;
  } catch { /* ignore */ }
  return { name: '', nif: '' };
}

function saveSettings(s: CompanySettings): void {
  localStorage.setItem('autoconta_settings', JSON.stringify(s));
}

function uid(): string {
  return Math.random().toString(36).slice(2);
}

// ─── DOM refs ────────────────────────────────────────────────────────────────

const fileInput = document.getElementById('file-input') as HTMLInputElement;
const dropZone = document.getElementById('drop-zone') as HTMLDivElement;
const tableBody = document.getElementById('table-body') as HTMLTableSectionElement;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
const settingsModal = document.getElementById('settings-modal') as HTMLDivElement;
const settingsClose = document.getElementById('settings-close') as HTMLButtonElement;
const settingsSave = document.getElementById('settings-save') as HTMLButtonElement;
const inputName = document.getElementById('input-name') as HTMLInputElement;
const inputNif = document.getElementById('input-nif') as HTMLInputElement;

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

async function handleFiles(files: FileList): Promise<void> {
  for (const file of Array.from(files)) {
    const row: InvoiceRow = {
      id: uid(),
      filename: file.name,
      status: 'pending',
      showRaw: false,
    };
    rows.push(row);
    renderRow(row);
    // Start async processing (don't await here to allow UI updates)
    processFile(file, row).catch((err: unknown) => {
      row.status = 'error';
      row.error = err instanceof Error ? err.message : String(err);
      updateRow(row);
    });
  }
  updateExportButton();
}

// ─── Processing pipeline ──────────────────────────────────────────────────────

async function processFile(file: File, row: InvoiceRow): Promise<void> {
  row.status = 'processing';
  updateRow(row);

  let rawText = '';

  if (file.type === 'application/pdf') {
    const buffer = await file.arrayBuffer();
    const result = await extractPdfText(buffer);
    if (result.needsOcr) {
      rawText = await ocrCanvases(result.canvases);
    } else {
      rawText = result.text;
    }
  } else if (file.type.startsWith('image/')) {
    rawText = await ocrImage(file);
  } else {
    throw new Error(`Tipo de archivo no soportado: ${file.type}`);
  }

  const parsed: ParsedInvoice = parseInvoice(rawText, file.name, settings);
  row.parsed = parsed;
  row.status = 'done';
  updateRow(row);
  updateExportButton();
}

// ─── Table rendering ──────────────────────────────────────────────────────────

function renderRow(row: InvoiceRow): void {
  const tr = document.createElement('tr');
  tr.id = `row-${row.id}`;
  tableBody.appendChild(tr);
  updateRow(row);
}

function updateRow(row: InvoiceRow): void {
  const tr = document.getElementById(`row-${row.id}`);
  if (!tr) return;

  const p = row.parsed;
  const statusIcon = {
    pending: '⏳',
    processing: '<span class="spinner"></span>',
    done: row.parsed?.needsReview ? '⚠️' : '✅',
    error: '❌',
  }[row.status];

  const reviewTip = p?.reviewReasons.join('\n') ?? '';

  tr.innerHTML = `
    <td>${escapeHtml(row.filename)}</td>
    <td>${statusIcon}</td>
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
  const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
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
  const done = rows.filter((r) => r.status === 'done' && r.parsed).map((r) => r.parsed!);
  if (done.length === 0) return;
  const csv = invoicesToCsv(done);
  downloadCsv(csv, 'facturas.csv');
});

function updateExportButton(): void {
  const hasDone = rows.some((r) => r.status === 'done' && r.parsed);
  exportBtn.disabled = !hasDone;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function showToast(message: string): void {
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
