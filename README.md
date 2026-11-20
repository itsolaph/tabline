# TAB

Deferred settlement ("tabs") for x402 API sellers on Celo mainnet.

A seller serves verified agents first and collects once a day in a single
tagged transaction. Trust is read from chain, never from the agent:

1. **Self Agent ID** — the seller recovers the request signature, then checks
   the `SelfAgentRegistry` (ERC-8004 + proof-of-human): a fresh passport proof
   behind the agent's key, one agent per human.
2. **Altana Keystore** — the agent pays settlements from a non-custodial
   Altana wallet under an owner-granted session key (spend cap, expiry).
   The seller verifies the session key's existence and expiry against the
   public onchain Keystore before serving; the spend cap itself is enforced
   by the Altana account contract when the settlement executes.
3. **Tab policy** — outstanding debt per agent stays under the seller's own
   limit. Revoking the session key (1 tx) suspends the agent instantly.

Unverified or banned agents get a machine-readable rejection — the demo shows
the agent that gets turned away.

## Layout

```
src/config.ts    addresses, prices, policy constants
src/policy.ts    the admission decision (pure, unit-tested)
src/onchain.ts   public chain reads (Self registry via SDK, Altana keys)
src/ledger.ts    demo-grade JSON ledger
src/seller.ts    Hono server: /api/parse (tab-charged), /tab/summary, /tab/health
src/agent.ts     agent CLI: setup / status / call / settle / revoke
test/            policy tests
```

## Quickstart

```bash
npm install
cp .env.example .env   # fill keys (never commit .env)
npm test
npm run seller         # http://127.0.0.1:8791
npm run agent -- setup # grant a capped session key
npm run agent -- call  # tab-charged call
npm run agent -- settle # one USDT transfer, ERC-8021 tagged
npm run agent -- revoke # watch the next call get rejected
```

## Tracks

- **Self Agent ID: Verified Agent Payments** — identity gates the terms; settlements in USDT on Celo.
- **Altana Agent Wallets** — the agent spends only from an owner-granted session cap.

## License

MIT
