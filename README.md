# @ch99q/bucket

High-throughput streaming data access layer for trading applications. Built for backtesting, algorithmic trading, and real-time market data processing.

## Performance

Results from an Apple M4 Pro (Node via Bun). Run `npm run bench` to reproduce on your hardware.

### Core

| Benchmark | ops/sec | avg |
|---|--:|--:|
| Single symbol stream (100k records) | 25.0 | 40ms |
| Multi-symbol merged stream (5 x 20k) | 10.2 | 98ms |
| Live ticks (50k) | 18.4 | 54ms |
| Fetch no cache (10k records) | 242.7 | 4.1ms |
| Fetch TTL cache hit (10k records) | 214.4 | 4.7ms |
| Batch fetch (8 symbols x 3 intervals) | 117.1 | 8.5ms |
| Storage cache hit | 928.7 | 1.1ms |
| Storage gap fill (sliding window) | 316.9 | 3.2ms |
| filter + map + take (50k to 25k) | 40.0 | 25ms |
| Resample 60k 1s to 5m | 38.4 | 26ms |
| Stream 200k records (memory) | 11.9 | 84ms |

### Storage adapters (write + fetch)

| Adapter | Write 1MB | Fetch 1MB | Write 10MB | Fetch 10MB |
|---|--:|--:|--:|--:|
| **fs** | 41ms | 52ms | 243ms | 304ms |
| **sqlite** | 85ms | 96ms | 492ms | 564ms |
| **memory** | 33ms | 35ms | 214ms | 231ms |

Raw results are written to [`benchs/results.json`](benchs/results.json) after each run.

## Installation

```bash
npm install @ch99q/bucket
```

## Quick Start

```javascript
import { createBucket, memoryDriver, ttlCache } from '@ch99q/bucket';

// Create a simple in-memory data source
const driver = memoryDriver("test", candleData, [
  { kind: "candle", supports: { fetch: true }, priority: 1 }
]);

// Create bucket with optional caching — auto-closes when scope exits
await using bucket = createBucket({
  drivers: [driver],
  cache: ttlCache({ ms: 60000 }) // 60-second TTL
});

// Fetch historical data
const data = await bucket.fetch({
  symbol: "AAPL",
  kind: "candle",
  interval: "1m",
  from: "2024-01-01T00:00:00Z",
  to: "2024-01-02T00:00:00Z"
});

// Stream data for processing
for await (const candle of bucket.stream({ symbol: "AAPL", kind: "candle", interval: "1m" })) {
  console.log(candle.close);
}
```

## Built-in Drivers

### Memory Driver

Import it directly from the dedicated subpath for optimal tree-shaking:

```js
import { memoryDriver } from '@ch99q/bucket/driver/memory';
```

It eagerly sorts the in-memory dataset, builds per-symbol indexes, and is ideal for deterministic tests, demos, and backtests. Drivers now self-identify, so you can skip manual IDs unless you are running multiple instances:

```js
const driver = memoryDriver({
  rows: candleData,
  capabilities: [
    { kind: 'candle', supports: { fetch: true }, priority: 1 },
  ],
  // id: 'memory' // optional override
});
```

### TradingView Driver (`@ch99q/twc`)

A ready-made TradingView driver is included under `@ch99q/bucket/driver/tradingview`. It is built on top of [`@ch99q/twc`](https://www.npmjs.com/package/@ch99q/twc) and streams both historical and live candle data.

```ts
import { createBucket, ttlCache } from '@ch99q/bucket';
import { tradingViewDriver } from '@ch99q/bucket/driver/tradingview';

const driver = tradingViewDriver({
  id: 'tv-nasdaq',
  defaultExchange: 'NASDAQ',              // fallback when symbol lacks exchange prefix
  token: process.env.TRADINGVIEW_TOKEN,   // optional session token
  historyLimit: 750,                      // default number of candles for fetch()
  liveWarmupBars: 3,                      // warmup bars before live streaming
  capabilities: [
    { kind: 'candle', supports: { fetch: true, live: true }, priority: 10, symbols: [/^NASDAQ:/] },
  ],
});

const bucket = createBucket({
  drivers: [driver],
  cache: ttlCache({ ms: 30_000, max: 1024 }),
});

for await (const candle of bucket.stream({ symbol: 'NASDAQ:AAPL', kind: 'candle', interval: '1m' })) {
  console.log(candle.close);
}
```

> Always import TradingView via its subpath (`@ch99q/bucket/driver/tradingview`) so bundlers only pull in the driver you actually need.
>
> The upstream `@ch99q/twc` package expects a WebSocket implementation. Install `ws` (and `@types/ws` when using TypeScript) in the host app if you're not running inside a browser.

#### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | `string` | `"tradingview"` | Identifier surfaced in logs/errors for this driver instance. |
| `capabilities` | `Capability[]` | `[{ kind: 'candle', supports: { fetch: true, live: true }, priority: 5 }]` | Advertised driver coverage; override to scope by exchange/symbol/type. |
| `token` | `string` | `undefined` | Optional TradingView auth token passed to `createSession`. |
| `verbose` | `boolean` | `false` | Enables extra logging inside `@ch99q/twc`. |
| `defaultExchange` | `string` | `undefined` | Prepended when the query symbol does not include `EXCHANGE:`. |
| `historyLimit` | `number` | `500` | Baseline number of bars fetched when no explicit range is given. |
| `maxHistoryBars` | `number` | `5000` | Upper bound for any historical fetch. |
| `liveWarmupBars` | `number` | `5` | Bars requested before switching a live stream online. |
| `client` | `{ createSession, createChart, createSeries }` | `@ch99q/twc` exports | Inject fakes for testing or instrumentation. |

Symbol parsing (e.g., `BINANCE:BTCUSDT`) and interval translation (`1m`, `1h`, `1D`, `1W`, `1M`) are handled internally. If you need additional formats, open an issue so we can bake them into the shared mapper.

## Persistence & Storage

`createBucket` accepts an optional `storage` adapter. The adapter is consulted before touching any upstream driver, and every new record streamed through the bucket is written back automatically. This gives you a zero-effort write-through cache that can live on-disk, in SQLite, or purely in-memory.

```ts
import { createBucket, ttlCache } from '@ch99q/bucket';
import { tradingViewDriver } from '@ch99q/bucket/driver/tradingview';
import { fsAdapter } from '@ch99q/bucket/storage/fs';

await using storage = fsAdapter({
  baseDir: '.bucket-storage',    // defaults to cwd/.bucket-storage
  namespace: 'prod',             // optional multi-tenant isolation
});

await using bucket = createBucket({
  storage,
  drivers: [tradingViewDriver({ defaultExchange: 'NASDAQ' })],
  cache: ttlCache({ ms: 60_000 }),
});

// Bucket will hit the filesystem cache first, only pulling missing spans from TradingView.
const candles = await bucket.fetch({
  symbol: 'NASDAQ:AAPL',
  kind: 'candle',
  interval: '1m',
  from: '2024-01-01T10:00:00Z',
  to: '2024-01-01T11:00:00Z',
});
```

### Built-in Adapters

| Subpath | When to use |
| --- | --- |
| `@ch99q/bucket/storage/memory` | Tests & short-lived jobs where you want persistence semantics without touching disk. |
| `@ch99q/bucket/storage/fs` | Human-readable JSON chunks on disk, easy to inspect or sync. |
| `@ch99q/bucket/storage/sqlite` | High-throughput durable cache backed by Bun's `bun:sqlite` or `better-sqlite3`. |

```ts
// Memory adapter
import { memoryAdapter } from '@ch99q/bucket/storage/memory';
await using storage = memoryAdapter();

// Filesystem adapter
import { fsAdapter } from '@ch99q/bucket/storage/fs';
await using storage = fsAdapter({ baseDir: './.bucket-storage', namespace: 'backtests' });

// SQLite adapter (auto-detects bun:sqlite or better-sqlite3)
import { sqliteAdapter } from '@ch99q/bucket/storage/sqlite';
await using storage = sqliteAdapter({ path: './bucket-cache.sqlite' });
```

### Custom Adapters

Build on the shared `storageAdapter` helper exported by `@ch99q/bucket/storage/adapter`. Each adapter implements `fetch(query) => { rows, missing }`, `write(records, ctx)` and (optionally) `close()`. The bucket handles gap detection, cache hydration, and automatic write-through so upstream drivers stay persistence-agnostic.

```ts
import { storageAdapter } from '@ch99q/bucket/storage/adapter';

const adapter = storageAdapter({
  id: 'custom-cache',
  async fetch(query) {
    return { rows: [], missing: [{ from: query.from, to: query.to }] };
  },
  async write(rows, ctx) {
    // persist rows somewhere durable
  },
});
```

## API Reference

### Core Functions

#### `createBucket(options)`

Creates a new bucket instance with configured drivers and caching. Supports `Symbol.asyncDispose` for automatic cleanup via `await using`.

```javascript
await using bucket = createBucket({
  drivers: [driver1, driver2],      // Data source drivers
  cache: ttlCache({ ms: 60000 }),   // Optional: Cache with TTL
  storage: adapter,                 // Optional: Storage adapter
  select: customSelectFunction      // Optional: Custom driver selection
});
```

**Parameters:**
- `drivers`: Array of driver instances that provide data
- `cache`: Optional cache instance (recommend `ttlCache({ ms: 60000 })`)
- `storage`: Optional storage adapter for persistence
- `select`: Optional custom driver selection function

**Returns:** Bucket instance with `fetch`, `stream`, `session`, and `close` methods.

---

#### `bucket.fetch(query, options?)`

Fetches data as an array. Suitable for small datasets and backtesting.

```javascript
// Single query
const data = await bucket.fetch({
  symbol: "AAPL",
  kind: "candle",
  interval: "1m",
  from: "2024-01-01T00:00:00Z",
  to: "2024-01-01T01:00:00Z"
});

// Multi-symbol batch query
const data = await bucket.fetch({
  aapl: { symbol: "AAPL", kind: "candle", interval: "1m" },
  googl: { symbol: "GOOGL", kind: "candle", interval: "1m" }
});

// With options
const data = await bucket.fetch(query, {
  limit: 1000,           // Limit results
  descending: true,      // Newest first
  useCache: false        // Skip cache
});
```

**Query Object:**
- `symbol`: Required string (e.g., "AAPL", "BTC-USD")
- `kind`: Required "candle" | "tick" | "custom"
- `interval`: Required for candles (e.g., "1m", "5m", "1h", "1d")
- `type`: Required for custom data
- `from`: Optional ISO timestamp
- `to`: Optional ISO timestamp

---

#### `bucket.stream(query, options?)`

Intelligent streaming that automatically handles historical, live, and seamless transitions based on time bounds. Preferred for large datasets and real-time processing.

```javascript
// Historical streaming (bounded time range)
for await (const record of bucket.stream({
  symbol: "AAPL",
  kind: "candle",
  interval: "1m",
  from: "2024-01-01T00:00:00Z",
  to: "2024-01-02T00:00:00Z"     // Ends at specific time
})) {
  // Process historical data - memory efficient streaming
}

// Live streaming (no time bounds)
for await (const record of bucket.stream({
  symbol: "AAPL",
  kind: "tick"                   // No from/to = live data
})) {
  // Process real-time data as it arrives
}

// Historical -> Live transition (seamless)
for await (const record of bucket.stream({
  symbol: "AAPL",
  kind: "tick",
  from: "2024-01-01T00:00:00Z"   // From past, no 'to' = continues live
})) {
  // Streams historical data first, then seamlessly transitions to live
}

// Multi-symbol merged stream
const queries = {
  aapl: { symbol: "AAPL", kind: "candle", interval: "1m" },
  googl: { symbol: "GOOGL", kind: "candle", interval: "1m" }
};

for await (const msg of bucket.stream(queries, { merge: true })) {
  console.log(msg.sourceId, msg.record.close);
}
```

**Smart Streaming Behavior:**
- **Historical**: Query has `to` parameter -> uses historical drivers
- **Live**: Query has no time bounds -> uses live drivers (WebSocket, etc.)
- **Transition**: Query has `from` but no `to` -> historical first, then live
- **Future**: Query has future `from` -> waits until then, goes live
- **Performance**: Zero overhead when no live drivers exist

---

#### `bucket.session(options)`

Creates a session for backtesting with time control and historical consistency.

```javascript
const session = bucket.session({
  asOf: "2024-01-01T00:00:00Z",  // Starting point in time
  strict: true                   // Enforce no future data access
});

// All queries limited to session time
const data = await session.fetch({ symbol: "AAPL", kind: "candle", interval: "1m" });

// Advance time for backtesting
await session.advance("2024-01-01T01:00:00Z");

// Session prevents look-ahead bias
console.log(session.asOf()); // Current session time
```

---

### Streaming Operators

Functional operators for transforming data streams:

#### `pipe(stream, ...operators)`

Chains operators together for functional composition.

```javascript
import { pipe, filter, map, take, resample } from '@ch99q/bucket';

const processedStream = pipe(
  bucket.stream({ symbol: "AAPL", kind: "candle", interval: "1s" }),
  filter(candle => candle.volume > 1000),           // High volume only
  map(candle => ({                                  // Add computed fields
    ...candle,
    change: candle.close - candle.open,
    bodySize: Math.abs(candle.close - candle.open)
  })),
  resample("5m"),                                   // Convert to 5-minute bars
  take(100)                                         // Limit to 100 results
);

for await (const candle of processedStream) {
  console.log(candle.change);
}
```

#### Available Operators

- **`filter(predicate)`** - Keep only records matching condition
- **`map(transform)`** - Transform each record
- **`take(n)`** - Limit to first n records
- **`resample(interval)`** - Convert candles to different timeframes

---

### Cache Functions

#### `ttlCache({ ms, max })`

Creates a time-to-live cache for query results.

```javascript
const cache = ttlCache({ ms: 60000, max: 512 }); // 60-second expiration, max 512 entries

const bucket = createBucket({
  drivers: [driver],
  cache: cache
});

// First call hits driver, subsequent calls hit cache (until TTL expires)
const data1 = await bucket.fetch(query); // Driver hit
const data2 = await bucket.fetch(query); // Cache hit (fast)
```

---

### Driver System

#### `memoryDriver(id, data, capabilities)`

Creates an in-memory driver for testing and small datasets.

```javascript
const candleData = [
  {
    kind: "candle",
    symbol: "AAPL",
    ts: "2024-01-01T09:30:00Z",
    open: 150.0, high: 152.0, low: 149.5, close: 151.0,
    volume: 1000000
  }
  // ... more data
];

const driver = memoryDriver("memory-test", candleData, [
  {
    kind: "candle",
    supports: { fetch: true, live: false },
    priority: 1,
    intervals: [/^\d+[smhd]$/],  // Regex for supported intervals
    symbols: [/^[A-Z]+$/]        // Regex for supported symbols
  }
]);
```

#### Custom Drivers

Implement the `Driver` interface for external data sources:

```javascript
const customDriver = {
  id: "my-data-source",
  capabilities: [
    {
      kind: "candle",
      supports: { fetch: true, live: true },
      priority: 10
    }
  ],

  async* fetch(query, options) {
    for (const record of await getDataFromAPI(query)) {
      if (options?.signal?.aborted) break;
      yield record;
    }
  },

  async close() {
    // Cleanup resources
  }
};
```

---

## Data Types

### Candle (OHLCV)
```javascript
{
  kind: "candle",
  symbol: "AAPL",
  ts: "2024-01-01T09:30:00Z",
  open: 150.0,
  high: 152.0,
  low: 149.5,
  close: 151.0,
  volume: 1000000
}
```

### Tick
```javascript
{
  kind: "tick",
  symbol: "AAPL",
  ts: "2024-01-01T09:30:00.123Z",
  price: 151.0,
  size: 100
}
```

### Custom
```javascript
{
  kind: "custom",
  symbol: "AAPL",
  type: "level2",
  ts: "2024-01-01T09:30:00Z",
  payload: { /* custom fields */ }
}
```

---

## Error Handling

```javascript
import { BucketError } from '@ch99q/bucket';

try {
  const data = await bucket.fetch({
    symbol: "INVALID",
    kind: "candle"
  });
} catch (error) {
  if (error instanceof BucketError) {
    switch (error.code) {
      case "BAD_REQUEST":
        console.log("Invalid query:", error.message);
        break;
      case "NO_PROVIDER":
        console.log("No driver available for this query");
        break;
      case "PROVIDER_FAILED":
        console.log("Driver error:", error.cause);
        break;
    }
  }
}
```

**Error Codes:**
- `BAD_REQUEST` - Invalid query parameters
- `NO_PROVIDER` - No driver supports this query
- `UNSUPPORTED` - Driver doesn't support required operation
- `PROVIDER_FAILED` - Driver threw an error
- `ABORTED` - Operation was cancelled

---

## Examples

Runnable scripts live in `examples/`. Execute any file with `node examples/<name>.mjs`:

- `memory-driver.mjs` - basic in-memory driver usage
- `live-stream.mjs` - historical + live driver example
- `session-backtest.mjs` - session clamp/advance walkthrough
- `buffer.mjs` - shared ring-buffer stream feeding multiple worker threads
- `storage-memory.mjs` - write-through cache with the memory storage adapter
- `storage-fs.mjs` - filesystem persistence with the fs storage adapter

## Testing

```bash
npm test
```

## License

[MIT](LICENSE)
