# Autoconta — OCR Invoice Extractor

A fully **client-side** web application for extracting structured data from invoices (PDFs and images) and exporting it as CSV. No server, no backend, no data ever leaves your device.

## Features

- Upload PDF invoices or images (JPG, PNG, TIFF, WebP).
- Extract embedded text from digital PDFs using **PDF.js**.
- Fall back to **Tesseract.js OCR** for scanned PDFs and images (runs in a Web Worker).
- Classify each invoice as **Compra / Venta / Otro** based on your company's NIF/name.
- Detect contracts (`contrato`, `compraventa`) and mark them with `[CONTRATO]`.
- Detect non-EUR currencies and append `[MONEDA: USD]` / `[MONEDA: NON-EUR]`.
- Extract IGIC percentages, amounts, and taxable bases (pipe-separated for multiple rates).
- Export to **semicolon-delimited CSV** with European number formatting.

## CSV Column Order

| Column | Description |
|---|---|
| Fecha | Latest date found in the invoice (DD/MM/YYYY) |
| Tipo | Compra / Venta / Otro |
| Contraparte | Counterparty name + NIF + markers |
| TOTAL factura | Invoice total (European format) |
| IGIC% | IGIC rate(s), pipe-separated if multiple |
| IGIC | IGIC tax amount(s), pipe-separated |
| Base | Taxable base(s), pipe-separated |

## Usage

### Development

```bash
npm install
npm run dev
```

Open <http://localhost:5173>.

### Production build

```bash
npm run build
# Output is in dist/
npm run preview   # preview the built app locally
```

### Tests

```bash
npm test
```

## Project Structure

```
src/
  types.ts          – TypeScript interfaces for all domain types
  pdfTextExtract.ts – PDF.js text extraction + canvas rendering fallback
  ocr.ts            – Tesseract.js OCR wrapper (shared worker)
  parseInvoice.ts   – All regex/heuristics: dates, NIFs, IGIC, totals, classification
  formatCsv.ts      – CSV serialisation and download helpers
  main.ts           – SPA UI orchestration
  styles.css        – Dark-themed UI styles
tests/
  parseInvoice.test.ts – Unit tests for parsers
  formatCsv.test.ts    – Unit tests for CSV formatters
index.html          – SPA shell
```

## Settings

Click **⚙ Configuración** in the header to enter your company's:
- **Razón social** — used to detect whether your company is issuer or recipient.
- **NIF / CIF** — the primary identifier for Compra/Venta classification.

Settings are saved in `localStorage`.

## Business Rules

### Invoice type

- If OCR text contains `compraventa` or `contrato` (case-insensitive) → **Otro** + `[CONTRATO]` marker appended to Contraparte field.
- If company NIF/name found near `EMISOR / VENDEDOR / PROVEEDOR` labels → **Venta**.
- If company NIF/name found near `CLIENTE / DESTINATARIO / COMPRADOR` labels → **Compra**.
- Otherwise → **Otro** (flagged for review).

### Date

All dates in the document are extracted; the **latest** is used. Output format: `DD/MM/YYYY`. If no date can be parsed, the field is left empty and the invoice is flagged for review.

### Contraparte

The counterparty is always the *other* party (not your company):
- For **Venta**: the client/recipient.
- For **Compra**: the supplier/issuer.
- Format: `Name NIF [CONTRATO?] [MONEDA?]`

### Currency

- `USD` detected → append `[MONEDA: USD]` to Contraparte.
- Other non-EUR currency detected → append `[MONEDA: NON-EUR]`.
- No currency conversion is performed.

### IGIC (Canary Islands Tax)

Multiple IGIC tranches are supported. Percentages, amounts, and bases are stored pipe-separated: e.g. `3|7` for IGIC%, `3,00|7,00` for amounts.

## How to add training examples

Training examples let you verify parser accuracy and iterate on the heuristics.
No Node OCR is required — you capture the raw text from the browser and save it
as a plain-text fixture.

### Step 1 — Capture OCR text from the browser

1. Open the application in a browser and upload the PDF you want to evaluate.
2. Wait for OCR to finish (the spinner stops and the row shows ✅ or ⚠️).
3. Click **"Texto"** in the row to expand the raw OCR text panel.
4. Select all text in the panel and copy it.

### Step 2 — Save the fixture

Save the copied text to `src/TESTS/` using the naming convention:

```
src/TESTS/<PDF_BASENAME>.p<PAGE_NUMBER>.ocr.txt
```

Examples:

```
src/TESTS/INFO_000212.p1.ocr.txt   ← page 1 of INFO_000212.pdf
src/TESTS/INFO_000212.p2.ocr.txt   ← page 2
src/TESTS/INFO_000211.p1.ocr.txt   ← page 1 of INFO_000211.pdf
```

### Step 3 — Add the expected output to the ground-truth file

Open `src/TESTS/TEST1` and add (or verify) a line for each fixture in the same
order as the fixtures will be sorted alphabetically:

```
Fecha;Tipo;Contraparte;TOTAL;IGIC%;IGIC;Base
28/01/2026;Compra;FERRETERÍA GOYO E HIJOS, S.L. (NIF B38627774);28,22;3;0,82;27,40
```

Field rules:
- **Fecha** — `DD/MM/YYYY` (latest date on the invoice)
- **Tipo** — `Compra`, `Venta`, or `Otro`
- **Contraparte** — `Company Name NIF` (space-separated); alias in
  parentheses is fine: `DEEGIE CANARIAS, S.L. (RADICANSA) B38461463`
- **IGIC%**, **IGIC**, **Base** — pipe-separated for multiple rates:
  `3|7`, `9,51|45,06`, `317,00|643,69`

### Step 4 — Run the evaluation script

```bash
node src/TESTS/evaluate.mjs
# With your company NIF to exclude it from contraparte detection:
node src/TESTS/evaluate.mjs --nif B12345678 --name "MI EMPRESA, S.L."
# Show all rows (not just mismatches):
node src/TESTS/evaluate.mjs --verbose
```

The script prints a field-by-field mismatch report and an overall accuracy
summary. Exit code 0 means all rows matched perfectly.

### Fixture ordering vs. ground-truth ordering

Fixtures are sorted alphabetically. The ground truth (`TEST1`) must list rows in
the **same alphabetical order** as the fixture files. The current convention is:

- `INFO_000212` fixtures (and their GT rows) come **first**
- `INFO_000211` fixtures (and their GT rows) come **after**

This matches the alphabetical sort order where `INFO_000212` sorts after `INFO_000211`
(since the differing character `2` > `1`).  So fixtures from `INFO_000212` appear
**before** those from `INFO_000211` alphabetically, which is why the GT rows are in
the same order.

## Limitations

- OCR accuracy depends on image quality. Blurry or low-resolution scans may produce poor results.
- Name extraction near NIFs is heuristic and may require manual review.
- IGIC extraction assumes text follows common Spanish invoice patterns; unusual formats may not be captured.
- Currency detection is keyword/symbol based; amounts are not converted.
- Tesseract language data (spa + eng) is bundled in the repository under `vendor/tessdata/`.

## Browser Support

Modern browsers with ES2020+ support: Chrome 90+, Firefox 90+, Edge 90+, Safari 15+.

## Vendored Dependencies

All dependencies are vendored inside the repository under `vendor/` — no external CDNs are required.
The application works fully offline once the GitHub Pages site is loaded.

| Path | Package | Version |
|---|---|---|
| `vendor/tesseract/tesseract.esm.min.js` | tesseract.js | 5.1.0 |
| `vendor/tesseract/worker.min.js` | tesseract.js | 5.1.0 |
| `vendor/tesseract/tesseract-core-simd-lstm.wasm.js` | tesseract.js-core | 5.1.0 |
| `vendor/tessdata/eng.traineddata.gz` | @tesseract.js-data/eng | 4.0.0_best_int |
| `vendor/tessdata/spa.traineddata.gz` | @tesseract.js-data/spa | 4.0.0_best_int |
| `vendor/pdfjs/pdf.min.mjs` | pdfjs-dist | 4.4.168 |
| `vendor/pdfjs/pdf.worker.min.mjs` | pdfjs-dist | 4.4.168 |
