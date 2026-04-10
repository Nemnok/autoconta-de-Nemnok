#!/usr/bin/env node
/**
 * evaluate.mjs — Parser v2.0 evaluation harness
 *
 * Compares the output of parseInvoiceV2 against the ground-truth file
 * src/TESTS/TEST1 using OCR-text fixtures stored alongside the PDFs.
 *
 * Usage
 * ─────
 *   node src/TESTS/evaluate.mjs [options]
 *
 * Options
 * ───────
 *   --gt  <path>   Path to ground-truth file (default: src/TESTS/TEST1)
 *   --nif <nif>    Your company NIF (used to exclude it from contraparte)
 *   --name <name>  Your company name (used in classification)
 *   --verbose      Print every row, including exact matches
 *
 * Ground-truth format (semicolon-delimited, one line per invoice page):
 *   Fecha;Tipo;Contraparte;TOTAL;IGIC%;IGIC;Base
 *   28/01/2026;Compra;FERRETERÍA GOYO E HIJOS, S.L. (NIF B38627774);28,22;3;0,82;27,40
 *
 * OCR text fixtures
 * ─────────────────
 * Place the raw OCR text for each PDF page beside the PDF in src/TESTS/:
 *
 *   src/TESTS/INFO_000212.p1.ocr.txt   ← OCR text for page 1 of INFO_000212.pdf
 *   src/TESTS/INFO_000212.p2.ocr.txt   ← OCR text for page 2, etc.
 *
 * Each fixture file contains exactly the text that Tesseract.js returns when
 * processing that PDF page in the browser.  To obtain the text:
 *   1. Open the application in a browser.
 *   2. Upload the PDF.
 *   3. Click "Texto" next to the processed row to reveal the raw OCR text.
 *   4. Copy the text and save it to the corresponding .ocr.txt file.
 *
 * Fixture-to-GT mapping
 * ─────────────────────
 * The script discovers all *.ocr.txt files in the same directory as the GT
 * file, sorts them (INFO_000212 before INFO_000211 by alphabetical order of
 * the filename), and maps them in order against GT rows.
 *
 * Override the ordering by naming your fixtures with a numeric prefix:
 *   01_INFO_000212.p1.ocr.txt
 *   02_INFO_000212.p2.ocr.txt
 *   …
 *
 * If no fixtures are found the script prints instructions and exits.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

// ─── CLI argument parsing ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
let gtPath = join(__dir, 'TEST1');
let myNif = '';
let myName = '';
let verbose = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--gt' && args[i + 1]) { gtPath = args[++i]; continue; }
  if (args[i] === '--nif' && args[i + 1]) { myNif = args[++i]; continue; }
  if (args[i] === '--name' && args[i + 1]) { myName = args[++i]; continue; }
  if (args[i] === '--verbose') { verbose = true; continue; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FIELDS = ['fecha', 'tipo', 'contraparte', 'total', 'igicPercent', 'igicAmount', 'base'];
const HEADERS = ['Fecha', 'Tipo', 'Contraparte', 'TOTAL', 'IGIC%', 'IGIC', 'Base'];

/**
 * Parse a single GT/CSV row into a structured object.
 * @param {string} line
 * @returns {Record<string, string>}
 */
function parseGtRow(line) {
  const parts = line.split(';');
  return {
    fecha: parts[0]?.trim() ?? '',
    tipo: parts[1]?.trim() ?? '',
    contraparte: parts[2]?.trim() ?? '',
    total: parts[3]?.trim() ?? '',
    igicPercent: parts[4]?.trim() ?? '',
    igicAmount: parts[5]?.trim() ?? '',
    base: parts[6]?.trim() ?? '',
  };
}

/**
 * Normalise a field value for comparison (trim, collapse whitespace).
 * @param {string} v
 * @returns {string}
 */
function norm(v) {
  return (v ?? '').trim().replace(/\s{2,}/g, ' ');
}

/**
 * Normalise a Contraparte field for comparison.
 * Strips the "(NIF XXXX)" wrapper so "Name (NIF B38627774)" and
 * "Name B38627774" are treated as equal.
 * @param {string} s
 * @returns {string}
 */
function normalizeContraparte(s) {
  return norm(s)
    .replace(/\(\s*NIF\s+([A-Z0-9]+)\s*\)/gi, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Compare two field values, returning true when they are considered equal.
 * Pipe-separated multi-tranche fields are compared as sets.
 * @param {string} expected
 * @param {string} actual
 * @param {string} field
 * @returns {boolean}
 */
function fieldEqual(expected, actual, field) {
  const e = field === 'contraparte' ? normalizeContraparte(expected) : norm(expected);
  const a = field === 'contraparte' ? normalizeContraparte(actual) : norm(actual);
  if (e === a) return true;
  // Pipe-separated: compare as sets regardless of order
  if (e.includes('|') || a.includes('|')) {
    const eSet = new Set(e.split('|').map(norm));
    const aSet = new Set(a.split('|').map(norm));
    if (eSet.size !== aSet.size) return false;
    for (const v of eSet) if (!aSet.has(v)) return false;
    return true;
  }
  return false;
}

// ─── Load parseInvoiceV2 ──────────────────────────────────────────────────────

// Resolve path relative to evaluate.mjs location
const parserPath = resolve(__dir, '..', 'parseInvoiceV2.js');

let parseInvoice;
try {
  const mod = await import(parserPath);
  parseInvoice = mod.parseInvoice;
  if (typeof parseInvoice !== 'function') throw new Error('parseInvoice not found');
} catch (err) {
  console.error(`\nFailed to load parseInvoiceV2.js: ${err.message}`);
  console.error(`Expected at: ${parserPath}`);
  process.exit(1);
}

// ─── Load ground truth ────────────────────────────────────────────────────────

if (!existsSync(gtPath)) {
  console.error(`\nGround-truth file not found: ${gtPath}`);
  process.exit(1);
}

const gtLines = readFileSync(gtPath, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);

if (gtLines.length === 0) {
  console.error('\nGround-truth file is empty.');
  process.exit(1);
}

const gtRows = gtLines.map(parseGtRow);
console.log(`\nLoaded ${gtRows.length} ground-truth rows from ${basename(gtPath)}`);

// ─── Discover OCR fixtures ────────────────────────────────────────────────────

const fixtureDir = dirname(resolve(gtPath));
const allFiles = readdirSync(fixtureDir).sort();
const fixtures = allFiles.filter((f) => f.endsWith('.ocr.txt'));

if (fixtures.length === 0) {
  console.log(`
No OCR text fixtures found in ${fixtureDir}.

To add training examples:
  1. Open the app in a browser and upload a PDF.
  2. Click "Texto" in the invoice row to view the raw OCR text.
  3. Copy the text and save it to:
       src/TESTS/<filename>.p<N>.ocr.txt
     e.g.  src/TESTS/INFO_000212.p1.ocr.txt
  4. Re-run this script.

See README.md → "How to add training examples" for full instructions.
`);
  process.exit(0);
}

console.log(`Found ${fixtures.length} OCR fixture(s): ${fixtures.join(', ')}`);

if (fixtures.length !== gtRows.length) {
  console.warn(
    `\nWarning: fixture count (${fixtures.length}) does not match GT row count (${gtRows.length}).`,
  );
  console.warn('Only the first min(fixtures, GT) pairs will be evaluated.\n');
}

// ─── Run evaluation ───────────────────────────────────────────────────────────

const settings = { name: myName, nif: myNif };
const pairCount = Math.min(fixtures.length, gtRows.length);

let totalFields = 0;
let matchedFields = 0;
let perfectRows = 0;

console.log('\n' + '═'.repeat(72));

for (let i = 0; i < pairCount; i++) {
  const fixtureName = fixtures[i];
  const fixturePath = join(fixtureDir, fixtureName);
  const rawText = readFileSync(fixturePath, 'utf8');
  const expected = gtRows[i];

  const parsed = parseInvoice(rawText, fixtureName, settings);
  const actual = {
    fecha: parsed.fecha,
    tipo: parsed.tipo,
    contraparte: parsed.contraparte,
    total: parsed.total,
    igicPercent: parsed.igicPercent,
    igicAmount: parsed.igicAmount,
    base: parsed.base,
  };

  const mismatches = [];
  let rowMatched = true;

  for (const field of FIELDS) {
    const eq = fieldEqual(expected[field], actual[field], field);
    totalFields++;
    if (eq) {
      matchedFields++;
    } else {
      rowMatched = false;
      mismatches.push({ field, expected: expected[field], actual: actual[field] });
    }
  }

  if (rowMatched) perfectRows++;

  if (!rowMatched || verbose) {
    const icon = rowMatched ? '✅' : '❌';
    console.log(`\n${icon} Row ${i + 1}  fixture: ${fixtureName}`);
    if (mismatches.length > 0) {
      const colW = 15;
      console.log(
        '  ' +
          'Field'.padEnd(colW) +
          'Expected'.padEnd(35) +
          'Actual',
      );
      console.log('  ' + '─'.repeat(colW + 70));
      for (const mm of mismatches) {
        const header = HEADERS[FIELDS.indexOf(mm.field)];
        console.log(
          '  ' +
            header.padEnd(colW) +
            norm(mm.expected).slice(0, 33).padEnd(35) +
            norm(mm.actual).slice(0, 33),
        );
      }
    }
    if (parsed.reviewReasons.length > 0) {
      console.log(`  ⚠  Review flags: ${parsed.reviewReasons.join(' | ')}`);
    }
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(72));
const fieldPct = totalFields > 0
  ? ((matchedFields / totalFields) * 100).toFixed(1)
  : '0.0';
const rowPct = pairCount > 0
  ? ((perfectRows / pairCount) * 100).toFixed(1)
  : '0.0';

console.log(`\nSummary (${pairCount} invoice(s) evaluated)`);
console.log(`  Perfect rows : ${perfectRows}/${pairCount}  (${rowPct}%)`);
console.log(`  Field accuracy: ${matchedFields}/${totalFields}  (${fieldPct}%)`);
console.log('');

process.exit(perfectRows === pairCount ? 0 : 1);
