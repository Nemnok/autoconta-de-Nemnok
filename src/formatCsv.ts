/**
 * formatCsv.ts
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

import type { ParsedInvoice } from './types.js';

export const CSV_HEADERS = [
  'Fecha',
  'Tipo',
  'Contraparte',
  'TOTAL factura',
  'IGIC%',
  'IGIC',
  'Base',
] as const;

/**
 * Escape a single CSV field value.
 *
 * According to RFC 4180 (adapted for semicolon delimiter):
 *  - If the field contains a semicolon, double-quote, carriage return or
 *    newline, wrap it in double-quotes.
 *  - Escape any embedded double-quotes by doubling them ("").
 */
export function escapeCsvField(value: string): string {
  const needsQuoting = /[;"'\n\r]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuoting ? `"${escaped}"` : escaped;
}

/**
 * Serialize a single invoice to a CSV data row (no trailing newline).
 */
export function invoiceToCsvRow(inv: ParsedInvoice): string {
  const fields: string[] = [
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
 */
export function invoicesToCsv(invoices: ParsedInvoice[]): string {
  const header = CSV_HEADERS.map(escapeCsvField).join(';');
  const rows = invoices.map(invoiceToCsvRow);
  return [header, ...rows].join('\r\n');
}

/**
 * Trigger a browser download of the given CSV content.
 *
 * @param content  UTF-8 CSV string
 * @param filename Suggested file name (default: "facturas.csv")
 */
export function downloadCsv(content: string, filename = 'facturas.csv'): void {
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
