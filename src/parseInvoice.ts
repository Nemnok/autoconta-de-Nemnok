/**
 * parseInvoice.ts
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

import type { CompanySettings, IgicEntry, InvoiceType, ParsedInvoice } from './types.js';

// ─── Spanish month names ──────────────────────────────────────────────────────

const MONTH_MAP: Record<string, number> = {
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
 */
export function extractDates(text: string): Date[] {
  const dates: Date[] = [];

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const reNumeric = /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})\b/g;
  let m: RegExpExecArray | null;
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

function isValidDate(y: number, mo: number, d: number): boolean {
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
 */
export function chooseBestDate(dates: Date[]): Date | null {
  if (dates.length === 0) return null;
  return dates.reduce((best, d) => (d > best ? d : best), dates[0]);
}

/**
 * Format a Date as DD/MM/YYYY (European convention).
 */
export function formatDate(d: Date): string {
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
 */
export function parseEuropeanNumber(raw: string): number {
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
 * Uses a custom formatter to avoid relying on `Intl`/locale data that may
 * not be available in all environments (e.g. Node.js test runners).
 */
export function toEuropeanString(raw: string): string {
  const n = parseEuropeanNumber(raw);
  if (isNaN(n)) return raw;
  // toFixed gives us "1234.56"; we then apply European separators.
  const fixed = n.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  // Insert dot as thousands separator every 3 digits from the right.
  const intFormatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intFormatted},${decPart}`;
}

// ─── NIF / CIF / NIE extraction ───────────────────────────────────────────────

/** Regex for Spanish tax identifiers (NIF, CIF, NIE). */
const NIF_RE =
  /\b([A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b/g;

export interface NifMatch {
  nif: string;
  /** Characters immediately before the NIF in the source text */
  prefix: string;
  /** Characters immediately after the NIF in the source text */
  suffix: string;
}

export function extractNifs(text: string): NifMatch[] {
  const results: NifMatch[] = [];
  const re = new RegExp(NIF_RE.source, 'g');
  let m: RegExpExecArray | null;
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
 * Looks at the text immediately before the NIF for a capitalised name
 * (2–6 consecutive capitalised / title-case words).
 */
export function extractNameNearNif(context: string): string {
  // Try lines that contain "RAZÓN SOCIAL", "NOMBRE", "DENOMINACIÓN"
  const labelled =
    /(?:RAZ[ÓO]N\s+SOCIAL|NOMBRE|DENOMINACI[ÓO]N|EMISOR|PROVEEDOR|CLIENTE|DESTINATARIO)\s*:?\s*([^\n\r;]{3,60})/i;
  const lm = labelled.exec(context);
  if (lm) return lm[1].trim();

  // Fall back: last line with ≥2 capitalised words before the NIF
  const lines = context.split(/\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    // A line containing mostly capital letters (company name style)
    if (/([A-ZÁÉÍÓÚÑÜ][A-Za-záéíóúñü]+\s+){1,5}[A-ZÁÉÍÓÚÑÜ]/.test(line) && line.length < 80) {
      return line;
    }
  }
  return '';
}

// ─── IGIC extraction ──────────────────────────────────────────────────────────

/**
 * Extract IGIC tranches from text.
 *
 * Handles patterns like:
 *   "IGIC 7%  14,00"
 *   "Base imponible: 200,00  IGIC (7%): 14,00"
 *   "7% IGIC  14,00"
 *   Multiple lines with different rates
 */
export function extractIgic(text: string): IgicEntry[] {
  const entries: IgicEntry[] = [];

  // Pattern A: "IGIC" followed (optionally) by percent, then an amount
  // e.g. "IGIC 7% 14,00"  or  "IGIC (7 %) 14,00"
  const reA =
    /IGIC\s*\(?(\d{1,2}(?:[.,]\d+)?)\s*%\)?\s*:?\s*([\d.,]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = reA.exec(text)) !== null) {
    const pct = m[1].replace(',', '.');
    const amt = toEuropeanString(m[2]);
    const base = findBaseForPercent(text, pct);
    entries.push({ percent: pct, amount: amt, base });
  }

  // Pattern B: percent first, then "IGIC" or "de IGIC"
  // e.g. "7% IGIC   14,00"
  const reB =
    /(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:de\s+)?IGIC\s*:?\s*([\d.,]+)/gi;
  while ((m = reB.exec(text)) !== null) {
    const pct = m[1].replace(',', '.');
    if (entries.some((e) => e.percent === pct)) continue; // dedup
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

function findBaseForPercent(text: string, _pct: string): string {
  // Look for "Base imponible ... <amount>" near the same line or in a table
  const reBase =
    /BASE\s+(?:IMPONIBLE)?\s*:?\s*([\d.,]+)/gi;
  const bases: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = reBase.exec(text)) !== null) {
    bases.push(toEuropeanString(m[1]));
  }
  // If exactly one base found, attribute it to this percent
  if (bases.length === 1) return bases[0];
  // Otherwise leave blank (caller will pipe-separate all available bases)
  return '';
}

/**
 * Extract all distinct base amounts from text.
 */
export function extractBases(text: string): string[] {
  const re = /BASE\s+(?:IMPONIBLE)?\s*:?\s*([\d.,]+)/gi;
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push(toEuropeanString(m[1]));
  }
  return [...new Set(results)]; // deduplicate
}

// ─── Total extraction ─────────────────────────────────────────────────────────

/**
 * Extract the invoice total amount.
 * Tries several label patterns in order of preference.
 */
export function extractTotal(text: string): string {
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

export type CurrencyMarker = '' | '[MONEDA: USD]' | '[MONEDA: NON-EUR]';

export function detectCurrencyMarker(text: string): CurrencyMarker {
  if (/\bUSD\b|\$\s*[\d.,]/.test(text)) return '[MONEDA: USD]';
  // Other non-EUR currencies
  if (/\bGBP\b|£\s*[\d.,]|\bCHF\b|\bJPY\b|\bCAD\b|\bAUD\b/.test(text))
    return '[MONEDA: NON-EUR]';
  return '';
}

// ─── Invoice type classification ──────────────────────────────────────────────

const CONTRACT_KEYWORDS = /\b(compraventa|contrato)\b/i;

/**
 * Determine whether the invoice is a Compra, Venta, or Otro, and whether it
 * is a contract document.
 *
 * Heuristic:
 *  1. If CONTRACT_KEYWORDS found → Otro + isContract = true.
 *  2. Else if the company's NIF/name appears near "emisor / vendedor / proveedor"
 *     labels → Venta.
 *  3. Else if the company's NIF/name appears near "cliente / destinatario /
 *     comprador / receptor" labels → Compra.
 *  4. Otherwise → Otro.
 */
export function classifyInvoice(
  text: string,
  settings: CompanySettings,
): { tipo: InvoiceType; isContract: boolean } {
  if (CONTRACT_KEYWORDS.test(text)) {
    return { tipo: 'Otro', isContract: true };
  }

  const upper = text.toUpperCase();
  const companyNif = settings.nif.toUpperCase().trim();
  const companyName = settings.name.toUpperCase().trim();

  const hasCompanyId = (ctx: string): boolean => {
    if (companyNif && ctx.includes(companyNif)) return true;
    if (companyName && ctx.includes(companyName)) return true;
    return false;
  };

  // Look for "emisor" / "vendedor" sections
  const issuerSection = extractSection(upper, [
    'EMISOR', 'VENDEDOR', 'PROVEEDOR', 'EXPEDIDA POR', 'FACTURADO POR',
  ]);
  if (issuerSection && hasCompanyId(issuerSection)) {
    return { tipo: 'Venta', isContract: false };
  }

  // Look for "cliente" / "destinatario" sections
  const recipientSection = extractSection(upper, [
    'CLIENTE', 'DESTINATARIO', 'COMPRADOR', 'RECEPTOR', 'FACTURADO A',
  ]);
  if (recipientSection && hasCompanyId(recipientSection)) {
    return { tipo: 'Compra', isContract: false };
  }

  // Fallback: if company id appears at all without section context
  if (companyNif && upper.includes(companyNif)) {
    // Check relative position: company in first half → likely issuer (Venta)
    const pos = upper.indexOf(companyNif);
    if (pos < upper.length / 2) return { tipo: 'Venta', isContract: false };
    return { tipo: 'Compra', isContract: false };
  }

  return { tipo: 'Otro', isContract: false };
}

/** All recognised section-label keywords (used to find section boundaries). */
const ALL_SECTION_LABELS = [
  'EMISOR', 'VENDEDOR', 'PROVEEDOR', 'EXPEDIDA POR', 'FACTURADO POR',
  'CLIENTE', 'DESTINATARIO', 'COMPRADOR', 'RECEPTOR', 'FACTURADO A',
];

/**
 * Extract up to 300 chars after each of the given label words, but stop at
 * the first occurrence of any other section label so we don't spill context
 * into the next block.
 */
function extractSection(text: string, labels: string[]): string {
  for (const label of labels) {
    const idx = text.indexOf(label);
    if (idx === -1) continue;
    const afterLabel = text.slice(idx + label.length);
    // Find the earliest boundary imposed by a sibling label
    let end = Math.min(afterLabel.length, 300);
    for (const other of ALL_SECTION_LABELS) {
      if (labels.includes(other)) continue; // same group – not a boundary
      const otherIdx = afterLabel.indexOf(other);
      if (otherIdx !== -1 && otherIdx < end) end = otherIdx;
    }
    return afterLabel.slice(0, end);
  }
  return '';
}

// ─── Contraparte extraction ───────────────────────────────────────────────────

export interface ContraparteInfo {
  name: string;
  nif: string;
  needsReview: boolean;
}

/**
 * Extract the counterparty (the other party – not the company).
 *
 * If tipo === 'Venta': counterparty is the client/recipient.
 * If tipo === 'Compra': counterparty is the supplier/issuer.
 * If tipo === 'Otro':   use best-guess (first prominent NIF found that ≠ company NIF).
 */
export function extractContraparte(
  text: string,
  settings: CompanySettings,
  tipo: InvoiceType,
): ContraparteInfo {
  const nifs = extractNifs(text);
  const companyNifUpper = settings.nif.toUpperCase().trim();

  // Filter out the company's own NIF
  const otherNifs = nifs.filter((n) => n.nif.toUpperCase() !== companyNifUpper);

  if (otherNifs.length === 0) {
    return { name: '', nif: '', needsReview: true };
  }

  // Pick the most relevant NIF based on tipo
  let chosen: NifMatch;
  if (tipo === 'Venta') {
    // Counterparty is the recipient – look in "cliente" / "destinatario" sections
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
    needsReview: !name, // flag if we could not extract a name
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Parse a raw text string (from PDF extraction or OCR) into a structured
 * `ParsedInvoice` object.
 */
export function parseInvoice(
  rawText: string,
  filename: string,
  settings: CompanySettings,
): ParsedInvoice {
  const reviewReasons: string[] = [];

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

    // If bases are missing from igic entries, try standalone extraction
    if (!base) {
      base = extractBases(rawText).join('|');
    }
  } else {
    // Even without IGIC, try to extract base imponible
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
