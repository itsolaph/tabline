/**
 * Demo-grade JSON ledger. One file, atomic-ish writes, no dependencies.
 * Tracks one tab record per agent address + a nullifier banlist.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Address } from "viem";
import { LEDGER_PATH, PRICE_PER_CALL_USD } from "./config.js";
import { emptyTab, type TabRecord } from "./policy.js";

interface LedgerFile {
  tabs: Record<string, TabRecord>;
  bannedNullifiers: string[];
  settlements: {
    at: number;
    agent: string;
    amountUsd: number;
    txHash?: string;
  }[];
}

let cache: LedgerFile | null = null;

function load(): LedgerFile {
  if (cache) return cache;
  if (existsSync(LEDGER_PATH)) {
    cache = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as LedgerFile;
  } else {
    cache = { tabs: {}, bannedNullifiers: [], settlements: [] };
  }
  return cache;
}

function save() {
  if (!cache) return;
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  writeFileSync(LEDGER_PATH, JSON.stringify(cache, null, 2));
}

export function tabFor(agent: Address): TabRecord {
  const l = load();
  if (!l.tabs[agent.toLowerCase()]) l.tabs[agent.toLowerCase()] = emptyTab();
  return l.tabs[agent.toLowerCase()];
}

export function recordCharge(agent: Address, usd = PRICE_PER_CALL_USD) {
  const t = tabFor(agent);
  t.chargedUsd = Math.round((t.chargedUsd + usd) * 1e6) / 1e6;
  t.chargeCount += 1;
  t.lastChargeAt = Date.now();
  save();
}

export function recordSettlement(
  agent: Address,
  amountUsd: number,
  txHash?: string,
) {
  const t = tabFor(agent);
  t.settledUsd = Math.round((t.settledUsd + amountUsd) * 1e6) / 1e6;
  load().settlements.push({
    at: Date.now(),
    agent,
    amountUsd,
    txHash,
  });
  save();
}

export function banNullifier(nullifier: string) {
  load().bannedNullifiers.push(nullifier);
  save();
}

export function bannedNullifiers(): ReadonlySet<string> {
  return new Set(load().bannedNullifiers);
}

export function allTabs(): Record<string, TabRecord> {
  return load().tabs;
}
