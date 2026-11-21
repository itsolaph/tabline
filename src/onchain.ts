/**
 * Onchain reads used by the seller to decide whether an agent earns tab terms.
 *
 * Two independent signals, both public reads (no API keys):
 *  1. Self Agent ID  — does a fresh proof-of-human stand behind this agent?
 *  2. Altana Keystore — does the agent's session key exist, unexpired, unrevoked?
 */
import { createPublicClient, http, type Address } from "viem";
import { celo } from "viem/chains";
import {
  CELO,
  accountHasKey,
  getKey,
  keyHashForSessionOrKey,
} from "@altananetwork/sdk";
import { RPC_URL } from "./config.js";

export const publicClient = createPublicClient({
  chain: celo,
  transport: http(RPC_URL),
});

/** Cast: Altana SDK pins an older viem; the wire calls are identical. */
type AnyClient = Parameters<typeof accountHasKey>[0];
export const sdkClient = publicClient as unknown as AnyClient;

export interface AltanaKeyStatus {
  wallet: Address;
  /** Session public key hex, as advertised by the agent. */
  publicKey?: string;
  /** The account contract currently holds this key hash. */
  keyOnAccount: boolean;
  /** KeyStore entry valid: registered, unexpired, unrevoked. */
  keyStoreValid: boolean;
  /** Unix seconds expiry, 0 = non-expiring. */
  expiry: number;
}

/**
 * Check the Altana account + KeyStore for a wallet/session key.
 * The agent advertises its wallet + session public key in headers; the seller
 * verifies them against chain state. Nothing here is trusted from the agent
 * beyond the two identifiers.
 */
export async function checkAltanaKey(
  wallet: Address,
  publicKey?: string,
): Promise<AltanaKeyStatus> {
  let keyOnAccount = false;
  let keyStoreValid = false;
  let expiry = 0;
  try {
    if (publicKey) {
      const keyHash = keyHashForSessionOrKey(publicKey as `0x${string}`);
      keyOnAccount = await accountHasKey(sdkClient, wallet, keyHash);
      if (keyOnAccount) {
        const key = await getKey(sdkClient, wallet, keyHash);
        expiry = Number(key.expiry);
      }
    } else {
      // No key advertised: at least confirm the account exists onchain.
      const code = await publicClient.getBytecode({ address: wallet });
      keyOnAccount = (code?.length ?? 0) > 2;
    }
  } catch {
    // RPC or contract failure reads as "no valid key" — fail closed.
    keyOnAccount = false;
    keyStoreValid = false;
  }
  return { wallet, publicKey, keyOnAccount, keyStoreValid, expiry };
}

// ------------------------------------------------------------ settlement ----
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

/**
 * Read a claimed settlement from chain: how much USDT did `from` actually
 * send `to` in this transaction? The seller credits the tab with this number,
 * never with the amount the agent claims. Relay fees paid in the same tx
 * (transfers to other addresses) are ignored.
 */
export async function usdtPaidInTx(
  txHash: `0x${string}`,
  token: Address,
  from: Address,
  to: Address,
): Promise<bigint> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") return 0n;
  const pad = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
  let paid = 0n;
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === token.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics[1]?.toLowerCase() === pad(from) &&
      log.topics[2]?.toLowerCase() === pad(to)
    ) {
      paid += BigInt(log.data);
    }
  }
  return paid;
}
