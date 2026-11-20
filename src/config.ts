/**
 * Central config: chain constants, addresses, prices.
 * All addresses are Celo mainnet (chain 42220) unless noted.
 */
import "dotenv/config";

export const RPC_URL = process.env.RPC_URL ?? "https://forno.celo.org";
export const CHAIN_ID = 42220;

/** SelfAgentRegistry — Self Agent ID (ERC-8004 identity + proof-of-human). */
export const SELF_AGENT_REGISTRY = "0xaC3DF9ABf80d0F5c020C06B04Cced27763355944";
/** USDT on Celo (EIP-3009, 6 decimals). Source: x402.celo.org token table. */
export const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
export const USDT_DECIMALS = 6;

/** Demo per-call price in USD. $0.02/call. */
export const PRICE_PER_CALL_USD = 0.02;
/** Seller tab policy: max outstanding debt per agent, in USD. */
export const MAX_OUTSTANDING_USD = Number(
  process.env.MAX_OUTSTANDING_USD ?? "1.00",
);

/** ERC-8021 attribution code for settlement txs. */
export const ATTRIB_CODE = process.env.ATTRIB_CODE ?? "tab";

export const PORT = Number(process.env.PORT ?? 8791);

/** Ledger file (demo-grade persistence). */
export const LEDGER_PATH =
  process.env.LEDGER_PATH ?? "./data/ledger.json";

export const usdToBase = (usd: number) =>
  BigInt(Math.round(usd * 10 ** USDT_DECIMALS));
export const baseToUsd = (base: bigint) =>
  Number(base) / 10 ** USDT_DECIMALS;
