import type { Prisma } from "@prisma/client";

type Decimalish = Prisma.Decimal | number;
type TaxMode = "INCLUSIVE" | "EXCLUSIVE";
type TaxTreatment = "STANDARD" | "ZERO_RATED" | "EXEMPT";

// Each line carries the tax it was actually sold under (snapshot). When those
// are null — a pre-existing row, or a caller that hasn't stamped them — the
// order-level fallback (the tenant's BusinessProfile) is used instead.
export type OrderLineForTotals = {
  quantity: number;
  unitPrice: Decimalish;
  addons: { quantity: number; unitPrice: Decimalish }[];
  taxRate?: Decimalish | null;
  taxMode?: TaxMode | null;
  taxTreatment?: TaxTreatment | null;
};

export type OrderForTotals = {
  discount: Decimalish;
  items: OrderLineForTotals[];
};

export type TaxSettings =
  | { taxRate: Decimalish | null; taxMode: TaxMode; taxTreatment?: TaxTreatment | null }
  | null
  | undefined;

export type TaxLine = {
  key: string;
  label: string;
  treatment: TaxTreatment;
  rate: number;
  mode: TaxMode;
  net: number;
  tax: number;
  gross: number;
};

export type TaxLineItem = TaxLine & {
  index: number;
  quantity: number;
};

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function labelFor(treatment: TaxTreatment, rate: number, mode: TaxMode) {
  if (treatment === "EXEMPT") return "Exempt";
  if (treatment === "ZERO_RATED") return "Zero-rated (0%)";
  return `VAT ${rate}% ${mode === "EXCLUSIVE" ? "exclusive" : "inclusive"}`;
}

/** Single source of truth for order money math, shared by the POS order
 * routes, the sales report and the receipt. Tax is computed per line from the
 * line's own snapshot (falling back to the tenant default), so an order that
 * mixes a standard-rated dish, a zero-rated loaf and an exempt service all
 * total correctly. The order discount is apportioned across lines in
 * proportion to their value before tax is worked out. */
export function computeOrderFinancials(order: OrderForTotals, tax: TaxSettings) {
  const fallbackRate = tax?.taxRate != null ? Number(tax.taxRate) : 16;
  const fallbackMode: TaxMode = tax?.taxMode ?? "INCLUSIVE";
  const fallbackTreatment: TaxTreatment = tax?.taxTreatment ?? "STANDARD";

  const lines = order.items.map((item) => {
    const addonsTotal = item.addons.reduce((s, a) => s + Number(a.unitPrice) * a.quantity, 0);
    return { lineSubtotal: (Number(item.unitPrice) + addonsTotal) * item.quantity, item };
  });

  const subtotal = lines.reduce((s, l) => s + l.lineSubtotal, 0);
  const discount = Math.min(Number(order.discount), subtotal);

  const buckets = new Map<string, TaxLine>();
  let netTotal = 0;
  let taxTotal = 0;
  let grossTotal = 0;
  let zeroRatedAmount = 0;
  let exemptAmount = 0;
  const taxLineItems: TaxLineItem[] = [];

  for (const [index, { lineSubtotal, item }] of lines.entries()) {
    // Apportion the order discount by line value so each line's tax is worked
    // out on what that line actually contributes after the discount.
    const share = subtotal > 0 ? lineSubtotal - discount * (lineSubtotal / subtotal) : 0;
    const rate = item.taxRate != null ? Number(item.taxRate) : fallbackRate;
    const mode: TaxMode = item.taxMode ?? fallbackMode;
    const treatment: TaxTreatment = item.taxTreatment ?? fallbackTreatment;

    let net: number;
    let taxAmount: number;
    if (treatment === "EXEMPT" || treatment === "ZERO_RATED" || rate <= 0) {
      net = share;
      taxAmount = 0;
    } else if (mode === "EXCLUSIVE") {
      net = share;
      taxAmount = net * (rate / 100);
    } else {
      net = share / (1 + rate / 100);
      taxAmount = share - net;
    }
    const gross = net + taxAmount;

    netTotal += net;
    taxTotal += taxAmount;
    grossTotal += gross;
    if (treatment === "ZERO_RATED") zeroRatedAmount += net;
    if (treatment === "EXEMPT") exemptAmount += net;

    const effTreatment: TaxTreatment = treatment === "STANDARD" && rate <= 0 ? "ZERO_RATED" : treatment;
    const key = `${effTreatment}|${effTreatment === "STANDARD" ? `${rate}|${mode}` : "0"}`;
    const bucket = buckets.get(key) ?? {
      key,
      label: labelFor(effTreatment, rate, mode),
      treatment: effTreatment,
      rate: effTreatment === "STANDARD" ? rate : 0,
      mode,
      net: 0,
      tax: 0,
      gross: 0,
    };
    bucket.net += net;
    bucket.tax += taxAmount;
    bucket.gross += gross;
    buckets.set(key, bucket);
    taxLineItems.push({
      key,
      label: bucket.label,
      treatment: effTreatment,
      rate: bucket.rate,
      mode,
      net: round2(net),
      tax: round2(taxAmount),
      gross: round2(gross),
      index,
      quantity: item.quantity,
    });
  }

  const taxLines = [...buckets.values()]
    .map((b) => ({ ...b, net: round2(b.net), tax: round2(b.tax), gross: round2(b.gross) }))
    .sort((a, b) => (b.treatment === "STANDARD" ? 1 : 0) - (a.treatment === "STANDARD" ? 1 : 0) || b.rate - a.rate);

  // Back-compat scalar rate/mode: the standard bucket that carries the most
  // value, else the fallback.
  const dominantStandard = taxLines.filter((l) => l.treatment === "STANDARD").sort((a, b) => b.gross - a.gross)[0];

  return {
    subtotal: round2(subtotal),
    discount: round2(discount),
    taxable: round2(netTotal - zeroRatedAmount - exemptAmount),
    net: round2(netTotal),
    taxRate: dominantStandard?.rate ?? (fallbackTreatment === "STANDARD" ? fallbackRate : 0),
    taxMode: dominantStandard?.mode ?? fallbackMode,
    taxAmount: round2(taxTotal),
    zeroRatedAmount: round2(zeroRatedAmount),
    exemptAmount: round2(exemptAmount),
    total: round2(grossTotal),
    taxLines,
    taxLineItems,
  };
}
