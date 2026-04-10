/**
 * formatCsv.js
 *
 * Format extracted invoice data into a semicolon-delimited CSV string.
 *
 * Column order (spec):
 *  1. Fecha
 *  2. Tipo (Compra / Venta / Otro)
 *  3. Contraparte (Name + NIF + markers)
 *  4. TOTAL factura
 *  5. IGIC%
 *  6. IGIC (amount)
 *  7. Base
 *
 * Rules:
 *  - Delimiter: semicolon (;)
 *  - One line per invoice + header line
 *  - Fields containing ; or " or newlines are quoted with double-quotes
 *  - Internal double-quotes are escaped as ""
 *  - European number formatting (comma decimal) is preserved as-is
 */

export const CSV_HEADERS = [
  'Fecha',
  'Tipo',
  'Contraparte',
  'TOTAL factura',
  'IGIC%',
  'IGIC',
  'Base',
];

/**
 * Escape a single CSV field value.
 *
 * According to RFC 4180 (adapted for semicolon delimiter):
 *  - If the field contains a semicolon, double-quote, carriage return or
 *    newline, wrap it in double-quotes.
 *  - Escape any embedded double-quotes by doubling them ("").
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeCsvField(value) {
  const needsQuoting = /[;"\n\r]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuoting ? `"${escaped}"` : escaped;
}

/**
 * Serialize a single invoice to a CSV data row (no trailing newline).
 *
 * @param {import('./parseInvoice.js').ParsedInvoice} inv
 * @returns {string}
 */
export function invoiceToCsvRow(inv) {
  const fields = [
    inv.fecha,
    inv.tipo,
    inv.contraparte,
    inv.total,
    inv.igicPercent,
    inv.igicAmount,
    inv.base,
  ];
  return fields.map(escapeCsvField).join(';');
}

/**
 * Serialize an array of parsed invoices to a complete CSV string
 * (header + data rows, lines separated by CRLF for maximum compatibility).
 *
 * @param {import('./parseInvoice.js').ParsedInvoice[]} invoices
 * @returns {string}
 */
export function invoicesToCsv(invoices) {
  const header = CSV_HEADERS.map(escapeCsvField).join(';');
  const rows = invoices.map(invoiceToCsvRow);
  return [header, ...rows].join('\r\n');
}

/**
 * Trigger a browser download of the given CSV content.
 *
 * @param {string} content  UTF-8 CSV string
 * @param {string} [filename]  Suggested file name (default: "facturas.csv")
 */
export function downloadCsv(content, filename = 'facturas.csv') {
  // BOM (U+FEFF) ensures Excel opens the file with correct encoding
  const bom = '\uFEFF';
  const blob = new Blob([bom + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
