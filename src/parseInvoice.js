/**
 * parseInvoice.js
 *
 * All regex / heuristic logic for extracting structured invoice fields
 * from raw OCR or embedded-PDF text.
 *
 * Business rules implemented here:
 *  - Date extraction (multiple formats) → latest date → DD/MM/YYYY output
 *  - NIF/CIF/NIE detection
 *  - Invoice type: Compra / Venta / Otro
 *    - "CompraVenta" or "contrato" → Otro + contract flag
 *  - Contraparte (counterparty name + NIF) with currency markers
 *  - TOTAL extraction (European-formatted number)
 *  - IGIC % / amount / base (possibly multiple tranches → pipe-separated)
 */

// ─── Spanish month names ──────────────────────────────────────────────────────

const MONTH_MAP = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  // common abbreviations
  ene: 1, feb: 2, mar: 3, abr: 4, jun: 6,
  jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12,
};

// ─── Date parsing ─────────────────────────────────────────────────────────────

/**
 * Extract all recognisable dates from text.
 * Accepts:
 *   DD/MM/YYYY  DD-MM-YYYY  DD.MM.YYYY
 *   YYYY/MM/DD  YYYY-MM-DD
 *   DD de MONTH de YYYY  (Spanish long form)
 *   DD MONTH YYYY
 *
 * @param {string} text
 * @returns {Date[]}
 */
export function extractDates(text) {
  const dates = [];

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const reNumeric = /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})\b/g;
  let m;
  while ((m = reNumeric.exec(text)) !== null) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (isValidDate(y, mo, d)) dates.push(new Date(y, mo - 1, d));
  }

  // YYYY-MM-DD or YYYY/MM/DD
  const reIso = /\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/g;
  while ((m = reIso.exec(text)) !== null) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (isValidDate(y, mo, d)) dates.push(new Date(y, mo - 1, d));
  }

  // DD de MONTH de YYYY  (Spanish full)
  const reSpLong = /\b(\d{1,2})\s+de\s+([\wé]+)\s+de\s+(\d{4})\b/gi;
  while ((m = reSpLong.exec(text)) !== null) {
    const d = Number(m[1]);
    const mo = MONTH_MAP[m[2].toLowerCase()];
    const y = Number(m[3]);
    if (mo && isValidDate(y, mo, d)) dates.push(new Date(y, mo - 1, d));
  }

  // DD MONTH YYYY  (no "de")
  const reSpShort = /\b(\d{1,2})\s+([\wé]+)\s+(\d{4})\b/gi;
  while ((m = reSpShort.exec(text)) !== null) {
    const mo = MONTH_MAP[m[2].toLowerCase()];
    if (!mo) continue;
    const d = Number(m[1]);
    const y = Number(m[3]);
    if (isValidDate(y, mo, d)) dates.push(new Date(y, mo - 1, d));
  }

  return dates;
}

/**
 * @param {number} y
 * @param {number} mo
 * @param {number} d
 * @returns {boolean}
 */
function isValidDate(y, mo, d) {
  if (y < 1990 || y > 2100) return false;
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  // Basic per-month check
  const daysInMonth = new Date(y, mo, 0).getDate();
  return d <= daysInMonth;
}

/**
 * Choose the latest date from an array.
 * Returns null when the array is empty.
 *
 * @param {Date[]} dates
 * @returns {Date|null}
 */
export function chooseBestDate(dates) {
  if (dates.length === 0) return null;
  return dates.reduce((best, d) => (d > best ? d : best), dates[0]);
}

/**
 * Format a Date as DD/MM/YYYY (European convention).
 *
 * @param {Date} d
 * @returns {string}
 */
export function formatDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

// ─── Number formatting ────────────────────────────────────────────────────────

/**
 * Parse a number string that may use either European (1.234,56) or
 * Anglo-Saxon (1,234.56) formatting.
 * Returns a plain JS number, or NaN on failure.
 *
 * @param {string} raw
 * @returns {number}
 */
export function parseEuropeanNumber(raw) {
  const cleaned = raw.trim().replace(/\s/g, '');
  // Detect European: has comma as decimal separator
  if (/^\d{1,3}(\.\d{3})*(,\d+)?$/.test(cleaned)) {
    // European style
    return parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
  }
  // Anglo style or plain
  return parseFloat(cleaned.replace(/,/g, ''));
}

/**
 * Format a number as European string (comma decimal, dot thousands).
 * Returns the original raw string if parsing fails, to avoid data loss.
 *
 * @param {string} raw
 * @returns {string}
 */
export function toEuropeanString(raw) {
  const n = parseEuropeanNumber(raw);
  if (isNaN(n)) return raw;
  const fixed = n.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const intFormatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intFormatted},${decPart}`;
}

// ─── NIF / CIF / NIE extraction ───────────────────────────────────────────────

/** Regex for Spanish tax identifiers (NIF, CIF, NIE). */
const NIF_RE = /\b([A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b/g;

/**
 * @typedef {Object} NifMatch
 * @property {string} nif
 * @property {string} prefix - Characters immediately before the NIF in the source text
 * @property {string} suffix - Characters immediately after the NIF in the source text
 */

/**
 * @param {string} text
 * @returns {NifMatch[]}
 */
export function extractNifs(text) {
  const results = [];
  const re = new RegExp(NIF_RE.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - 120);
    const end = Math.min(text.length, m.index + m[0].length + 120);
    results.push({
      nif: m[0],
      prefix: text.slice(start, m.index),
      suffix: text.slice(m.index + m[0].length, end),
    });
  }
  return results;
}

/**
 * Try to extract a company/person name near a NIF.
 * Looks at the text immediately before the NIF for a capitalised name.
 *
 * @param {string} context
 * @returns {string}
 */
export function extractNameNearNif(context) {
  // Try lines that contain "RAZÓN SOCIAL", "NOMBRE", "DENOMINACIÓN"
  const labelled =
    /(?:RAZ[ÓO]N\s+SOCIAL|NOMBRE|DENOMINACI[ÓO]N|EMISOR|PROVEEDOR|CLIENTE|DESTINATARIO)\s*:?\s*([^\n\r;]{3,60})/i;
  const lm = labelled.exec(context);
  if (lm) return lm[1].trim();

  // Fall back: last line with ≥2 capitalised words before the NIF
  const lines = context.split(/\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (/([A-ZÁÉÍÓÚÑÜ][A-Za-záéíóúñü]+\s+){1,5}[A-ZÁÉÍÓÚÑÜ]/.test(line) && line.length < 80) {
      return line;
    }
  }
  return '';
}

// ─── IGIC extraction ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} IgicEntry
 * @property {string} percent
 * @property {string} amount
 * @property {string} base
 */

/**
 * Extract IGIC tranches from text.
 *
 * @param {string} text
 * @returns {IgicEntry[]}
 */
export function extractIgic(text) {
  const entries = [];

  // Pattern A: "IGIC" followed (optionally) by percent, then an amount
  const reA = /IGIC\s*\(?(\d{1,2}(?:[.,]\d+)?)\s*%\)?\s*:?\s*([\d.,]+)/gi;
  let m;
  while ((m = reA.exec(text)) !== null) {
    const pct = m[1].replace(',', '.');
    const amt = toEuropeanString(m[2]);
    const base = findBaseForPercent(text, pct);
    entries.push({ percent: pct, amount: amt, base });
  }

  // Pattern B: percent first, then "IGIC" or "de IGIC"
  const reB = /(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:de\s+)?IGIC\s*:?\s*([\d.,]+)/gi;
  while ((m = reB.exec(text)) !== null) {
    const pct = m[1].replace(',', '.');
    if (entries.some((e) => e.percent === pct)) continue;
    const amt = toEuropeanString(m[2]);
    const base = findBaseForPercent(text, pct);
    entries.push({ percent: pct, amount: amt, base });
  }

  // Pattern C: "IGIC" alone + nearby number (no explicit percent)
  if (entries.length === 0) {
    const reC = /IGIC\s*:?\s*([\d.,]+)/gi;
    while ((m = reC.exec(text)) !== null) {
      const amt = toEuropeanString(m[1]);
      entries.push({ percent: '', amount: amt, base: '' });
    }
  }

  return entries;
}

/**
 * @param {string} text
 * @param {string} _pct
 * @returns {string}
 */
function findBaseForPercent(text, _pct) {
  const reBase = /BASE\s+(?:IMPONIBLE)?\s*:?\s*([\d.,]+)/gi;
  const bases = [];
  let m;
  while ((m = reBase.exec(text)) !== null) {
    bases.push(toEuropeanString(m[1]));
  }
  if (bases.length === 1) return bases[0];
  return '';
}

/**
 * Extract all distinct base amounts from text.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractBases(text) {
  const re = /BASE\s+(?:IMPONIBLE)?\s*:?\s*([\d.,]+)/gi;
  const results = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    results.push(toEuropeanString(m[1]));
  }
  return [...new Set(results)];
}

// ─── Total extraction ─────────────────────────────────────────────────────────

/**
 * Extract the invoice total amount.
 *
 * @param {string} text
 * @returns {string}
 */
export function extractTotal(text) {
  const patterns = [
    /TOTAL\s+(?:A\s+PAGAR|FACTURA|IMPORTE)\s*:?\s*([\d.,]+)/gi,
    /IMPORTE\s+TOTAL\s*:?\s*([\d.,]+)/gi,
    /TOTAL\s*:?\s*([\d.,]+)/gi,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return toEuropeanString(m[1]);
  }
  return '';
}

// ─── Currency detection ───────────────────────────────────────────────────────

/**
 * @param {string} text
 * @returns {'' | '[MONEDA: USD]' | '[MONEDA: NON-EUR]'}
 */
export function detectCurrencyMarker(text) {
  if (/\bUSD\b|\$\s*[\d.,]/.test(text)) return '[MONEDA: USD]';
  if (/\bGBP\b|£\s*[\d.,]|\bCHF\b|\bJPY\b|\bCAD\b|\bAUD\b/.test(text))
    return '[MONEDA: NON-EUR]';
  return '';
}

// ─── Invoice type classification ──────────────────────────────────────────────

const CONTRACT_KEYWORDS = /\b(compraventa|contrato)\b/i;

/**
 * @typedef {'Compra'|'Venta'|'Otro'} InvoiceType
 */

/**
 * @typedef {Object} CompanySettings
 * @property {string} name
 * @property {string} nif
 */

/**
 * Determine whether the invoice is a Compra, Venta, or Otro.
 *
 * @param {string} text
 * @param {CompanySettings} settings
 * @returns {{ tipo: InvoiceType, isContract: boolean }}
 */
export function classifyInvoice(text, settings) {
  if (CONTRACT_KEYWORDS.test(text)) {
    return { tipo: 'Otro', isContract: true };
  }

  const upper = text.toUpperCase();
  const companyNif = settings.nif.toUpperCase().trim();
  const companyName = settings.name.toUpperCase().trim();

  const hasCompanyId = (ctx) => {
    if (companyNif && ctx.includes(companyNif)) return true;
    if (companyName && ctx.includes(companyName)) return true;
    return false;
  };

  const issuerSection = extractSection(upper, [
    'EMISOR', 'VENDEDOR', 'PROVEEDOR', 'EXPEDIDA POR', 'FACTURADO POR',
  ]);
  if (issuerSection && hasCompanyId(issuerSection)) {
    return { tipo: 'Venta', isContract: false };
  }

  const recipientSection = extractSection(upper, [
    'CLIENTE', 'DESTINATARIO', 'COMPRADOR', 'RECEPTOR', 'FACTURADO A',
  ]);
  if (recipientSection && hasCompanyId(recipientSection)) {
    return { tipo: 'Compra', isContract: false };
  }

  if (companyNif && upper.includes(companyNif)) {
    const pos = upper.indexOf(companyNif);
    if (pos < upper.length / 2) return { tipo: 'Venta', isContract: false };
    return { tipo: 'Compra', isContract: false };
  }

  return { tipo: 'Otro', isContract: false };
}

/** All recognised section-label keywords. */
const ALL_SECTION_LABELS = [
  'EMISOR', 'VENDEDOR', 'PROVEEDOR', 'EXPEDIDA POR', 'FACTURADO POR',
  'CLIENTE', 'DESTINATARIO', 'COMPRADOR', 'RECEPTOR', 'FACTURADO A',
];

/**
 * @param {string} text
 * @param {string[]} labels
 * @returns {string}
 */
function extractSection(text, labels) {
  for (const label of labels) {
    const idx = text.indexOf(label);
    if (idx === -1) continue;
    const afterLabel = text.slice(idx + label.length);
    let end = Math.min(afterLabel.length, 300);
    for (const other of ALL_SECTION_LABELS) {
      if (labels.includes(other)) continue;
      const otherIdx = afterLabel.indexOf(other);
      if (otherIdx !== -1 && otherIdx < end) end = otherIdx;
    }
    return afterLabel.slice(0, end);
  }
  return '';
}

// ─── Contraparte extraction ───────────────────────────────────────────────────

/**
 * @typedef {Object} ContraparteInfo
 * @property {string} name
 * @property {string} nif
 * @property {boolean} needsReview
 */

/**
 * Extract the counterparty (the other party – not the company).
 *
 * @param {string} text
 * @param {CompanySettings} settings
 * @param {InvoiceType} tipo
 * @returns {ContraparteInfo}
 */
export function extractContraparte(text, settings, tipo) {
  const nifs = extractNifs(text);
  const companyNifUpper = settings.nif.toUpperCase().trim();

  const otherNifs = nifs.filter((n) => n.nif.toUpperCase() !== companyNifUpper);

  if (otherNifs.length === 0) {
    return { name: '', nif: '', needsReview: true };
  }

  let chosen;
  if (tipo === 'Venta') {
    const recipientSection = extractSection(text.toUpperCase(), [
      'CLIENTE', 'DESTINATARIO', 'COMPRADOR', 'RECEPTOR',
    ]);
    const inRecipient = otherNifs.filter((n) =>
      recipientSection.includes(n.nif.toUpperCase()),
    );
    chosen = inRecipient[0] ?? otherNifs[0];
  } else if (tipo === 'Compra') {
    const issuerSection = extractSection(text.toUpperCase(), [
      'EMISOR', 'VENDEDOR', 'PROVEEDOR',
    ]);
    const inIssuer = otherNifs.filter((n) =>
      issuerSection.includes(n.nif.toUpperCase()),
    );
    chosen = inIssuer[0] ?? otherNifs[0];
  } else {
    chosen = otherNifs[0];
  }

  const name = extractNameNearNif(chosen.prefix + ' ' + chosen.suffix);
  return {
    name,
    nif: chosen.nif,
    needsReview: !name,
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} ParsedInvoice
 * @property {string} filename
 * @property {string} fecha
 * @property {InvoiceType} tipo
 * @property {string} contraparte
 * @property {string} total
 * @property {string} igicPercent
 * @property {string} igicAmount
 * @property {string} base
 * @property {string} rawText
 * @property {boolean} needsReview
 * @property {string[]} reviewReasons
 * @property {boolean} isContract
 */

/**
 * Parse a raw text string (from PDF extraction or OCR) into a structured
 * ParsedInvoice object.
 *
 * @param {string} rawText
 * @param {string} filename
 * @param {CompanySettings} settings
 * @returns {ParsedInvoice}
 */
export function parseInvoice(rawText, filename, settings) {
  const reviewReasons = [];

  // ── Date ──────────────────────────────────────────────────────────────────
  const dates = extractDates(rawText);
  const bestDate = chooseBestDate(dates);
  let fecha = '';
  if (bestDate) {
    fecha = formatDate(bestDate);
  } else {
    reviewReasons.push('No se pudo determinar la fecha');
  }

  // ── Type & contract ───────────────────────────────────────────────────────
  const { tipo, isContract } = classifyInvoice(rawText, settings);
  if (tipo === 'Otro' && !isContract) {
    reviewReasons.push('Tipo de factura indeterminado');
  }

  // ── Contraparte ───────────────────────────────────────────────────────────
  const contraInfo = extractContraparte(rawText, settings, tipo);
  if (contraInfo.needsReview) {
    reviewReasons.push('No se pudo identificar la contraparte con certeza');
  }

  let contraparteField = [contraInfo.name, contraInfo.nif]
    .filter(Boolean)
    .join(' ');

  if (isContract) contraparteField += ' [CONTRATO]';

  const currencyMarker = detectCurrencyMarker(rawText);
  if (currencyMarker) contraparteField += ` ${currencyMarker}`;

  // ── Total ─────────────────────────────────────────────────────────────────
  const total = extractTotal(rawText);
  if (!total) reviewReasons.push('No se pudo extraer el total de la factura');

  // ── IGIC ──────────────────────────────────────────────────────────────────
  const igicEntries = extractIgic(rawText);

  let igicPercent = '';
  let igicAmount = '';
  let base = '';

  if (igicEntries.length > 0) {
    igicPercent = igicEntries.map((e) => e.percent).filter(Boolean).join('|');
    igicAmount = igicEntries.map((e) => e.amount).filter(Boolean).join('|');
    base = igicEntries.map((e) => e.base).filter(Boolean).join('|');

    if (!base) {
      base = extractBases(rawText).join('|');
    }
  } else {
    base = extractBases(rawText).join('|');
  }

  return {
    filename,
    fecha,
    tipo,
    contraparte: contraparteField.trim(),
    total,
    igicPercent,
    igicAmount,
    base,
    rawText,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
    isContract,
  };
}
