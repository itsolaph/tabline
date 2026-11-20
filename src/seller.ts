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
import { SelfAgentVerifier } from "@selfxyz/agent-sdk";
import { PRICE_PER_CALL_USD, PORT, MAX_OUTSTANDING_USD } from "./config.js";
import {
  checkAltanaKey,
  publicClient,
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

/** Agent reports a settlement tx; seller marks the tab paid. */
app.post("/tab/settle-record", async (c) => {
  const body = (await c.req.json()) as {
    agent: string;
    amountUsd: number;
    txHash?: string;
  };
  const agent = getAddress(body.agent as Address);
  const t = tabFor(agent);
  const maxSettle = outstandingUsd(t);
  const amount = Math.min(body.amountUsd, maxSettle);
  if (amount <= 0) return c.json({ error: "nothing_outstanding" }, 400);
  recordSettlement(agent, amount, body.txHash);
  return c.json({ ok: true, settledUsd: amount, outstandingUsd: outstandingUsd(tabFor(agent)) });
});

/** Health: shows what the seller reads from chain right now. */
app.get("/tab/health", async (c) => {
  const block = await publicClient.getBlockNumber();
  return c.json({ ok: true, chainBlock: Number(block) });
});

/** Very small demo invoice parser (the "real job" stands in). */
function parseInvoice(text: string) {
  const vendor = text.match(/Vendor:\s*(.+)/i)?.[1]?.trim();
  const total = text.match(/Total:\s*\$?\s*([\d.,]+)/i)?.[1];
  const date = text.match(/Date:\s*(.+)/i)?.[1]?.trim();
  const number = text.match(/Invoice\s*#?:?\s*([A-Z0-9-]+)/i)?.[1];
  return {
    vendor: vendor ?? null,
    invoiceNumber: number ?? null,
    date: date ?? null,
    totalUsd: total ? Number(total.replace(/,/g, "")) : null,
  };
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[tab-seller] listening on :${info.port} — price/call $${PRICE_PER_CALL_USD}`);
});
