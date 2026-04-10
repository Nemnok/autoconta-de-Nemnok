/**
 * parseInvoice.test.ts — Unit tests for all parsing utilities
 */

import { describe, it, expect } from 'vitest';
import {
  extractDates,
  chooseBestDate,
  formatDate,
  parseEuropeanNumber,
  toEuropeanString,
  extractNifs,
  extractIgic,
  extractTotal,
  detectCurrencyMarker,
  classifyInvoice,
  extractContraparte,
  parseInvoice,
} from '../src/parseInvoice.js';
import type { CompanySettings } from '../src/types.js';

// ─── Date parsing ─────────────────────────────────────────────────────────────

describe('extractDates', () => {
  it('parses DD/MM/YYYY', () => {
    const dates = extractDates('Fecha: 15/03/2024');
    expect(dates).toHaveLength(1);
    expect(dates[0].getFullYear()).toBe(2024);
    expect(dates[0].getMonth()).toBe(2); // 0-indexed
    expect(dates[0].getDate()).toBe(15);
  });

  it('parses DD-MM-YYYY', () => {
    const dates = extractDates('Fecha: 01-01-2023');
    expect(dates[0].getFullYear()).toBe(2023);
  });

  it('parses DD.MM.YYYY', () => {
    const dates = extractDates('31.12.2022');
    expect(dates[0].getDate()).toBe(31);
    expect(dates[0].getMonth()).toBe(11);
  });

  it('parses ISO YYYY-MM-DD', () => {
    const dates = extractDates('2024-06-20');
    expect(dates[0].getFullYear()).toBe(2024);
    expect(dates[0].getMonth()).toBe(5);
    expect(dates[0].getDate()).toBe(20);
  });

  it('parses Spanish long form "15 de marzo de 2024"', () => {
    const dates = extractDates('Emitida el 15 de marzo de 2024 en Las Palmas.');
    expect(dates[0].getMonth()).toBe(2);
    expect(dates[0].getDate()).toBe(15);
  });

  it('returns multiple dates from text', () => {
    const text = 'Pedido: 01/01/2024. Entrega: 15/02/2024. Vencimiento: 01/03/2024.';
    const dates = extractDates(text);
    expect(dates.length).toBeGreaterThanOrEqual(3);
  });

  it('ignores invalid dates', () => {
    const dates = extractDates('32/13/2024 is invalid; 99/99/9999 too');
    expect(dates).toHaveLength(0);
  });
});

describe('chooseBestDate', () => {
  it('returns null for empty array', () => {
    expect(chooseBestDate([])).toBeNull();
  });

  it('returns the latest date', () => {
    const d1 = new Date(2024, 0, 1);
    const d2 = new Date(2024, 5, 15);
    const d3 = new Date(2023, 11, 31);
    expect(chooseBestDate([d1, d2, d3])).toBe(d2);
  });
});

describe('formatDate', () => {
  it('formats to DD/MM/YYYY', () => {
    expect(formatDate(new Date(2024, 2, 5))).toBe('05/03/2024');
  });

  it('pads single-digit day and month', () => {
    expect(formatDate(new Date(2023, 0, 1))).toBe('01/01/2023');
  });
});

// ─── Number formatting ────────────────────────────────────────────────────────

describe('parseEuropeanNumber', () => {
  it('parses European format 1.234,56', () => {
    expect(parseEuropeanNumber('1.234,56')).toBeCloseTo(1234.56);
  });

  it('parses Anglo format 1234.56', () => {
    expect(parseEuropeanNumber('1234.56')).toBeCloseTo(1234.56);
  });

  it('parses plain integer', () => {
    expect(parseEuropeanNumber('500')).toBe(500);
  });

  it('parses comma-only decimal "14,00"', () => {
    expect(parseEuropeanNumber('14,00')).toBeCloseTo(14);
  });
});

describe('toEuropeanString', () => {
  it('converts "1234.56" to European format', () => {
    const result = toEuropeanString('1234.56');
    expect(result).toMatch(/1\.234,56|1234,56/);
  });

  it('preserves already-European format', () => {
    expect(toEuropeanString('14,00')).toBe('14,00');
  });

  it('returns raw string when parsing fails', () => {
    expect(toEuropeanString('N/A')).toBe('N/A');
  });
});

// ─── NIF extraction ───────────────────────────────────────────────────────────

describe('extractNifs', () => {
  it('extracts CIF (company tax id)', () => {
    const nifs = extractNifs('Empresa: ACME SL  CIF: B12345678');
    expect(nifs.map((n) => n.nif)).toContain('B12345678');
  });

  it('extracts DNI-style NIF', () => {
    const nifs = extractNifs('NIF del cliente: 12345678Z');
    expect(nifs.map((n) => n.nif)).toContain('12345678Z');
  });

  it('extracts NIE (X0000000T)', () => {
    const nifs = extractNifs('NIE: X1234567L');
    expect(nifs.map((n) => n.nif)).toContain('X1234567L');
  });

  it('returns empty array when no NIF found', () => {
    expect(extractNifs('Sin número fiscal aquí')).toHaveLength(0);
  });
});

// ─── IGIC extraction ──────────────────────────────────────────────────────────

describe('extractIgic', () => {
  it('extracts single IGIC line "IGIC 7% 14,00"', () => {
    const entries = extractIgic('Base imponible: 200,00\nIGIC 7% 14,00\nTOTAL: 214,00');
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries.find((e) => e.percent === '7');
    expect(entry).toBeDefined();
    expect(entry?.amount).toBe('14,00');
  });

  it('extracts multiple tranches', () => {
    const text = 'IGIC 3% 6,00\nIGIC 7% 14,00';
    const entries = extractIgic(text);
    const percents = entries.map((e) => e.percent);
    expect(percents).toContain('3');
    expect(percents).toContain('7');
  });

  it('extracts IGIC with pattern "7% IGIC 14,00"', () => {
    const entries = extractIgic('7% IGIC 14,00');
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty when no IGIC present', () => {
    expect(extractIgic('Sin impuesto alguno')).toHaveLength(0);
  });
});

// ─── Total extraction ─────────────────────────────────────────────────────────

describe('extractTotal', () => {
  it('extracts "TOTAL FACTURA: 1.234,56"', () => {
    expect(extractTotal('TOTAL FACTURA: 1.234,56')).toBe('1.234,56');
  });

  it('extracts "TOTAL A PAGAR 500,00"', () => {
    expect(extractTotal('TOTAL A PAGAR 500,00')).toBe('500,00');
  });

  it('extracts "IMPORTE TOTAL 300,00"', () => {
    expect(extractTotal('IMPORTE TOTAL 300,00')).toBe('300,00');
  });

  it('extracts plain "TOTAL: 99,00"', () => {
    expect(extractTotal('TOTAL: 99,00')).toBe('99,00');
  });

  it('returns empty string when no total found', () => {
    expect(extractTotal('No hay nada aquí')).toBe('');
  });
});

// ─── Currency marker ──────────────────────────────────────────────────────────

describe('detectCurrencyMarker', () => {
  it('detects USD by symbol "$"', () => {
    expect(detectCurrencyMarker('Total: $500.00 USD')).toBe('[MONEDA: USD]');
  });

  it('detects USD by code', () => {
    expect(detectCurrencyMarker('Importe: 200 USD')).toBe('[MONEDA: USD]');
  });

  it('detects GBP as NON-EUR', () => {
    expect(detectCurrencyMarker('Amount: £150 GBP')).toBe('[MONEDA: NON-EUR]');
  });

  it('returns empty for EUR-only text', () => {
    expect(detectCurrencyMarker('Total: 500,00 €')).toBe('');
  });
});

// ─── Invoice classification ───────────────────────────────────────────────────

describe('classifyInvoice', () => {
  const settings: CompanySettings = { name: 'MI EMPRESA SL', nif: 'B12345678' };

  it('classifies as Otro + contract when "contrato" keyword found', () => {
    const { tipo, isContract } = classifyInvoice('Contrato de compraventa...', settings);
    expect(tipo).toBe('Otro');
    expect(isContract).toBe(true);
  });

  it('classifies as Otro + contract when "CompraVenta" found', () => {
    const { tipo, isContract } = classifyInvoice('Contrato CompraVenta nº 123', settings);
    expect(tipo).toBe('Otro');
    expect(isContract).toBe(true);
  });

  it('classifies as Venta when company NIF is near EMISOR', () => {
    const text = 'EMISOR: MI EMPRESA SL  B12345678\nCLIENTE: Proveedor SA  A98765432';
    const { tipo } = classifyInvoice(text, settings);
    expect(tipo).toBe('Venta');
  });

  it('classifies as Compra when company NIF is near CLIENTE', () => {
    const text = 'PROVEEDOR: Suministros SA  A11111111\nCLIENTE: MI EMPRESA SL  B12345678';
    const { tipo } = classifyInvoice(text, settings);
    expect(tipo).toBe('Compra');
  });
});

// ─── Contraparte extraction ───────────────────────────────────────────────────

describe('extractContraparte', () => {
  const settings: CompanySettings = { name: 'MI EMPRESA SL', nif: 'B12345678' };

  it('returns the other party NIF, not the company NIF', () => {
    const text = 'EMISOR: MI EMPRESA SL B12345678\nCLIENTE: ACME SL A99887766';
    const result = extractContraparte(text, settings, 'Venta');
    expect(result.nif).toBe('A99887766');
  });

  it('flags for review when no counterparty NIF found', () => {
    const text = 'Factura sin datos de contraparte';
    const result = extractContraparte(text, settings, 'Compra');
    expect(result.needsReview).toBe(true);
  });
});

// ─── Integration: parseInvoice ────────────────────────────────────────────────

describe('parseInvoice', () => {
  const settings: CompanySettings = { name: 'MI EMPRESA SL', nif: 'B12345678' };

  it('parses a full venta invoice text', () => {
    const text = `
FACTURA Nº 2024-001
Fecha: 15/06/2024

EMISOR: MI EMPRESA SL
NIF: B12345678
Calle Mayor 1, Las Palmas

CLIENTE: SERVICIOS ISLA SA
NIF: A11223344

BASE IMPONIBLE: 1.000,00
IGIC 7% 70,00
TOTAL FACTURA: 1.070,00
    `.trim();

    const inv = parseInvoice(text, 'factura.pdf', settings);
    expect(inv.tipo).toBe('Venta');
    expect(inv.fecha).toBe('15/06/2024');
    expect(inv.total).toBe('1.070,00');
    expect(inv.igicPercent).toContain('7');
    expect(inv.igicAmount).toContain('70,00');
  });

  it('sets needsReview when date missing', () => {
    const inv = parseInvoice('TOTAL: 100,00', 'x.pdf', settings);
    expect(inv.needsReview).toBe(true);
    expect(inv.reviewReasons.some((r) => /fecha/i.test(r))).toBe(true);
  });

  it('marks contract invoices correctly', () => {
    const inv = parseInvoice('Contrato de compraventa entre partes', 'ctto.pdf', settings);
    expect(inv.isContract).toBe(true);
    expect(inv.tipo).toBe('Otro');
    expect(inv.contraparte).toContain('[CONTRATO]');
  });

  it('appends USD currency marker to contraparte', () => {
    const text = `
EMISOR: FOREIGN CO LLC
NIF EIN: 98-7654321
CLIENTE: MI EMPRESA SL B12345678
TOTAL: $500.00 USD
    `.trim();
    const inv = parseInvoice(text, 'usd.pdf', settings);
    expect(inv.contraparte).toContain('[MONEDA: USD]');
  });

  it('pipe-separates multiple IGIC rates', () => {
    const text = `
BASE 100,00
IGIC 3% 3,00
IGIC 7% 7,00
TOTAL: 110,00
    `.trim();
    const inv = parseInvoice(text, 'multi.pdf', settings);
    expect(inv.igicPercent).toContain('|');
  });
});
