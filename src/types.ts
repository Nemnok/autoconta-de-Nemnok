// ─── Domain types ───────────────────────────────────────────────────────────

export interface CompanySettings {
  name: string;
  nif: string;
}

/** Invoice classification */
export type InvoiceType = 'Compra' | 'Venta' | 'Otro';

/** One IGIC tranche: percent, tax amount, taxable base */
export interface IgicEntry {
  percent: string; // e.g. "7"
  amount: string;  // e.g. "14,00"
  base: string;    // e.g. "200,00"
}

/** All fields extracted from a single invoice */
export interface ParsedInvoice {
  filename: string;
  /** DD/MM/YYYY or empty string when parse failed */
  fecha: string;
  tipo: InvoiceType;
  /**
   * Counterparty: "Name NIF [CONTRATO] [MONEDA: X]"
   * – name + NIF combined in one field
   */
  contraparte: string;
  /** European format with comma decimal, e.g. "1.234,56" */
  total: string;
  /** Pipe-separated IGIC percentages, e.g. "3|7" */
  igicPercent: string;
  /** Pipe-separated IGIC amounts */
  igicAmount: string;
  /** Pipe-separated taxable bases */
  base: string;
  /** Full raw OCR/extracted text */
  rawText: string;
  /** True when any field is uncertain and manual review is recommended */
  needsReview: boolean;
  reviewReasons: string[];
  isContract: boolean;
}

// ─── Processing pipeline types ────────────────────────────────────────────

export type ProcessingStatus = 'pending' | 'processing' | 'done' | 'error';

export interface InvoiceRow {
  id: string;
  filename: string;
  status: ProcessingStatus;
  error?: string;
  parsed?: ParsedInvoice;
  showRaw: boolean;
}
