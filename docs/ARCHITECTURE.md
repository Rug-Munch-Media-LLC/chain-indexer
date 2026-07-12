# Chain Indexer — Solana + Bridge Tracking Architecture

> **Version**: 1.0
> **Date**: 2026-07-12
> **Status**: Design — pending review

---

## 1. Overview

The chain-indexer currently ingests 11 EVM chains via Subsquid Pipes SDK plus Tron via
TronGrid. Events are written as NDJSON to disk, partitioned by `chain/YYYY-MM-DD/`, then
synced to Cloudflare R2 via rclone.

This document defines the architecture for two new capabilities:

1. **Solana ingestion** — SPL token transfers, Jupiter DEX swaps, pump.fun launches,
   and Raydium/Orca LP activity.
2. **Cross-chain bridge tracking** — Wormhole, LayerZero/Stargate, Across, and CCIP
   fund flows across chains.

Both must feed into the same NDJSON → R2 pipeline with zero changes to `sync.ts`.

---

## 2. Existing Codebase Patterns (Reference)

Before designing, we studied the existing modules. Here is what every new module
must follow.

### 2.1 Module structure

Each ingestion source is a single file under `src/`:

| File | Responsibility |
|------|---------------|
| `src/index.ts` | CLI, orchestration loop, periodic R2 sync |
| `src/chains.ts` | `ChainConfig` interface, chain registry, `ENABLED_CHAINS` |
| `src/subsquid.ts` | EVM ingestion via Subsquid Pipes SDK |
| `src/tron.ts` | TRC-20 ingestion via TronGrid polling |
| `src/sync.ts` | rclone push to R2 (read-only for new code) |

### 2.2 ChainConfig pattern

```ts
// src/chains.ts
interface ChainConfig {
  id: string;           // short key: 'ethereum', 'tron', 'solana'
  name: string;          // display name
  subsquidNetwork: string | null;  // Subsquid archive name, null = custom
  rpcPool: string[];     // fallback RPC URLs
  blockTime: number;     // seconds
  confirmations: number; // confirmations for finality
}
```

Each chain has its own config object in the `CHAINS` record. The `ENABLED_CHAINS`
array lists which chains actually run. Tron broke the pattern by having
`subsquidNetwork: null` and using a custom ingestion function selected in
`index.ts` with an `if (cfg.id === 'tron')` branch.

### 2.3 Ingestion function signature

Every ingestion function has the same shape:

```ts
export async function ingestX(cfg: ChainConfig): Promise<void>
```

- Takes a `ChainConfig`
- Runs in an infinite retry loop (managed by `index.ts`)
- Writes NDJSON to `DATA_DIR/<chain>/<yyyy-mm-dd>/events.jsonl`
- Saves state to `STATE_DIR/<chain>.json`

### 2.4 State persistence

State is a JSON file at `STATE_DIR/<chainId>.json`, written atomically
(tmp → rename). Contains at minimum `{ lastBlock, lastTimestamp }`.

### 2.5 NDJSON event structure

Every event written to disk must be a flat JSON object with:

```ts
{
  type: string;           // 'transfer', 'swap', 'bridge_lock', etc.
  chain: string;          // chain ID
  blockNumber: number;
  blockTimestamp: number; // unix seconds (number, not string — fix tron)
  txHash: string;
  from: string;           // sender
  to: string;             // recipient
  tokenAddress: string;   // token contract / mint
  value: string;          // raw amount as string (avoid IEEE 754)
  // ... per-type extensions
}
```

**Important inconsistency to fix**: Subsquid writes `blockTimestamp` as a string,
Tron writes it as a number. The new modules should use `number` (unix seconds)
and we will back-fix the Subsquid module later.

### 2.6 Batch write pattern

```ts
let batch: Event[] = [];
const BATCH_SIZE = 10_000;

for (/* events */) {
  batch.push(event);
  if (batch.length >= BATCH_SIZE) {
    writeBatch(chainId, batch.splice(0));
  }
}
writeBatch(chainId, batch.splice(0));  // final flush
```

NDJSON is written to `DATA_DIR/<chain>/<YYYY>-<MM>-<DD>/events.jsonl` in append
mode. Files are partitioned by UTC date of event (NOT write time).

### 2.7 Orchestration in index.ts

```ts
if (cfg.id === 'tron') {
  await ingestTron(cfg);          // poll-based, returns after batch
  await sleep(cfg.blockTime * 20);
} else if (cfg.subsquidNetwork) {
  await ingestEvmChain(cfg);      // streaming, blocks indefinitely
}
```

New ingestion methods will add branches here in the same pattern.

---

## 3. Solana Ingestion Module

### 3.1 Why Solana is Different

Solana has no event logs. All "events" are embedded in transaction instructions.
An SPL token transfer is **not** a log topic — it is a `transfer` instruction on
the SPL Token program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`). A Jupiter
swap is a series of instructions routed through the Jupiter aggregator.

This means:
- We cannot use Subsquid Pipes (no EVM-style logs).
- We must decode Solana transaction instructions ourselves.
- We need two ingestion paths: real-time (Helius webhooks) and historical backfill
  (Helius Enhanced Transactions API).

### 3.2 API Dependencies

| Service | Purpose | Auth | Rate Limit |
|---------|---------|------|------------|
| **Helius RPC** | Read parsed transactions, getSignaturesForAddress | API key (in gopass) | Tiered, ~100 req/s on paid plan |
| **Helius Webhooks** | Push real-time transaction data | API key | Unlimited pushes, configurable filters |
| **Helius Enhanced Transactions** | Bulk historical backfill with enriched parsing | API key | 100 txns/req, batched |
| **Jupiter Quote API** | Swap event data, token prices | None | 60 req/min free |
| **Solana public RPC** | Fallback for block fetching | None (pool) | 10 req/s typical |

### 3.3 Dual-Ingestion Strategy

```
                    ┌──────────────────────┐
                    │   Helius Webhooks    │  Real-time push
                    │  (filtered: token    │──────────────┐
                    │   transfers + swaps) │              │
                    └──────────────────────┘              ▼
                                              ┌───────────────────┐
                    ┌──────────────────────┐  │  solana.ts        │
                    │  Helius Enhanced     │  │                   │
                    │  Transactions API    │─▶│  Normalize →      │──▶ NDJSON → R2
                    │  (historical backfill)│  │  TokenEvent       │
                    └──────────────────────┘  └───────────────────┘
                                              ▲
                    ┌──────────────────────┐  │
                    │  Jupiter Quote API   │──┘
                    │  (swap enrichment)   │
                    └──────────────────────┘
```

**Real-time path (primary)**: Helius webhook → HTTP endpoint → event normalization
→ NDJSON write. The webhook filters for program IDs we care about (SPL Token,
Jupiter, pump.fun, Raydium, Orca).

**Historical backfill path**: Helius Enhanced Transactions API → paginated fetch
→ normalization → NDJSON write. Used on startup to catch up from last known slot.
Also used for periodic gap detection.

### 3.4 ChainConfig Addition

```ts
// In src/chains.ts, add:
solana: {
  id: 'solana',
  name: 'Solana',
  subsquidNetwork: null,  // not available
  rpcPool: [
    'https://api.mainnet-beta.solana.com',
    'https://solana-rpc.publicnode.com',
    // Helius is primary, these are fallback
  ],
  blockTime: 0.4,            // ~400ms slot time
  confirmations: 32,          // ~13 seconds for optimistic finality
},
```

### 3.5 ChainConfig Extension for Solana

Solana needs extra config fields. Add optional fields to `ChainConfig`:

```ts
interface ChainConfig {
  // ... existing fields ...
  /** Solana-specific: program IDs to monitor */
  solanaPrograms?: string[];
  /** Solana-specific: Helius webhook ID (assigned at creation) */
  heliusWebhookId?: string;
  /** Solana-specific: whether to use webhooks (true) or polling (false) */
  heliusWebhooks?: boolean;
}
```

### 3.6 Event Types

Solana produces multiple event types. Each maps to a flat NDJSON object with a
`type` discriminator.

#### 3.6.1 SPL Token Transfer (`type: 'sol_transfer'`)

```ts
interface SolTransferEvent {
  type: 'sol_transfer';
  chain: 'solana';
  blockNumber: number;         // Solana slot
  blockTimestamp: number;      // unix seconds
  txHash: string;              // base58 transaction signature
  instructionIndex: number;    // position within tx
  from: string;                // base58 owner address
  to: string;                  // base58 owner address
  tokenAddress: string;        // SPL mint address
  value: string;               // raw amount
  decimals: number;            // token decimals
  programId: string;           // 'Tokenkeg...' or 'TokenzQ...' (Token-2022)
}
```

**Detection**: Instruction where `programId` is SPL Token or Token-2022 and
`data` starts with the `transfer` discriminator (first byte = 3 for SPL Token).

#### 3.6.2 SOL Native Transfer (`type: 'sol_transfer'` with `tokenAddress: 'native'`)

```ts
interface SolNativeTransferEvent {
  type: 'sol_transfer';
  chain: 'solana';
  blockNumber: number;
  blockTimestamp: number;
  txHash: string;
  instructionIndex: number;
  from: string;
  to: string;
  tokenAddress: 'So11111111111111111111111111111111111111112'; // wSOL mint
  value: string;               // lamports as string
  decimals: 9;
  programId: '11111111111111111111111111111111'; // System Program
  isNativeSol: true;
}
```

#### 3.6.3 Jupiter Swap (`type: 'sol_swap'`)

```ts
interface SolSwapEvent {
  type: 'sol_swap';
  chain: 'solana';
  blockNumber: number;
  blockTimestamp: number;
  txHash: string;
  from: string;                // user wallet
  dex: 'jupiter';              // or 'raydium', 'orca'
  tokenIn: string;             // input token mint
  tokenOut: string;            // output token mint
  amountIn: string;            // raw input amount
  amountOut: string;           // raw output amount
  decimalsIn: number;
  decimalsOut: number;
  // Enriched from Jupiter Quote API:
  priceUsdIn?: number;
  priceUsdOut?: number;
  routePlan?: string[];        // market addresses used in route
}
```

**Detection**: Instruction where `programId` is `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`
(Jupiter v6) or `JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uJvfo` (Jupiter v4).

#### 3.6.4 pump.fun Token Creation (`type: 'sol_token_create'`)

```ts
interface SolTokenCreateEvent {
  type: 'sol_token_create';
  chain: 'solana';
  blockNumber: number;
  blockTimestamp: number;
  txHash: string;
  creator: string;             // deployer wallet
  tokenAddress: string;        // new mint address
  platform: 'pump.fun';
  initialPriceSol: string;
  bondingCurveAddress: string;
}
```

**Detection**: Instruction where `programId` is `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
(pump.fun program).

#### 3.6.5 Raydium / Orca LP Events (`type: 'sol_liquidity'`)

```ts
interface SolLiquidityEvent {
  type: 'sol_liquidity';
  chain: 'solana';
  blockNumber: number;
  blockTimestamp: number;
  txHash: string;
  dex: 'raydium' | 'orca';
  action: 'add' | 'remove';
  user: string;
  poolAddress: string;
  tokenA: string;
  tokenB: string;
  amountA: string;
  amountB: string;
}
```

**Detection**:
- Raydium: `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` (Raydium LP v4)
  or `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` (Raydium CLMM)
- Orca: `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` (Orca Whirlpools)

### 3.7 Solana State Model

```ts
interface SolanaState {
  lastSlot: number;
  lastTimestamp: number;
  lastSignature: string;       // last processed tx sig (for cursor-based polling)
  webhookId: string | null;    // active Helius webhook ID
  source: 'webhook' | 'backfill' | 'stopped';
}
```

### 3.8 Normalization Layer

A shared normalization function converts Helius transaction data into our event
types. This is the most complex part of the Solana module.

```ts
function normalizeTransaction(
  tx: HeliusParsedTransaction,
  chain: 'solana',
): TokenEvent[] {
  const events: TokenEvent[] = [];
  const slot = tx.slot;
  const timestamp = tx.blockTime ?? 0;
  const signature = tx.transaction?.signatures?.[0] ?? '';

  for (const [idx, ix] of (tx.transaction?.message?.instructions ?? []).entries()) {
    const programId = ix.programId ?? '';

    switch (programId) {
      case SPL_TOKEN_PROGRAM:
      case TOKEN_2022_PROGRAM:
        events.push(normalizeSplTransfer(ix, idx, slot, timestamp, signature));
        break;
      case JUPITER_V6_PROGRAM:
      case JUPITER_V4_PROGRAM:
        events.push(normalizeJupiterSwap(ix, idx, slot, timestamp, signature));
        break;
      case PUMP_FUN_PROGRAM:
        events.push(normalizePumpFunCreate(ix, idx, slot, timestamp, signature));
        break;
      case RAYDIUM_V4_PROGRAM:
      case RAYDIUM_CLMM_PROGRAM:
      case ORCA_WHIRLPOOLS_PROGRAM:
        events.push(normalizeLiquidityEvent(ix, idx, slot, timestamp, signature));
        break;
      case SYSTEM_PROGRAM:
        // Native SOL transfers only
        events.push(normalizeNativeSolTransfer(ix, idx, slot, timestamp, signature));
        break;
    }
  }
  return events.filter(Boolean) as TokenEvent[];
}
```

### 3.9 Helius Webhook Setup (One-Time)

The webhook must be created once via the Helius API, not in code:

```bash
curl -X POST https://api.helius.xyz/v0/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "webhookURL": "http://localhost:4096/webhook/solana",
    "transactionTypes": ["TRANSFER", "SWAP", "TOKEN_MINT", "UNKNOWN"],
    "accountAddresses": [],
    "webhookType": "enhanced",
    "txnStatus": "all"
  }'
```

The webhook ID is stored in `STATE_DIR/solana.json` under `webhookId`. On
startup, `ingestSolana` checks if a webhook exists; if not, it falls back to
polling mode.

**For production**: Consider hosting the webhook receiver on a public endpoint
(e.g., Cloudflare Tunnel) rather than running an HTTP server inside the
indexer process. Alternatively, poll the Helius Enhanced Transactions API
periodically — this avoids the complexity of running an HTTP server and works
behind NAT/firewalls.

### 3.10 Recommended Architecture: Polling Primary

Given the deployment environment (Talos, no public HTTP ingress for this
service), we recommend **polling-based ingestion** as the primary path:

```
┌──────────────────────────────────────────────────────────────────┐
│  ingestSolana(cfg)                                               │
│                                                                  │
│  1. Load SolanaState from STATE_DIR/solana.json                  │
│  2. Get current slot from Helius RPC                             │
│  3. Fetch signatures via getSignaturesForAddress (for tracked    │
│     program IDs) since lastSignature                             │
│  4. Batch fetch parsed transactions via Helius Enhanced          │
│     Transactions API (up to 100 per request)                     │
│  5. normalizeTransaction() each response                         │
│  6. writeBatch() to NDJSON                                      │
│  7. Save state, sleep ~2s, repeat                                │
└──────────────────────────────────────────────────────────────────┘
```

This matches the existing Tron polling pattern and requires no new
infrastructure.

### 3.11 Key Solana Constants

```ts
// src/solana.ts
const SOLANA_RPC = 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY';

const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const JUPITER_V6_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const JUPITER_V4_PROGRAM = 'JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uJvfo';
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RAYDIUM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const ORCA_WHIRLPOOLS_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

// Major SPL tokens to always track (in addition to program-level tracking)
const TRACKED_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'So11111111111111111111111111111111111111112',     // wSOL
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  // JUP
]);
```

### 3.12 Jupiter Swap Enrichment

After a swap event is detected, optionally enrich it with the Jupiter Quote API:

```ts
async function enrichSwapWithJupiter(swap: SolSwapEvent): Promise<SolSwapEvent> {
  const resp = await fetch(
    `https://quote-api.jup.ag/v6/quote?inputMint=${swap.tokenIn}&outputMint=${swap.tokenOut}&amount=${swap.amountIn}&slippageBps=50`
  );
  const quote = await resp.json();
  return {
    ...swap,
    priceUsdIn: quote.inAmount ? Number(quote.inAmount) / 10 ** swap.decimalsIn : undefined,
    priceUsdOut: quote.outAmount ? Number(quote.outAmount) / 10 ** swap.decimalsOut : undefined,
    routePlan: quote.routePlan?.map((r: any) => r.swapInfo?.ammKey).filter(Boolean),
  };
}
```

This is optional — skip it if rate-limited. The swap event is still written
without enrichment.

---

## 4. Cross-Chain Bridge Tracking

### 4.1 Why Bridge Tracking Matters

Bridge transactions are the primary mechanism for whale fund movements and
cross-chain arbitrage. Without bridge tracking, large sum transfers between
chains appear as disconnected events — a "sell" on Ethereum and a "buy" on
Solana with no causal link.

Bridge events share a common structure: a user locks/burns assets on chain A,
and a relayer/validator mints/releases equivalent assets on chain B. We track
both sides.

### 4.2 Bridges to Track

| Bridge | Chains | Mechanism | Detection |
|--------|--------|-----------|-----------|
| **Wormhole** | Solana ↔ EVM (all) | Lock on source, mint on destination | EVM: `LogMessagePublished` event on Wormhole Core. Solana: `postMessage` instruction |
| **LayerZero / Stargate** | EVM ↔ EVM (40+ chains) | `Packet` events on UltraLightNode + `Swap` on Stargate pools | EVM: `PacketSent`, `PacketReceived` events |
| **Across Protocol** | EVM ↔ EVM (Arb/Opt/Base/ETH/Polygon) | Intent-based relay with `V3FundsDeposited` | EVM: `V3FundsDeposited`, `FilledV3Relay` on SpokePool contracts |
| **CCIP (Chainlink)** | EVM ↔ EVM (multi-chain) | `CCIPMessageSent`, `ExecutionStateChanged` | EVM: `CCIPMessageSent` on Router, `Executed` on destination |

### 4.3 Bridge Event Data Model

All bridge events follow a unified schema with additional fields for cross-chain
correlation:

```ts
interface BridgeEvent {
  type: 'bridge_lock' | 'bridge_mint' | 'bridge_burn' | 'bridge_release';
  chain: string;               // chain where this event was observed
  bridge: 'wormhole' | 'layerzero' | 'stargate' | 'across' | 'ccip';
  blockNumber: number;
  blockTimestamp: number;
  txHash: string;
  logIndex?: number;           // EVM only
  instructionIndex?: number;   // Solana only

  // User
  from: string;                // sender/depositor
  to: string;                  // recipient on destination chain

  // Token
  tokenAddress: string;        // token on this chain
  value: string;
  decimals: number;

  // Cross-chain correlation
  sourceChain: string;         // origin chain
  destinationChain: string;    // target chain
  messageHash: string;         // unique message/settlement ID (critical for correlation)
  sequenceNumber?: number;     // sequential ID (LayerZero, Wormhole)

  // Bridge-specific
  bridgeAddress: string;       // bridge contract / program ID
  fee?: string;                // bridge fee paid
  relayer?: string;            // relayer/filler address (Across)
}
```

### 4.4 Wormhole — Detailed Design

Wormhole uses a "guardian network" model: lock on source, guardians sign a VAA
(Verified Action Approval), then mint on destination.

#### 4.4.1 EVM Side

Monitor the Wormhole Core Bridge contract on every EVM chain for the
`LogMessagePublished` event. This fires when assets are locked.

**Contract**: `0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B` (same on all EVM chains)

**Event signature**:
```
LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)
```

**Detection in Subsquid**: Add to the existing `evmDecoder` event list.

**Code change in `subsquid.ts`**:

```ts
// In addition to commonAbis.erc20.events.Transfer, add:
events: {
  Transfer: commonAbis.erc20.events.Transfer,
  WormholeMessage: commonAbis.wormhole?.events.LogMessagePublished, // custom ABI
}
```

**Normalization**: Decode the `payload` to extract `targetChain`, `targetAddress`,
`tokenAddress`, and `amount`. The `sequence` is the correlation key.

#### 4.4.2 Solana Side

Monitor the Wormhole Core Bridge program on Solana for `postMessage` instructions.

**Program ID**: `worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth`

**Detection in Solana module**: Add `WORMHOLE_CORE_PROGRAM` to the program ID
switch in `normalizeTransaction`. Decode instruction data to find the VAA payload.

#### 4.4.3 Wormhole Token Bridge

The token bridge lives at a separate address but is the primary user-facing
contract. Most token transfers go through here.

**EVM**: `0x3ee18B2214AFF97000D974cf647E7C347E8fa585` (same on all chains)
**Events**: `TransferRedeemed`, `TransferSent`
**Solana**: `wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb`

### 4.5 LayerZero / Stargate — Detailed Design

LayerZero is a general messaging protocol. Stargate is the most popular
application built on it, handling stablecoin bridging.

#### 4.5.1 LayerZero V2 Events

On each EVM chain, the `EndpointV2` contract emits `PacketSent` and
`PacketReceived`.

**EndpointV2 address** (same on all chains):
`0x1a44076050125825900e736c501f859c50fE728c`

**Events to track**:
```
PacketSent(bytes32 encodedPayload, bytes options, address sendLibrary)
PacketVerified(bytes32 payloadHash, bytes32 proposedBy, uint40 proposedEpoch)
```

The `encodedPayload` contains `srcEid`, `dstEid`, `sender`, `receiver`,
`message`. Decode this to extract token transfer details.

#### 4.5.2 Stargate V2 Pool Events

Stargate pools emit `Swap` events when users bridge tokens.

**Stargate USDC pool (Ethereum mainnet)**: `0xc026395860Db2d07ee33e05fE50ed7bD583189C7`
(varies by chain — need per-chain address map).

**Event**: `Swap(address indexed sender, uint256 amountIn, uint256 amountOut, uint32 dstEid, bytes32 to, ...)`

**Per-chain pool addresses** (major chains, USDC pools):

| Chain | Stargate USDC Pool |
|-------|-------------------|
| Ethereum | `0xc026395860Db2d07ee33e05fE50ed7bD583189C7` |
| Arbitrum | `0x6694340fc020c5E6B96567843da2df01b2CE1eb6` |
| Optimism | `0x38EA452219524Bb87e18dE1C24D3bB59510BD783` |
| Base | `0x27a16dc786820B16E5c9028b75B99F6f604b5d26` |
| Polygon | `0x9Aa02D4FAe4F58b8E8A4154E80632BCa4d072Fa9` |
| BSC | `0x2bFcFe4c4A98F5d3c3D9e10e8e88a3F5b73c2e98` |
| Avalanche | `0x1205f31718499dBf1fCa446663B0Ef87481fE12d` |

### 4.6 Across Protocol — Detailed Design

Across is an intent-based bridge: users deposit funds on the source chain, a
relayer fills the order on the destination chain, and the relayer is repaid
from the deposit.

#### 4.6.1 Events

**SpokePool contracts** emit `V3FundsDeposited` (source) and `FilledV3Relay`
(destination).

**SpokePool addresses** (v3, as of 2026):

| Chain | SpokePool Address |
|-------|-------------------|
| Ethereum | `0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5` |
| Arbitrum | `0xe35e9842f7aCA96570B734083f4a58e8F7C8f2A7` |
| Optimism | `0x6f26Bf09B1C792e3228e5468f09d9375f36d33dD` |
| Base | `0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64` |
| Polygon | `0x9295EE1d8C5b022Eda3A8F059aA33bB4b209b1e5` |

**Event signatures**:
```
V3FundsDeposited(
  address inputToken, address outputToken, uint256 inputAmount,
  uint256 outputAmount, uint256 indexed destinationChainId,
  uint32 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline,
  uint32 exclusivityDeadline, address indexed depositor,
  address recipient, address exclusiveRelayer, bytes message
)

FilledV3Relay(
  address inputToken, address outputToken, uint256 inputAmount,
  uint256 outputAmount, uint256 repaymentChainId,
  uint256 indexed originChainId, uint32 indexed depositId,
  uint32 fillDeadline, uint32 exclusivityDeadline,
  address exclusiveRelayer, address indexed relayer,
  address depositor, address recipient, bytes message,
  V3RelayExecutionEventInfo relayExecutionInfo
)
```

The correlation key is `depositId` + `originChainId`.

### 4.7 CCIP (Chainlink) — Detailed Design

CCIP is Chainlink's cross-chain messaging protocol.

#### 4.7.1 Events

**Router contract** emits `CCIPMessageSent` on the source chain.

**Router address** (Ethereum): `0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D`

**Events**:
```
CCIPMessageSent(bytes32 indexed messageId, uint64 indexed destinationChainSelector, address receiver, bytes data, address feeToken, uint256 fees)

ExecutionStateChanged(bytes32 indexed messageId, uint64 indexed sourceChainSelector, MessageExecutionState state, bytes returnData)
```

`messageId` is the correlation key. `destinationChainSelector` maps to a known
chain ID (e.g., `5009297550715157269` = Arbitrum, `3734403246176062136` = Optimism).

### 4.8 Bridge Tracking Integration Points

#### 4.8.1 EVM Chains

Bridge events fire on EVM chains as regular contract events. They can be
captured by **extending the existing Subsquid ingestion** in `subsquid.ts`.
Add bridge-specific event ABIs to the `evmDecoder` configuration.

**Proposed change**: Add a second Subsquid stream for bridge contracts, OR
extend the existing stream with bridge event decoders.

**Recommendation**: Create a separate `BridgesDecoder` in `src/bridges.ts` that
runs alongside the ERC-20 Transfer decoder. This keeps the ERC-20 module focused
and allows the bridge module to evolve independently.

```ts
// src/bridges.ts — EVM side
export async function ingestEvmBridges(cfg: ChainConfig): Promise<void> {
  const { evmPortalSource, evmDecoder } = await import('@subsquid/pipes/evm');

  const stream = evmPortalSource({
    portal: `https://portal.sqd.dev/datasets/${cfg.subsquidNetwork}`,
  }).pipe(
    evmDecoder({
      events: {
        // Wormhole
        WormholeLogMessage: WORMHOLE_ABI.events.LogMessagePublished,
        WormholeTransfer: WORMHOLE_TOKEN_BRIDGE_ABI.events.TransferSent,
        // LayerZero
        LayerZeroPacketSent: LAYERZERO_ABI.events.PacketSent,
        LayerZeroPacketReceived: LAYERZERO_ABI.events.PacketReceived,
        // Stargate
        StargateSwap: STARGATE_ABI.events.Swap,
        // Across
        AcrossDeposit: ACROSS_ABI.events.V3FundsDeposited,
        AcrossFilled: ACROSS_ABI.events.FilledV3Relay,
        // CCIP
        CCIPSent: CCIP_ABI.events.CCIPMessageSent,
        CCIPExecuted: CCIP_ABI.events.ExecutionStateChanged,
      },
      range: { from: 0 },
    }),
  );

  // ... batch + write loop (identical pattern to subsquid.ts)
}
```

#### 4.8.2 Solana Side

Bridge events on Solana are captured by the Solana module. Add bridge program
IDs to the `normalizeTransaction` switch statement.

**Solana bridge program IDs**:
```ts
const WORMHOLE_CORE_PROGRAM = 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth';
const WORMHOLE_TOKEN_BRIDGE = 'wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb';
```

### 4.9 Bridge Contract Address Registry

Maintain a centralized registry of bridge contract addresses per chain:

```ts
// src/bridges.ts
interface BridgeContract {
  bridge: string;
  contract: string;
  chain: string;
  events: string[];
}

const BRIDGE_REGISTRY: BridgeContract[] = [
  // Wormhole
  { bridge: 'wormhole', contract: '0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B', chain: '*', events: ['LogMessagePublished'] },
  { bridge: 'wormhole', contract: '0x3ee18B2214AFF97000D974cf647E7C347E8fa585', chain: '*', events: ['TransferSent', 'TransferRedeemed'] },

  // LayerZero EndpointV2
  { bridge: 'layerzero', contract: '0x1a44076050125825900e736c501f859c50fE728c', chain: '*', events: ['PacketSent', 'PacketVerified'] },

  // Stargate USDC (per-chain, examples)
  { bridge: 'stargate', contract: '0xc026395860Db2d07ee33e05fE50ed7bD583189C7', chain: 'ethereum', events: ['Swap'] },
  { bridge: 'stargate', contract: '0x6694340fc020c5E6B96567843da2df01b2CE1eb6', chain: 'arbitrum', events: ['Swap'] },
  // ... add for every chain

  // Across SpokePools (per-chain)
  { bridge: 'across', contract: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5', chain: 'ethereum', events: ['V3FundsDeposited', 'FilledV3Relay'] },
  // ... add for every chain

  // CCIP Router
  { bridge: 'ccip', contract: '0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D', chain: 'ethereum', events: ['CCIPMessageSent'] },
  // ... add for every chain
];
```

---

## 5. Integration with Existing Pipeline

### 5.1 index.ts Orchestration Changes

```ts
// src/index.ts — new branches in the runner loop
const runners = chains.map(async (cfg) => {
  while (true) {
    try {
      if (cfg.id === 'tron') {
        await ingestTron(cfg);
        await sleep(cfg.blockTime * 20 * 1000);
      } else if (cfg.id === 'solana') {
        await ingestSolana(cfg);           // NEW: Solana polling
        await sleep(2000);                  // 2 second poll interval
      } else if (cfg.subsquidNetwork) {
        await ingestEvmChain(cfg);
      }
    } catch (err) {
      logger.error({ chain: cfg.id, err }, 'Ingestion error — retrying in 30s');
      await sleep(30_000);
    }
  }
});

// Bridge ingestion runs per-EVM-chain alongside the ERC-20 stream.
// For each EVM chain with bridge config, start a bridge stream in parallel:
const bridgeRunners = EVM_CHAINS_WITH_BRIDGES.map(async (cfg) => {
  while (true) {
    try {
      await ingestEvmBridges(cfg);         // NEW: bridge events
    } catch (err) {
      logger.error({ chain: cfg.id, err }, 'Bridge ingestion error — retrying in 30s');
      await sleep(30_000);
    }
  }
});

await Promise.all([...runners, ...bridgeRunners]);
```

### 5.2 NDJSON Output

Both Solana and bridge events are written to the same directory structure:

```
/srv/data/chain-indexer/jsonl/
├── ethereum/
│   ├── 2026-07-12/
│   │   ├── events.jsonl       # ERC-20 transfers + bridge events
│   │   └── bridges.jsonl      # OPTIONAL: separate bridge file
│   └── ...
├── solana/
│   ├── 2026-07-12/
│   │   └── events.jsonl       # SPL transfers + swaps + LP
│   └── ...
├── tron/
│   └── ...
└── bridges/                    # OPTIONAL: cross-chain unified bridge dir
    ├── 2026-07-12/
    │   └── events.jsonl
    └── ...
```

**Recommendation**: Write bridge events to the same `events.jsonl` per chain
(not a separate file). This keeps the R2 sync simple and allows downstream
consumers to filter by `type` field. Bridge events have `type` values starting
with `'bridge_'` for easy filtering.

### 5.3 R2 Sync — No Changes Required

`sync.ts` uses `rclone sync "${DATA_DIR}" "r2:${R2_BUCKET}/jsonl/"`. New chain
directories under `DATA_DIR` are picked up automatically. No code changes
needed.

### 5.4 Downstream Parquet Conversion

The existing DuckDB conversion in the comment in `sync.ts` works on any JSONL
file. For bridge events with variable schemas (extra optional fields), DuckDB's
`read_json_auto` handles schema inference gracefully. No changes needed.

---

## 6. File Structure

```
src/
├── index.ts              # CLI + orchestration [MODIFY — add solana + bridges branches]
├── chains.ts             # ChainConfig + registry [MODIFY — add solana config]
├── subsquid.ts           # EVM ERC-20 ingestion [NO CHANGE]
├── tron.ts               # Tron TRC-20 ingestion [NO CHANGE]
├── sync.ts               # R2 sync [NO CHANGE]
│
├── solana.ts             # [NEW] Solana SPL + DEX ingestion
│   - SOLANA_PROGRAMS constants
│   - normalizeTransaction() — instruction → event mapping
│   - ingestSolana() — polling loop
│   - Helius API client helpers
│
├── bridges.ts            # [NEW] Cross-chain bridge tracking
│   - BRIDGE_REGISTRY — per-chain contract addresses
│   - BRIDGE_ABIS — event signatures per bridge
│   - ingestEvmBridges() — Subsquid stream for bridge events
│   - BridgeEvent type definitions
│
└── types.ts              # [NEW] Shared event type definitions
    - TokenEvent (union type)
    - SolTransferEvent, SolSwapEvent, SolLiquidityEvent, SolTokenCreateEvent
    - BridgeEvent
    - shared writeBatch() + state persistence helpers
```

**Decision**: `types.ts` is introduced as a new file to avoid circular imports
between `solana.ts`, `bridges.ts`, and any future modules. The shared
`writeBatch()` and state functions can also live here to eliminate the
duplication currently present between `subsquid.ts` and `tron.ts`.

---

## 7. Estimated Effort

| Task | Effort | Dependencies |
|------|--------|-------------|
| **Extract shared utilities to `types.ts`** | 0.5 day | None |
| **Solana polling module** (`solana.ts`) | 2 days | Helius API key |
| **Solana instruction decoder** (normalizeTransaction) | 2 days | Solana program ID reference |
| **Jupiter swap enrichment** (optional) | 0.5 day | Jupiter API |
| **Bridge contract ABI collection** | 1 day | Etherscan, block explorers |
| **Bridge EVM ingestion** (`bridges.ts` Subsquid stream) | 1.5 days | Bridge ABIs |
| **Bridge Solana ingestion** (in `solana.ts`) | 0.5 day | Wormhole program ID |
| **Add Solana to `chains.ts` + orchestration** | 0.5 day | — |
| **Testing + debugging** | 1 day | Testnet data |
| **Documentation + deployment** | 0.5 day | — |
| **Total** | **~10 days** | |

### 7.1 Dependencies to Install

```json
// Additional npm packages needed
{
  "@solana/web3.js": "^2.0.0",          // Solana RPC client
  "@solana/spl-token": "^0.4.0",        // SPL token instruction decoding
  "bs58": "^6.0.0"                       // base58 encoding/decoding
}
```

No new system dependencies. No new Docker services. No database changes.

### 7.2 Environment Variables to Add

```bash
# Helius
HELIUS_API_KEY=         # from gopass
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}

# Optional: Helius Webhook
HELIUS_WEBHOOK_ID=      # set after creating webhook via Helius API
```

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Helius API rate limits | Medium | Medium | Exponential backoff, RPC fallback pool |
| Solana slot lag on backfill | Medium | Low | Helius Enhanced Transactions API handles this |
| Bridge contract upgrades break ABIs | Medium | High | Versioned ABI registry with fallback |
| SPL Token-2022 program adds new instruction formats | Low | Medium | Modular instruction decoder, tested against Token-2022 |
| NDJSON schema drift between modules | Medium | Medium | Shared `types.ts`, CI validation on event schemas |
| Webhook endpoint requires public HTTP (if used) | Low | Medium | Default to polling; webhook optional |
| Duplicate events on restart | High | Low | Deduplication by `txHash + instructionIndex` in state |
| Large Solana transaction volume overwhelms NDJSON | Low | Medium | Batch writes (10K events), same as EVM |

---

## 9. Implementation Order

### Phase 1: Foundation (Days 1-2)
1. Create `src/types.ts` — extract shared types, `writeBatch()`, state helpers
2. Refactor `src/subsquid.ts` and `src/tron.ts` to use shared utilities
3. Add Solana to `src/chains.ts` ChainConfig

### Phase 2: Solana Core (Days 3-5)
4. Create `src/solana.ts` — Helius polling, program constants
5. Implement `normalizeTransaction()` — SPL transfers, native SOL
6. Integrate into `src/index.ts` orchestration
7. Test against recent Solana blocks

### Phase 3: Solana DEX (Days 5-6)
8. Add Jupiter swap detection to `normalizeTransaction()`
9. Add pump.fun token creation detection
10. Add Raydium/Orca LP detection
11. Optional: Jupiter Quote API enrichment

### Phase 4: Bridges EVM (Days 7-8)
12. Collect bridge ABIs and contract addresses
13. Create `src/bridges.ts` with bridge registry
14. Implement `ingestEvmBridges()` using Subsquid
15. Integrate into `src/index.ts`

### Phase 5: Bridges Solana + Polish (Days 8-10)
16. Add Wormhole Solana programs to `solana.ts`
17. Test end-to-end bridge correlation
18. Documentation, deployment, monitoring

---

## 10. Open Questions

1. **Webhook vs. polling for Solana?** Recommend starting with polling
   (simpler infra, works behind NAT) and adding webhook support later if
   latency becomes a concern. Solana block time is ~400ms so 2-second polling
   is acceptable for most use cases.

2. **Separate bridge event file or same file?** Recommend writing bridge events
   to the same `events.jsonl` per chain. Use the `type` field to discriminate.
   This avoids managing separate file streams and keeps downstream Parquet
   conversion unified.

3. **Bridge event correlation?** The `messageHash` field allows downstream
   consumers to match lock↔mint pairs. We do NOT do correlation in the
   indexer itself — that is an analytics/query-layer concern.

4. **Should we backfill historical Solana data?** The Helius Enhanced
   Transactions API supports arbitrary historical slots. The initial boot
   will naturally backfill from `lastSlot=0`. This could take days for the
   full history. Consider starting from a recent slot (e.g., last 30 days)
   and backfilling older data as a separate batch job.

5. **Token-2022 support?** The Token-2022 program (`TokenzQd...`) extends SPL
   with transfer hooks, permanent delegate, and other features. The
   instruction formats are similar but not identical to standard SPL. We
   include it in the program ID list from day one and handle differences
   in the decoder.

---

## Appendix A: Solana Program ID Reference

| Program | Address | Tracked |
|---------|---------|---------|
| System Program | `11111111111111111111111111111111` | Native SOL transfers |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | SPL transfers |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | SPL (extended) |
| Jupiter v6 | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | DEX swaps |
| Jupiter v4 | `JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uJvfo` | DEX swaps (legacy) |
| pump.fun | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | Token launches |
| Raydium v4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | LP events |
| Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | Concentrated LP |
| Orca Whirlpools | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | Concentrated LP |
| Wormhole Core | `worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth` | Bridge messages |
| Wormhole Token Bridge | `wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb` | Bridge tokens |

## Appendix B: EVM Bridge Contract Reference

| Bridge | Contract | Address | Chain |
|--------|----------|---------|-------|
| Wormhole Core | `0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B` | All EVM | Core message passing |
| Wormhole Token Bridge | `0x3ee18B2214AFF97000D974cf647E7C347E8fa585` | All EVM | Token bridging |
| LayerZero EndpointV2 | `0x1a44076050125825900e736c501f859c50fE728c` | All EVM | Message passing |
| Stargate USDC Pool | varies | Per-chain | Stablecoin bridging |
| Across SpokePool v3 | varies | Per-chain | Intent-based relay |
| CCIP Router | varies | Per-chain | Chainlink messaging |
