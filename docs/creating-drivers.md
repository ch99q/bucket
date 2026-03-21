# Creating Drivers

A **driver** is a data source that knows how to fetch historical records and/or stream live records. This guide covers everything you need to build your own.

## Driver Interface

```ts
type Driver = {
  id: string;                                              // unique identifier
  capabilities: Capability[];                              // what this driver can do
  fetch?: (q: Query, opt?: FetchOpts) => AsyncIterable<DataRecord>;   // historical data
  subscribe?: (q: Query, opt?: LiveOpts) => AsyncIterable<DataRecord>; // live data
  fetchBatch?: (queries: Query[], opt?: FetchOpts) => Promise<DataRecord[][]>; // batch optimization
  close?: () => Promise<void> | void;                      // cleanup resources
};
```

At minimum, a driver needs an `id`, `capabilities`, and at least one of `fetch` or `subscribe`.

## Capabilities

Capabilities tell the bucket what kind of data your driver serves and how to route queries to it:

```ts
type Capability = {
  kind: 'candle' | 'tick' | 'custom';        // data type
  supports: { fetch?: boolean; live?: boolean }; // which operations
  priority?: number;                           // higher = preferred (default: 0)
  symbols?: RegExp[];                          // symbol patterns to match
  intervals?: RegExp[];                        // interval patterns to match
  types?: RegExp[];                            // custom type patterns to match
};
```

### Priority

When multiple drivers can serve the same query, the one with the highest `priority` wins. Use this to layer drivers — for example, a fast local driver at priority 10 with a remote API fallback at priority 1.

### Pattern Matching

Use regex arrays to restrict which symbols/intervals a driver handles:

```js
{
  kind: 'candle',
  supports: { fetch: true, live: true },
  priority: 5,
  symbols: [/^BINANCE:/],           // only BINANCE symbols
  intervals: [/^(1m|5m|15m|1h)$/],  // only these intervals
}
```

If `symbols`, `intervals`, or `types` are omitted, the driver matches **all** values for that field.

## Minimal Driver Example

A driver that fetches candle data from a REST API:

```js
import { defineDriver } from '@ch99q/bucket';

const myApiDriver = defineDriver({
  id: 'my-api',
  capabilities: [
    {
      kind: 'candle',
      supports: { fetch: true },
      priority: 5,
      intervals: [/^\d+[smh]$/],
    },
  ],

  async *fetch(query, opt) {
    const params = new URLSearchParams({
      symbol: query.symbol,
      interval: query.interval,
      ...(query.from && { from: query.from }),
      ...(query.to && { to: query.to }),
      ...(opt?.limit && { limit: String(opt.limit) }),
    });

    const res = await fetch(`https://api.example.com/candles?${params}`, {
      signal: opt?.signal,
    });
    const data = await res.json();

    for (const bar of data) {
      yield {
        kind: 'candle',
        symbol: query.symbol,
        interval: query.interval,
        ts: bar.timestamp,
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
        volume: bar.v,
      };
    }
  },
});
```

> `defineDriver()` is a pass-through identity helper — it returns your driver as-is. It exists as a hook for future validation and to signal intent. You can also just use a plain object.

## Live Streaming Driver

Add a `subscribe` method to support live data. The bucket automatically transitions from `fetch` to `subscribe` when a query has `from` but no `to`:

```js
const wsDriver = defineDriver({
  id: 'ws-feed',
  capabilities: [
    {
      kind: 'tick',
      supports: { fetch: true, live: true },
      symbols: [/^AAPL$/, /^MSFT$/],
      priority: 10,
    },
  ],

  async *fetch(query, opt) {
    // Fetch historical ticks from REST API
    const res = await fetch(`https://api.example.com/ticks/${query.symbol}`);
    const data = await res.json();
    for (const tick of data) {
      yield { kind: 'tick', symbol: query.symbol, ts: tick.ts, price: tick.price, size: tick.size };
    }
  },

  async *subscribe(query, opt) {
    const ws = new WebSocket(`wss://feed.example.com/ticks/${query.symbol}`);

    try {
      // Convert WebSocket events to an async iterable
      const messages = createMessageIterator(ws, opt?.signal);

      for await (const msg of messages) {
        const data = JSON.parse(msg);
        yield {
          kind: 'tick',
          symbol: query.symbol,
          ts: new Date().toISOString(),
          price: data.price,
          size: data.size,
        };
      }
    } finally {
      ws.close();
    }
  },

  async close() {
    // Cleanup any shared connections
  },
});
```

## Batch Optimization

If your data source supports batch queries (e.g., fetching multiple symbols in one API call), implement `fetchBatch`:

```js
const batchDriver = defineDriver({
  id: 'batch-api',
  capabilities: [
    { kind: 'candle', supports: { fetch: true }, priority: 5 },
  ],

  // Standard fetch for single queries (always required if batch is provided)
  async *fetch(query, opt) {
    const results = await fetchFromApi([query]);
    for (const record of results[0]) yield record;
  },

  // Batch fetch — called when the bucket has multiple queries for this driver
  async fetchBatch(queries, opt) {
    const response = await fetch('https://api.example.com/batch', {
      method: 'POST',
      body: JSON.stringify({ queries: queries.map(q => ({
        symbol: q.symbol,
        interval: q.interval,
        from: q.from,
        to: q.to,
      })) }),
      signal: opt?.signal,
    });
    const data = await response.json();

    // Return array of arrays — one per query, in the same order
    return data.results.map((bars, i) =>
      bars.map(bar => ({
        kind: 'candle',
        symbol: queries[i].symbol,
        interval: queries[i].interval,
        ts: bar.timestamp,
        open: bar.o, high: bar.h, low: bar.l, close: bar.c,
        volume: bar.v,
      }))
    );
  },
});
```

The bucket automatically groups multi-query `fetch()` calls by driver and uses `fetchBatch` when available, falling back to individual `fetch()` calls otherwise.

## Custom Data Types

Drivers aren't limited to candles and ticks. Use `kind: 'custom'` with a `type` field for arbitrary data:

```js
const sentimentDriver = defineDriver({
  id: 'sentiment',
  capabilities: [
    {
      kind: 'custom',
      supports: { fetch: true },
      types: [/^sentiment$/],
      priority: 1,
    },
  ],

  async *fetch(query, opt) {
    const res = await fetch(`https://api.example.com/sentiment/${query.symbol}`);
    const data = await res.json();

    for (const entry of data) {
      yield {
        kind: 'custom',
        symbol: query.symbol,
        type: 'sentiment',
        ts: entry.timestamp,
        payload: { score: entry.score, source: entry.source },
      };
    }
  },
});

// Usage
const data = await bucket.fetch({
  symbol: 'AAPL',
  kind: 'custom',
  type: 'sentiment',
  from: '2024-01-01T00:00:00Z',
});
```

## Handling Abort Signals

Always check the abort signal so queries can be cancelled:

```js
async *fetch(query, opt) {
  for (const page of paginate(query)) {
    if (opt?.signal?.aborted) {
      throw new BucketError('ABORTED', 'fetch cancelled');
    }
    const data = await fetchPage(page, { signal: opt?.signal });
    for (const record of data) {
      yield record;
    }
  }
},
```

## Error Handling

Throw `BucketError` with appropriate codes so the bucket can handle errors consistently:

```js
import { BucketError } from '@ch99q/bucket';

async *fetch(query, opt) {
  try {
    const res = await fetch(url, { signal: opt?.signal });
    if (!res.ok) {
      throw new BucketError('PROVIDER_FAILED', `API returned ${res.status}`);
    }
    // ...yield records
  } catch (err) {
    if (err instanceof BucketError) throw err;
    throw new BucketError('PROVIDER_FAILED', `Fetch failed: ${err.message}`, err);
  }
},
```

## Multiple Drivers

Register multiple drivers to layer data sources. The bucket routes each query to the best-matching driver by capability and priority:

```js
const bucket = createBucket({
  drivers: [
    localCacheDriver,     // priority: 10 — fast local data
    primaryApiDriver,     // priority: 5  — main data source
    fallbackApiDriver,    // priority: 1  — backup source
  ],
});
```

### Custom Driver Selection

Override the default selection logic for advanced routing:

```js
const bucket = createBucket({
  drivers: [driverA, driverB],
  select: ({ drivers, query, need }) => {
    // Custom logic — return ordered array of drivers to try
    if (query.symbol.startsWith('CRYPTO:')) {
      return drivers.filter(d => d.id === 'crypto-exchange');
    }
    // Fall back to default behavior
    return drivers.filter(d =>
      d.capabilities.some(c => c.kind === query.kind && c.supports[need])
    );
  },
});
```

## Lifecycle

1. **Registration** — drivers are passed to `createBucket({ drivers: [...] })`
2. **Selection** — on each query, the bucket matches capabilities and picks the best driver
3. **Execution** — `fetch()` or `subscribe()` is called on the selected driver
4. **Cleanup** — `bucket.close()` calls `close()` on every driver

## Checklist

When building a driver, make sure you:

- [ ] Set a unique `id`
- [ ] Define accurate `capabilities` (kind, supports, symbols/intervals)
- [ ] Implement `fetch` and/or `subscribe` as async generators
- [ ] Respect `opt.limit` (stop yielding after N records)
- [ ] Check `opt.signal?.aborted` in loops
- [ ] Respect `query.from` and `query.to` bounds
- [ ] Yield records in ascending timestamp order
- [ ] Implement `close()` if you hold connections or state
- [ ] Throw `BucketError` with appropriate codes on failure

## Reference: Built-in Drivers

- **Memory Driver** (`@ch99q/bucket/driver/memory`) — in-memory data for testing and backtesting
- **TradingView Driver** (`@ch99q/bucket/driver/tradingview`) — real-time and historical candles via `@ch99q/twc`
