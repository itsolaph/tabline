/**
 * Policy engine tests — the admission logic that decides who gets tab terms.
 * Pure functions; no chain, no I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, emptyTab, outstandingUsd, type TabRecord, type SelfProofStatus } from "../src/policy.js";
import type { AltanaKeyStatus } from "../src/onchain.js";

const agent = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const PRICE = 0.02;
const LIMIT = 1.0;

function altana(over: Partial<AltanaKeyStatus> = {}): AltanaKeyStatus {
  return {
    wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`,
    publicKey: "0x04abc",
    keyOnAccount: true,
    keyStoreValid: true,
    expiry: Math.floor(Date.now() / 1000) + 86_400, // valid for a day
    ...over,
  };
}

function self(over: Partial<SelfProofStatus> = {}): SelfProofStatus {
  return { isVerified: true, isFresh: true, nullifier: "12345", ...over };
}

const now = Date.now();

test("fresh verified agent with live key gets served", () => {
  const d = decide(agent, emptyTab(), self(), altana(), now, new Set(), PRICE, LIMIT);
  assert.equal(d.allow, true);
});

test("unverified agent is turned away", () => {
  const d = decide(agent, emptyTab(), self({ isVerified: false }), altana(), now, new Set(), PRICE, LIMIT);
  assert.equal(d.allow, false);
  assert.equal(d.reason, "not_verified");
});

test("stale proof (expired freshness) is turned away", () => {
  const d = decide(agent, emptyTab(), self({ isFresh: false }), altana(), now, new Set(), PRICE, LIMIT);
  assert.equal(d.reason, "not_verified");
});

test("revoked/missing Altana session key is turned away", () => {
  const d = decide(agent, emptyTab(), self(), altana({ keyOnAccount: false }), now, new Set(), PRICE, LIMIT);
  assert.equal(d.reason, "no_altana_key");
});

test("expired session key is turned away", () => {
  const d = decide(
    agent,
    emptyTab(),
    self(),
    altana({ expiry: Math.floor(now / 1000) - 1 }),
    now,
    new Set(),
    PRICE,
    LIMIT,
  );
  assert.equal(d.reason, "key_expired");
});

test("outstanding debt above the limit stops service", () => {
  const tab: TabRecord = { ...emptyTab(), chargedUsd: 1.0 }; // owes exactly the limit
  const d = decide(agent, tab, self(), altana(), now, new Set(), PRICE, LIMIT);
  assert.equal(d.allow, false);
  assert.equal(d.reason, "tab_limit");
});

test("a banned nullifier is turned away before anything else", () => {
  const d = decide(agent, emptyTab(), self(), altana({ keyOnAccount: false }), now, new Set(["12345"]), PRICE, LIMIT);
  assert.equal(d.reason, "banned");
});

test("outstanding math rounds through charges and settlements", () => {
  const t = emptyTab();
  t.chargedUsd = 0.02 * 30; // 30 calls
  t.settledUsd = 0.5;
  assert.ok(Math.abs(outstandingUsd(t) - 0.1) < 1e-9);
});
