import { z } from 'zod';

/* eslint-disable no-restricted-syntax */

const decimalString = z.string().regex(/^-?\d+(?:\.\d+)?$/);

export const invoiceLineInputSchema = z.object({
  quantity: decimalString,
  unitPrice: decimalString,
  discountRate: decimalString.default('0'),
  discountAmount: decimalString.default('0'),
  taxRate: decimalString.default('0'),
});

export type InvoiceLineInput = z.input<typeof invoiceLineInputSchema>;
export type InvoiceLineTotal = {
  gross: string;
  discount: string;
  net: string;
  tax: string;
  total: string;
  /**
   * The line's share of the header (document) discount, distributed pro-rata by
   * gross value — the desktop `InvoiceCalc`/`BindToEntry` rule
   * (`price × qty × TotDiscount / SumPrice`). It is already subtracted from `net`
   * (and its VAT from `tax`), so header totals reconcile with the lines — which is
   * what ZATCA validates. Zero when the invoice carries no header discount.
   */
  headerDiscountShare: string;
};

export type InvoiceTotalsInput = {
  lines: InvoiceLineInput[];
  priceIncludesVat?: boolean;
  invoiceDiscount?: string;
  extraTax?: string;
  withholding?: string;
  scale?: number;
};

export type InvoiceTotals = {
  lines: InvoiceLineTotal[];
  subtotal: string;
  discount: string;
  taxable: string;
  tax: string;
  extraTax: string;
  withholding: string;
  total: string;
};

type Int = bigint;
const ten = (scale: number): Int => 10n ** BigInt(scale);

function parse(value: string, scale: number): Int {
  const normalized = value.trim();
  const [wholePart = '0', fraction = ''] = normalized.replace(/^\+/, '').split('.');
  const negative = wholePart.startsWith('-');
  const wholeValue = BigInt(negative ? wholePart.slice(1) || '0' : wholePart || '0');
  const kept = fraction.padEnd(scale, '0').slice(0, scale);
  const base = wholeValue * ten(scale) + BigInt(kept || '0');
  const rounded = fraction.length > scale && Number(fraction[scale]) >= 5 ? base + 1n : base;
  return negative ? -rounded : rounded;
}

function format(value: Int, scale: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const raw = absolute.toString().padStart(scale + 1, '0');
  const fraction = raw.slice(-scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${raw.slice(0, -scale)}${fraction ? `.${fraction}` : ''}`;
}

function divRound(numerator: Int, denominator: Int): Int {
  if (denominator === 0n) throw new Error('Cannot divide by zero');
  const sign = numerator < 0n === denominator < 0n ? 1n : -1n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  return sign * ((n + d / 2n) / d);
}

export function calculateInvoiceTotals(input: InvoiceTotalsInput): InvoiceTotals {
  const scale = input.scale ?? 4;
  const unit = ten(scale);
  const prepared = input.lines.map((line) => {
    const quantity = parse(line.quantity, scale);
    const unitPrice = parse(line.unitPrice, scale);
    const gross = divRound(quantity * unitPrice, unit);
    const rate = parse(line.discountRate ?? '0', scale);
    const rateDiscount = divRound(gross * rate, 100n * unit);
    const discount = rateDiscount + parse(line.discountAmount ?? '0', scale);
    const net = gross - discount;
    const taxRate = parse(line.taxRate ?? '0', scale);
    return { gross, discount, net, taxRate };
  });

  // The header discount is distributed across the lines pro-rata by gross value
  // (desktop rule) so every line's net and VAT already reflect it. A discount that
  // only shrank the header while the lines kept their VAT would overstate the tax
  // and fail ZATCA reconciliation (header taxable must equal the sum of line nets).
  const headerDiscount = parse(input.invoiceDiscount ?? '0', scale);
  const shares = new Array<Int>(prepared.length).fill(0n);
  if (headerDiscount !== 0n && prepared.length > 0) {
    const totalGross = prepared.reduce((sum, line) => sum + (line.gross > 0n ? line.gross : 0n), 0n);
    if (totalGross > 0n) {
      for (let index = 0; index < prepared.length; index += 1) {
        const base = prepared[index]!.gross > 0n ? prepared[index]!.gross : 0n;
        shares[index] = divRound(headerDiscount * base, totalGross);
      }
      const distributed = shares.reduce((sum, share) => sum + share, 0n);
      const remainder = headerDiscount - distributed;
      if (remainder !== 0n) {
        let target = 0;
        for (let index = 1; index < prepared.length; index += 1) {
          if (prepared[index]!.gross > prepared[target]!.gross) target = index;
        }
        shares[target] = (shares[target] ?? 0n) + remainder;
      }
    }
  }

  const lines = prepared.map((line, index) => {
    const share = shares[index] ?? 0n;
    // The share reduces the VAT-inclusive base, exactly as the desktop subtracts the
    // header discount from the gross sum before extracting VAT.
    const base = line.net - share;
    const tax = input.priceIncludesVat
      ? divRound(base * line.taxRate, 100n * unit + line.taxRate)
      : divRound(base * line.taxRate, 100n * unit);
    const taxableNet = input.priceIncludesVat ? base - tax : base;
    const total = input.priceIncludesVat ? base : base + tax;
    return { gross: format(line.gross, scale), discount: format(line.discount, scale), net: format(taxableNet, scale), tax: format(tax, scale), total: format(total, scale), headerDiscountShare: format(share, scale) };
  });
  const subtotal = lines.reduce((sum, line) => sum + parse(line.net, scale), 0n);
  const tax = lines.reduce((sum, line) => sum + parse(line.tax, scale), 0n);
  const extraTax = parse(input.extraTax ?? '0', scale);
  const withholding = parse(input.withholding ?? '0', scale);
  // Normally every fils of the discount is distributed (the remainder lands on the
  // largest line above). Only a zero-gross invoice leaves a share unallocated, and
  // dropping it silently would undercharge — so it still reduces the header total,
  // which the service then rejects as negative for sales documents.
  const unallocated = headerDiscount - shares.reduce((sum, share) => sum + share, 0n);
  const total = subtotal + tax + extraTax - withholding - unallocated;
  return { lines, subtotal: format(subtotal, scale), discount: format(headerDiscount, scale), taxable: format(subtotal, scale), tax: format(tax, scale), extraTax: format(extraTax, scale), withholding: format(withholding, scale), total: format(total, scale) };
}

export type LandedCostLineInput = { lineId?: string; itemId?: string; quantity: string; net: string; unitCost?: string };
export type LandedCostInput = { lines: LandedCostLineInput[]; costs: Array<{ amount: string }>; method: 'qty' | 'value'; scale?: number };
export type LandedCostLineAllocation = {
  lineId?: string;
  itemId?: string;
  base: string;
  allocatedCost: string;
  net: string;
  landedTotal: string;
  effectiveUnitCost: string;
};
export type LandedCostAllocation = { method: 'qty' | 'value'; totalCost: string; lines: LandedCostLineAllocation[] };

/**
 * Allocates landed costs pro-rata by quantity or value, HALF_UP at the selected scale,
 * then assigns any rounding remainder to the line with the largest allocation base.
 */
export function allocateLandedCost(input: LandedCostInput): LandedCostAllocation {
  const scale = input.scale ?? 4;
  const totalCost = input.costs.reduce((sum, cost) => sum + parse(cost.amount, scale), 0n);
  const prepared = input.lines.map((line, index) => {
    const quantity = parse(line.quantity, scale);
    const net = parse(line.net, scale);
    const base = input.method === 'qty' ? quantity : net;
    return { line, index, quantity, net, base };
  });
  const totalBase = prepared.reduce((sum, line) => sum + line.base, 0n);
  if (prepared.length === 0 || totalCost < 0n || totalBase <= 0n) {
    throw new Error('Cannot allocate landed cost without positive lines, costs and allocation base');
  }

  const allocations = prepared.map((line) => divRound(totalCost * line.base, totalBase));
  const allocated = allocations.reduce((sum, value) => sum + value, 0n);
  const remainder = totalCost - allocated;
  if (remainder !== 0n) {
    let target = 0;
    for (let index = 1; index < prepared.length; index += 1) {
      if (prepared[index]!.base > prepared[target]!.base) target = index;
    }
    allocations[target] = (allocations[target] ?? 0n) + remainder;
  }

  return {
    method: input.method,
    totalCost: format(totalCost, scale),
    lines: prepared.map(({ line, quantity, net, base }, index) => {
      const allocatedCost = allocations[index] ?? 0n;
      const landedTotal = net + allocatedCost;
      const effectiveUnitCost = divRound(landedTotal * ten(scale), quantity);
      return {
        lineId: line.lineId,
        itemId: line.itemId,
        base: format(base, scale),
        allocatedCost: format(allocatedCost, scale),
        net: format(net, scale),
        landedTotal: format(landedTotal, scale),
        effectiveUnitCost: format(effectiveUnitCost, scale),
      };
    }),
  };
}

export const invoiceMath = { calculateInvoiceTotals, allocateLandedCost, invoiceLineInputSchema };
