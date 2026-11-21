# TAB

Net terms for AI agents, on Celo mainnet.

Paying per call makes sense when you have to. But a buyer an API already
trusts shouldn't need a signed payment on every request, and the seller
shouldn't have to eat a transaction for every two-cent call. Businesses fix
this with net terms: serve now, invoice later. Agents can't get net terms
because nobody knows who they are, and if they don't pay there's no way to
make them.

TAB gets around both problems without asking anyone who they are. Nobody
looks at a passport, a credit score or a reputation. The seller checks one
thing onchain: does the agent have a live, capped
[Altana](https://altana.network) session key on its wallet? If so, it gets a
tab.

- **Calls go on the tab.** No payment per request. The seller records $0.02 a
  call, up to a credit limit it sets itself.
- **Settlement is one transfer.** The agent pays everything it owes in a single
  USDT transfer from its Altana wallet, signed by the session key and tagged
  with ERC-8021.
- **The owner holds the kill switch.** Revoking the session key takes one
  transaction, and the seller rejects the very next call.
- **The cap isn't a promise.** The Altana account contract enforces the daily
  spend limit and the allowed calls, so the session key can do nothing except
  send USDT, up to the cap.

## Proven on Celo mainnet

All of these are real transactions from this repo's CLI:

| Step | Transaction |
|---|---|
| Owner grants a session key: USDT `transfer` only, $5/day, 7 days, registered in the Celo KeyStore | [`0x81fa3278…bb1c`](https://celoscan.io/tx/0x81fa3278852e72abf118a3d6330fe9d2d8b40ee28bcde3184b9bbccaf9d5bb1c) |
| 3 API calls on the tab → owes $0.06 | (off-chain, nothing to pay yet) |
| Agent settles $0.06 in one USDT transfer, ERC-8021 tagged | [`0x7f89751b…c9c3`](https://celoscan.io/tx/0x7f89751bbdc5866e97e5a8f2de6abd0afa9da6607440120c6d35d100e4fdc9c3) |
| Owner revokes the key | [`0x165b2756…f9fb`](https://celoscan.io/tx/0x165b2756e4de0a617ef144f6c4b01f3a79a044e35550cc1bc04d35e551e8f9fb) |
| Next call | `HTTP 403 {"error":"no_altana_key"}` |
| ERC-8004 identity minted through Altana `registerErc8004Agent` (agentId **10081**) | [`0xc9c9669c…5d45`](https://celoscan.io/tx/0xc9c9669cf24f7175a01fae78a1253f95f81c28904cb1f58ea609f2806bc85d45) |
| Identity record published with its registration entry | [`0x7f7cabc8…779a`](https://celoscan.io/tx/0x7f7cabc873b0706a46a9278940c9b6ca59ae3d5cc42e515375630f5ab848779a) |
| Second settlement, credited only after the seller read it from chain | [`0xc166e0c3…d7a3`](https://celoscan.io/tx/0xc166e0c366570071b36e966015e41ad890ee939d936ff24b107a85472d61d7a3) |

Agent wallet: [`0x5aeC9aC78bb3E045d2f85e311aD3385B8116d0c5`](https://celoscan.io/address/0x5aeC9aC78bb3E045d2f85e311aD3385B8116d0c5)
· ERC-8004 registry: [`0x8004A169…a432`](https://celoscan.io/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432)

## How a call is admitted

```
agent                                   seller                          Celo
  │ POST /api/parse                        │                              │
  │  x-tab-wallet, x-tab-session-key       │                              │
  │  x-tab-ts, x-tab-sig ─────────────────►│ 1. signature by that key?    │
  │                                        │ 2. key on the account? ─────►│ Altana account
  │                                        │    expired? ◄────────────────│
  │                                        │ 3. owed + $0.02 ≤ limit?     │
  │ ◄──────────── 200 + result, tab +$0.02 │                              │
  │                                        │                              │
  │ USDT.transfer(seller, owed) + 8021 tag ──────────────────────────────►│ cap enforced here
  │ POST /tab/settle-record {txHash} ─────►│ 4. read the Transfer logs ──►│
  │ ◄───────────── credited what was paid  │                              │
```

1. **Request signature.** The wallet and session key in the headers are public
   onchain data, so on their own they prove nothing. Every call is signed by
   the session key over the method, path, body hash and a timestamp. Stale,
   replayed or wrong-signer requests get a `401`.
2. **Key check.** The seller reads the Altana account to see whether it still
   holds the key and when it expires. Revoked or expired means `403`.
3. **Credit limit.** Owed amount plus the price has to stay under the seller's
   limit (default $1). Otherwise the call gets `403 tab_limit`.
4. **Settlement check.** The seller doesn't take the agent's word for it. It
   fetches the receipt, adds up the USDT `Transfer` logs from the agent's
   wallet to the seller's payout address, and credits only that amount. Each
   transaction can be credited once. Relay fees paid in the same transaction
   are ignored.

The paid work is a small invoice parser: vendor, number, issue and due
dates, total and currency, from labelled or free-form text. It's
deterministic on purpose, since the point of the demo is the payment terms.

## Run it

```bash
npm install
cp .env.example .env        # fill in keys; .env is gitignored
npm test                    # 17 tests: policy, request signing, invoice parsing

npm run seller              # http://127.0.0.1:8791
npm run agent -- setup 5 7  # owner grants a $5/day, 7-day session key
npm run agent -- call       # one call on the tab
npm run agent -- settle     # pay the tab in one tagged USDT transfer
npm run agent -- revoke     # owner kills the key; the next call is refused
npm run agent -- register   # ERC-8004 identity for the wallet
```

The owner key has to be fresh: Altana delegates the owner's EOA with
EIP-7702, and its first grant expects the account nonce to be 0. Fund it by
sending to it, and don't send transactions from it yourself.

Gas: the Altana relay takes its fee in USDT, so the agent never needs CELO.
The owner pays the one-time KeyStore registration in CELO.

## Layout

```
src/agent.ts     CLI: setup / call / settle / revoke / register / status
src/seller.ts    Hono server: /api/parse (on tab), /tab/summary, /tab/settle-record
src/reqsig.ts    session-key request signing and verification
src/onchain.ts   chain reads: Altana key status, USDT paid in a tx
src/policy.ts    the admission decision (pure)
src/invoice.ts   the paid work: invoice field extraction
src/ledger.ts    JSON ledger (demo grade)
scripts/         CIP-64 fee-currency probe
test/            unit tests
```

## Limits, stated plainly

- Settlement is agent-initiated. A session key belongs to the agent, so the
  seller can't pull money. The seller's protection is the credit limit plus
  refusing service until the tab is paid, which is the same as net terms
  anywhere else.
- The ledger is a JSON file. A production seller would use a database and
  settle on a schedule.
- `REQUIRE_SELF=true` adds an optional Self Agent ID proof-of-human gate on
  top. It's off by default because TAB is meant to work without identity.

## Built with

[Altana SDK](https://www.npmjs.com/package/@altananetwork/sdk) (wallets,
session keys, ERC-8004),
[@celo/attribution-tags](https://www.npmjs.com/package/@celo/attribution-tags)
(ERC-8021), [viem](https://viem.sh), [Hono](https://hono.dev). Built for
Celo's Agents Open for Business, Altana Agent Wallets track.

## License

MIT
