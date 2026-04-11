/**
 * parseInvoiceV2.js — Parser v2.0
 *
 * Optimised for Compra invoices with scanned-PDF (OCR) text.
 *
 * Key improvements over v1:
 *  - Default tipo = Compra (unless contrato/compraventa detected in header)
 *  - Robust NIF/CIF/NIE extraction including OCR garble patterns
 *  - OCR normalisation (O/0, I/1, S/5, B/8, A/4) applied to NIF candidates
 *  - Better contraparte: multi-strategy company name extraction
 *  - Currency detection disabled (all invoices are EUR)
 *  - Context-aware date selection (prefers "Fecha" labelled dates)
 *  - Richer TOTAL keywords + numeric fallback
 *  - Improved multi-tranche IGIC extraction including 0%-rate rows
 *
 * Exports the same `parseInvoice` function signature as v1 so main.js needs
 * only an import path change.
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
  formatDate,
  toEuropeanString,
  parseEuropeanNumber,
} from './parseInvoice.js';

// ─── OCR normalisation helpers ────────────────────────────────────────────────

function ocrNifVariants(raw) {
  const upper = raw.toUpperCase().trim();
  const variants = [upper];
  const first = upper[0];
  const restDigits = upper.slice(1);
  if (first === '8') variants.push('B' + restDigits);
  if (first === '0') variants.push('O' + restDigits);
  if (first === '1') variants.push('I' + restDigits);
  if (first === '5') variants.push('S' + restDigits);
  if (first === '4') variants.push('A' + restDigits);
  const digitNorm = upper.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5');
  if (digitNorm !== upper) variants.push(digitNorm);
  // Handle trailing letter OCR confusion
  if (upper.length === 9) {
    const last = upper[8];
    const prefix = upper.slice(0, 8);
    if (last === '4') variants.push(prefix + 'A');
    if (last === 'A') variants.push(prefix + '4');
    if (last === '8') variants.push(prefix + 'B');
  }
  return [...new Set(variants)];
}

// ─── NIF / CIF / NIE extraction v2 ───────────────────────────────────────────

const STD_NIF_RE = /\b([A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b/;

function isStdNif(s) {
  return STD_NIF_RE.test(s.toUpperCase().trim());
}

function resolveNif(raw) {
  const cleaned = raw.replace(/-/g, '').replace(/\s/g, '');
  for (const v of ocrNifVariants(cleaned)) {
    if (isStdNif(v)) return v;
  }
  return null;
}

/**
 * @typedef {Object} NifMatch
 * @property {string} nif
 * @property {string} rawNif
 * @property {string} prefix
 * @property {string} suffix
 * @property {number} index
 */

export function extractNifsV2(text) {
  const results = [];
  const push = (rawNif, index) => {
    const nif = resolveNif(rawNif);
    if (!nif) return;
    if (results.some((r) => r.nif === nif)) return;
    const start = Math.max(0, index - 400);
    const end = Math.min(text.length, index + rawNif.length + 400);
    results.push({
      nif, rawNif,
      prefix: text.slice(start, index),
      suffix: text.slice(index + rawNif.length, end),
      index,
    });
  };

  // Pattern 1: standard NIF/CIF/NIE
  const reStd = new RegExp(STD_NIF_RE.source, 'g');
  let m;
  while ((m = reStd.exec(text)) !== null) push(m[0], m.index);

  // Pattern 2: "(NIF B38627774)" or "(NIF 838627774)"
  const reParens = /\(\s*(?:NIF|CIF|NIE|C\.I\.F\.)\s+([A-Z0-9]{7,10})\s*\)/gi;
  while ((m = reParens.exec(text)) !== null)
    push(m[1], m.index + m[0].indexOf(m[1]));

  // Pattern 3: labeled "NIF: B38627774", "CIF: B-76080308", "NIF. 838627774", "C.1.F.:B-76769108"
  const reLabeled = /(?:NIF|CIF|NIE|C\.I\.F\.|C\.1\.F\.?|N\.I\.F\.?)\s*[.:]\s*([A-Z0-9][A-Z0-9\-]{6,11})\b/gi;
  while ((m = reLabeled.exec(text)) !== null)
    push(m[1], m.index + m[0].indexOf(m[1]));

  // Pattern 4: bare NIF after label on next line
  const reBare = /(?:NIF|CIF|C\.I\.F\.?|C\.1\.F\.?)\s*\.?\s*:?\s*\n?\s*([A-Z0-9\-]{8,12})\b/gi;
  while ((m = reBare.exec(text)) !== null)
    push(m[1], m.index + m[0].indexOf(m[1]));

  return results.sort((a, b) => a.index - b.index);
}

// ─── Name extraction ──────────────────────────────────────────────────────────

const KNOWN_IGIC_RATES = new Set(['0', '3', '7', '9.5', '9,5', '13', '15', '20']);

const COMPANY_SUFFIX_RE =
  /(?:,\s*)?(?:S\.L\.U?\.?|S\.A\.U?\.?|S\.C\.P\.?|S\.C\.?|S\.L\.L?\.?|S\.A\.T\.?|S\.COOP\.?|SL\b|SA\b)/i;

function findCompanyNamesInText(text) {
  const results = [];
  const re = /([A-ZÁÉÍÓÚÑÜa-záéíóúñü][A-ZÁÉÍÓÚÑÜa-záéíóúñü\s,.()&\-]{2,80}?(?:,\s*)?(?:S\.L\.U?\.?|S\.A\.U?\.?|S\.L\b|S\.A\b|SL\b|SA\b)\.?(?:\s*\([^)]{2,40}\))?)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim();
    if (name.length < 5) continue;
    if (/^\d/.test(name)) continue;
    results.push({ name, index: m.index });
  }
  return results;
}

function normalizeCompanyName(name) {
  let n = name.trim();
  // Clean up extra periods before comma+suffix
  n = n.replace(/\.+(,\s*S\.)/g, '$1');
  // Fix bare SL/SA → S.L./S.A.
  n = n.replace(/\bSL\b(?!\.)/g, 'S.L.');
  n = n.replace(/\bSA\b(?!\.)/g, 'S.A.');
  // Ensure period after S.L or S.A if missing
  n = n.replace(/\bS\.L(?![\.\w])/g, 'S.L.');
  n = n.replace(/\bS\.A(?![\.\w])/g, 'S.A.');
  // Ensure comma before S.L./S.A. if not already present
  n = n.replace(/([A-Za-záéíóúñüÁÉÍÓÚÑÜ])\s+(S\.(?:L|A)\.)/g, '$1, $2');
  // Fix spacing around comma-suffix
  n = n.replace(/,\s*(S\.(?:L|A)\.)/g, ', $1');
  // Clean up multiple spaces
  n = n.replace(/\s{2,}/g, ' ');
  return n.trim();
}

function extractCompanyName(text, nifMatch, clientNif, clientName) {
  const clientNifUpper = (clientNif || '').toUpperCase().trim();
  const clientNameUpper = (clientName || '').toUpperCase().trim();

  const isClientRelated = (name) => {
    const upper = name.toUpperCase();
    if (clientNifUpper && upper.includes(clientNifUpper)) return true;
    if (clientNameUpper && clientNameUpper.length >= 4 && upper.includes(clientNameUpper)) return true;
    if (/\bBRATUKH\b/i.test(name)) return true;
    if (/\bMAKSYM\b/i.test(name)) return true;
    return false;
  };

  // Strategy 1: Look near the NIF (400-char context)
  const context = nifMatch.prefix + '\n' + nifMatch.suffix;
  const nearbyNames = findCompanyNamesInText(context);
  for (const cn of nearbyNames) {
    if (!isClientRelated(cn.name)) {
      return normalizeCompanyName(cn.name);
    }
  }

  // Strategy 2: Search the ENTIRE text
  const allNames = findCompanyNamesInText(text);
  const validNames = allNames.filter(cn => !isClientRelated(cn.name));
  if (validNames.length > 0) {
    let best = validNames[0];
    let bestDist = Math.abs(best.index - nifMatch.index);
    for (const cn of validNames) {
      const dist = Math.abs(cn.index - nifMatch.index);
      if (dist < bestDist) { best = cn; bestDist = dist; }
    }
    return normalizeCompanyName(best.name);
  }

  // Strategy 3: GDPR responsable pattern
  const gdprMatch =
    /(?:responsable\s+(?:es|del\s+tratamiento[^:]*es)\s*:?\s*([^,\n]{5,60}(?:,\s*)?(?:S\.L\.?|S\.A\.?)\.?(?:\s*\([^)]{2,40}\))?))/i
      .exec(text);
  if (gdprMatch && !isClientRelated(gdprMatch[1])) {
    return normalizeCompanyName(gdprMatch[1].trim());
  }

  // Strategy 4: Fall back to old approach
  return extractNameNearNifV2(nifMatch.prefix, nifMatch.suffix);
}

export function extractNameNearNifV2(prefix, suffix) {
  const combined = prefix + ' ' + suffix;
  const labelledRe =
    /(?:RAZ[ÓO]N\s+SOCIAL|NOMBRE(?:\s+FISCAL)?|DENOMINACI[ÓO]N|RAZ[ÓO]N|EMPRESA|EMISOR|PROVEEDOR|DESTINATARIO|SOCIEDAD)\s*:?\s*([^\n\r;:]{3,80})/i;
  const lm = labelledRe.exec(combined);
  if (lm) {
    const candidate = lm[1].trim().replace(/\s{2,}/g, ' ');
    if (candidate.length >= 3) return candidate;
  }
  const lines = prefix.split(/[\n\r]+/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().replace(/\s{2,}/g, ' ');
    if (!line || line.length < 3 || line.length > 120) continue;
    const hasCompanySuffix = COMPANY_SUFFIX_RE.test(line);
    const hasCapWords = (line.match(/[A-ZÁÉÍÓÚÑÜ]{2,}/g) ?? []).length >= 2;
    if (hasCompanySuffix || hasCapWords) {
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

const ALL_SECTION_LABELS = [
  'EMISOR', 'VENDEDOR', 'PROVEEDOR', 'EXPEDIDA POR', 'FACTURADO POR',
  'CLIENTE', 'DESTINATARIO', 'COMPRADOR', 'RECEPTOR', 'FACTURADO A',
];

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

export function classifyInvoiceV2(text, settings) {
  // Only check for contract keywords in the first quarter (header area)
  const headerEnd = Math.floor(text.length / 4);
  const headerText = text.slice(0, headerEnd);
  if (CONTRACT_KEYWORDS.test(headerText)) {
    return { tipo: 'Otro', isContract: true };
  }

  const upper = text.toUpperCase();
  const companyNif = settings.nif.toUpperCase().trim();
  const companyName = settings.name.toUpperCase().trim();

  if (!companyNif && !companyName) {
    return { tipo: 'Compra', isContract: false };
  }

  const hasCompanyId = (ctx) => {
    if (companyNif && ctx.includes(companyNif)) return true;
    if (companyName && companyName.length >= 4 && ctx.includes(companyName)) return true;
    return false;
  };

  const issuerSection = extractSection(upper, [
    'EMISOR', 'VENDEDOR', 'PROVEEDOR', 'EXPEDIDA POR', 'FACTURADO POR',
  ]);
  if (issuerSection && hasCompanyId(issuerSection))
    return { tipo: 'Venta', isContract: false };

  const recipientSection = extractSection(upper, [
    'CLIENTE', 'DESTINATARIO', 'COMPRADOR', 'RECEPTOR', 'FACTURADO A',
  ]);
  if (recipientSection && hasCompanyId(recipientSection))
    return { tipo: 'Compra', isContract: false };

  if (companyNif && upper.includes(companyNif)) {
    const pos = upper.indexOf(companyNif);
    if (pos < upper.length / 2) return { tipo: 'Venta', isContract: false };
    return { tipo: 'Compra', isContract: false };
  }

  return { tipo: 'Compra', isContract: false };
}

// ─── Contraparte extraction v2 ────────────────────────────────────────────────

export function extractContraparteV2(text, settings, tipo) {
  const nifs = extractNifsV2(text);
  const companyNifUpper = settings.nif.toUpperCase().trim();
  const otherNifs = nifs.filter((n) => n.nif.toUpperCase() !== companyNifUpper);

  if (otherNifs.length === 0) {
    return { name: '', nif: '', needsReview: true };
  }

  let chosen = null;

  if (tipo === 'Venta') {
    const recipientSection = extractSection(text.toUpperCase(), [
      'CLIENTE', 'DESTINATARIO', 'COMPRADOR', 'RECEPTOR',
    ]);
    const inRecipient = otherNifs.filter((n) =>
      recipientSection.includes(n.nif.toUpperCase()));
    chosen = inRecipient[0] ?? otherNifs[0];
  } else {
    const issuerSection = extractSection(text.toUpperCase(), [
      'EMISOR', 'VENDEDOR', 'PROVEEDOR',
    ]);
    const inIssuer = otherNifs.filter((n) =>
      issuerSection.includes(n.nif.toUpperCase()));
    if (inIssuer.length > 0) {
      chosen = inIssuer[0];
    } else {
      const upperThirdEnd = Math.floor(text.length / 3);
      const inUpperThird = otherNifs.filter((n) => n.index < upperThirdEnd);
      chosen = inUpperThird[0] ?? otherNifs[0];
    }
  }

  const name = extractCompanyName(text, chosen, settings.nif, settings.name);
  return { name, nif: chosen.nif, needsReview: !name };
}

// ─── Total extraction v2 ──────────────────────────────────────────────────────

function extractAllAmounts(text) {
  const re = /\b(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\b/g;
  const results = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = parseEuropeanNumber(m[1]);
    if (!isNaN(value) && value > 0) results.push({ value, str: m[1] });
  }
  return results;
}

export function extractTotalV2(text) {
  // Ordered by specificity (most specific first)
  const patterns = [
    /NETO\s+A\s+PAGAR\s*:?\s*([\d.,]+)/gi,
    /TOTAL\s+A\s+PAGAR\s*:?\s*([\d.,]+)/gi,
    /TOTAL\s+FACTURA\s*:?\s*([\d.,]+)/gi,
    /TOTAL\s+IMPORTE\s*:?\s*([\d.,]+)/gi,
    /L[IÍ]QUIDO\s+A\s+PAGAR\s*:?\s*([\d.,]+)/gi,
    /IMPORTE\s+A\s+PAGAR\s*:?\s*([\d.,]+)/gi,
    /A\s+PAGAR\s*:?\s*([\d.,]+)/gi,
  ];

  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const n = parseEuropeanNumber(m[1]);
      if (!isNaN(n) && n < 1_000_000) return toEuropeanString(m[1]);
    }
  }

  // "Importe total EUR ... amount" (Würth format)
  {
    const re = /Importe\s+total\s+EUR[\s\S]{0,40}?([\d]{1,3}(?:\.\d{3})*,\d{2})/gi;
    const m = re.exec(text);
    if (m) {
      const n = parseEuropeanNumber(m[1]);
      if (!isNaN(n) && n < 1_000_000) return toEuropeanString(m[1]);
    }
  }

  // "TOTAL (EUR) - amount"
  {
    const re = /TOTAL\s*\(?EUR\)?\s*[-:.]?\s*([\d.,]+)/gi;
    const m = re.exec(text);
    if (m) {
      const n = parseEuropeanNumber(m[1]);
      if (!isNaN(n) && n < 1_000_000) return toEuropeanString(m[1]);
    }
  }

  // "TOTAL amount €"
  {
    const re = /\bTOTAL\s*:?\s*([\d.,]+)\s*€/gi;
    const m = re.exec(text);
    if (m) {
      const n = parseEuropeanNumber(m[1]);
      if (!isNaN(n) && n < 1_000_000) return toEuropeanString(m[1]);
    }
  }

  // Bare "TOTAL amount"
  {
    const re = /\bTOTAL\s+([\d]{1,3}(?:\.\d{3})*,\d{2})\b/gi;
    const m = re.exec(text);
    if (m) {
      const n = parseEuropeanNumber(m[1]);
      if (!isNaN(n) && n < 1_000_000) return toEuropeanString(m[1]);
    }
  }

  // Numeric fallback: "amount €" in lower part
  const splitPoint = Math.floor(text.length / 3);
  const lowerText = text.slice(splitPoint);
  {
    const re = /\b(\d{1,3}(?:\.\d{3})*,\d{2})\s*€/g;
    const amounts = [];
    let m;
    while ((m = re.exec(lowerText)) !== null) {
      const n = parseEuropeanNumber(m[1]);
      if (!isNaN(n) && n > 0) amounts.push({ value: n, str: m[1] });
    }
    if (amounts.length > 0) {
      const largest = amounts.reduce((best, a) => a.value > best.value ? a : best, amounts[0]);
      return toEuropeanString(largest.str);
    }
  }

  // Last resort: largest amount in lower part excluding BASE/IGIC lines
  const cleanedLower = lowerText
    .split(/\n/)
    .filter((l) => !/\b(?:BASE|IGIC|CUOTA|TIPO|Valor\s+neto)\b/i.test(l))
    .join('\n');
  const amounts = extractAllAmounts(cleanedLower);
  if (amounts.length > 0) {
    const largest = amounts.reduce((best, a) => a.value > best.value ? a : best, amounts[0]);
    return toEuropeanString(largest.str);
  }

  return '';
}

// ─── IGIC extraction v2 ───────────────────────────────────────────────────────

function parseIgicTableRow(line) {
  if (!/\b(?:BASE|IGIC|CUOTA|TIPO|EXENTO|1\.G\.1\.C|I\.G\.I\.C)\b|%/i.test(line) &&
      !/\b(?:3,00|7,00|3\.00|7\.00)\b/.test(line)) return null;
  if (/\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b/.test(line)) return null;

  const numbers = [];
  const numRe = /(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+(?:[.,]\d+)?)/g;
  let m;
  while ((m = numRe.exec(line)) !== null) {
    const raw = m[0];
    if (/^\d{5,}$/.test(raw)) continue;
    numbers.push({ raw, value: parseEuropeanNumber(raw), pos: m.index });
  }
  if (numbers.length < 2) return null;

  const rateIdx = numbers.findIndex((n) =>
    n.value >= 0 && n.value <= 20 && KNOWN_IGIC_RATES.has(String(n.value)));
  if (rateIdx === -1) return null;

  const percent = String(numbers[rateIdx].value);
  const after = numbers.slice(rateIdx + 1);
  if (after.length === 0) return null;
  const amount = toEuropeanString(after[0].raw);
  const before = numbers.slice(0, rateIdx);
  const base = before.length > 0 ? toEuropeanString(before[before.length - 1].raw) : '';

  return { base, percent, amount };
}

export function extractIgicV2(text) {
  const entries = [];

  // Pattern A: explicit "IGIC X% amount"
  const reA = /IGIC\s*\(?(\d{1,2}(?:[.,]\d+)?)\s*%\)?\s*:?\s*([\d.,]+)/gi;
  let m;
  while ((m = reA.exec(text)) !== null) {
    const pct = String(parseFloat(m[1].replace(',', '.')));
    const amt = toEuropeanString(m[2]);
    if (!entries.some((e) => e.percent === pct))
      entries.push({ percent: pct, amount: amt, base: '' });
  }

  // Pattern A2: "X% de IGIC amount"
  const reA2 = /(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:de\s+)?IGIC\s*:?\s*([\d.,]+)/gi;
  while ((m = reA2.exec(text)) !== null) {
    const pct = String(parseFloat(m[1].replace(',', '.')));
    if (entries.some((e) => e.percent === pct)) continue;
    const amt = toEuropeanString(m[2]);
    entries.push({ percent: pct, amount: amt, base: '' });
  }

  if (entries.length > 0) {
    assignBasesToEntries(text, entries);
    return entries;
  }

  // Pattern B: table rows with base/rate/amount structure
  const igicIdx = text.search(/\b(?:IGIC|1\.G\.1\.C|I\.G\.I\.C)\b/i);
  const baseIdx = text.search(/\bBASE\b/i);
  const searchStart = Math.max(0, Math.min(
    igicIdx !== -1 ? igicIdx : text.length,
    baseIdx !== -1 ? baseIdx : text.length
  ) - 100);
  const searchEnd = Math.min(text.length, Math.max(
    igicIdx !== -1 ? igicIdx : 0,
    baseIdx !== -1 ? baseIdx : 0
  ) + 800);
  const tableBlock = (igicIdx !== -1 || baseIdx !== -1)
    ? text.slice(searchStart, searchEnd) : text;

  for (const line of tableBlock.split(/\n/)) {
    const row = parseIgicTableRow(line);
    if (!row) continue;
    if (entries.some((e) => e.percent === row.percent)) continue;
    entries.push(row);
  }
  if (entries.length > 0) return entries;

  // Pattern C: "X,XX %  1.G.1.C.  YY,YY"
  {
    const re = /(\d{1,2}(?:,\d+)?)\s*[:%]\s*(?:°?\s*)?(?:1\.G\.1\.C\.?|I\.G\.I\.C\.?)\s*[.:]?\s*([\d.,]+)/gi;
    while ((m = re.exec(text)) !== null) {
      const pct = String(parseFloat(m[1].replace(',', '.')));
      const amt = toEuropeanString(m[2]);
      if (!entries.some((e) => e.percent === pct))
        entries.push({ percent: pct, amount: amt, base: '' });
    }
    if (entries.length > 0) {
      assignBasesToEntries(text, entries);
      return entries;
    }
  }

  // Pattern D: "X% amount" in lower half near IGIC/1.G.1.C
  {
    const re = /(\d{1,2}(?:,\d+)?)\s*%\s+([\d.,]+)/gi;
    const lowerHalf = text.slice(Math.floor(text.length / 2));
    if (/1\.G\.1\.C|I\.G\.I\.C|IGIC/i.test(lowerHalf)) {
      while ((m = re.exec(lowerHalf)) !== null) {
        const pct = String(parseFloat(m[1].replace(',', '.')));
        if (!KNOWN_IGIC_RATES.has(pct)) continue;
        const amt = toEuropeanString(m[2]);
        if (!entries.some((e) => e.percent === pct))
          entries.push({ percent: pct, amount: amt, base: '' });
      }
      if (entries.length > 0) {
        assignBasesToEntries(text, entries);
        return entries;
      }
    }
  }

  // Pattern E: bare "IGIC : amount"
  const reC = /IGIC\s*:?\s*([\d.,]+)/gi;
  while ((m = reC.exec(text)) !== null) {
    const amt = toEuropeanString(m[1]);
    if (!entries.some((e) => e.amount === amt))
      entries.push({ percent: '', amount: amt, base: '' });
  }

  return entries;
}

function assignBasesToEntries(text, entries) {
  const re = /BASE(?:\s+IMPONIBLE)?\s*:?\s*([\d.,]+)/gi;
  const bases = [];
  let m;
  while ((m = re.exec(text)) !== null)
    bases.push({ value: toEuropeanString(m[1]), index: m.index });

  // Also "Valor neto EUR" pattern
  const reValor = /Valor\s+neto\s+EUR[\s\S]{0,40}?([\d]{1,3}(?:\.\d{3})*,\d{2})/gi;
  while ((m = reValor.exec(text)) !== null)
    bases.push({ value: toEuropeanString(m[1]), index: m.index });

  // Also "Importe neto" pattern
  const reNeto = /Importe\s+neto[\s\S]{0,40}?([\d]{1,3}(?:\.\d{3})*,\d{2})/gi;
  while ((m = reNeto.exec(text)) !== null)
    bases.push({ value: toEuropeanString(m[1]), index: m.index });

  if (bases.length === 1 && entries.length === 1) {
    entries[0].base = bases[0].value;
  } else if (bases.length >= entries.length) {
    for (let i = 0; i < entries.length && i < bases.length; i++) {
      if (!entries[i].base) entries[i].base = bases[i].value;
    }
  }

  // Compute missing bases from rate and amount
  for (const entry of entries) {
    if (entry.base || !entry.percent || !entry.amount) continue;
    const rate = parseFloat(entry.percent);
    const amt = parseEuropeanNumber(entry.amount);
    if (rate > 0 && !isNaN(amt)) {
      const computedBase = amt / (rate / 100);
      entry.base = toEuropeanString(computedBase.toFixed(2).replace('.', ','));
    }
  }
}

export function extractBasesV2(text) {
  const re = /BASE\s+(?:IMPONIBLE)?\s*:?\s*([\d.,]+)/gi;
  const results = [];
  let m;
  while ((m = re.exec(text)) !== null) results.push(toEuropeanString(m[1]));
  return [...new Set(results)];
}

// ─── Smart date selection ─────────────────────────────────────────────────────

function chooseBestDateV2(text, dates) {
  if (dates.length === 0) return null;
  if (dates.length === 1) return dates[0];

  const reNumeric = /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b/g;
  const dateInfos = [];
  let m;
  while ((m = reNumeric.exec(text)) !== null) {
    const d = Number(m[1]), mo = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y = y < 50 ? 2000 + y : 1900 + y;
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    if (d > new Date(y, mo, 0).getDate()) continue;

    const before = text.slice(Math.max(0, m.index - 80), m.index).toLowerCase();
    const isVencimiento = /vencimiento/i.test(before);
    const isFechaLabel = /\bfecha\b/i.test(before) && !isVencimiento;
    const isFechaFactura = /fecha\s+factura/i.test(before);

    dateInfos.push({
      date: new Date(y, mo - 1, d),
      isFechaLabel, isFechaFactura, isVencimiento,
      index: m.index,
    });
  }

  const fechaFactura = dateInfos.filter(d => d.isFechaFactura);
  if (fechaFactura.length > 0) return fechaFactura[0].date;
  const fecha = dateInfos.filter(d => d.isFechaLabel);
  if (fecha.length > 0) return fecha[0].date;
  const nonVenc = dateInfos.filter(d => !d.isVencimiento);
  if (nonVenc.length > 0) return nonVenc[0].date;
  return dates[0];
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function parseInvoice(rawText, filename, settings) {
  const reviewReasons = [];

  // Date (context-aware selection)
  const dates = extractDates(rawText);
  const bestDate = chooseBestDateV2(rawText, dates);
  let fecha = '';
  if (bestDate) {
    fecha = formatDate(bestDate);
  } else {
    reviewReasons.push('No se pudo determinar la fecha');
  }

  // Type & contract
  const { tipo, isContract } = classifyInvoiceV2(rawText, settings);

  // Contraparte
  const contraInfo = extractContraparteV2(rawText, settings, tipo);
  if (contraInfo.needsReview)
    reviewReasons.push('No se pudo identificar la contraparte con certeza');

  let contraparteField = [contraInfo.name, contraInfo.nif].filter(Boolean).join(' ');
  if (isContract) contraparteField += ' [CONTRATO]';
  // Currency detection disabled — all invoices are EUR

  // Total
  const total = extractTotalV2(rawText);
  if (!total) reviewReasons.push('No se pudo extraer el total de la factura');

  // IGIC
  const igicEntries = extractIgicV2(rawText);
  let igicPercent = '';
  let igicAmount = '';
  let base = '';

  if (igicEntries.length > 0) {
    igicPercent = igicEntries.map((e) => e.percent).filter(Boolean).join('|');
    igicAmount = igicEntries.map((e) => e.amount).filter(Boolean).join('|');
    base = igicEntries.map((e) => e.base).filter(Boolean).join('|');
    if (!base) base = extractBasesV2(rawText).join('|');
  } else {
    base = extractBasesV2(rawText).join('|');
  }

  return {
    filename, fecha, tipo,
    contraparte: contraparteField.trim(),
    total, igicPercent, igicAmount, base,
    rawText,
    needsReview: reviewReasons.length > 0,
    reviewReasons, isContract,
  };
}
