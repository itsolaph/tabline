import "dotenv/config";
/**
 * TAB agent client.
 *
 * Subcommands:
 *   setup   — create/derive the Altana wallet, grant a capped session key
 *             (KeyStore-registered so any seller can verify it onchain),
 *             persist the session, print the tab identity headers.
 *   status  — Self proof state + Altana key state + local session summary.
 *   call    — run one tab-charged API call against the seller.
 *   settle  — pay the outstanding tab in one USDT transfer from the Altana
 *             wallet under the session key, tagged ERC-8021.
 *   revoke  — owner action: revoke the session key (1 tx) — tab access dies.
 *
 * Keys come from the environment; nothing is ever committed.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import {
  createClient,
  signerFromPrivateKey,
  CELO,
  serializeSession,
  deserializeSession,
  type Session,
} from "@altananetwork/sdk";
import { SelfAgent } from "@selfxyz/agent-sdk";
import { toDataSuffix } from "@celo/attribution-tags";
import { USDT, RPC_URL, ATTRIB_CODE, usdToBase } from "./config.js";

const SESSION_PATH = process.env.TAB_SESSION_PATH ?? "./.self/tab-session.json";
const SELLER_URL = process.env.SELLER_URL ?? "http://127.0.0.1:8791";

function newClient() {
  return createClient({ chains: [CELO], defaultChainId: 42220 });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in .env`);
  return v;
}

function loadSession(): Session {
  if (!existsSync(SESSION_PATH)) {
    throw new Error(`no session at ${SESSION_PATH} — run \`setup\` first`);
  }
  // Stored half has no key material; marry it back to the session signer.
  return deserializeSession(
    JSON.parse(readFileSync(SESSION_PATH, "utf8")),
    signerFromPrivateKey(requireEnv("AGENT_SESSION_KEY") as `0x${string}`),
  );
}

function saveSession(session: Session) {
  mkdirSync(".self", { recursive: true });
  writeFileSync(SESSION_PATH, JSON.stringify(serializeSession(session), null, 2));
  console.log(`session saved → ${SESSION_PATH}`);
}

function newSelfAgent(): SelfAgent {
  return new SelfAgent({
    privateKey: requireEnv("AGENT_PRIVATE_KEY"),
    network: "mainnet",
    rpcUrl: RPC_URL,
  });
}

/** USDT transfer calldata with the ERC-8021 attribution suffix appended. */
function taggedTransfer(to: string, amountBase: bigint): {
  to: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
} {
  const selector = "0xa9059cbb"; // transfer(address,uint256)
  const paddedTo = to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const paddedAmount = amountBase.toString(16).padStart(64, "0");
  const suffix = toDataSuffix(ATTRIB_CODE);
  return {
    to: USDT as `0x${string}`,
    value: 0n,
    data: (selector + paddedTo + paddedAmount + suffix.replace(/^0x/, "")) as `0x${string}`,
  };
}

// ---------------------------------------------------------------- setup ----
async function setup(opts: { spendLimitUsd: string; days: string }) {
  const ownerSigner = signerFromPrivateKey(
    requireEnv("OWNER_PRIVATE_KEY") as `0x${string}`,
  );
  const sessionSigner = signerFromPrivateKey(
    requireEnv("AGENT_SESSION_KEY") as `0x${string}`,
  );
  const client = newClient();

  // Idempotent: reuse the wallet from a previous run if present.
  // createWallet is NOT idempotent server-side (each call appends an auth
  // item, advancing the account's expected nonce) — never repeat it.
  let walletAddress: `0x${string}` | undefined;
  const walletMemo = ".self/wallet-address.txt";
  if (existsSync(walletMemo)) {
    walletAddress = readFileSync(walletMemo, "utf8").trim() as `0x${string}`;
    console.log(`reusing wallet ${walletAddress}`);
  } else if (existsSync(SESSION_PATH)) {
    walletAddress = (JSON.parse(readFileSync(SESSION_PATH, "utf8")) as Session)
      .walletAddress as `0x${string}`;
    console.log(`reusing wallet ${walletAddress}`);
  } else {
    const created = await client.createWallet({ signer: ownerSigner });
    walletAddress = created.address as `0x${string}`;
    mkdirSync(".self", { recursive: true });
    writeFileSync(walletMemo, walletAddress);
    console.log(`wallet created ${walletAddress}`);
  }

  const result = await client.grantSession({
    wallet: { address: walletAddress },
    signer: ownerSigner,
    sessionSigner,
    permissions: {
      // Only USDT.transfer — the settlement call — and nothing else.
      calls: [{ to: USDT as `0x${string}`, signature: "transfer(address,uint256)" }],
      spend: [
        { token: USDT as `0x${string}`, limit: usdToBase(Number(opts.spendLimitUsd)), period: "day" },
      ],
    },
    expiry: Math.floor(Date.now() / 1000) + Number(opts.days) * 86_400,
    chainId: 42220,
  });

  // GrantSessionResult is a Session plus grant metadata.
  if (result.status !== "granted") {
    throw new Error(`grantSession failed: ${JSON.stringify(result.legs)}`);
  }
  const session: Session = result;
  saveSession(session);
  console.log(`grant tx: ${result.transactionHash ?? "(none)"}`);
  const legs = [...result.legs, ...(await result.registration), ...(await result.cacheSync)];
  for (const l of legs) {
    const leg = l as { kind?: string; chainId?: number; status?: string; transactionHash?: string };
    console.log(`  leg ${leg.kind}@${leg.chainId}: ${leg.status} ${leg.transactionHash ?? ""}`);
  }
  if (result.agentIdentities?.length)
    console.log("agent identities:", JSON.stringify(result.agentIdentities));
  console.log(
    `session granted: spend cap $${opts.spendLimitUsd}/day USDT, expiry ${opts.days}d`,
  );
  console.log(`tab identity → x-tab-wallet: ${session.walletAddress}`);
  console.log(`tab identity → x-tab-session-key: ${session.publicKey}`);
}

// --------------------------------------------------------------- status ----
async function status() {
  const agent = newSelfAgent();
  const info = await agent.getInfo();
  console.log(
    "self:",
    JSON.stringify(info, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
  const session = loadSession();
  console.log("altana wallet:", session.walletAddress);
  console.log("session expiry:", new Date(session.expiry * 1000).toISOString());
  console.log("session pubkey:", session.publicKey);
}

// ----------------------------------------------------------------- call ----
async function call(invoiceText: string) {
  const session = loadSession();
  const init = {
    method: "POST",
    body: invoiceText,
    headers: {
      "content-type": "text/plain",
      "x-tab-wallet": session.walletAddress,
      "x-tab-session-key": session.publicKey,
    },
  };
  // Self signing only when the seller demands it (REQUIRE_SELF=true).
  const res =
    process.env.REQUIRE_SELF === "true"
      ? await newSelfAgent().fetch(`${SELLER_URL}/api/parse`, init)
      : await fetch(`${SELLER_URL}/api/parse`, init);
  console.log(`HTTP ${res.status}`);
  console.log(await res.text());
}

// --------------------------------------------------------------- settle ----
async function settle() {
  const summary = (await (await fetch(`${SELLER_URL}/tab/summary`)).json()) as {
    agents: Record<string, { outstandingUsd: number }>;
  };
  // Tab identity = the Altana wallet (or the Self agent address if REQUIRE_SELF).
  const my = (
    process.env.REQUIRE_SELF === "true"
      ? readFileSync(".self/agent-address", "utf8")
      : loadSession().walletAddress
  ).trim().toLowerCase();
  const mine = summary.agents[my];
  if (!mine || mine.outstandingUsd <= 0) {
    console.log("nothing outstanding; seller summary:", JSON.stringify(summary.agents));
    return;
  }
  const sellerAddress = requireEnv("SELLER_ADDRESS");
  console.log(`settling $${mine.outstandingUsd} → ${sellerAddress}`);

  const client = newClient();
  const result = await client.execute({
    session: loadSession(),
    calls: taggedTransfer(sellerAddress, usdToBase(mine.outstandingUsd)),
    chainId: 42220,
  });
  console.log(
    "execute:",
    JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
  const rec = await fetch(`${SELLER_URL}/tab/settle-record`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: my,
      amountUsd: mine.outstandingUsd,
      txHash: (result as { transactionHash?: string }).transactionHash,
    }),
  });
  console.log("seller recorded:", await rec.text());
}

// --------------------------------------------------------------- revoke ----
async function revoke() {
  const session = loadSession();
  const client = newClient();
  const result = await client.revokeSession({
    wallet: { address: session.walletAddress as `0x${string}` },
    signer: signerFromPrivateKey(requireEnv("OWNER_PRIVATE_KEY") as `0x${string}`),
    session,
  });
  console.log(
    JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
}

// ----------------------------------------------------------------- main ----
const [cmd, ...args] = process.argv.slice(2);
const invoiceSample = `Vendor: Sinar Jaya Paper Co
Invoice #: SJP-2026-1143
Date: 2026-11-20
Total: $184.50`;

const commands: Record<string, () => Promise<void>> = {
  setup: () => setup({ spendLimitUsd: args[0] ?? "5", days: args[1] ?? "7" }),
  status,
  call: () => call(args[0] ?? invoiceSample),
  settle,
  revoke,
};

if (!cmd || !commands[cmd]) {
  console.log("usage: tab-agent <setup|status|call|settle|revoke> [args]");
  process.exit(1);
}
commands[cmd]().catch((e: unknown) => {
  const err = e as Record<string, unknown>;
  console.error("error:", (err as { message?: string }).message ?? String(e));
  for (const k of ["code", "detail", "relayMessage", "statement", "action"])
    if (err[k] !== undefined) console.error(`${k}:`, err[k]);
  if (err.cause) console.error("cause:", err.cause);
  process.exit(1);
});
