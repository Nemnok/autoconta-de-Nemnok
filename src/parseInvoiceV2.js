/**
 * parseInvoiceV2.js — Parser v2.0
 *
 * Optimised for Compra invoices with scanned-PDF (OCR) text.
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
  // Common OCR confusions for the first character (letter ↔ digit)
  if (first === '8') variants.push('B' + restDigits);
  if (first === '0') variants.push('O' + restDigits);
  if (first === '1') variants.push('I' + restDigits);
  if (first === '5') variants.push('S' + restDigits);
  if (first === '4') variants.push('A' + restDigits);
  if (first === '2') variants.push('Z' + restDigits); // NIE documents
  const digitNorm = upper.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5');
  if (digitNorm !== upper) variants.push(digitNorm);
  if (upper.length === 9) {
    const last = upper[8];
    const prefix8 = upper.slice(0, 8);
    // Last-character OCR confusions
    if (last === '4') variants.push(prefix8 + 'A');
    if (last === 'A') variants.push(prefix8 + '4');
    if (last === '8') variants.push(prefix8 + 'B');
    if (last === 'B') variants.push(prefix8 + '8');
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

function nifsMatch(nif1, nif2) {
  if (!nif1 || !nif2) return false;
  const a = nif1.toUpperCase().trim();
  const b = nif2.toUpperCase().trim();
  if (a === b) return true;
  const resolved1 = resolveNif(a);
  const resolved2 = resolveNif(b);
  if (resolved1 && resolved2 && resolved1 === resolved2) return true;
  if (resolved1 === b || resolved2 === a) return true;
  if (a.length === b.length && a.length >= 8 && a.slice(1) === b.slice(1)) return true;
  return false;
}

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

  const reStd = new RegExp(STD_NIF_RE.source, 'g');
  let m;
  while ((m = reStd.exec(text)) !== null) push(m[0], m.index);

  const reParens = /\(\s*(?:NIF|CIF|NIE|C\.I\.F\.)\s+([A-Z0-9]{7,10})\s*\)/gi;
  while ((m = reParens.exec(text)) !== null)
    push(m[1], m.index + m[0].indexOf(m[1]));

  const reLabeled = /(?:NIF|CIF|NIE|C\.I\.F\.|C\.1\.F\.?|N\.I\.F\.?)\s*[.:]\s*([A-Z0-9][A-Z0-9\-]{6,11})\b/gi;
  while ((m = reLabeled.exec(text)) !== null)
    push(m[1], m.index + m[0].indexOf(m[1]));

  const reCifNif = /(?:CIF\/NIF|NIF\/CIF)\s+([A-Z0-9][A-Z0-9\-]{6,11})\b/gi;
  while ((m = reCifNif.exec(text)) !== null)
    push(m[1], m.index + m[0].indexOf(m[1]));

  const reCifDni = /(?:CIF\/DNI|DNI\/CIF)\s*:?\s*\n?\s*([A-Z0-9][A-Z0-9\-]{6,11})\b/gi;
  while ((m = reCifDni.exec(text)) !== null)
    push(m[1], m.index + m[0].indexOf(m[1]));

  return results.sort((a, b) => a.index - b.index);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalise OCR decimal: "45.06" → "45,06" (dot before exactly 2 final digits → comma) */
function normalizeDecimal(s) {
  return s.replace(/\.(\d{2})$/, ',$1');
}

// ─── Name extraction ──────────────────────────────────────────────────────────

const KNOWN_IGIC_RATES = new Set(['0', '3', '7', '9.5', '9,5', '13', '15', '20']);

function findCompanyNamesInText(text) {
  const results = [];
  
  // Normalize: join single newlines (preserving paragraph breaks)
  const normalized = text.replace(/\n(?!\n)/g, ' ').replace(/\s{2,}/g, ' ');
  
  // Find company names with GREEDY match to capture full names  
  const re = /\b([A-ZÁÉÍÓÚÑÜW][A-ZÁÉÍÓÚÑÜa-záéíóúñü\s,.&\-'()]{2,80})(?:,\s*)?(S\.L\.?U?\.?|S\.A\.?U?\.?|\bSL\b\.?|\bSA\b\.?)(?:\s*\(([^)]{2,40})\))?/gi;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    let name = m[1].trim();
    const suffix = m[2];
    const tradeName = m[3] || '';
    
    // Clean: remove everything before last sentence-ending break
    let breakIdx = Math.max(
      name.lastIndexOf('. '),
      name.lastIndexOf(': '),
      name.lastIndexOf('; '),
    );
    // Also check for comma + capitalized word (e.g., "vigente, Ferretería")
    // But only if the comma is followed by a capitalized word
    const commaBreakRe = /,\s+(?=[A-ZÁÉÍÓÚÑÜW][a-záéíóúñü])/g;
    let cm;
    while ((cm = commaBreakRe.exec(name)) !== null) {
      // Only use comma breaks that are clearly sentence boundaries
      // (preceded by a lowercase word, not part of a company name like "Goyo e Hijos,")
      const before = name.slice(0, cm.index);
      if (/[a-záéíóúñü]$/.test(before) && !/, $/.test(before)) {
        breakIdx = Math.max(breakIdx, cm.index + cm[0].length - 1);
      }
    }
    if (breakIdx >= 0) {
      const afterBreak = name.slice(breakIdx).replace(/^[.,;:\s]+/, '').trim();
      if (afterBreak.length >= 3 && /^[A-ZÁÉÍÓÚÑÜW]/.test(afterBreak)) {
        name = afterBreak;
      }
    }
    
    // Remove leading prepositions/articles ONLY if they don't look like part of a company name
    // "LAS CHAFIRAS" → keep "LAS" because it's part of the name
    // "de Ferretería" → remove "de"
    name = name.replace(/^(?:a|es|de|del|en|con|y|que|para|por|su|se)\s+/gi, '');
    // Only remove articles if followed by a lowercase word (not part of a company name)
    // Don't use /i flag here - we want case-sensitive check
    if (/^(?:la|el|los|las)\s+[a-záéíóúñü]/i.test(name)) {
      // Check if followed by lowercase (truly not a company name)
      const afterArticle = name.replace(/^(?:la|el|los|las)\s+/i, '');
      if (/^[a-záéíóúñü]/.test(afterArticle)) {
        name = afterArticle;
      }
    }
    
    // Remove leading lowercase words
    name = name.replace(/^(?:[a-záéíóúñü]+\s+)+(?=[A-ZÁÉÍÓÚÑÜW])/, '');
    
    // Remove leading non-alpha garbage
    name = name.replace(/^[^A-ZÁÉÍÓÚÑÜa-záéíóúñü]+/, '');
    // Remove leading OCR garbage: short uppercase + single letter prefixes
    // e.g., "DSS A LAS CHAFIRAS" → "LAS CHAFIRAS"
    name = name.replace(/^(?:[A-Z]{1,3}\s+[A-Z]\s+)+(?=[A-Z]{2,})/, '');
    
    if (name.length < 3) continue;
    
    // Filter garbage patterns
    if (/CANTIDAD|IMPORTE|DESCRIPCI|ARTÍCULO|PRECIO|DOCUMENTO|FACTURA/i.test(name)) continue;
    if (/^(?:calle|c\/|www|http|pol\.|email|Tel|IBAN|@)/i.test(name)) continue;
    // Remove email/URL prefixes but keep the company name after them
    name = name.replace(/^[a-z.@]+\.(?:com|es|net|org)\s+/i, '');
    if (/Cobrado|VISA|Efectivo/i.test(name)) continue;
    if (/IGIC|IMPONIBLE/i.test(name + suffix)) continue;
    
    // Build full name
    let fullName = name;
    if (!fullName.endsWith(',')) {
      fullName += ', ' + suffix;
    } else {
      fullName += ' ' + suffix;
    }
    if (tradeName) fullName += ' (' + tradeName + ')';
    fullName = fullName.replace(/\s{2,}/g, ' ').replace(/,\s*,/g, ',').trim();
    
    if (fullName.length < 5) continue;
    
    const origIdx = text.indexOf(name.slice(0, Math.min(15, name.length)));
    results.push({ name: fullName, index: origIdx >= 0 ? origIdx : m.index });
  }
  
  return results;
}

function normalizeCompanyName(name) {
  let n = name.trim();
  n = n.replace(/\s*\n\s*/g, ' ');
  n = n.replace(/\.+(,\s*S\.)/g, '$1');
  n = n.replace(/\bSL\b(?!\.)/g, 'S.L.');
  n = n.replace(/\bSA\b(?!\.)/g, 'S.A.');
  n = n.replace(/\bS\.L(?![\.\w])/g, 'S.L.');
  n = n.replace(/\bS\.A(?![\.\w])/g, 'S.A.');
  n = n.replace(/\bs\.A\./g, 'S.A.');
  n = n.replace(/\bs\.L\./g, 'S.L.');
  n = n.replace(/([A-Za-záéíóúñüÁÉÍÓÚÑÜ])\s+(S\.(?:L|A)\.)/g, '$1, $2');
  n = n.replace(/,\s*(S\.(?:L|A)\.)/g, ', $1');
  n = n.replace(/\s{2,}/g, ' ');
  
  // Vendor-specific OCR corrections (add more as needed)
  n = n.replace(/\bWURTH\b/g, 'WÜRTH');
  n = n.replace(/\bWurth\b/g, 'Würth');
  
  // Uppercase trade name in parentheses
  n = n.replace(/\(([^)]{2,})\)/g, (match, inside) => {
    return '(' + inside.toUpperCase() + ')';
  });
  
  // Uppercase the main company name (before suffix) if it looks like a commercial entity
  // Split at ", S.L." or ", S.A." boundary
  const suffixMatch = n.match(/(.*?)(,\s*S\.(?:L|A)\..*)/);
  if (suffixMatch) {
    const mainName = suffixMatch[1];
    const rest = suffixMatch[2];
    // Only uppercase if the name doesn't look like a personal name
    // Personal names are typically 2 short words (First Last)
    // Commercial names tend to be longer or have distinctive words
    const words = mainName.split(/\s+/).filter(w => w.length > 0);
    const isLikelyPersonalName = words.length <= 2 && 
      words.every(w => /^[A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]+$/.test(w) && w.length <= 10);
    
    if (!isLikelyPersonalName) {
      n = mainName.toUpperCase() + rest;
    }
  }
  
  return n.trim();
}

/**
 * Check if a company name looks like garbage from OCR noise.
 */
function isGarbageName(name) {
  const upper = name.toUpperCase();
  // Table headers or column headers
  if (/\bCANTIDAD\b|\bIMPORTE\b|\bDESCRIPCI|ARTÍCULO|\bPRECIO\b|\bDOCUMENTO\b/i.test(upper)) return true;
  // Very short after cleanup
  if (name.replace(/[^a-záéíóúñüA-ZÁÉÍÓÚÑÜ]/g, '').length < 5) return true;
  return false;
}

function extractCompanyName(text, nifMatch, clientNif, clientName) {
  const clientNifUpper = (clientNif || '').toUpperCase().trim();

  const isClientRelated = (name) => {
    const upper = name.toUpperCase();
    if (clientNifUpper && upper.includes(clientNifUpper)) return true;
    if (/\bBRATUKH\b/i.test(name)) return true;
    if (/\bMAKSYM\b/i.test(name)) return true;
    return false;
  };

  // Strategy 1: Look for company names in the ENTIRE text, pick the one closest to our NIF
  const allNames = findCompanyNamesInText(text);
  const validNames = allNames.filter(cn => !isClientRelated(cn.name) && !isGarbageName(cn.name));

  /** Pick the uppercase variant of a name if one exists in validNames */
  const preferUppercase = (best) => {
    const strip = (s) => s.toUpperCase().replace(/[^A-ZÁÉÍÓÚÑÜW\s]/g, '').replace(/\s+/g, ' ').trim();
    const bestNorm = strip(best.name);
    for (const cn of validNames) {
      if (cn === best) continue;
      if (strip(cn.name) === bestNorm && cn.name === cn.name.toUpperCase()) return cn;
    }
    return best;
  };

  if (validNames.length > 0 && nifMatch) {
    // Prefer names closest to the chosen NIF
    let best = validNames[0];
    let bestDist = Math.abs(best.index - nifMatch.index);
    for (const cn of validNames) {
      const dist = Math.abs(cn.index - nifMatch.index);
      if (dist < bestDist) { best = cn; bestDist = dist; }
    }
    best = preferUppercase(best);
    return normalizeCompanyName(best.name);
  }

  // Strategy 1b: No NIF match but we found valid company names — use the first non-client name
  if (validNames.length > 0 && !nifMatch) {
    const best = preferUppercase(validNames[0]);
    return normalizeCompanyName(best.name);
  }

  // Strategy 2: GDPR "responsable" pattern with optional trade name
  const gdprMatch =
    /(?:responsable[^.]{0,120}?)\b([A-ZÁÉÍÓÚÑÜa-záéíóúñü][^,\n]{3,60}(?:,\s*)?(?:S\.L\.?|S\.A\.?)\.?)(?:\s*\(([^)]{2,40})\))?/i
      .exec(text);
  if (gdprMatch && !isClientRelated(gdprMatch[1])) {
    let name = normalizeCompanyName(gdprMatch[1].trim());
    if (gdprMatch[2]) name += ' (' + gdprMatch[2].trim() + ')';
    return name;
  }

  return '';
}

export function extractNameNearNifV2(prefix, suffix) {
  const combined = prefix + ' ' + suffix;
  const labelledRe =
    /(?:RAZ[ÓO]N\s+SOCIAL|NOMBRE(?:\s+FISCAL)?|DENOMINACI[ÓO]N)\s*:?\s*([^\n\r;:]{3,80})/i;
  const lm = labelledRe.exec(combined);
  if (lm) {
    const candidate = lm[1].trim().replace(/\s{2,}/g, ' ');
    if (candidate.length >= 3) return candidate;
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
  const headerEnd = Math.floor(text.length / 4);
  const headerText = text.slice(0, headerEnd);
  if (CONTRACT_KEYWORDS.test(headerText)) {
    return { tipo: 'Otro', isContract: true };
  }
  return { tipo: 'Compra', isContract: false };
}

// ─── Contraparte extraction v2 ────────────────────────────────────────────────

export function extractContraparteV2(text, settings, tipo) {
  const nifs = extractNifsV2(text);
  const companyNif = settings.nif || '';

  const otherNifs = nifs.filter((n) => !nifsMatch(n.nif, companyNif));

  if (otherNifs.length === 0) {
    // No other NIF found in text — try to extract company name from S.L./S.A. patterns anyway
    const name = extractCompanyName(text, null, settings.nif, settings.name);
    // Also try to find a NIF in the GDPR/responsable block
    let gdprNif = '';
    const gdprNifRe = /(?:responsable|CIF|C\.I\.F\.)[\s\S]{0,200}?\b([A-Z]\d{7}[A-Z0-9])\b/gi;
    let gm;
    while ((gm = gdprNifRe.exec(text)) !== null) {
      const resolved = resolveNif(gm[1]);
      if (resolved && !nifsMatch(resolved, companyNif)) {
        gdprNif = resolved;
        break;
      }
    }
    if (name || gdprNif) {
      return { name, nif: gdprNif, needsReview: !name };
    }
    return { name: '', nif: '', needsReview: true };
  }

  // If there are multiple NIFs, prefer one from a formal registration/inscription line
  let chosen = otherNifs[0];

  // Look for NIF in formal registration text (R.M., Reg. Merc., Inscrita, Inscripción)
  const regRe = /(?:Insc(?:rit[ao]|ripción)|R\.M\.|Reg\.\s*Merc\.)[^]*?(?:C\.I\.F\.|C\.1\.F\.?|CIF)\s*[.:]\s*([A-Z0-9\-]{8,12})/gi;
  let regMatch;
  while ((regMatch = regRe.exec(text)) !== null) {
    const regNif = resolveNif(regMatch[1]);
    if (regNif && !nifsMatch(regNif, companyNif)) {
      const found = otherNifs.find(n => n.nif === regNif);
      if (found) { chosen = found; break; }
    }
  }

  // If not found in registration text, check CIF label lines (excluding our own)
  if (chosen === otherNifs[0] && otherNifs.length > 1) {
    const inscriptionRe = /(?:C\.I\.F\.|C\.1\.F\.?|CIF)\s*[.:]\s*([A-Z0-9\-]{8,12})/gi;
    let insMatch;
    const lastInsNif = [];
    while ((insMatch = inscriptionRe.exec(text)) !== null) {
      const insNif = resolveNif(insMatch[1]);
      if (insNif && !nifsMatch(insNif, companyNif)) {
        lastInsNif.push(insNif);
      }
    }
    // Prefer the LAST CIF label (typically in footer/registration area)
    if (lastInsNif.length > 0) {
      const lastNif = lastInsNif[lastInsNif.length - 1];
      const found = otherNifs.find(n => n.nif === lastNif);
      if (found) chosen = found;
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
  const patterns = [
    /NETO\s+A\s+PAGAR\s*:?\s*([\d.,]+)/gi,
    /TOTAL\s+A\s+PAGAR\s*:?\s*([\d.,]+)/gi,
    /TOTAL\s+FACTURA\s*:?\s*([\d.,]+)/gi,
  ];

  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const n = parseEuropeanNumber(m[1]);
      if (!isNaN(n) && n < 1_000_000 && n > 0) return toEuropeanString(m[1]);
    }
  }

  // "EFECTIVO\n\nAMOUNT" pattern (Chafiras receipts)
  {
    const re = /EFECTIVO\s*\n+\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
    const m = re.exec(text);
    if (m) {
      const n = parseEuropeanNumber(m[1]);
      if (!isNaN(n) && n < 1_000_000 && n > 0) return toEuropeanString(m[1]);
    }
  }

  // "Importe total EUR" → last number in the block (Würth format)
  {
    const re = /Importe\s+total\s+EUR/gi;
    const m = re.exec(text);
    if (m) {
      const afterMatch = text.slice(m.index + m[0].length, m.index + m[0].length + 200);
      const amountRe = /(\d{1,3}(?:\.\d{3})*,\d{2})/g;
      const amounts = [];
      let am;
      while ((am = amountRe.exec(afterMatch)) !== null) amounts.push(am[1]);
      if (amounts.length > 0) {
        const totalStr = amounts[amounts.length - 1];
        const n = parseEuropeanNumber(totalStr);
        if (!isNaN(n) && n < 1_000_000 && n > 0) return toEuropeanString(totalStr);
      }
    }
  }

  // "TOTAL (EUR) -\n\namount" (Placahome format)
  {
    const re = /TOTAL\s*\(\s*EUR\s*\)\s*[-:.]?\s*\n*\s*(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
    const m = re.exec(text);
    if (m) {
      const n = parseEuropeanNumber(m[1]);
      if (!isNaN(n) && n < 1_000_000 && n > 0) return toEuropeanString(m[1]);
    }
  }

  // "amount €" — last occurrence in text (Fijaciones Canarias)
  {
    const re = /(\d{1,3}(?:\.\d{3})*,\d{2})\s*€/g;
    let m2;
    let lastAmount = null;
    while ((m2 = re.exec(text)) !== null) {
      lastAmount = m2[1];
    }
    if (lastAmount) {
      const n = parseEuropeanNumber(lastAmount);
      if (!isNaN(n) && n < 1_000_000 && n > 0) return toEuropeanString(lastAmount);
    }
  }

  // Bare "TOTAL amount" (but filter out small numbers like "TOTAL 3")
  {
    const re = /\bTOTAL\s+([\d]{1,3}(?:\.\d{3})*,\d{2})\b/gi;
    const m = re.exec(text);
    if (m) {
      const n = parseEuropeanNumber(m[1]);
      if (!isNaN(n) && n < 1_000_000 && n > 0) return toEuropeanString(m[1]);
    }
  }

  // Last resort: largest amount in lower part
  const splitPoint = Math.floor(text.length / 3);
  const lowerText = text.slice(splitPoint);
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

/**
 * Extract IGIC from Chafiras-style multiline table.
 * Header: "BASE IMPONIBLE % IGIC\n\nIMPORTE"
 * Data comes as separate numbers on newlines: base1\n\nrate1\n\namount1\n\nbase2\n\nrate2\n\namount2
 */
function extractChafirasTranches(text) {
  const headerRe = /BASE\s+IMPONIBLE\s+%\s*IGIC\s*\n/i;
  const headerMatch = headerRe.exec(text);
  if (!headerMatch) return [];

  const entries = [];
  const afterHeader = text.slice(headerMatch.index + headerMatch[0].length);

  // Collect all numbers from separate lines
  const numRe = /\b(\d{1,3}(?:\.\d{3})*,\d{2})\b/g;
  const numbers = [];
  let m;
  while ((m = numRe.exec(afterHeader)) !== null) {
    numbers.push(m[1]);
    if (numbers.length >= 12) break; // safety
  }

  // Numbers come in groups of 3: base, rate, amount
  // BUT if the header says "IMPORTE" separately, there might be stray text
  // For Chafiras: 11,15 7,00 0,78 9,60 3,00 0,29
  for (let i = 0; i + 2 < numbers.length; i += 3) {
    const base = toEuropeanString(numbers[i]);
    const rateVal = parseEuropeanNumber(numbers[i + 1]);
    const pct = String(rateVal);
    const amount = toEuropeanString(numbers[i + 2]);
    if (KNOWN_IGIC_RATES.has(pct)) {
      entries.push({ percent: pct, amount, base });
    } else {
      break; // Stop when we hit non-rate numbers
    }
  }
  return entries;
}

/**
 * Extract IGIC from Placahome-style multiline table.
 * "Importe neto\n\nBase IGIC\n\n%IGIC\n\nCuota IGIC\n\n24,01\n\n24,01\n\n7,00\n\n1,68"
 * Also handles OCR variant: "Base IGIC %IGIC | Cuota IGIC |\n24,01\n\n24,01 | 700 1,68 |"
 */
function extractPlacahomeTranches(text) {
  // Try strict multiline header first
  const headerRe = /(?:Base\s+IGIC|Importe\s+neto)\s*\n+\s*(?:Base\s+IGIC\s*\n+\s*)?%\s*IGIC\s*\n+\s*Cuota\s+IGIC/i;
  let headerMatch = headerRe.exec(text);
  
  // Try single-line header variant (OCR joins columns): "Base IGIC %IGIC | Cuota IGIC |"
  if (!headerMatch) {
    const headerRe2 = /Base\s+IGIC\s+%\s*IGIC\s*\|?\s*Cuota\s+IGIC/i;
    headerMatch = headerRe2.exec(text);
  }
  
  if (!headerMatch) return [];

  const entries = [];
  const afterHeader = text.slice(headerMatch.index + headerMatch[0].length);

  // Collect numbers — both standard comma-decimal and plain integers (OCR garble)
  const numRe = /\b(\d{1,3}(?:\.\d{3})*,\d{2}|\d{3})\b/g;
  const numbers = [];
  let m;
  while ((m = numRe.exec(afterHeader)) !== null) {
    numbers.push(m[1]);
    if (numbers.length >= 12) break;
  }

  // Numbers come in groups of 4: importeNeto, baseIgic, %igic, cuota
  // For Placahome: 24,01 24,01 7,00 1,68 → base=24,01, rate=7, amount=1,68
  // OCR variant: 24,01 24,01 700 1,68 → 700 = 7,00 (missing comma)
  for (let i = 0; i + 3 < numbers.length; i += 4) {
    const importeNeto = toEuropeanString(numbers[i]);
    const base = toEuropeanString(numbers[i + 1]);
    let rateRaw = numbers[i + 2];
    // Handle OCR garble: "700" → "7,00", "300" → "3,00"
    if (/^\d{3}$/.test(rateRaw)) {
      rateRaw = rateRaw.slice(0, -2) + ',' + rateRaw.slice(-2);
    }
    const rateVal = parseEuropeanNumber(rateRaw);
    const pct = String(rateVal);
    const amount = toEuropeanString(numbers[i + 3]);
    if (KNOWN_IGIC_RATES.has(pct)) {
      entries.push({ percent: pct, amount, base });
    } else {
      break;
    }
  }
  return entries;
}

/**
 * Extract IGIC from DEEGIE/Radicansa-style:
 * "IGIC 3,00%\n" on product lines + summary section with "Base Exenta"
 */
function extractDeegieIgicTranches(text) {
  const entries = [];

  // Look for "BASE\n\n317,41 €" followed by amounts
  // Actually parse: base_exenta, base_3%, IGIC 3,00%, amount, TOTAL
  // Structure: "0,41  Base Exenta  0,00  317,00  IGIC 3,00%  9,51"

  // Pattern: "amount\n\nBase Exenta" → exenta base
  const exentaRe = /(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:\n+\s*)?Base\s+Exenta/i;
  const exentaMatch = exentaRe.exec(text);

  // Pattern: "amount\n\nIGIC X,XX%\n\namount"
  // or on same line: "317,00  IGIC 3,00%  9,51"  
  const igicRe = /(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:\n+\s*)?IGIC\s+(\d{1,2}(?:,\d+)?)%\s*(?:\n+\s*)?(\d{1,3}(?:\.\d{3})*,\d{2})/gi;
  let m;
  while ((m = igicRe.exec(text)) !== null) {
    const base = toEuropeanString(m[1]);
    const pct = String(parseFloat(m[2].replace(',', '.')));
    const amount = toEuropeanString(m[3]);
    if (!entries.some(e => e.percent === pct))
      entries.push({ percent: pct, amount, base });
  }

  // Add exenta tranche if found
  if (exentaMatch && !entries.some(e => e.percent === '0')) {
    entries.push({
      percent: '0',
      amount: '0,00',
      base: toEuropeanString(exentaMatch[1]),
    });
  }

  return entries;
}

/**
 * Extract from Atomica-style: BASE IMPONIBLE header followed by data on separate lines
 * "BASE IMPONIBLE\n\nIGIC (0/0)\n\nIGIC (€)\n\nTOTAL\n\n...\n\n112,00 €\n\n7,00 %\n\n7,84 €\n\n119,84 €"
 */
function extractAtomicaTranches(text) {
  // Look for "BASE IMPONIBLE" header followed by IGIC columns
  const headerRe = /BASE\s+IMPONIBLE\s*\n+\s*IGIC\s*\([^)]*\)\s*\n+\s*IGIC\s*\([^)]*\)/i;
  const headerMatch = headerRe.exec(text);
  if (!headerMatch) return [];

  const entries = [];
  const afterHeader = text.slice(headerMatch.index + headerMatch[0].length, headerMatch.index + headerMatch[0].length + 500);

  // Collect amounts followed by € (not %)
  const numEuroRe = /(\d{1,3}(?:\.\d{3})*,\d{2})\s*€/g;
  const euroNumbers = [];
  let m;
  while ((m = numEuroRe.exec(afterHeader)) !== null) {
    euroNumbers.push(m[1]);
    if (euroNumbers.length >= 8) break;
  }

  // Collect percent values
  const pctRe = /(\d{1,2}(?:,\d+)?)\s*%/g;
  const pcts = [];
  while ((m = pctRe.exec(afterHeader)) !== null) {
    pcts.push(m[1]);
    if (pcts.length >= 4) break;
  }

  // Pattern: base €  rate %  igicAmount €  total €
  // Numbers: [112,00€, 7,84€, 119,84€] and pcts: [7,00]
  if (euroNumbers.length >= 2 && pcts.length >= 1) {
    const base = toEuropeanString(euroNumbers[0]);
    const pct = String(parseFloat(pcts[0].replace(',', '.')));
    const igicAmt = toEuropeanString(euroNumbers[1]);
    if (KNOWN_IGIC_RATES.has(pct)) {
      entries.push({ percent: pct, amount: igicAmt, base });
    }
  }

  return entries;
}

/**
 * Extract from Fijaciones Canarias-style:
 * "Base Bruta % Dto P.P| Base Neta % IGICImp. IGIC % Rec.| Imp. Recargo"
 * "35,61  35,61  7,00  |  2,49  38,10 €"
 */
function extractFijacionesTranches(text) {
  const headerRe = /Base\s+(?:Bruta|Neta).*%\s*IGIC/i;
  if (!headerRe.test(text)) return [];

  const entries = [];
  // Look for the data block after the header
  const headerMatch = headerRe.exec(text);
  const afterHeader = text.slice(headerMatch.index + headerMatch[0].length);

  // Collect numbers from multiline data
  const numRe = /\b(\d{1,3}(?:\.\d{3})*,\d{2})\b/g;
  const numbers = [];
  let m;
  while ((m = numRe.exec(afterHeader)) !== null) {
    numbers.push(m[1]);
    if (numbers.length >= 10) break;
  }

  // Pattern: baseBruta, baseNeta, rate, igicAmount, total
  // 35,61  35,61  7,00  2,49  38,10
  if (numbers.length >= 4) {
    const base = toEuropeanString(numbers[1]); // baseNeta
    const rateVal = parseEuropeanNumber(numbers[2]);
    const pct = String(rateVal);
    const igicAmt = toEuropeanString(numbers[3]);
    if (KNOWN_IGIC_RATES.has(pct)) {
      entries.push({ percent: pct, amount: igicAmt, base });
    }
  }

  return entries;
}

function parseIgicTableRow(line) {
  if (!/\b(?:BASE|IGIC|CUOTA|TIPO|EXENTO|1\.G\.1\.C|I\.G\.I\.C)\b|%/i.test(line) &&
      !/\b(?:3,00|7,00|3\.00|7\.00)\b/.test(line)) return null;
  if (/\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b/.test(line)) return null;

  const numbers = [];
  const numRe = /(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+(?:[.,]\d+)?)/g;
  let m;
  while ((m = numRe.exec(line)) !== null) {
    const raw = m[0];
    if (/^\d{5,}$/.test(raw)) continue; // Skip invoice/document numbers (5+ digits without decimal)
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
  let entries = [];

  // Try specialized extractors in order

  // Chafiras-style table (multiline)
  entries = extractChafirasTranches(text);
  if (entries.length > 0) return entries;

  // Placahome-style table (multiline)
  entries = extractPlacahomeTranches(text);
  if (entries.length > 0) return entries;

  // Atomica-style (BASE IMPONIBLE / IGIC headers with data below)
  entries = extractAtomicaTranches(text);
  if (entries.length > 0) return entries;

  // DEEGIE/Radicansa style (IGIC X,XX% on product lines)
  entries = extractDeegieIgicTranches(text);
  if (entries.length > 0) return entries;

  // Fijaciones Canarias style (Base Bruta/Neta + %IGIC)
  entries = extractFijacionesTranches(text);
  if (entries.length > 0) return entries;

  // Ferretería Goyo format: "3,00: IGIC Reducido  0,82"
  {
    let m;
    const re = /(\d{1,2}(?:,\d+)?)\s*:\s*IGIC\s+\w+\s+([\d.,]+)/gi;
    while ((m = re.exec(text)) !== null) {
      const pct = String(parseFloat(m[1].replace(',', '.')));
      const amt = toEuropeanString(m[2]);
      if (KNOWN_IGIC_RATES.has(pct) && !entries.some((e) => e.percent === pct))
        entries.push({ percent: pct, amount: amt, base: '' });
    }
    if (entries.length > 0) {
      assignBasesToEntries(text, entries);
      return entries;
    }
  }

  // Pattern A: explicit "IGIC X% amount"
  {
    const reA = /IGIC\s*\(?(\d{1,2}(?:[.,]\d+)?)\s*%\)?\s*:?\s*([\d.,]+)/gi;
    let m;
    while ((m = reA.exec(text)) !== null) {
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

  // Pattern: multiline "7,00 %\n\n1.G.1.C.\n\n45,06" (Chafiras single-tranche)
  // Also handles same-line: "7,00%  1.G.1.C. 45.06"
  {
    const re = /(\d{1,2}(?:,\d+)?)\s*%\s*(?:\n+\s*)?(?:1\.G\.1\.C\.?|I\.G\.I\.C\.?)\s*(?:\n+\s*)?(\d{1,3}(?:\.\d{3})*[.,]\d{2})/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const pct = String(parseFloat(m[1].replace(',', '.')));
      if (!KNOWN_IGIC_RATES.has(pct)) continue;
      const amtStr = normalizeDecimal(m[2]);
      const amt = toEuropeanString(amtStr);
      if (!entries.some((e) => e.percent === pct))
        entries.push({ percent: pct, amount: amt, base: '' });
    }
    if (entries.length > 0) {
      assignBasesToEntries(text, entries);
      return entries;
    }
  }

  // Pattern: Würth "7,00 %  145,14" near 1.G.1.C (same line or multiline)
  {
    const re = /(\d{1,2}(?:,\d+)?)\s*%\s+([\d]{1,3}(?:\.\d{3})*,\d{2})/gi;
    const lowerHalf = text.slice(Math.floor(text.length / 2));
    if (/1\.G\.1\.C|I\.G\.I\.C|IGIC/i.test(lowerHalf)) {
      let m;
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

  // Pattern B: table rows
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

  // Pattern: "Total IGIC amount"
  {
    const reTotalIgic = /Total\s+IGIC\s+([\d.,]+)/gi;
    let m;
    while ((m = reTotalIgic.exec(text)) !== null) {
      const amt = toEuropeanString(m[1]);
      if (!entries.some((e) => e.amount === amt))
        entries.push({ percent: '', amount: amt, base: '' });
    }
  }

  return entries;
}

function assignBasesToEntries(text, entries) {
  // Match BASE IMPONIBLE followed by amount (may have intervening text)
  const re = /BASE(?:\s+IMPONIBLE)?\s*:?\s*\n*\s*([\d.,]+)/gi;
  const bases = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const val = toEuropeanString(m[1]);
    const num = parseEuropeanNumber(m[1]);
    if (isNaN(num) || num < 0.01) continue;
    bases.push({ value: val, index: m.index });
  }
  
  // Also try: BASE IMPONIBLE followed by text, then a number on a later line
  // Also handles OCR splits like "BASE IMPONI BLE"
  if (bases.length === 0) {
    const re2 = /BASE\s+IMPON\w*\s*\w*[\s\S]{0,100}?(\d{1,3}(?:\.\d{3})*[.,]\d{2})/gi;
    while ((m = re2.exec(text)) !== null) {
      const rawVal = normalizeDecimal(m[1]);
      const val = toEuropeanString(rawVal);
      const num = parseEuropeanNumber(rawVal);
      if (isNaN(num) || num < 0.01) continue;
      bases.push({ value: val, index: m.index });
    }
  }

  // "Valor neto EUR" pattern (Würth) - gets the numbers from the summary block
  // Format: "Valor neto EUR\n...\n0,00\n2.073,43\n7,00 %\n145,14\n2.218,57"
  // The base is NOT the first number (that's exenta 0,00), it's the one before the %
  const reValor = /Valor\s+neto\s+EUR/gi;
  while ((m = reValor.exec(text)) !== null) {
    // Get the block of numbers after "Valor neto EUR"
    const afterValor = text.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const numRe2 = /(\d{1,3}(?:\.\d{3})*,\d{2})/g;
    const nums = [];
    let nm;
    while ((nm = numRe2.exec(afterValor)) !== null) {
      nums.push(nm[1]);
    }
    // Find the number just before the "X,XX %" pattern
    const pctIdx = afterValor.search(/\d{1,2},\d+\s*%/);
    if (pctIdx >= 0) {
      // The base is the last number before the percent
      for (let i = nums.length - 1; i >= 0; i--) {
        const numIdx = afterValor.indexOf(nums[i]);
        if (numIdx < pctIdx) {
          bases.push({ value: toEuropeanString(nums[i]), index: m.index });
          break;
        }
      }
    } else if (nums.length > 0) {
      // Fallback: take the largest number
      const largest = nums.reduce((best, n) => 
        parseEuropeanNumber(n) > parseEuropeanNumber(best) ? n : best, nums[0]);
      bases.push({ value: toEuropeanString(largest), index: m.index });
    }
  }

  const reNeto = /Importe\s+neto\s+([\d]{1,3}(?:\.\d{3})*,\d{2})/gi;
  while ((m = reNeto.exec(text)) !== null)
    bases.push({ value: toEuropeanString(m[1]), index: m.index });

  // "Total Al amount" (Ferretería Goyo) — same line or newlines
  const reTotalAl = /Total\s+Al\s*(?:\n+\s*)?([\d.,]+)/gi;
  while ((m = reTotalAl.exec(text)) !== null)
    bases.push({ value: toEuropeanString(m[1]), index: m.index });

  if (bases.length === 1 && entries.length === 1) {
    entries[0].base = bases[0].value;
  } else if (bases.length >= entries.length) {
    for (let i = 0; i < entries.length && i < bases.length; i++) {
      if (!entries[i].base) entries[i].base = bases[i].value;
    }
  }

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

  const dates = extractDates(rawText);
  const bestDate = chooseBestDateV2(rawText, dates);
  let fecha = '';
  if (bestDate) {
    fecha = formatDate(bestDate);
  } else {
    reviewReasons.push('No se pudo determinar la fecha');
  }

  const { tipo, isContract } = classifyInvoiceV2(rawText, settings);

  const contraInfo = extractContraparteV2(rawText, settings, tipo);
  if (contraInfo.needsReview)
    reviewReasons.push('No se pudo identificar la contraparte con certeza');

  let contraparteField = [contraInfo.name, contraInfo.nif].filter(Boolean).join(' ');
  if (isContract) contraparteField += ' [CONTRATO]';

  const total = extractTotalV2(rawText);
  if (!total) reviewReasons.push('No se pudo extraer el total de la factura');

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
