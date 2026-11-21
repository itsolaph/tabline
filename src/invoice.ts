/**
 * The paid work behind the tab: pull the fields an agent's bookkeeping needs
 * out of an invoice, labelled ("Total: $184.50") or free-form one-liners
 * ("INV-001 ACME Corp total 120.50 USD due 2026-12-01"). Deterministic on
 * purpose — the demo is about payment terms, not model output.
 */

export type ParsedInvoice = {
  vendor: string | null;
  invoiceNumber: string | null;
  date: string | null;
  dueDate: string | null;
  totalUsd: number | null;
  currency: string | null;
};

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

const DATE_RE =
  /(\d{4}-\d{2}-\d{2})|(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})|(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})|([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/;

/** Normalise the first date in `s` to YYYY-MM-DD (day-first for d/m/y). */
export function findDate(s: string): string | null {
  const m = s.match(DATE_RE);
  if (!m) return null;
  const pad = (x: string) => x.padStart(2, "0");
  if (m[1]) return m[1];
  if (m[2]) return `${m[4]}-${pad(m[3])}-${pad(m[2])}`;
  if (m[5]) {
    const mo = MONTHS[m[6].toLowerCase()];
    return mo ? `${m[7]}-${mo}-${pad(m[5])}` : null;
  }
  const mo = MONTHS[m[8].toLowerCase()];
  return mo ? `${m[10]}-${mo}-${pad(m[9])}` : null;
}

function amount(raw: string): number {
  // "1.234,56" (EU) vs "1,234.56" (US): the last separator is the decimal one.
  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");
  const n =
    lastComma > lastDot && raw.length - lastComma === 3
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(/,/g, "");
  return Number(n);
}

const CURRENCY_RE = /\b(USD|USDT|USDC|EUR|IDR|GBP)\b|([$€£])/i;
const SYMBOL: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };

export function parseInvoice(text: string): ParsedInvoice {
  const t = text.replace(/\r/g, "");

  const labelled = (label: string) =>
    t.match(new RegExp(`^\\s*${label}\\s*[:#]\\s*(.+)$`, "im"))?.[1]?.trim() ?? null;

  // Invoice number: labelled, or an INV-style token anywhere.
  const invoiceNumber =
    t.match(/invoice\s*(?:no\.?|number|#)\s*:?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i)?.[1] ??
    t.match(/\b((?:INV|SJP|BILL)[-\/]?[A-Z0-9][A-Z0-9\-\/]*)\b/i)?.[1] ??
    null;

  // Total: the amount after the last "total"/"amount due" keyword.
  let totalUsd: number | null = null;
  let currency: string | null = null;
  const totals = [
    ...t.matchAll(/(?:grand\s+total|total(?:\s+due)?|amount\s+due|balance\s+due)\s*:?\s*([^\n]{0,40})/gi),
  ];
  for (const m of totals.reverse()) {
    const num = m[1].match(/(\d[\d.,]*\d|\d)/);
    if (num) {
      totalUsd = amount(num[1]);
      const c = m[0].match(CURRENCY_RE);
      currency = c ? (c[1]?.toUpperCase() ?? SYMBOL[c[2]]) : null;
      break;
    }
  }
  if (currency === null) {
    const c = t.match(CURRENCY_RE);
    if (c) currency = c[1]?.toUpperCase() ?? SYMBOL[c[2]];
  }
  if (currency && !["USD", "USDT", "USDC"].includes(currency)) totalUsd = null;

  // Due date: after "due"; issue date: labelled Date, else the first date
  // that is not the due date.
  const dueDate = (() => {
    // "Total due: $1,100" also says "due" — take the first one followed by a date.
    for (const m of t.matchAll(/due(?:\s+date|\s+on|\s+by)?\s*:?\s*([^\n]{0,30})/gi)) {
      const d = findDate(m[1]);
      if (d) return d;
    }
    return null;
  })();
  const labelledDate = labelled("(?:invoice\\s+)?date");
  let date = labelledDate ? findDate(labelledDate) : null;
  if (!date) {
    const first = findDate(t);
    date = first && first !== dueDate ? first : null;
  }

  // Vendor: labelled, "from X", or the words right after the invoice number.
  let vendor = labelled("(?:vendor|from|seller|supplier|billed\\s+by)");
  if (!vendor) {
    const after = invoiceNumber
      ? t.slice(t.indexOf(invoiceNumber) + invoiceNumber.length)
      : t.split("\n")[0];
    const m = after.match(
      /^\s*[-–:,]?\s*([A-Z][\w&.'’]*(?:\s+[A-Z][\w&.'’]*)*?(?:\s+(?:Corp|Inc|Ltd|LLC|GmbH|Co|PT|CV|Tbk)\.?)?)(?=\s+(?:total|amount|due|for|invoice)\b|\s*$|\s*\n|\s+\d)/i,
    );
    vendor = m?.[1]?.trim() || null;
  }

  return { vendor, invoiceNumber, date, dueDate, totalUsd, currency };
}
