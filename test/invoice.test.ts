import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInvoice, findDate } from "../src/invoice.js";

test("labelled invoice", () => {
  const r = parseInvoice(`Vendor: Sinar Jaya Paper Co
Invoice #: SJP-2026-1143
Date: 2026-11-20
Total: $184.50`);
  assert.deepEqual(r, {
    vendor: "Sinar Jaya Paper Co",
    invoiceNumber: "SJP-2026-1143",
    date: "2026-11-20",
    dueDate: null,
    totalUsd: 184.5,
    currency: "USD",
  });
});

test("free-form one-liner", () => {
  const r = parseInvoice("INV-001 ACME Corp total 120.50 USD due 2026-12-01");
  assert.equal(r.invoiceNumber, "INV-001");
  assert.equal(r.vendor, "ACME Corp");
  assert.equal(r.totalUsd, 120.5);
  assert.equal(r.currency, "USD");
  assert.equal(r.dueDate, "2026-12-01");
  assert.equal(r.date, null);
});

test("subtotal is ignored in favour of the final total, thousands separators", () => {
  const r = parseInvoice(`From: Northwind Traders Ltd
Invoice Number: NW/7781
Invoice Date: 3 Nov 2026
Subtotal: $1,000.00
Tax: $100.00
Total due: $1,100.00
Due by: Dec 3, 2026`);
  assert.equal(r.vendor, "Northwind Traders Ltd");
  assert.equal(r.invoiceNumber, "NW/7781");
  assert.equal(r.date, "2026-11-03");
  assert.equal(r.dueDate, "2026-12-03");
  assert.equal(r.totalUsd, 1100);
});

test("non-USD totals are not reported as USD", () => {
  const r = parseInvoice("Invoice #: B-12\nTotal: €1.234,56");
  assert.equal(r.currency, "EUR");
  assert.equal(r.totalUsd, null);
});

test("day-first numeric dates", () => {
  assert.equal(findDate("issued 05/11/2026"), "2026-11-05");
  assert.equal(findDate("nothing here"), null);
});
