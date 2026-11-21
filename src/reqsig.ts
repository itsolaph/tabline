/**
 * Request signing with the Altana session key.
 *
 * The tab headers (wallet + session public key) are public onchain, so on
 * their own they prove nothing — anyone could copy them and run up someone
 * else's tab. Every tab-charged request therefore carries a signature by the
 * session key over the method, path, body hash and a timestamp. The seller
 * recovers the signer and checks it is the key the headers name.
 */
import {
  keccak256,
  toBytes,
  recoverMessageAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount, publicKeyToAddress } from "viem/accounts";

export const MAX_SKEW_MS = 60_000;

export function requestDigest(method: string, path: string, body: string, ts: number): string {
  return `tab-v1\n${method.toUpperCase()}\n${path}\n${keccak256(toBytes(body))}\n${ts}`;
}

/** Agent side: headers to add to a tab-charged request. */
export async function signRequest(
  sessionKey: Hex,
  method: string,
  path: string,
  body: string,
  now = Date.now(),
): Promise<Record<string, string>> {
  const sig = await privateKeyToAccount(sessionKey).signMessage({
    message: requestDigest(method, path, body, now),
  });
  return { "x-tab-ts": String(now), "x-tab-sig": sig };
}

export type SigCheck = { ok: true } | { ok: false; reason: string };

/** Seller side: is this request signed by the session key it names? */
export async function verifyRequest(args: {
  publicKey: string;
  method: string;
  path: string;
  body: string;
  ts?: string;
  sig?: string;
  now?: number;
  seen?: Set<string>;
}): Promise<SigCheck> {
  const now = args.now ?? Date.now();
  if (!args.ts || !args.sig) return { ok: false, reason: "missing_signature" };
  const ts = Number(args.ts);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS)
    return { ok: false, reason: "stale_signature" };
  if (args.seen?.has(args.sig)) return { ok: false, reason: "replayed_signature" };
  let expected: string;
  let recovered: string;
  try {
    expected = publicKeyToAddress(args.publicKey as Hex);
    recovered = await recoverMessageAddress({
      message: requestDigest(args.method, args.path, args.body, ts),
      signature: args.sig as Hex,
    });
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (recovered.toLowerCase() !== expected.toLowerCase())
    return { ok: false, reason: "wrong_signer" };
  args.seen?.add(args.sig);
  return { ok: true };
}
