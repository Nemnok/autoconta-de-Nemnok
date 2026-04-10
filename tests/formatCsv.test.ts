/**
 * formatCsv.test.ts — Unit tests for CSV formatting utilities
 */

import { describe, it, expect } from 'vitest';
import { escapeCsvField, invoiceToCsvRow, invoicesToCsv } from '../src/formatCsv.js';
import type { ParsedInvoice } from '../src/types.js';

// ─── escapeCsvField ───────────────────────────────────────────────────────────

describe('escapeCsvField', () => {
  it('returns plain value unchanged when no special chars', () => {
    expect(escapeCsvField('hello')).toBe('hello');
  });

  it('wraps in double-quotes when value contains semicolon', () => {
    expect(escapeCsvField('a;b')).toBe('"a;b"');
  });

  it('wraps in double-quotes when value contains double-quote', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('wraps in double-quotes when value contains newline', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('wraps in double-quotes when value contains carriage return', () => {
    expect(escapeCsvField('line1\rline2')).toBe('"line1\rline2"');
  });

  it('handles empty string', () => {
    expect(escapeCsvField('')).toBe('');
  });

  it('preserves European number format (comma decimal)', () => {
    expect(escapeCsvField('1.234,56')).toBe('1.234,56');
  });
});

// ─── invoiceToCsvRow ──────────────────────────────────────────────────────────

function makeInvoice(overrides: Partial<ParsedInvoice> = {}): ParsedInvoice {
  return {
    filename: 'test.pdf',
    fecha: '15/06/2024',
    tipo: 'Venta',
    contraparte: 'ACME SL A11223344',
    total: '1.070,00',
    igicPercent: '7',
    igicAmount: '70,00',
    base: '1.000,00',
    rawText: '',
    needsReview: false,
    reviewReasons: [],
    isContract: false,
    ...overrides,
  };
}

describe('invoiceToCsvRow', () => {
  it('produces exactly 7 semicolon-separated fields', () => {
    const row = invoiceToCsvRow(makeInvoice());
    const fields = row.split(';');
    expect(fields).toHaveLength(7);
  });

  it('fields follow the correct column order', () => {
    const inv = makeInvoice();
    const row = invoiceToCsvRow(inv);
    const [fecha, tipo, contraparte, total, igicPct, igicAmt, base] = row.split(';');
    expect(fecha).toBe(inv.fecha);
    expect(tipo).toBe(inv.tipo);
    expect(contraparte).toBe(inv.contraparte);
    expect(total).toBe(inv.total);
    expect(igicPct).toBe(inv.igicPercent);
    expect(igicAmt).toBe(inv.igicAmount);
    expect(base).toBe(inv.base);
  });

  it('escapes semicolons inside contraparte', () => {
    const inv = makeInvoice({ contraparte: 'Empresa; Cía SL B12345678' });
    const row = invoiceToCsvRow(inv);
    expect(row).toContain('"Empresa; Cía SL B12345678"');
  });

  it('handles empty optional fields (IGIC)', () => {
    const inv = makeInvoice({ igicPercent: '', igicAmount: '', base: '' });
    const row = invoiceToCsvRow(inv);
    // Should still have 7 fields (possibly empty)
    expect(row.split(';')).toHaveLength(7);
  });

  it('includes pipe-separated IGIC rates as-is', () => {
    const inv = makeInvoice({ igicPercent: '3|7', igicAmount: '3,00|7,00', base: '100,00|100,00' });
    const row = invoiceToCsvRow(inv);
    expect(row).toContain('3|7');
    expect(row).toContain('3,00|7,00');
  });
});

// ─── invoicesToCsv ────────────────────────────────────────────────────────────

describe('invoicesToCsv', () => {
  it('produces header as first line', () => {
    const csv = invoicesToCsv([]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toContain('Fecha');
    expect(lines[0]).toContain('Tipo');
    expect(lines[0]).toContain('Contraparte');
    expect(lines[0]).toContain('TOTAL factura');
  });

  it('produces one data line per invoice', () => {
    const invoices = [makeInvoice(), makeInvoice({ filename: 'b.pdf' })];
    const csv = invoicesToCsv(invoices);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(3); // header + 2 rows
  });

  it('uses CRLF line endings', () => {
    const csv = invoicesToCsv([makeInvoice()]);
    expect(csv).toContain('\r\n');
  });

  it('handles invoices with contract markers', () => {
    const inv = makeInvoice({ contraparte: 'ACME SL A11223344 [CONTRATO]' });
    const csv = invoicesToCsv([inv]);
    expect(csv).toContain('[CONTRATO]');
  });

  it('handles invoices with currency markers', () => {
    const inv = makeInvoice({ contraparte: 'FOREIGN CO EIN123 [MONEDA: USD]' });
    const csv = invoicesToCsv([inv]);
    expect(csv).toContain('[MONEDA: USD]');
  });

  it('produces empty CSV (header only) for empty array', () => {
    const csv = invoicesToCsv([]);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(1);
  });
});
