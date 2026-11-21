import "dotenv/config";
import { parseInvoice } from "./invoice.js";
import { verifyRequest } from "./reqsig.js";
/**
 * TAB seller server (Hono).
 *
 * Serves an API (demo: invoice parser) on tab terms to agents that pass:
 *   1. Self Agent ID — signature-recovered identity + fresh proof-of-human
 *   2. Altana Keystore — live, unexpired session key on the agent's wallet
 *   3. Tab policy — outstanding debt stays under the seller's limit
 *
 * Agents that fail get turned away with a machine-readable reason —
 * the same demo moment Self recommends: "show the agent that gets rejected".
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getAddress, type Address } from "viem";
import { PRICE_PER_CALL_USD, PORT, MAX_OUTSTANDING_USD, USDT, baseToUsd } from "./config.js";

/**
 * Self Agent ID layer is OPTIONAL (env REQUIRE_SELF, default off):
 * admission then rides on the Altana session key alone — validity +
 * expiry are read live from the public onchain Keystore, which is the
 * credit signal for tab terms. Flip REQUIRE_SELF=true to additionally
 * demand a fresh proof-of-human behind the agent key.
 */
const REQUIRE_SELF = process.env.REQUIRE_SELF === "true";

import { SelfAgentVerifier } from "@selfxyz/agent-sdk";
import {
  checkAltanaKey,
  publicClient,
  usdtPaidInTx,
  type AltanaKeyStatus,
} from "./onchain.js";
import {
  decide,
  outstandingUsd,
  type SelfProofStatus,
  type TabDecision,
} from "./policy.js";
import {
  tabFor,
  recordCharge,
  recordSettlement,
  bannedNullifiers,
  allTabs,
  settlementSeen,
} from "./ledger.js";

const verifier = new SelfAgentVerifier({
  network: "mainnet",
  maxAgentsPerHuman: 1,
});

const app = new Hono();

interface TabHeaders {
  signature: string;
  timestamp: string;
  altanaWallet?: Address;
  altanaPubKey?: string;
}

function readTabHeaders(h: Record<string, string>): TabHeaders {
  return {
    signature: h["x-self-agent-signature"] ?? "",
    timestamp: h["x-self-agent-timestamp"] ?? "",
    altanaWallet: h["x-tab-wallet"] as Address | undefined,
    altanaPubKey: h["x-tab-session-key"],
  };
}

/** Signatures already used (replay guard within the timestamp window). */
const seenSignatures = new Set<string>();

/** Full admission pipeline shared by every priced route. */
async function admit(
  rawBody: string,
  headers: Record<string, string>,
  url: string,
  method: string,
): Promise<
  | { ok: true; agent: Address; altana: AltanaKeyStatus; self: SelfProofStatus; nullifier: string }
  | { ok: false; status: 401 | 402 | 403; body: Record<string, unknown> }
> {
  const th = readTabHeaders(headers);
  // The tab headers are public onchain data; only a signature by the named
  // session key proves the caller holds it.
  if (th.altanaPubKey) {
    const sig = await verifyRequest({
      publicKey: th.altanaPubKey,
      method,
      path: url,
      body: rawBody,
      ts: headers["x-tab-ts"],
      sig: headers["x-tab-sig"],
      seen: seenSignatures,
    });
    if (!sig.ok) return { ok: false, status: 401, body: { error: sig.reason } };
  }
  if (!REQUIRE_SELF) {
    // Altana-key-only admission: no Self signature required.
    if (!th.altanaWallet || !th.altanaPubKey) {
      return {
        ok: false,
        status: 401,
        body: { error: "missing_tab_headers", hint: "send x-tab-wallet + x-tab-session-key" },
      };
    }
    const altana = await checkAltanaKey(getAddress(th.altanaWallet), th.altanaPubKey);
    const d = decide(
      getAddress(th.altanaWallet),
      tabFor(getAddress(th.altanaWallet)),
      { isVerified: true, isFresh: true }, // self layer not required
      altana,
      Date.now(),
      bannedNullifiers(),
      PRICE_PER_CALL_USD,
      MAX_OUTSTANDING_USD,
    );
    if (!d.allow) {
      return {
        ok: false,
        status: 403,
        body: { error: d.reason },
      };
    }
    return {
      ok: true,
      agent: getAddress(th.altanaWallet),
      altana,
      self: { isVerified: true, isFresh: true },
      nullifier: "",
    };
  }

  if (!th.signature || !th.timestamp) {
    return {
      ok: false,
      status: 401,
      body: { error: "missing_self_headers", hint: "sign with SelfAgent.fetch()" },
    };
  }

  // 1. Self Agent ID: recover signer, check registry, freshness, sybil.
  let result;
  try {
    result = await verifier.verify({
      signature: th.signature,
      timestamp: th.timestamp,
      method,
      url,
      body: rawBody,
    });
  } catch (e) {
    return {
      ok: false,
      status: 401,
      body: { error: "self_verification_failed", detail: String(e) },
    };
  }

  const self: SelfProofStatus = {
    isVerified: result.valid,
    isFresh: result.valid, // verifier enforces hasHumanProof && isProofFresh
    nullifier: result.nullifier ? result.nullifier.toString() : undefined,
  };

  if (!result.valid) {
    return {
      ok: false,
      status: 403,
      body: { error: "not_verified", detail: result.error ?? "unknown" },
    };
  }

  // 2. Altana session key: chain state, fail closed.
  if (!th.altanaWallet) {
    return {
      ok: false,
      status: 401,
      body: { error: "missing_tab_headers", hint: "send x-tab-wallet + x-tab-session-key" },
    };
  }
  const altana = await checkAltanaKey(getAddress(th.altanaWallet), th.altanaPubKey);

  // 3. Tab policy.
  const agent = getAddress(result.agentAddress as Address);
  const decision: TabDecision = decide(
    agent,
    tabFor(agent),
    self,
    altana,
    Date.now(),
    bannedNullifiers(),
  );
  if (!decision.allow) {
    return {
      ok: false,
      status: 403,
      body: {
        error: decision.reason,
        outstandingUsd: decision.outstandingUsd,
        limitUsd: decision.limitUsd,
      },
    };
  }

  return { ok: true, agent, altana, self, nullifier: self.nullifier ?? "" };
}

/** Demo endpoint: parse a plain-text invoice. $0.02 per call, on tab. */
app.post("/api/parse", async (c) => {
  const raw = await c.req.text();
  const url = new URL(c.req.url).pathname;
  const admission = await admit(
    raw,
    Object.fromEntries([...c.req.raw.headers]),
    url,
    "POST",
  );
  if (!admission.ok) return c.json(admission.body, admission.status as 401 | 402 | 403);

  const invoice = parseInvoice(raw);
  recordCharge(admission.agent);
  const tab = tabFor(admission.agent);
  return c.json({
    ok: true,
    invoice,
    priceUsd: PRICE_PER_CALL_USD,
    outstandingUsd: outstandingUsd(tab),
    limitUsd: MAX_OUTSTANDING_USD,
    settledNote: "settle via POST /tab/settle (agent-initiated)",
  });
});

/** Seller dashboard: tab state per agent. */
app.get("/tab/summary", (c) => {
  const tabs = allTabs();
  const out: Record<string, unknown> = {};
  for (const [addr, t] of Object.entries(tabs)) {
    out[addr] = {
      chargedUsd: t.chargedUsd,
      settledUsd: t.settledUsd,
      outstandingUsd: outstandingUsd(t),
      limitUsd: MAX_OUTSTANDING_USD,
      calls: t.chargeCount,
      lastChargeAt: t.lastChargeAt ? new Date(t.lastChargeAt).toISOString() : null,
    };
  }
  return c.json({ policy: { maxOutstandingUsd: MAX_OUTSTANDING_USD }, agents: out });
});

/**
 * Agent reports a settlement tx. The seller reads the tx from chain and
 * credits the tab with the USDT the agent's wallet actually sent the seller's
 * payout address in it — the claimed amount is only an upper bound, and each
 * tx can be credited once.
 */
const SELLER_ADDRESS = process.env.SELLER_ADDRESS as Address | undefined;
app.post("/tab/settle-record", async (c) => {
  const body = (await c.req.json()) as { agent: string; amountUsd: number; txHash?: string };
  if (!SELLER_ADDRESS) return c.json({ error: "seller_address_not_configured" }, 500);
  if (!body.txHash || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash))
    return c.json({ error: "tx_hash_required" }, 400);
  if (settlementSeen(body.txHash)) return c.json({ error: "tx_already_credited" }, 409);
  const agent = getAddress(body.agent as Address);
  const t = tabFor(agent);
  let paidBase: bigint;
  try {
    paidBase = await usdtPaidInTx(body.txHash as `0x${string}`, USDT as Address, agent, getAddress(SELLER_ADDRESS));
  } catch {
    return c.json({ error: "tx_not_found" }, 404);
  }
  const paidUsd = baseToUsd(paidBase);
  if (paidUsd <= 0) return c.json({ error: "no_payment_in_tx", txHash: body.txHash }, 402);
  const amount = Math.min(paidUsd, outstandingUsd(t));
  if (amount <= 0) return c.json({ error: "nothing_outstanding" }, 400);
  recordSettlement(agent, amount, body.txHash);
  return c.json({
    ok: true,
    verifiedOnchainUsd: paidUsd,
    settledUsd: amount,
    outstandingUsd: outstandingUsd(tabFor(agent)),
  });
});

/** Health: shows what the seller reads from chain right now. */
app.get("/tab/health", async (c) => {
  const block = await publicClient.getBlockNumber();
  return c.json({ ok: true, chainBlock: Number(block) });
});

/** What a visitor (or an agent) sees at the root: the terms of service. */
app.get("/", (c) =>
  c.json({
    service: "TAB — net terms for agents",
    chain: "celo-mainnet (42220)",
    erc8004AgentId: 10081,
    terms: {
      priceUsdPerCall: PRICE_PER_CALL_USD,
      creditLimitUsd: MAX_OUTSTANDING_USD,
      settleIn: "USDT",
      payTo: SELLER_ADDRESS ?? null,
    },
    admission: [
      "x-tab-wallet: your Altana wallet",
      "x-tab-session-key: the session public key granted on it",
      "x-tab-ts + x-tab-sig: session-key signature over method, path, body hash, ts",
    ],
    routes: {
      "POST /api/parse": "invoice text -> fields, charged to your tab",
      "GET /tab/summary": "open tabs",
      "POST /tab/settle-record": "{agent, txHash} -> credited from onchain Transfer logs",
      "GET /tab/health": "liveness + chain head",
    },
    source: "https://github.com/itsolaph/tabline",
  }),
);

serve({ fetch: app.fetch, port: PORT, hostname: process.env.HOST ?? "127.0.0.1" }, (info) => {
  console.log(`[tab-seller] listening on :${info.port} — price/call $${PRICE_PER_CALL_USD}`);
});
