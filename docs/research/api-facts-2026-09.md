> Snapshot of the API facts verified on 2026-09-26 while building MIDAS. APIs move fast — re-verify before relying on a detail.

# API facts, verified 2026-09-26

All facts below come from installed packages (read from their published packages), live HTTP calls, and the official documentation pages. Anything I could not verify is marked **UNVERIFIED**.

---

## 1. Google Gemini API (`@google/genai` 2.24.0)

Sources: https://ai.google.dev/gemini-api/docs/models (updated 2026-09-24), `/pricing`, `/deprecations`, `/embeddings`, `/thinking`, `/gemini-3`, `/caching`, `/migrate-to-interactions`, and `node_modules/@google/genai/dist/genai.d.ts`.

### 1.1 Model IDs (Gemini Developer API)

| Tier | ID | Status |
|---|---|---|
| Flash (newest, recommended) | `gemini-3.8-flash` | Stable, released 2026-09-02, no shutdown date |
| Flash | `gemini-3.7-flash` | Stable (2026-08-13) |
| Flash | `gemini-3.6-flash` | Stable (2026-07-21) |
| Flash | `gemini-3.5-flash` | Stable (2026-05-19), now labeled "legacy" |
| Flash-Lite | `gemini-3.5-flash-lite` | Stable (2026-07-21) |
| Flash-Lite | `gemini-3.1-flash-lite` | Stable, earliest shutdown 2027-05-07 |
| Flash (preview) | `gemini-3-flash-preview` | Preview, no shutdown date (replacement: 3.6-flash) |
| **Pro** | `gemini-3.1-pro-preview` (also `gemini-3.1-pro-preview-customtools`) | **Preview only.** No GA 3.x Pro text model exists. |
| Pro (legacy) | `gemini-2.5-pro` | Stable, but **access limited to prior users** |
| 2.5 family | `gemini-2.5-flash`, `gemini-2.5-flash-lite` | Stable, **limited to prior users** ("new projects: use 3.5 Flash-Lite or 3.8 Flash") |
| SHUT DOWN | `gemini-3-pro-preview` (2026-03-09), `gemini-2.0-flash`/`-lite` (2026-06-01), `gemini-3.1-flash-lite-preview` (2026-05-25) | Do not use |
| Alias | `gemini-flash-latest` | Hot-swapped to the newest Flash (2-week email notice before a breaking swap) |

Embeddings:
- `gemini-embedding-2`: listed as **Stable** on the embeddings page (last updated April 2026). The models overview page instead lists `gemini-embedding-2-preview`, so the two pages disagree; the pricing page uses `gemini-embedding-2`. It is multimodal, accepts up to 8,192 input tokens, and outputs **3072 dims by default** (MRL: 128 to 3072; 768, 1536 or 3072 recommended). Truncated outputs are auto-normalized.
  - **It does NOT support `taskType`.** Put the task in the text instead, e.g. `task: search result | query: {content}`.
  - **Gotcha:** several strings passed directly in `contents` are merged into ONE aggregated embedding. To get one embedding per text, wrap each input in its own `Content` object (`{parts:[{text}]}`) or use the Batch API.
- `gemini-embedding-001`: text only, 2,048 input tokens, 3072 dims by default, supports `taskType`. Truncated dims (768/1536) must be normalized manually. Its vector space is **incompatible** with embedding-2.
- Price: `gemini-embedding-2` text costs $0.20/1M tokens ($0.10 with Batch).

### 1.2 Pricing, paid tier, per 1M tokens (Standard)

| Model | Input | Output (incl. thinking) | Cached input | Cache storage |
|---|---|---|---|---|
| gemini-3.8-flash | $0.75 until 2026-12-31, then $1.50 | $3.75, then $7.50 | $0.075, then $0.15 | $0.50 then $1.00 /1M tok/hr |
| gemini-3.7-flash / 3.6-flash | same as 3.8 ($0.75 / $3.75 promo) | | | |
| gemini-3.5-flash | $1.50 | $9.00 | $0.15 | $1.00 |
| gemini-3-flash-preview | $0.50 (audio $1.00) | $3.00 | $0.05 | $1.00 |
| gemini-3.5-flash-lite | $0.30 | $2.50 | $0.03 | $1.00 |
| gemini-3.1-flash-lite | $0.25 (audio $0.50) | $1.50 | $0.025 | $1.00 |
| gemini-3.1-pro-preview | $2.00 (>200k: $4.00) | $12.00 (>200k: $18.00) | $0.20 / $0.40 | $4.50 |
| gemini-2.5-pro | $1.25 / $2.50 | $10 / $15 | $0.125 / $0.25 | $4.50 |
| gemini-2.5-flash | $0.30 | $2.50 | $0.03 | $1.00 |

- Batch and Flex tiers cost 50% of Standard. A Priority tier also exists (3.8-flash Priority: $1.35 in / $6.75 out).
- 3.1-pro-preview has **no free API tier**.
- Search grounding on Gemini 3.x: 5,000 free search requests per month (shared across all 3.x models), then $14 per 1,000.
- **Implicit caching** is on by default for 2.5 and newer. Cached tokens cost about **10% of input price (a 90% discount)**. Minimum prompt size to qualify is **4,096 tokens** for 3.8/3.7/3.6/3.5 Flash and 3.1 Pro Preview, and 2,048 for 2.5 Flash/Pro.

### 1.3 Gemini 3 behavior notes (from `/gemini-3` and `/thinking`)
- Keep **temperature at the default 1.0**. Values below 1.0 "may lead to looping or degraded performance".
- `thinkingLevel` replaces `thinkingBudget`. `thinkingBudget` still works for backward compatibility, but **sending both returns a 400**.
- Supported levels and defaults:

| Model | Default | Supported levels |
|---|---|---|
| 3.8-flash | medium | low, medium, high |
| 3.7-flash | medium | low, medium, high |
| 3.6-flash | medium | minimal, low, medium, high |
| 3.5-flash | medium | minimal, low, medium, high |
| 3.5-flash-lite | minimal | minimal, low, medium, high |
| 3.1-pro-preview | high | low, medium, high |
| 3-flash-preview | high | minimal, low, medium, high |

- **Structured output combined with Google Search grounding IS supported on Gemini 3 models.** This also covers URL Context, Code Execution and Function Calling.
- Context window: 1M tokens in, up to 64k out. Knowledge cutoff January 2025.
- Google's docs now recommend the new **Interactions API** (`ai.interactions.create`, `response_format`, `generation_config.thinking_level`) for new work. They also say "`generateContent` remains fully supported".

### 1.4 Exact TS types (`node_modules/@google/genai/dist/genai.d.ts`)

```ts
export declare interface GoogleGenAIOptions {
  enterprise?: boolean; vertexai?: boolean; project?: string; location?: string;
  apiKey?: string; apiVersion?: string; googleAuthOptions?: GoogleAuthOptions; httpOptions?: HttpOptions;
}
// class Models
generateContent: (params: types.GenerateContentParameters) => Promise<types.GenerateContentResponse>;
generateContentStream: (params: types.GenerateContentParameters) => Promise<AsyncGenerator<types.GenerateContentResponse>>;
embedContent: (params: types.EmbedContentParameters) => Promise<types.EmbedContentResponse>;

export declare interface GenerateContentParameters { model: string; contents: ContentListUnion; config?: GenerateContentConfig; }
export declare interface GenerateContentConfig {
  httpOptions?; abortSignal?: AbortSignal; serviceTier?: ServiceTier; // 'unspecified'|'flex'|'standard'|'priority'
  systemInstruction?: ContentUnion;
  temperature?: number; topP?: number; topK?: number; candidateCount?: number; maxOutputTokens?: number;
  stopSequences?: string[]; responseLogprobs?: boolean; logprobs?: number; presencePenalty?: number;
  frequencyPenalty?: number; seed?: number;
  responseMimeType?: string;          // 'application/json'
  responseSchema?: SchemaUnion;       // OpenAPI-subset Schema (Type enum)
  responseJsonSchema?: unknown;       // JSON Schema; if set, responseSchema must be omitted, responseMimeType required
  safetySettings?: SafetySetting[]; tools?: ToolListUnion; toolConfig?: ToolConfig;
  labels?: Record<string,string>; cachedContent?: string; responseModalities?: string[];
  mediaResolution?: MediaResolution; thinkingConfig?: ThinkingConfig; imageConfig?; ...
}
export declare interface ThinkingConfig { includeThoughts?: boolean; thinkingBudget?: number; /*0=off,-1=auto*/ thinkingLevel?: ThinkingLevel; }
export declare enum ThinkingLevel { THINKING_LEVEL_UNSPECIFIED="THINKING_LEVEL_UNSPECIFIED", MINIMAL="MINIMAL", LOW="LOW", MEDIUM="MEDIUM", HIGH="HIGH" }

export declare class GenerateContentResponse {
  candidates?: Candidate[]; modelVersion?: string; responseId?: string; promptFeedback?;
  usageMetadata?: GenerateContentResponseUsageMetadata;
  get text(): string | undefined;   // excludes thought parts
}
export declare class GenerateContentResponseUsageMetadata {
  cacheTokensDetails?: ModalityTokenCount[]; cachedContentTokenCount?: number;
  candidatesTokenCount?: number; candidatesTokensDetails?: ModalityTokenCount[];
  promptTokenCount?: number;        // INCLUDES cached tokens
  promptTokensDetails?: ModalityTokenCount[];
  thoughtsTokenCount?: number; toolUsePromptTokenCount?: number; toolUsePromptTokensDetails?;
  totalTokenCount?: number;         // prompt + candidates + toolUsePrompt + thoughts
  trafficType?: TrafficType;
}

export declare interface EmbedContentParameters { model: string; contents: ContentListUnion; config?: EmbedContentConfig; }
export declare interface EmbedContentConfig {
  httpOptions?; abortSignal?; taskType?: string; title?: string; outputDimensionality?: number;
  mimeType?: string; autoTruncate?: boolean; /* Vertex-only */ documentOcr?; audioTrackExtraction?;
}
export declare class EmbedContentResponse { embeddings?: ContentEmbedding[]; metadata?: EmbedContentMetadata; }
export declare interface ContentEmbedding { values?: number[]; statistics?: ContentEmbeddingStatistics; }

export declare interface Tool { googleSearch?: GoogleSearch; urlContext?: UrlContext; codeExecution?; functionDeclarations?; fileSearch?; googleMaps?; ... }
export declare interface GoogleSearch { searchTypes?: SearchTypes; timeRangeFilter?: Interval; /* excludeDomains/blockingConfidence Vertex-only */ }
export declare interface GroundingMetadata { groundingChunks?; groundingSupports?; searchEntryPoint?; webSearchQueries?: string[]; ... }
```

Usage:
```ts
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const r = await ai.models.generateContent({
  model: "gemini-3.8-flash",
  contents: prompt,
  config: {
    systemInstruction: "You are ...",
    responseMimeType: "application/json",
    responseJsonSchema: jsonSchema,            // e.g. z.toJSONSchema(zodSchema)
    tools: [{ googleSearch: {} }],             // OK together with JSON output on Gemini 3
    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, // do NOT also send thinkingBudget
    // temperature: leave unset (1.0) on Gemini 3
  },
});
const data = JSON.parse(r.text!);
const u = r.usageMetadata; // u.promptTokenCount, u.cachedContentTokenCount, u.candidatesTokenCount, u.thoughtsTokenCount
r.candidates?.[0]?.groundingMetadata?.groundingChunks;

const e = await ai.models.embedContent({
  model: "gemini-embedding-2",
  contents: texts.map(t => ({ parts: [{ text: t }] })), // one Content per text, so separate embeddings
  config: { outputDimensionality: 768 },
});
e.embeddings![i].values; // number[]
```

---

## 2. Polymarket

Sources: https://docs.polymarket.com/llms.txt, `changelog/predictions.md`, `trading/fees.md`, `api-reference/rate-limits.md`, `market-data/realtime-data.md`, `/api-spec/gamma-openapi.yaml`, `/api-spec/clob-openapi.yaml`, `https://data-api.polymarket.com/v2/openapi.json`, live calls on 2026-09-26, and the installed packages.

### 2.0 Breaking changes in 2026
- **CLOB V2 went live 2026-04-28 on `https://clob.polymarket.com`.** It has **no V1 compatibility**: legacy V1 SDKs and V1-signed orders are rejected.
- Collateral is now **pUSD** (an ERC-20 on Polygon backed by USDC), replacing USDC.e.
- The order struct dropped `nonce`, `feeRateBps` and `taker`, and added `timestamp` (ms), `metadata` and `builder`. The EIP-712 exchange domain version is now "2".
- Fees are set at match time, so no fee field goes on orders.
- `GET https://clob.polymarket.com/version` returns `{"version":2}` (live).
- **`@polymarket/clob-client` (5.8.1, last published 2026-03-23) is the legacy V1 client. Do not use it.** Use `@polymarket/clob-client-v2` (1.2.0) or the new unified SDK `@polymarket/client` (0.11.0, **requires Node >= 24**).
- Accounts created on or after 2026-05-04 use a "Deposit Wallet" (EIP-1271, signature type 3).
- Price history has moved to **Data API v2**: `GET https://data-api.polymarket.com/v2/prices-history`. The CLOB `/prices-history` still answers (verified live).

### 2.1 Gamma API (`https://gamma-api.polymarket.com`, no auth)
- `GET /markets` accepts `limit, offset, order, ascending, id, slug, clob_token_ids, condition_ids, liquidity_num_min/max, volume_num_min/max, start_date_min/max, end_date_min/max, tag_id, related_tags, cyom, uma_resolution_status, game_id, sports_market_types, rewards_min_size, question_ids, include_tag, closed`. Since 2026-04-09 **`closed` defaults to false**.
- `GET /markets/keyset` (recommended; offset-based `/markets` will be deprecated) returns `{markets:[...], next_cursor}` and takes `after_cursor`. Max `limit` is 100.
- `GET /events` accepts `limit, offset, order, ascending, id, tag_id, exclude_tag_id, slug, tag_slug, related_tags, active, archived, featured, cyom, closed, liquidity_min/max, volume_min/max, start_date_min/max, end_date_min/max, ...`. `GET /events/keyset` is the cursor version (it also has `title_search`, `live`, `series_id`, ...).
- Single-item lookups: `GET /markets/{id}`, `/markets/slug/{slug}`, `/events/{id}`, `/events/slug/{slug}`.
- `GET /public-search` accepts `q, cache, events_status, limit_per_type, page, events_tag, keep_closed_markets, sort, ascending, search_tags, search_profiles, recurrence, exclude_tag_id, optimized`. It returns `{events:[Event], tags?, profiles?, pagination:{hasMore,totalResults}}`.
- Market fields, checked against a live response:
  - `outcomes`, `outcomePrices` and `clobTokenIds` are **JSON-encoded strings**, e.g. `outcomes:'["Yes", "No"]'`, `outcomePrices:'["0.495", "0.505"]'`, `clobTokenIds:'["1040…","1094…"]'`. You must `JSON.parse` them.
  - `negRisk` (bool), `negRiskMarketID`, `negRiskRequestID`, `negRiskOther`.
  - `orderPriceMinTickSize` (number, e.g. 0.01), `orderMinSize` (e.g. 5).
  - `bestBid`, `bestAsk`, `lastTradePrice`, `spread`, `volume24hr`, `volumeNum`, `liquidityNum`, `conditionId`, `questionID`, `enableOrderBook`, `acceptingOrders`, `active`, `closed`, `endDate`.
  - Fee fields: `feesEnabled`, `feeSchedule:{exponent,rate,takerOnly,rebateRate}`, `feeType` (e.g. "sports_fees_v3"), `takerBaseFee`, `makerBaseFee`.
  - Also `positionIds` (V3 position IDs), `version` ("v1"), `rfqEnabled`, `secondsDelay`.
- Event fields: `negRisk`, `enableNegRisk`, `negRiskMarketID`, `negRiskAugmented`, `markets[]`.

### 2.2 CLOB REST (`https://clob.polymarket.com`, public GETs; all verified live)
- `GET /book?token_id=` returns `{market, asset_id, timestamp, hash, bids:[{price,size}], asks:[{price,size}], min_order_size, tick_size, neg_risk, last_trade_price}`. All values are strings. **Bids are sorted ascending (best bid LAST) and asks descending (best ask LAST).**
- `GET /books?token_ids=a,b` or `POST /books` (body `[{token_id}]`).
- `GET /midpoint?token_id=` returns `{"mid":"0.495"}`. `/midpoints` is the batch version.
- `GET /price?token_id=&side=BUY|SELL` returns `{"price":"0.49"}`. Per the spec, **BUY returns the best bid and SELL returns the best ask**. `/prices?token_ids=&sides=` and `POST /prices` are batch versions.
- `GET /spread?token_id=` returns `{"spread":"0.01"}`. `GET /last-trade-price?token_id=` returns `{"price":"0.5","side":"BUY"}`.
- `GET /tick-size?token_id=` returns `{"minimum_tick_size":0.01}`. `GET /neg-risk?token_id=` returns `{"neg_risk":true}`. `GET /fee-rate?token_id=` returns `{"base_fee":1000}`.
- `GET /prices-history?market=<token_id>&interval=max|all|1m|1w|1d|6h|1h&fidelity=<minutes>&startTs=&endTs=` returns `{history:[{t,p}]}`.
- **Data API v2** version: `GET https://data-api.polymarket.com/v2/prices-history?token_id=<id>&interval=1d&bucket_seconds=3600`. Use exactly one window form: `interval`, `start`/`end` (epoch seconds, max 15 days), or `as_of`. The response is `{data:[{timestamp, price, resolution_seconds}], next_cursor?}`. It **rejects `market=`** with HTTP 400.
- Tick sizes in V2 are `"0.1" | "0.01" | "0.005" | "0.0025" | "0.001" | "0.0001"`. World Cup markets use 0.0025.

### 2.3 Market WebSocket (verified live with `ws`)
- URL: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Subscribe: `{"assets_ids":["<token_id>"],"type":"market"}`. Add `"custom_feature_enabled":true` to also receive `best_bid_ask`, `new_market` and `market_resolved`.
- Change the subscription without reconnecting: `{"assets_ids":[...],"operation":"subscribe"|"unsubscribe"}`.
- **Keepalive:** send the text frame `PING` every 10 s. The server replies `PONG`, which is not JSON, so skip it before parsing.
- Events:
  - `book`: `{event_type, market, asset_id, timestamp, hash, bids, asks, tick_size, last_trade_price}`. **The initial snapshot arrives wrapped in a JSON array `[{...}]`**; later messages are single objects.
  - `price_change`: `{event_type, market, timestamp, price_changes:[{asset_id, price, size, side, hash, best_bid, best_ask}]}`. `size` is the new aggregate size at that level; 0 means the level was removed.
  - `last_trade_price`: `{event_type, market, asset_id, price, size, fee_rate_bps, side, timestamp, transaction_hash}`.
  - `tick_size_change`: `{..., old_tick_size, new_tick_size}`.
  - `best_bid_ask`: `{..., best_bid, best_ask, spread}`.
  - `new_market` is broadcast globally when custom features are enabled. `market_resolved` carries `{winning_asset_id, winning_outcome}`.
- A user channel also exists at `.../ws/user` (authenticated). Sports: `wss://sports-api.polymarket.com/ws`, where the server sends `ping` every 5 s and you reply `pong`.

### 2.4 Fees (Fee Structure V2, effective 2026-03-30; sports updated 2026-07-10)
- `fee = C × feeRate × p × (1 − p)`, where C is shares and p is price. Read the rate from the market's `feeSchedule.rate`; `exponent` is currently 1. **Only takers pay; makers pay 0.** Fees are rounded to 5 decimals.
- Taker rates: Crypto 0.07; Sports 0.05; Finance 0.04; Politics 0.04; Economics 0.05; Culture 0.05; Weather 0.05; Other 0.05; Mentions 0.04; Tech 0.04; **Geopolitics 0 (fee-free)**.
- Maker rebates: 20% of taker fees for crypto, 15% for sports, 25% for the other categories.
- Crypto taker delay is 150 ms (since 2026-09-04).

### 2.5 Rate limits (Cloudflare, per IP, sliding window; requests are throttled rather than rejected)
- General: 15,000 per 10 s.
- Gamma: 4,000 per 10 s general; `/events` 500; `/markets` 300; `/public-search` 350.
- CLOB: 9,000 per 10 s general; `/book` 1,500; `/books` 500; `/price` 1,500; `/midpoint` 1,500; `/prices-history` 1,000.
- CLOB trading: `POST /order` 5,000 per 10 s burst and 120,000 per 10 min sustained. `POST /orders` 2,000 per 10 s. `DELETE /orders` max 1,000 IDs per call. `DELETE /cancel-all` 250 per 10 s.
- Data API v2: 800 per 10 s general; `/v2/prices-history` 200 per 10 s.

### 2.6 `@polymarket/clob-client-v2` 1.2.0 (d.ts in `node_modules/@polymarket/clob-client-v2/dist`)
Dependencies are viem ^2 and `@ethersproject/wallet` v5. The signer is `EthersSigner` (ethers **v5** `_signTypedData`) or a viem **`WalletClient`**. ethers v6 is not accepted.

```ts
interface ClobClientOptions {
  host: string; chain: Chain; signer?: ClobSigner; creds?: ApiKeyCreds;
  signatureType?: SignatureTypeV2; funderAddress?: string; useServerTime?: boolean;
  builderConfig?: BuilderConfig; getSigner?: () => Promise<ClobSigner> | ClobSigner;
  retryOnError?: boolean; throwOnError?: boolean; feeSlippage?: number;
}
constructor(opts: ClobClientOptions)          // OPTIONS OBJECT (V1 was positional; chainId -> chain)
enum Chain { POLYGON = 137, AMOY = 80002 }
enum SignatureTypeV2 { EOA = 0, POLY_PROXY = 1, POLY_GNOSIS_SAFE = 2, POLY_1271 = 3 /* Deposit Wallet */ }
enum Side { BUY = "BUY", SELL = "SELL" }
enum OrderType { GTC = "GTC", FOK = "FOK", GTD = "GTD", FAK = "FAK" }
type TickSize = "0.1" | "0.01" | "0.005" | "0.0025" | "0.001" | "0.0001";
type CreateOrderOptions = { tickSize: TickSize; negRisk?: boolean; version?: 1 | 2 | 3 };
interface ApiKeyCreds { key: string; secret: string; passphrase: string }
type UserOrderV2 = ({tokenID: string} | {positionID: string}) & { price: number; size: number; side: Side; metadata?: string; builderCode?: string; expiration?: number; userUSDCBalance?: number };
type UserMarketOrderV2 = ({tokenID} | {positionID}) & { price?: number; amount: number /* BUY: $; SELL: shares */; side: Side; orderType?: OrderType.FOK | OrderType.FAK; userUSDCBalance?; metadata?; builderCode? };
interface OrderResponse { success: boolean; errorMsg: string; orderID: string; transactionsHashes?: string[]; tradeIDs?: string[]; status: string; takingAmount: string; makingAmount: string }

createOrDeriveApiKey(nonce?: number): Promise<ApiKeyCreds>;   // also createApiKey / deriveApiKey
getOrderBook(tokenID: string): Promise<OrderBookSummary>;
getOrderBooks(params: BookParams[]): Promise<OrderBookSummary[]>;
getTickSize(tokenID: string): Promise<TickSize>;
getNegRisk(tokenID: string): Promise<boolean>;
getFeeRateBps(tokenID: string): Promise<number>; getFeeExponent(tokenID: string): Promise<number>;
getClobMarketInfo(conditionID: string): Promise<MarketDetails>;   // warms tick/negRisk/fee caches
getMidpoint(tokenID); getPrice(tokenID, side: string); getSpread(tokenID); getLastTradePrice(tokenID);
getPricesHistory(params: { market?: string; startTs?: number; endTs?: number; fidelity?: number; interval?: PriceHistoryInterval }): Promise<MarketPrice[]>; // {t,p}
createOrder(userOrder: UserOrderV1 | UserOrderV2, options?: Partial<CreateOrderOptions>): Promise<SignedOrder>;
createMarketOrder(o: UserMarketOrderV1 | UserMarketOrderV2, options?): Promise<SignedOrder>;
createAndPostOrder<T extends OrderType.GTC | OrderType.GTD = OrderType.GTC>(userOrder, options?, orderType?: T, postOnly?: boolean, deferExec?: boolean): Promise<OrderResponse>;
createAndPostMarketOrder<T extends OrderType.FOK | OrderType.FAK = OrderType.FOK>(o, options?, orderType?: T, deferExec?: boolean): Promise<OrderResponse>;
postOrder<T extends OrderType = OrderType.GTC>(order: SignedOrder, orderType?: T, postOnly?: boolean, deferExec?: boolean): Promise<OrderResponse>;
postOrders(args: PostOrdersArgs[], postOnly?: boolean, deferExec?: boolean): Promise<OrderResponse[]>;
cancelOrder(payload: { orderID: string }); cancelOrders(ordersHashes: string[]); cancelAll();
cancelMarketOrders(payload: { market?: string; asset_id?: string });
postHeartbeat(heartbeatId?: string)   // if heartbeats are started and one is missed for 10s, all orders are cancelled
```
Note that `postOnly` now comes **before** `deferExec`. The legacy V1 client had the opposite order.

```ts
import { ClobClient, Chain, Side, OrderType, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem"; import { privateKeyToAccount } from "viem/accounts"; import { polygon } from "viem/chains";
const signer = createWalletClient({ account: privateKeyToAccount(PK), chain: polygon, transport: http() });
const l1 = new ClobClient({ host: "https://clob.polymarket.com", chain: Chain.POLYGON, signer });
const creds = await l1.createOrDeriveApiKey();
const client = new ClobClient({ host: "https://clob.polymarket.com", chain: Chain.POLYGON, signer, creds,
  signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE /* or EOA / POLY_PROXY / POLY_1271 */, funderAddress: PROFILE_ADDR, throwOnError: true });
await client.createAndPostOrder({ tokenID, price: 0.4, size: 10, side: Side.BUY }, { tickSize: "0.01", negRisk }, OrderType.GTC);
```

### 2.7 Unified SDK `@polymarket/client` 0.11.0 (officially recommended; **Node >= 24**)
```ts
import { createPublicClient, createSecureClient } from "@polymarket/client";
import { privateKey, signerFrom } from "@polymarket/client/viem";  // also /ethers-v5, /privy
const pub = createPublicClient();                       // (options?: { environment?, apiKey?, onRateLimitUpdate? })
const sec = await createSecureClient({ signer: privateKey(PK), wallet?: "0x…", credentials?: ApiKeyCreds /* or nonce */ });
pub.listMarkets({ closed: false, pageSize: 10 })        // Paginated<Market[]>: .firstPage(), for await, .from(cursor)
pub.search({...}); pub.fetchOrderBook({ tokenId }); pub.fetchMidpoint({ tokenId });
pub.listPriceHistory({ assetId, interval: "1d", bucketSeconds: 3600 });
await pub.subscribe([{ topic: "market", tokenIds: [id] }]) // async iterable: MarketBookEvent | MarketPriceChangeEvent | MarketLastTradePriceEvent | MarketTickSizeChangeEvent
sec.placeLimitOrder({ tokenId, price, size, side, postOnly?, expiration?, builderCode? });
sec.placeMarketOrder({ tokenId, side: BUY, amount, maxPrice?, orderType? } | { tokenId, side: SELL, shares, minPrice? });
sec.cancelOrder(...); sec.cancelAll();
```

---

## 3. RSS feeds (curl with browser UA, 2026-09-26 ~13:40 UTC)

`https://feeds.bloomberg.com/<section>/news.rss` returns **301 to `https://www.bloomberg.com/feeds/<section>/news.rss`**. The target returns 200 `text/xml`, and it also works with a non-browser UA.

| Bloomberg URL (use www form) | Status | Items |
|---|---|---|
| https://www.bloomberg.com/feeds/markets/news.rss | 200 RSS | 20, fresh |
| /feeds/politics/news.rss | 200 RSS | 20 |
| /feeds/technology/news.rss | 200 RSS | 20 |
| /feeds/economics/news.rss | 200 RSS | 13 |
| /feeds/industries/news.rss | 200 RSS | 18 |
| /feeds/bview/news.rss (Opinion) | 200 RSS | 7 |
| /feeds/businessweek/news.rss | 200 RSS | 1 |
| /feeds/wealth/news.rss, /feeds/crypto/news.rss | 200 but **0 items** | not useful |
| green, pursuits, opinion, view, citylab, deals, energy, finance, ai | **404** | dead |

Other feeds:

| Feed | Result |
|---|---|
| CNBC Top News `https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114` | 200 RSS, 30 items |
| CNBC Finance `...&id=10000664` / Markets `...&id=20910258` | 200 RSS, 30 items |
| `www.cnbc.com/id/.../device/rss/rss.html` | **403** (blocked) |
| MarketWatch Top Stories `https://feeds.content.dowjones.io/public/rss/mw_topstories` (old `feeds.marketwatch.com/marketwatch/topstories/` 301s here) | 200 RSS, fresh |
| MarketWatch `mw_marketpulse` | 200 but stale (Feb 2025) |
| WSJ Markets `https://feeds.content.dowjones.io/public/rss/RSSMarketsMain` | 200 RSS, 61 items, fresh |
| WSJ `https://feeds.a.dj.com/rss/RSSMarketsMain.xml` / `RSSWorldNews.xml` | 200 but **stale (Jan 2025)**; use the dowjones.io host |
| Fed all press `https://www.federalreserve.gov/feeds/press_all.xml` | 200 RSS, 20 items (pubDate in CDATA) |
| Fed monetary `.../feeds/press_monetary.xml`, speeches `.../feeds/speeches.xml` | 200 RSS |
| SEC press `https://www.sec.gov/news/pressreleases.rss` | 200 RSS, 25 items |
| SEC EDGAR 8-K Atom `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&output=atom` | 403 with a browser UA; **200 Atom with UA `"AppName contact@email"`** (SEC policy) |
| ECB press `https://www.ecb.europa.eu/rss/press.html` | 200 RSS, 15 items |
| Bank of England `https://www.bankofengland.co.uk/rss/news` | 200 RSS, 50 items |
| CoinDesk `https://www.coindesk.com/arc/outboundfeeds/rss/` | 200 RSS, 25 items |
| Cointelegraph `https://cointelegraph.com/rss` | 200 RSS, 30 items |
| The Block `https://www.theblock.co/rss.xml` | 200 RSS, 20 items |
| Yahoo Finance `https://finance.yahoo.com/news/rssindex` | 200 RSS, 49 items |
| Yahoo `feeds.finance.yahoo.com/rss/2.0/headline?s=...` | **429** |
| BBC Business `https://feeds.bbci.co.uk/news/business/rss.xml` | 200 RSS, 51 items |
| BBC World `https://feeds.bbci.co.uk/news/world/rss.xml` | 200 RSS |
| FT `https://www.ft.com/rss/home` (redirects to /rss/home/international) | 200 RSS, 12 items |
| FT Markets `https://www.ft.com/markets?format=rss` | 200 RSS, 25 items |
| NYT Business `https://rss.nytimes.com/services/xml/rss/nyt/Business.xml` | 200 RSS, 50 items |
| Guardian Business `https://www.theguardian.com/business/rss` | 200 RSS |
| Investing.com `https://www.investing.com/rss/news.rss` | 200 RSS |
| Seeking Alpha `https://seekingalpha.com/market_currents.xml` | 200 RSS |
| Nasdaq `https://www.nasdaq.com/feed/rssoutbound?category=Markets` | 200 RSS |
| Economist Finance `https://www.economist.com/finance-and-economics/rss.xml` | 200 RSS |
| AP: `apnews.com/hub/business.rss` returns 403; `feedx.net/rss/ap.xml` is stale (3 items) | no reliable free AP feed |
| NPR, BLS, IMF, OFAC | 403 from this environment |

---

## 4. TimesFM (PyPI `timesfm` 3.0.2; source read from the published wheel)

- Install: `pip install "timesfm[torch]"`. The base dependencies are numpy, huggingface_hub and safetensors. Other extras: `[mlx]` (Apple), `[flax]` (JAX), and `[xreg]` (**`jax[cuda]` plus scikit-learn**, required for the 2.5 covariate path).
- HF models that exist: `google/timesfm-3.0-pytorch` (about 330M params, updated 2026-09-02), `google/timesfm-2.5-200m-pytorch`, `google/timesfm-2.5-200m-flax`, `google/timesfm-2.5-200m-transformers`, `google/timesfm-2.0-500m-pytorch`, `google/timesfm-1.0-200m(-pytorch)`.
- **LICENSE WARNING:** TimesFM **3.0 weights use `timesfm-non-commercial-license-v1.0`**, which is non-commercial and non-production. **2.5 weights are Apache-2.0.** For a commercial or production app, use 2.5.

### TimesFM 3.0 (module `timesfm3`, also re-exported as `timesfm.TimesFM3Forecaster`)
```python
from timesfm3 import TimesFM3Forecaster, ModelConfig   # (TimesFM3Evaluator is a subclass)
f = TimesFM3Forecaster.from_pretrained("google/timesfm-3.0-pytorch", device="cuda", per_core_batch_size=32)
# ModelConfig fields: checkpoint_path, per_core_batch_size=4, input_patch_length=32, output_patch_length=64,
#   quantiles=[0.1..0.9], median_quantile_index=4, use_stitching, use_linear_detrending, ..., device, cache_dir, token, revision
out = f.predict(context: np.ndarray, horizon: int, past_only_covariates=None, past_future_covariates=None,
                ts_id=None, return_quantiles=False, use_symmetric_averaging=False, make_positive=False,
                sort_quantiles=True, use_znorm=False, padding_mode="none") -> ForecastOutput
outs = f.predict_batch(contexts: list[np.ndarray], horizon, past_only_covariates: list|None, past_future_covariates: list|None, ts_ids=None, return_quantiles=..., ...) -> Iterator[ForecastOutput]
# ForecastOutput(ts_id, forecast, quantiles)
# 1-D context -> forecast (h,), quantiles (h, 9) = deciles 0.1..0.9 (median = index 4)
# 2-D context (n_variates, T) -> forecast (n_variates, h), quantiles (n_variates, h, 9)
# covariates: past_only (n_cov, T); past_future (n_cov, T + h). Max context 15,360.
```

### TimesFM 2.5 (Apache-2.0)
```python
import timesfm, numpy as np
m = timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch")  # PyTorchModelHubMixin
m.compile(timesfm.ForecastConfig(max_context=1024, max_horizon=256, normalize_inputs=True,
          use_continuous_quantile_head=True, force_flip_invariance=True, infer_is_positive=True,
          fix_quantile_crossing=True))       # also per_core_batch_size=1, window_size=0, return_backcast=False
point, quant = m.forecast(horizon=12, inputs=[np.array(...), ...])
# point: (n, horizon) = quant[..., 5]; quant: (n, horizon, 10) -> index 0 = mean, 1..9 = q0.1..q0.9
# context limit 16384; input patch 32, output patch 128
m.forecast_with_covariates(inputs, dynamic_numerical_covariates={name: [[...ctx+h...]]}, dynamic_categorical_covariates=..., static_numerical_covariates=..., static_categorical_covariates=..., xreg_mode="xreg + timesfm", ridge=0.0, ...)
# requires ForecastConfig(return_backcast=True) and the [xreg] extra (JAX)
```

---

## 5. Modal (PyPI `modal` 1.5.5; source read from the published package)

```python
import modal
app = modal.App("midas-forecast")
image = (modal.Image.debian_slim(python_version="3.11")
         .uv_pip_install("timesfm[torch]==3.0.2", "fastapi[standard]")   # uv_pip_install(*packages, requirements=, index_url=, extra_index_url=, pre=, extra_options=, env=, secrets=, gpu=)
         .env({"HF_HOME": "/cache/hf"}))                                  # pip_install(...) still exists
hf_cache = modal.Volume.from_name("hf-cache", create_if_missing=True)
secret = modal.Secret.from_name("hf-token", required_keys=["HF_TOKEN"])   # or Secret.from_dict({...})

@app.cls(gpu="L4", image=image, volumes={"/cache": hf_cache}, secrets=[secret],
         scaledown_window=300, timeout=600, min_containers=0, max_containers=4)
class Forecaster:
    @modal.enter()                 # enter(*, snap: bool=False)
    def load(self): ...
    @modal.method()
    def forecast(self, series: list[float], horizon: int) -> dict: ...
    @modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)   # (method="GET", label=None, custom_domains=None, docs=False, requires_proxy_auth=False)
    def http(self, body: dict) -> dict: ...

# alternatively @app.function(...) + @modal.asgi_app(label=None, custom_domains=None, requires_proxy_auth=False) returning a FastAPI app
# fan-out: Forecaster().forecast.map(series_list, kwargs=...)  / fn.map(iter, order_outputs=True, return_exceptions=False); .starmap, .spawn_map
# concurrency: @modal.concurrent(max_inputs=..., target_inputs=...); batching: @modal.batched(max_batch_size=, wait_ms=)
```

- The full `App.cls` keyword list: `image, env, secrets, gpu (str or list, e.g. "L4", "A10G", "H100:2"), volumes, cpu, memory, ephemeral_disk, min_containers, max_containers, buffer_containers, scaledown_window, retries, timeout=300, startup_timeout, cloud, region, enable_memory_snapshot, max_inputs, ...`. The old `keep_warm`, `container_idle_timeout` and `concurrency_limit` keywords are gone.
- `@modal.web_endpoint` is deprecated; use `@modal.fastapi_endpoint`.
- **TS client over plain HTTPS:** POST to `https://<workspace>--<app>-<cls>-<method>.modal.run` (or the `label` URL). Send the headers `Modal-Key: wk-…` and `Modal-Secret: ws-…`, or `Authorization: Bearer wk-….ws-…`. Create tokens with `modal workspace proxy-tokens create`.
- **Alternative:** the official JS SDK `modal` (npm 0.10.1, Node >= 22) uses `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` (API tokens `ak-/as-`). Call pattern:
  ```ts
  const mc = new ModalClient();
  const cls = await mc.cls.fromName("app", "Forecaster");
  const inst = await cls.instance();
  await inst.method("forecast").remote([args], {kw});
  // functions: (await mc.functions.fromName(app, name)).remote(args?, kwargs?) / .spawn(...)
  ```

---

## 6. Next.js 16 + React 19 + Tailwind v4 + TypeScript

- Versions: `next` 16.3.6 (peer: react/react-dom `^18.2 || ^19`; node >= 20.9), `react`/`react-dom` 19.3.0, `@types/react`/`@types/react-dom` 19.3.0, `tailwindcss` and `@tailwindcss/postcss` 4.3.3, `eslint-config-next` 16.3.6 (peer eslint >= 9; create-next-app pins `eslint ^9`).
- **`next lint` no longer exists.** The CLI offers only build, dev, start, info, telemetry, typegen, upgrade and experimental-*. Use `eslint .` with the flat config below, or Biome (`biome check`). The `eslint` key is also gone from `NextConfig`.
- Turbopack is the default bundler for build and dev; `--webpack` opts out. The middleware file convention is renamed to **`proxy.ts`** (`PROXY_FILENAME = "proxy"`).
- Valid top-level `NextConfig` keys include: `typedRoutes, reactCompiler, turbopack, cacheComponents, serverExternalPackages, transpilePackages, images, output, typescript{ignoreBuildErrors,tsconfigPath}, experimental, env, headers/rewrites/redirects, allowedDevOrigins`.
- Scaffold template from create-next-app 16.3.6 (`app-tw/ts`):
  ```ts
  // next.config.ts
  import type { NextConfig } from "next";
  const nextConfig: NextConfig = {};
  export default nextConfig;
  ```
  ```js
  // postcss.config.mjs
  export default { plugins: { "@tailwindcss/postcss": {} } };
  ```
  ```css
  /* app/globals.css */
  @import "tailwindcss";
  @theme inline { --color-background: var(--background); }
  ```
  ```js
  // eslint.config.mjs
  import { defineConfig, globalIgnores } from "eslint/config";
  import nextVitals from "eslint-config-next/core-web-vitals";
  import nextTs from "eslint-config-next/typescript";
  export default defineConfig([...nextVitals, ...nextTs, globalIgnores([".next/**","out/**","build/**","next-env.d.ts"])]);
  ```
  - tsconfig uses `"jsx": "react-jsx"` and `"moduleResolution": "bundler"`, and includes `.next/types/**/*.ts` and `.next/dev/types/**/*.ts`. No tailwind.config.js is needed.
- **TypeScript:**
  - npm `latest` is 7.0.2 (the Go-native compiler). 6.0.3 and 5.9.3 are also current.
  - Next 16.3 handles TS 7 only through `experimental.useTypeScriptCli` (default **true** in 16.3.6), which runs the `tsc` CLI. TS 7 "does not provide the compiler API"; if you set that flag to false, Next errors and suggests TS 6.
  - Next warns only below 5.1.0. create-next-app pins `typescript: "^5"`.
  - **Recommendation: `typescript@~5.9.3`** (the template default, and the safest for typescript-eslint and other tooling). `^6.0.3` should also work. Avoid 7.x until your lint tooling supports it. Whether typescript-eslint works with TS 7 is **UNVERIFIED**.

---

## 7. System One decision models (Jev, Laya)

### 7a. Jev by TypeSafe AI

Sources: npm `@typesafe-ai/sdk` 0.6.0 (published 2026-09-15; d.ts read in full), https://docs.typesafe.ai/llms.txt, `/api.md`, `/models.md`, `/introduction/quickstart.md`, https://openrouter.ai/docs/guides/community/typesafe-sdk.md, the OpenRouter System One API reference, and https://openrouter.ai/blog/tutorials/how-to-use-jev/. The third-party guides (dev.to, refix.ai) agree with the official docs.

- **Official REST:** `POST https://api.typesafe.ai/v1/systemone` with headers `Authorization: Bearer <TYPESAFE_API_KEY>` and `Content-Type: application/json`. A live probe without a key returned 403 "Must supply an API key!". `GET /v1/models` returns `{models:[{name,description,release_date}]}`.
- **Through OpenRouter:**
  - `POST https://openrouter.ai/api/v1/systemone` is TypeSafe-SDK compatible. Set `baseURL: "https://openrouter.ai/api"` and use an OpenRouter key; bare `jev-1.13` maps to `typesafe/jev-1.13` and `jev-latest` maps to `~typesafe/jev-latest`.
  - The alternative is `POST https://openrouter.ai/api/alpha/decisions` (Decisions API, same body with `model:"typesafe/jev-1.13"`). Its response adds `usage.cost`, `id` and `provider`.
- `https://jevtypesafeai.com/api/v1/decide` is a **third-party, unofficial site** (Clerk login, `jv_live_` keys). It is **not** a TypeSafe domain. Do not use it.
- Models: `jev-1.13.0`. Aliases `jev-latest` and `jev-preview` both point to jev-1.13.0. OpenRouter ids: `typesafe/jev-1.13` (answers as `typesafe/jev-1.13-20260917`), `~typesafe/jev-latest`, and `typesafe/jev-router`.
- Price: **$0.042 per 1M input tokens; output is free.** OpenRouter shows prompt $0.000000042/token and completion 0.
- Limits: 250,000 tokens/s and 1,200 requests/min, adjusted dynamically; 429 on excess. Context is 64k tokens per request, and 32k for `state` plus the longest question. Text only. Choice questions take up to 255 options.

Request body: `{ state: string|object|array, model: string, questions: { [id]: Question } }`. Question types:
- `{type:"noul", instructions, criteria?:{true?, false?}}`
- `{type:"choice", instructions, criteria:{label: description|null}}`
- `{type:"score", instructions, criteria:[level0, level1, ...≥2]}`

Response body: `{ model, answers: { [id]: ... }, usage: { input_tokens, output_tokens } }`. Answer shapes:
- noul: `{type:"noul", noul: P(yes)}`. There is **no confidence field** on noul in the official API.
- choice: `{type:"choice", choice, confidence, probabilities:{label:p}}`
- score: `{type:"score", score /*expected value, may be fractional*/, confidence, legend:{"0":...}, probabilities:{"0":p}}`

SDK d.ts (verbatim excerpts):
```ts
interface TypeSafeClientConfig { apiKey?: string /*TYPESAFE_API_KEY*/; baseURL?: string /*TYPESAFE_BASE_URL, default https://api.typesafe.ai*/;
  defaultModel?: string /*TYPESAFE_DEFAULT_MODEL, default jev-latest*/; logLevel?; logger?; retry?: Partial<RetryPolicy>;
  timeout?: number /*10000 ms*/; defaultHeaders?; dangerouslyAllowBrowser?: boolean; fetch?: Fetch; }
declare class TypeSafeClient { constructor(config?: TypeSafeClientConfig); readonly models: Models;
  systemOne<const Q extends Questions>(request: SystemOneRequest<Q>, options?: RequestOptions): APIPromise<SystemOneResult<Q>>; }
interface SystemOneRequest<Q> { state: EntryType; questions: Q; model?: string }
interface SystemOneResult<Q> { readonly model: string; readonly answers: { [K in keyof Q]: ResultFor<Q[K]> }; readonly usage: Usage }
declare const noul: (instructions?: EntryType, criteria?: {true?: EntryType; false?: EntryType} | null) => NoulQuestion;
declare const score: <const T extends ScoreCriteria>(instructions: EntryType, criteria: T) => ScoreQuestion<T>;
declare const choice: <const T extends ChoiceCriteria>(instructions: EntryType, criteria: T) => ChoiceQuestion<T>;
// Errors: APIError(status, body, headers, requestId), BadRequestError, AuthenticationError, RateLimitError(retryAfterMs), APIConnectionError, APITimeoutError, APIUserAbortError
// Retry defaults: maxRetries 2, backoff 500ms..5000ms, retries 408/429/5xx, honors Retry-After
```
```ts
import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
const client = new TypeSafeClient(); // or { baseURL: "https://openrouter.ai/api", apiKey: OPENROUTER_KEY }
const { answers, usage } = await client.systemOne({
  state: { headline, market_question },
  questions: {
    relevant: noul("Does the headline bear on `market_question`?"),
    direction: choice("Which way does it move the YES probability?", { up: null, down: null, none: null }),
    impact: score("How large is the impact?", ["none", "small", "large"]),
  },
});
answers.relevant.noul; answers.direction.choice; answers.direction.probabilities.up; answers.impact.score;
```
Plain fetch, from the docs' curl example:
```ts
const res = await fetch("https://api.typesafe.ai/v1/systemone", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "jev-latest", state, questions: { is_urgent: { type: "noul", instructions: "..." } } }),
});
const { model, answers, usage } = await res.json();
```

### 7b. Laya by Convai Innovations

Source: PyPI `laya` 0.3.20, read from the published wheel. HF repos `convaiinnovations/laya`, `-multilingual` and `-typed-decisions` all exist (Apache-2.0, updated 2026-09-24).

- Dependencies: `torch>=2.0, transformers>=4.48, safetensors, huggingface_hub, numpy`. Extras:
  - `[serve]`: fastapi, uvicorn, python-multipart
  - `[fast]`: tilelang, CUDA only
  - `[onnx]`
  - `[mcp]`
  - `[langchain]` / `[langgraph]`
- Checkpoints: `english` (ModernBERT-large, 421M, 512 tokens) at the repo root; `multilingual` (mmBERT-base, 322M, 1024 tokens, 100+ languages); `typed-decisions` (421M, fine-tuned on 4 synthetic workflows, never auto-selected by default).

```python
import laya
agent = laya.load(model_id_or_path="convaiinnovations/laya", device=None, token=None, subfolder=None,  # subfolder="multilingual"
                  fast=False, lang_temperatures=None, hooks=None, ...)   # -> laya.Agent
agent.system_one(state, questions, lang=None, max_len=None, head_max_len=None) -> dict   # alias: agent.predict
agent.predict_batch(states: list, questions, batch_size=None, lang=None, ...) -> list[dict]

router = laya.Router(models=None, device=None, token=None, max_loaded=2, default="english",
                     auto_task_detection=False, standalone_repos=False, preload=False, lang_guess=None, hooks=None, ...)
router.predict(state, questions, model=None, task=None, lang=None, lang_guess=None, hooks=None, ..., max_len=None, head_max_len=None) -> dict
router.route(state, questions) -> RouteDecision   # dict with model, reason, detection
router.decide(state, schema=<JSON schema | pydantic model>) -> typed values; router.predict_batch(...); router.preload([...])
# model= accepts "english"|"multilingual"|"typed-decisions" or aliases "en","laya","multi","ml","typed","decisions"
```
Return dict (Jev-compatible, plus extra fields):
```python
{"model": "laya-rl-agent",
 "answers": {qid: {"type":"choice","choice":..., "probabilities":{...}, "confidence":..., "answer_confidence":..., "action":{"act_probability":...}}
                | {"type":"score","score":..., "legend":{"0":...}, "probabilities":{"0":...}, "confidence":..., "answer_confidence":..., "action":{...}}
                | {"type":"noul","noul": P(true), "confidence": max(p,1-p), "answer_confidence":..., "action":{...}}},
 "usage": {"input_tokens": n, "output_tokens": 0},
 "routing": {...}}    # routing only from Router.predict
```
Two confidence fields are returned. For noul, `confidence` is max(p). For choice and score, `confidence` is normalized entropy. `answer_confidence` is the calibrated value that is comparable across all question types.

- **HTTP server:** yes. `pip install "laya[serve]"`, then run `laya-serve`. It exposes `POST /v1/systemone` (the Jev wire protocol) and `GET /health`. It is configured through env vars:
  - `LAYA_HOST` (0.0.0.0), `LAYA_PORT` (8000), `LAYA_DEVICE`, `LAYA_PRELOAD` (1), `LAYA_MODELS`, `LAYA_THREADS`, `LAYA_AUTO_TASK`, `LAYA_API_KEY`
  - `LAYA_API_KEY` turns on a Bearer check.
  - Limits: 64 questions, 50,000 state characters, 2 MB body.
  - An unknown `model`, such as `jev-latest`, falls back to auto-routing.
- Other CLIs: `laya` and `laya-mcp-server`.
- **Calibration:** there is **no temperature-fitting API** in the package. Per-question-type temperatures (`temperature`, `temperature_by_options`) are read from the checkpoint config and clamped. You can override them per language with `lang_temperatures={"de": {"temperature":[t_choice,t_score,t_noul], "temperature_by_options":{...}}}` passed to `load()`/`Agent()`. The list order follows `QTYPES = {"choice":0, "score":1, "noul":2}`. Helpers `laya.ece_score` and `laya.proper_reward` exist for evaluation and training.
