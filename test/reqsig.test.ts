import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { signRequest, verifyRequest, MAX_SKEW_MS } from "../src/reqsig.js";

const key = generatePrivateKey();
const publicKey = privateKeyToAccount(key).publicKey;
const other = generatePrivateKey();
const body = "INV-001 ACME Corp total 120.50 USD";
const now = 1_800_000_000_000;

async function check(over: Partial<Parameters<typeof verifyRequest>[0]> = {}, signer = key) {
  const h = await signRequest(signer, "POST", "/api/parse", body, now);
  return verifyRequest({
    publicKey, method: "POST", path: "/api/parse", body,
    ts: h["x-tab-ts"], sig: h["x-tab-sig"], now, ...over,
  });
}

test("valid signature by the named session key", async () => {
  assert.deepEqual(await check(), { ok: true });
});

test("copied headers without the key are rejected", async () => {
  assert.deepEqual(await check({}, other), { ok: false, reason: "wrong_signer" });
  assert.deepEqual(await check({ sig: undefined }), { ok: false, reason: "missing_signature" });
});

test("body or path tampering breaks the signature", async () => {
  assert.equal((await check({ body: body + " " })).ok, false);
  assert.equal((await check({ path: "/api/other" })).ok, false);
});

test("stale and replayed signatures are rejected", async () => {
  assert.deepEqual(await check({ now: now + MAX_SKEW_MS + 1 }), { ok: false, reason: "stale_signature" });
  const seen = new Set<string>();
  assert.deepEqual(await check({ seen }), { ok: true });
  assert.deepEqual(await check({ seen }), { ok: false, reason: "replayed_signature" });
});
