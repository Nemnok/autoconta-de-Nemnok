/**
 * parseInvoiceV2.js — Parser v2.0
 *
 * Optimised for Compra invoices with scanned-PDF (OCR) text.
 *
 * Key improvements over v1:
 *  - Default tipo = Compra (unless contrato/compraventa detected)
 *  - Robust NIF/CIF/NIE extraction including:
 *      "(NIF B38627774)"  parenthesised with letter prefix
 *      "(NIF 838627774)"  parenthesised, numeric (OCR confusion B→8)
 *      "NIF: B38627774"   labelled inline
 *  - OCR normalisation (O/0, I/1, S/5, B/8) applied to NIF candidates
 *  - Better contraparte: issuer-section first, then header-area NIF, robust
 *    name capture including parenthetical trade names
 *  - Richer TOTAL keywords + numeric fallback (largest amount in lower half)
 *  - Improved multi-tranche IGIC extraction including 0%-rate rows
 *
 * Exports the same `parseInvoice` function signature as v1 so main.js needs
 * only an import path change.  All v1 helper exports are re-exported below for
 * backward compatibility with any tooling that imports them.
 */

export {
  extractDates,
  chooseBestDate,
  formatDate,
  parseEuropeanNumber,
  toEuropeanString,
  detectCurrencyMarker,
  extractBases,
} from './parseInvoice.js';

import {
  extractDates,
  chooseBestDate,
  formatDate,
  toEuropeanString,
  parseEuropeanNumber,
  detectCurrencyMarker,
} from './parseInvoice.js';

// ─── OCR normalisation helpers ────────────────────────────────────────────────

/**
 * Apply common OCR confusion substitutions to a tax-ID candidate string.
 * These are ONLY applied inside NIF/CIF candidate extraction; they are not
 * applied to arbitrary text.
 *
 * @param {string} raw - candidate string (may contain OCR errors)
 * @returns {string[]} candidate variations to try (first = best)
 */
function ocrNifVariants(raw) {
  const upper = raw.toUpperCase().trim();
  const variants = [upper];

  // If the first character looks like a digit that might be a letter:
  // 8 → B  (very common on receipts with bold font)
  // 0 → O  (less likely for a CIF starter)
  // 1 → I  (rare)
  const first = upper[0];
  const restDigits = upper.slice(1);
  if (first === '8') variants.push('B' + restDigits);
  if (first === '0') variants.push('O' + restDigits);
  if (first === '1') variants.push('I' + restDigits);
  if (first === '5') variants.push('S' + restDigits);

  // Within the digits portion, normalise O↔0 and I/L↔1 for invalid combos
  // (only worth doing when a variant already looks close to a valid pattern)
  const digitNorm = upper
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/S/g, '5');
  if (digitNorm !== upper) variants.push(digitNorm);

  return [...new Set(variants)];
}

// ─── NIF / CIF / NIE extraction v2 ───────────────────────────────────────────

/** Standard Spanish tax identifier pattern (same characters as v1). */
const STD_NIF_RE = /\b([A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b/;

/**
 * Return true if a string matches the standard NIF/CIF/NIE shape.
 *
 * @param {string} s
 * @returns {boolean}
 */
function isStdNif(s) {
  return STD_NIF_RE.test(s.toUpperCase().trim());
}

/**
 * Try to extract a valid NIF from a raw candidate (possibly OCR-garbled).
 * Returns null when no valid form can be derived.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function resolveNif(raw) {
  for (const v of ocrNifVariants(raw)) {
    if (isStdNif(v)) return v;
  }
  return null;
}

/**
 * @typedef {Object} NifMatch
 * @property {string} nif    - Resolved (normalised) tax identifier
 * @property {string} rawNif - As it appeared in the source text
 * @property {string} prefix - Up to 200 characters before the match
 * @property {string} suffix - Up to 200 characters after the match
 * @property {number} index  - Character position in the source text
 */

/**
 * Extract all tax identifiers from text (NIF/CIF/NIE + extended formats).
 *
 * @param {string} text
 * @returns {NifMatch[]}
 */
export function extractNifsV2(text) {
  const results = [];

  // Helper: push a match after resolving OCR variants
  const push = (rawNif, index) => {
    const nif = resolveNif(rawNif);
    if (!nif) return;
    if (results.some((r) => r.nif === nif)) return; // deduplicate
    const start = Math.max(0, index - 200);
    const end = Math.min(text.length, index + rawNif.length + 200);
    results.push({
      nif,
      rawNif,
      prefix: text.slice(start, index),
      suffix: text.slice(index + rawNif.length, end),
      index,
    });
  };

  // ── Pattern 1: standard NIF/CIF/NIE ──────────────────────────────────────
  const reStd = new RegExp(STD_NIF_RE.source, 'g');
  let m;
  while ((m = reStd.exec(text)) !== null) {
    push(m[0], m.index);
  }

  // ── Pattern 2: "(NIF B38627774)" or "(NIF 838627774)" ────────────────────
  const reParens = /\(\s*(?:NIF|CIF|NIE|C\.I\.F\.)\s+([A-Z0-9]{7,10})\s*\)/gi;
  while ((m = reParens.exec(text)) !== null) {
    push(m[1], m.index + m[0].indexOf(m[1]));
  }

  // ── Pattern 3: labeled "NIF: B38627774" or "CIF: B38627774" ─────────────
  const reLabeled =
    /(?:NIF|CIF|NIE|C\.I\.F\.)\s*:?\s*([A-Z0-9]{7,10})\b/gi;
  while ((m = reLabeled.exec(text)) !== null) {
    push(m[1], m.index + m[0].indexOf(m[1]));
  }

  // Sort by position in document (earlier = higher priority)
  return results.sort((a, b) => a.index - b.index);
}

// ─── Name extraction v2 ───────────────────────────────────────────────────────

/** Known Canary Islands (IGIC) tax rates. */
const KNOWN_IGIC_RATES = new Set(['0', '3', '7', '9.5', '9,5', '13', '15', '20']);

/** Company-type suffixes recognised in Spanish. */
const COMPANY_SUFFIX_RE =
  /\b(?:S\.L\.U?\.?|S\.A\.U?\.?|S\.C\.P\.?|S\.C\.?|S\.L\.L?\.?|S\.A\.T\.?|S\.COOP\.?|AUTÓNOMO|AUTÓNOM[AO])\b/i;

/**
 * Try to extract a company/person name from the text surrounding a NIF.
 * Searches the 'prefix' (text before the NIF) and 'suffix' (text after).
 *
 * @param {string} prefix - text before the NIF
 * @param {string} suffix - text after the NIF (used as fallback)
 * @returns {string}
 */
export function extractNameNearNifV2(prefix, suffix) {
  const combined = prefix + ' ' + suffix;

  // ── Labelled patterns (highest priority) ─────────────────────────────────
  const labelledRe =
    /(?:RAZ[ÓO]N\s+SOCIAL|NOMBRE(?:\s+FISCAL)?|DENOMINACI[ÓO]N|RAZ[ÓO]N|EMPRESA|EMISOR|PROVEEDOR|CLIENTE|DESTINATARIO|SOCIEDAD)\s*:?\s*([^\n\r;:]{3,80})/i;
  const lm = labelledRe.exec(combined);
  if (lm) {
    const candidate = lm[1].trim().replace(/\s{2,}/g, ' ');
    if (candidate.length >= 3) return candidate;
  }

  // ── Search prefix lines backwards for company name ─────────────────────
  const lines = prefix.split(/[\n\r]+/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().replace(/\s{2,}/g, ' ');
    if (!line || line.length < 3 || line.length > 120) continue;

    // Must contain a company type suffix or ≥2 capitalised words
    const hasCompanySuffix = COMPANY_SUFFIX_RE.test(line);
    const hasCapWords =
      (line.match(/[A-ZÁÉÍÓÚÑÜ]{2,}/g) ?? []).length >= 2;

    if (hasCompanySuffix || hasCapWords) {
      // Skip lines that look like dates, addresses, or phone numbers
      if (/^\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(line)) continue;
      if (/^\+?[\d\s\-()]{7,}$/.test(line)) continue;
      if (/^(calle|c\/|avda|av\.|plaza|pg\.)/i.test(line)) continue;
      return line;
    }
  }

  return '';
}

// ─── Invoice type classification v2 ──────────────────────────────────────────

const CONTRACT_KEYWORDS = /\b(compraventa|contrato)\b/i;

/**
 * @typedef {'Compra'|'Venta'|'Otro'} InvoiceType
 */

/**
 * @typedef {Object} CompanySettings
 * @property {string} name
 * @property {string} nif
 */

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
    let end = Math.min(afterLabel.length, 400);
    for (const other of ALL_SECTION_LABELS) {
      if (labels.includes(other)) continue;
      const otherIdx = afterLabel.indexOf(other);
      if (otherIdx !== -1 && otherIdx < end) end = otherIdx;
    }
    return afterLabel.slice(0, end);
  }
  return '';
}

/**
 * Determine invoice type.
 *
 * v2 change: default is **Compra** (not Otro) when the classification cannot
 * be determined from context.  This matches the real-world usage where almost
 * all uploaded invoices are purchases.
 *
 * @param {string} text
 * @param {CompanySettings} settings
 * @returns {{ tipo: InvoiceType, isContract: boolean }}
 */
export function classifyInvoiceV2(text, settings) {
  if (CONTRACT_KEYWORDS.test(text)) {
    return { tipo: 'Otro', isContract: true };
  }

  const upper = text.toUpperCase();
  const companyNif = settings.nif.toUpperCase().trim();
  const companyName = settings.name.toUpperCase().trim();

  if (!companyNif && !companyName) {
    // No settings → assume Compra
    return { tipo: 'Compra', isContract: false };
  }

  const hasCompanyId = (ctx) => {
    if (companyNif && ctx.includes(companyNif)) return true;
    if (companyName && companyName.length >= 4 && ctx.includes(companyName))
      return true;
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

  // Position heuristic: if our NIF appears in the upper half → Venta
  if (companyNif && upper.includes(companyNif)) {
    const pos = upper.indexOf(companyNif);
    if (pos < upper.length / 2) return { tipo: 'Venta', isContract: false };
    return { tipo: 'Compra', isContract: false };
  }

  // ── v2 default: Compra ────────────────────────────────────────────────────
  return { tipo: 'Compra', isContract: false };
}

// ─── Contraparte extraction v2 ────────────────────────────────────────────────

/**
 * @typedef {Object} ContraparteInfo
 * @property {string} name
 * @property {string} nif
 * @property {boolean} needsReview
 */

/**
 * Extract the counterparty (supplier/issuer) for a Compra invoice.
 *
 * Strategy (in order):
 *  1. Find NIFs inside a labelled issuer section (EMISOR/PROVEEDOR/VENDEDOR).
 *  2. Find NIFs in the upper third of the document (letterhead area).
 *  3. Take the first NIF that is not our own NIF.
 *
 * Name is extracted from the context around the chosen NIF.
 *
 * @param {string} text
 * @param {CompanySettings} settings
 * @param {InvoiceType} tipo
 * @returns {ContraparteInfo}
 */
export function extractContraparteV2(text, settings, tipo) {
  const nifs = extractNifsV2(text);
  const companyNifUpper = settings.nif.toUpperCase().trim();

  const otherNifs = nifs.filter(
    (n) => n.nif.toUpperCase() !== companyNifUpper,
  );

  if (otherNifs.length === 0) {
    return { name: '', nif: '', needsReview: true };
  }

  let chosen = null;

  if (tipo === 'Venta') {
    // For Venta: look in recipient section
    const recipientSection = extractSection(text.toUpperCase(), [
      'CLIENTE', 'DESTINATARIO', 'COMPRADOR', 'RECEPTOR',
    ]);
    const inRecipient = otherNifs.filter((n) =>
      recipientSection.includes(n.nif.toUpperCase()),
    );
    chosen = inRecipient[0] ?? otherNifs[0];
  } else {
    // For Compra (or Otro): prefer issuer section, then upper-document area
    const issuerSection = extractSection(text.toUpperCase(), [
      'EMISOR', 'VENDEDOR', 'PROVEEDOR',
    ]);
    const inIssuer = otherNifs.filter((n) =>
      issuerSection.includes(n.nif.toUpperCase()),
    );

    if (inIssuer.length > 0) {
      chosen = inIssuer[0];
    } else {
      // Prefer NIFs in the upper third of the document (header/letterhead)
      const upperThirdEnd = Math.floor(text.length / 3);
      const inUpperThird = otherNifs.filter((n) => n.index < upperThirdEnd);
      chosen = inUpperThird[0] ?? otherNifs[0];
    }
  }

  const name = extractNameNearNifV2(chosen.prefix, chosen.suffix);
  return {
    name,
    nif: chosen.nif,
    needsReview: !name,
  };
}

// ─── Total extraction v2 ──────────────────────────────────────────────────────

/**
 * Extract all currency-formatted amounts from text.
 * Returns parsed numeric values paired with their source strings.
 *
 * @param {string} text
 * @returns {{ value: number, str: string }[]}
 */
function extractAllAmounts(text) {
  // Match European-style numbers: optionally thousands-dotted, comma decimal
  const re = /\b(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\b/g;
  const results = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = parseEuropeanNumber(m[1]);
    if (!isNaN(value) && value > 0) {
      results.push({ value, str: m[1] });
    }
  }
  return results;
}

/**
 * Extract the invoice total.
 *
 * v2 adds more keyword patterns and a numeric fallback:
 *  fallback = largest amount in the lower two-thirds of the text,
 *  excluding values that appear next to BASE/IGIC/CUOTA keywords.
 *
 * @param {string} text
 * @returns {string}
 */
export function extractTotalV2(text) {
  const patterns = [
    /TOTAL\s+A\s+PAGAR\s*:?\s*([\d.,]+)/gi,
    /TOTAL\s+FACTURA\s*:?\s*([\d.,]+)/gi,
    /IMPORTE\s+TOTAL\s*:?\s*([\d.,]+)/gi,
    /TOTAL\s+IMPORTE\s*:?\s*([\d.,]+)/gi,
    /L[IÍ]QUIDO\s+A\s+PAGAR\s*:?\s*([\d.,]+)/gi,
    /L[IÍ]QUIDO\s*:?\s*([\d.,]+)/gi,
    /IMPORTE\s+A\s+PAGAR\s*:?\s*([\d.,]+)/gi,
    /A\s+PAGAR\s*:?\s*([\d.,]+)/gi,
    /TOTAL\s*:?\s*([\d.,]+)/gi,
    /TOTAL\s*EUR\s*:?\s*([\d.,]+)/gi,
  ];

  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const val = toEuropeanString(m[1]);
      // Sanity: skip implausibly large values (e.g. invoice numbers)
      const n = parseEuropeanNumber(m[1]);
      if (!isNaN(n) && n < 1_000_000) return val;
    }
  }

  // ── Numeric fallback ──────────────────────────────────────────────────────
  // Look in the lower two-thirds of the text, excluding BASE/IGIC/CUOTA lines
  const splitPoint = Math.floor(text.length / 3);
  const lowerText = text.slice(splitPoint);

  // Remove lines that look like BASE or IGIC to avoid picking those up
  const cleanedLower = lowerText
    .split(/\n/)
    .filter((l) => !/\b(?:BASE|IGIC|CUOTA|TIPO)\b/i.test(l))
    .join('\n');

  const amounts = extractAllAmounts(cleanedLower);
  if (amounts.length > 0) {
    const largest = amounts.reduce(
      (best, a) => (a.value > best.value ? a : best),
      amounts[0],
    );
    return toEuropeanString(largest.str);
  }

  return '';
}

// ─── IGIC extraction v2 ───────────────────────────────────────────────────────

/**
 * @typedef {Object} IgicEntry
 * @property {string} percent
 * @property {string} amount
 * @property {string} base
 */

/**
 * Try to parse a line as a table row containing base, percent, and IGIC amount.
 * Returns null when the line does not match a recognisable table row format.
 *
 * @param {string} line
 * @returns {{ base: string, percent: string, amount: string }|null}
 */
function parseIgicTableRow(line) {
  // Only process lines that contain IGIC-relevant keywords or a % sign
  if (!/\b(?:BASE|IGIC|CUOTA|TIPO|EXENTO)\b|%/i.test(line)) return null;

  // Skip lines that look like date strings (avoid matching "12" in "12/01/2026")
  if (/\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}\b/.test(line)) return null;

  const numbers = [];
  const numRe = /\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+(?:[.,]\d+)?/g;
  let m;
  while ((m = numRe.exec(line)) !== null) {
    numbers.push({ raw: m[0], value: parseEuropeanNumber(m[0]) });
  }

  // We need at least 2 numbers (percent + cuota)
  if (numbers.length < 2) return null;

  // Find a small integer that is a known IGIC rate (0–20 and in KNOWN_IGIC_RATES)
  const rateIdx = numbers.findIndex(
    (n) =>
      n.value >= 0 &&
      n.value <= 20 &&
      /^\d{1,2}$/.test(n.raw.trim()) &&
      KNOWN_IGIC_RATES.has(String(n.value)),
  );
  if (rateIdx === -1) return null;

  const percent = String(numbers[rateIdx].value);

  // The amount (cuota) is the last number after the rate index
  const after = numbers.slice(rateIdx + 1);
  if (after.length === 0) return null;
  const amount = toEuropeanString(after[after.length - 1].raw);

  // The base is the first number before the rate index (or first in row)
  const before = numbers.slice(0, rateIdx);
  const base = before.length > 0
    ? toEuropeanString(before[before.length - 1].raw)
    : '';

  return { base, percent, amount };
}

/**
 * Extract IGIC tranches from text (v2).
 *
 * Tries three strategies:
 *  A) Explicit "IGIC X% : amount" or "X% de IGIC : amount" patterns.
 *  B) Table rows detected near "IGIC" / "BASE" headers.
 *  C) Any row whose pattern looks like (base | rate | cuota) if A+B failed.
 *
 * @param {string} text
 * @returns {IgicEntry[]}
 */
export function extractIgicV2(text) {
  const entries = [];

  // ── Pattern A: explicit "IGIC X% amount" ─────────────────────────────────
  const reA = /IGIC\s*\(?(\d{1,2}(?:[.,]\d+)?)\s*%\)?\s*:?\s*([\d.,]+)/gi;
  let m;
  while ((m = reA.exec(text)) !== null) {
    const pct = String(parseFloat(m[1].replace(',', '.')));
    const amt = toEuropeanString(m[2]);
    const base = findBaseForIgicPercent(text, pct);
    if (!entries.some((e) => e.percent === pct)) {
      entries.push({ percent: pct, amount: amt, base });
    }
  }

  // Pattern A2: "X% de IGIC amount"
  const reA2 =
    /(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:de\s+)?IGIC\s*:?\s*([\d.,]+)/gi;
  while ((m = reA2.exec(text)) !== null) {
    const pct = String(parseFloat(m[1].replace(',', '.')));
    if (entries.some((e) => e.percent === pct)) continue;
    const amt = toEuropeanString(m[2]);
    const base = findBaseForIgicPercent(text, pct);
    entries.push({ percent: pct, amount: amt, base });
  }

  if (entries.length > 0) return entries;

  // ── Pattern B: table rows near IGIC/BASE header ───────────────────────────
  // Find the approximate location of the IGIC block
  const igicIdx = text.search(/\bIGIC\b/i);
  const baseIdx = text.search(/\bBASE\b/i);
  const tableStart = Math.max(0, Math.min(igicIdx, baseIdx) - 50);
  const tableEnd = Math.min(text.length, Math.max(igicIdx, baseIdx) + 600);
  const tableBlock = igicIdx !== -1 || baseIdx !== -1
    ? text.slice(tableStart, tableEnd)
    : text;

  for (const line of tableBlock.split(/\n/)) {
    const row = parseIgicTableRow(line);
    if (!row) continue;
    if (entries.some((e) => e.percent === row.percent)) continue;
    entries.push(row);
  }

  if (entries.length > 0) return entries;

  // ── Pattern C: bare "IGIC : amount" (no percent) ─────────────────────────
  const reC = /IGIC\s*:?\s*([\d.,]+)/gi;
  while ((m = reC.exec(text)) !== null) {
    const amt = toEuropeanString(m[1]);
    if (!entries.some((e) => e.amount === amt)) {
      entries.push({ percent: '', amount: amt, base: '' });
    }
  }

  return entries;
}

/**
 * Find the taxable base for a given IGIC rate.
 *
 * @param {string} text
 * @param {string} pct - rate as a normalised string (e.g. "7", "3", "0")
 * @returns {string}
 */
function findBaseForIgicPercent(text, pct) {
  const re = /BASE\s+(?:IMPONIBLE)?\s*:?\s*([\d.,]+)/gi;
  const bases = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    bases.push(toEuropeanString(m[1]));
  }
  if (bases.length === 1) return bases[0];
  // If multiple bases, try to match positionally (future: correlate by index)
  return '';
}

/**
 * Extract all distinct BASE IMPONIBLE values from text.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractBasesV2(text) {
  const re = /BASE\s+(?:IMPONIBLE)?\s*:?\s*([\d.,]+)/gi;
  const results = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    results.push(toEuropeanString(m[1]));
  }
  return [...new Set(results)];
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
 * ParsedInvoice object.  Identical interface to v1 `parseInvoice`.
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
  const { tipo, isContract } = classifyInvoiceV2(rawText, settings);
  // v2: 'Otro' without a contract is no longer raised as a review flag
  // because the default is Compra; only flag genuine ambiguity via contract.

  // ── Contraparte ───────────────────────────────────────────────────────────
  const contraInfo = extractContraparteV2(rawText, settings, tipo);
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
  const total = extractTotalV2(rawText);
  if (!total) reviewReasons.push('No se pudo extraer el total de la factura');

  // ── IGIC ──────────────────────────────────────────────────────────────────
  const igicEntries = extractIgicV2(rawText);

  let igicPercent = '';
  let igicAmount = '';
  let base = '';

  if (igicEntries.length > 0) {
    igicPercent = igicEntries.map((e) => e.percent).filter(Boolean).join('|');
    igicAmount = igicEntries.map((e) => e.amount).filter(Boolean).join('|');
    base = igicEntries.map((e) => e.base).filter(Boolean).join('|');

    if (!base) {
      base = extractBasesV2(rawText).join('|');
    }
  } else {
    base = extractBasesV2(rawText).join('|');
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
