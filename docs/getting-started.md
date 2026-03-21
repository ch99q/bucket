# Getting Started

This guide walks you through installing `@ch99q/bucket`, creating your first bucket, and fetching data.

## Installation

```bash
# bun (recommended)
bun add @ch99q/bucket

# npm
npm install @ch99q/bucket
```

## Your First Bucket

A bucket needs at least one **driver** — a data source that knows how to fetch or stream records. The simplest driver is the built-in memory driver.

```js
import { createBucket, memoryDriver, ttlCache } from '@ch99q/bucket';

// Generate some sample candle data
const candles = Array.from({ length: 500 }, (_, i) => ({
  kind: 'candle',
  symbol: 'AAPL',
  interval: '1m',
  ts: new Date(Date.now() - (500 - i) * 60_000).toISOString(),
  open: 150 + Math.random(),
  high: 151 + Math.random(),
  low: 149 + Math.random(),
  close: 150 + Math.random(),
  volume: Math.floor(Math.random() * 5000),
}));

// Create a driver that serves this data
const driver = memoryDriver('my-source', candles, [
  { kind: 'candle', supports: { fetch: true }, priority: 1 },
]);

// Create the bucket
await using bucket = createBucket({
  drivers: [driver],
  cache: ttlCache({ ms: 60_000 }),
});
```

> **Note:** `await using` automatically calls `bucket.close()` when the scope exits. If your runtime doesn't support `await using`, call `bucket.close()` manually in a `finally` block.

## Fetching Data

Pass a **query** object describing what data you want:

```js
const result = await bucket.fetch({
  symbol: 'AAPL',
  kind: 'candle',
  interval: '1m',
  from: new Date(Date.now() - 30 * 60_000).toISOString(),
  to: new Date().toISOString(),
});

console.log(`Got ${result.length} candles`);
console.log(result[0]); // { kind: 'candle', symbol: 'AAPL', ts: '...', open, high, low, close, volume }
```

### Fetch Options

```js
const result = await bucket.fetch(query, {
  limit: 100,         // max records to return
  descending: true,   // newest first
  signal: controller.signal, // AbortSignal for cancellation
  useCache: false,     // bypass TTL cache
});
```

### Multi-Query Fetch

Fetch multiple symbols in a single call. The bucket groups queries by driver and runs batch fetches when possible:

```js
const data = await bucket.fetch({
  aapl: { symbol: 'AAPL', kind: 'candle', interval: '1m' },
  msft: { symbol: 'MSFT', kind: 'candle', interval: '1m' },
});

console.log(data.aapl.length, data.msft.length);
```

## Streaming Data

`bucket.stream()` returns an `AsyncIterable` — use `for await` to consume records one by one:

```js
for await (const candle of bucket.stream({
  symbol: 'AAPL',
  kind: 'candle',
  interval: '1m',
})) {
  console.log(candle.ts, candle.close);
}
```

### Multi-Symbol Merged Stream

Stream multiple symbols interleaved by timestamp:

```js
const merged = bucket.stream(
  {
    aapl: { symbol: 'AAPL', kind: 'candle', interval: '1m' },
    msft: { symbol: 'MSFT', kind: 'candle', interval: '1m' },
  },
  { merge: true }
);

for await (const msg of merged) {
  console.log(msg.sourceId, msg.record.ts, msg.record.close);
}
```

## Data Types

Bucket supports three record kinds:

### Candle (OHLCV)
```js
{
  kind: 'candle',
  symbol: 'AAPL',
  interval: '1m',
  ts: '2024-01-15T10:30:00.000Z',
  open: 150.25,
  high: 150.80,
  low: 150.10,
  close: 150.65,
  volume: 12500,
  meta: {}  // optional
}
```

### Tick
```js
{
  kind: 'tick',
  symbol: 'AAPL',
  ts: '2024-01-15T10:30:00.123Z',
  price: 150.25,
  size: 100,  // optional
  meta: {}    // optional
}
```

### Custom
```js
{
  kind: 'custom',
  symbol: 'AAPL',
  type: 'sentiment',
  ts: '2024-01-15T10:30:00.000Z',
  payload: { score: 0.85, source: 'twitter' },
  meta: {}  // optional
}
```

## Query Object

Every fetch/stream call requires a query:

| Field      | Required | Description                              |
|------------|----------|------------------------------------------|
| `symbol`   | Yes      | Symbol identifier (e.g. `"AAPL"`, `"BINANCE:BTCUSDT"`) |
| `kind`     | Yes      | `"candle"`, `"tick"`, or `"custom"`      |
| `interval` | Candle   | Time interval (e.g. `"1m"`, `"5m"`, `"1h"`, `"1d"`) |
| `type`     | Custom   | Custom data type identifier              |
| `from`     | No       | ISO timestamp lower bound                |
| `to`       | No       | ISO timestamp upper bound                |

## Cleanup

Always close the bucket when done to release driver connections and clear caches:

```js
// Option 1: await using (recommended)
await using bucket = createBucket({ ... });

// Option 2: manual cleanup
const bucket = createBucket({ ... });
try {
  // ... use bucket
} finally {
  await bucket.close();
}
```

## Next Steps

- [Architecture](./architecture.md) — how bucket's components fit together
- [Creating Drivers](./creating-drivers.md) — build custom data sources
- [Creating Storage Adapters](./creating-storage-adapters.md) — add persistent caching
- [Streaming & Operators](./streaming-and-operators.md) — transform streams with pipe, filter, map, resample
- [Sessions & Backtesting](./sessions-and-backtesting.md) — time-controlled historical replay
- [Caching](./caching.md) — TTL cache configuration
- [Error Handling](./error-handling.md) — handle bucket errors gracefully
