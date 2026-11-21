/**
 * TAB policy engine — pure functions, no I/O. Unit-tested in test/policy.test.ts.
 *
 * A seller extends tab terms (serve now, settle later) only to agents that
 * pass every check. Exposure is bounded by the seller's own max-outstanding
 * policy; the agent's Altana session cap is enforced by the Altana account
 * contract itself when the settlement executes.
 */
import type { Address } from "viem";
import { PRICE_PER_CALL_USD, MAX_OUTSTANDING_USD } from "./config.js";
import type { AltanaKeyStatus } from "./onchain.js";

export interface SelfProofStatus {
  isVerified: boolean;
  /** Proof freshness flag from the registry (hasHumanProof && isProofFresh). */
  isFresh: boolean;
  /** Verification strength (100 = NFC passport). Optional; from credentials. */
  strength?: number;
  /** Per-(human, service) nullifier, when the verifier exposes it. */
  nullifier?: string;
}

export type DenialReason =
  | "not_verified" // no fresh proof-of-human behind the agent
  | "no_altana_key" // session key missing / revoked / account unknown
  | "key_expired"
  | "tab_limit" // outstanding debt would exceed the seller's policy
  | "banned"; // nullifier-scoped ban (defaults, abuse)

export interface TabRecord {
  chargedUsd: number;
  settledUsd: number;
  chargeCount: number;
  lastChargeAt: number;
}

export interface TabDecision {
  allow: boolean;
  reason?: DenialReason;
  outstandingUsd: number;
  limitUsd: number;
}

export const emptyTab = (): TabRecord => ({
  chargedUsd: 0,
  settledUsd: 0,
  chargeCount: 0,
  lastChargeAt: 0,
});

export function outstandingUsd(tab: TabRecord): number {
  // Round to USDT's 6 decimals so 0.08 - 0.06 reads 0.02, not 0.0200…04.
  return Math.max(0, Math.round((tab.chargedUsd - tab.settledUsd) * 1e6) / 1e6);
}

/** The single decision point: should this agent be served on tab? */
export function decide(
  agent: Address,
  tab: TabRecord,
  self: SelfProofStatus,
  altana: AltanaKeyStatus,
  now = Date.now(),
  bannedNullifiers: ReadonlySet<string> = new Set(),
  priceUsd = PRICE_PER_CALL_USD,
  limitUsd = MAX_OUTSTANDING_USD,
): TabDecision {
  const outstanding = outstandingUsd(tab);
  const deny = (reason: DenialReason): TabDecision => ({
    allow: false,
    reason,
    outstandingUsd: outstanding,
    limitUsd,
  });

  if (self.nullifier && bannedNullifiers.has(self.nullifier)) return deny("banned");
  if (!self.isVerified || !self.isFresh) return deny("not_verified");
  if (!altana.keyOnAccount) return deny("no_altana_key");
  if (altana.expiry !== 0 && altana.expiry * 1000 <= now) return deny("key_expired");
  if (outstanding + priceUsd > limitUsd) return deny("tab_limit");

  return { allow: true, outstandingUsd: outstanding, limitUsd };
}
