import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { readFileSync } from "node:fs";

// .env tabline: OWNER wallet pays gas in USDT (CIP-64 fee abstraction)
const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [
    l.slice(0, l.indexOf("=")).trim(),
    l.slice(l.indexOf("=") + 1).trim(),
  ]),
);
const account = privateKeyToAccount(env.OWNER_PRIVATE_KEY as `0x${string}`);
const client = createWalletClient({ account, chain: celo, transport: http(process.env.RPC_URL) });
const pc = createPublicClient({ chain: celo, transport: http(process.env.RPC_URL) });

const FEE = (process.env.FEE_TOKEN ?? "0x765DE816845861e75A25fCA122bb6898B8B1282a") as const;
const hash = await client.sendTransaction({
  to: account.address,
  value: 0n,
  feeCurrency: FEE,
  gas: Number(process.env.GAS ?? 80_000),
});
console.log("tx:", hash);
const r = await pc.waitForTransactionReceipt({ hash });
console.log("status:", r.status, "gasUsed:", r.gasUsed, "effectiveGasPrice:", r.effectiveGasPrice?.toString());
