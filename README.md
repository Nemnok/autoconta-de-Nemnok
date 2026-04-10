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

## Limitations

- OCR accuracy depends on image quality. Blurry or low-resolution scans may produce poor results.
- Name extraction near NIFs is heuristic and may require manual review.
- IGIC extraction assumes text follows common Spanish invoice patterns; unusual formats may not be captured.
- Currency detection is keyword/symbol based; amounts are not converted.
- The Tesseract language data (~20 MB) is downloaded on first use from a CDN.

## Browser Support

Modern browsers with ES2020+ support: Chrome 90+, Firefox 90+, Edge 90+, Safari 15+.

## Network Access Requirements

The application loads all dependencies at runtime from public CDNs.  Make sure
the following domains are reachable from the browser:

| CDN | Used for |
|---|---|
| `cdn.jsdelivr.net` | Tesseract.js ESM bundle |
| `cdnjs.cloudflare.com` | Tesseract.js worker & core WASM, PDF.js |
| `tessdata.projectnaptha.com` | Tesseract language data (spa + eng, ~20 MB, downloaded once) |

> **Smoke-test**: open the browser DevTools → Network tab, reload the page and
> confirm these domains return HTTP 200.  A blocked CDN will show the affected
> file(s) in red; OCR will degrade gracefully (an error is shown per file in
> the table) but the rest of the UI remains functional.
