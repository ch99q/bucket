# Creating Storage Adapters

A **storage adapter** acts as a write-through cache between your drivers and the bucket. When data is fetched from a driver, the storage adapter saves it so future queries for the same range are served from cache — without hitting the driver again.

## How It Works

```
Query → Bucket → Storage Adapter
                    ├── cache hit? → return rows
                    └── cache miss? → fetch from driver → save to storage → return rows
```

1. The bucket calls `adapter.fetch(query)` first
2. The adapter returns cached `rows` plus a list of `missing` time ranges
3. The bucket fetches missing ranges from the driver
4. New records are written back to the adapter via `adapter.write()` (asynchronously, best-effort)

This means drivers only get called for data the adapter doesn't already have.

## Storage Adapter Interface

```ts
type StorageAdapter = {
  id: string;
  fetch: (q: Query, opt?: FetchOpts) => Promise<StorageFetchResult>;
  write?: (rows: DataRecord[], ctx: StorageWriteContext) => Promise<void> | void;
  close?: () => Promise<void> | void;
};

type StorageFetchResult = {
  rows: DataRecord[];        // cached records matching the query
  missing?: StorageRange[];  // time ranges not covered by cache
};

type StorageRange = { from?: ISOTime; to?: ISOTime };

type StorageWriteContext = { query: Query };
```

## Building an Adapter

Use the `storageAdapter()` helper — it wires up `Symbol.asyncDispose` for `await using` support:

```js
import { storageAdapter } from '@ch99q/bucket/storage/adapter';

const myAdapter = storageAdapter({
  id: 'my-cache',

  async fetch(query, opt) {
    // Look up cached data for this query
    const cachedRows = await lookupCache(query);
    const coveredRanges = await getCoverage(query);

    // Calculate what's missing
    const missing = computeGaps(coveredRanges, query);

    return { rows: cachedRows, missing };
  },

  async write(rows, ctx) {
    // Save records to your backing store
    await saveToCache(rows, ctx.query);
    // Update coverage tracking
    await updateCoverage(ctx.query);
  },

  async close() {
    // Release connections, flush buffers, etc.
  },
});
```

### Using It

```js
import { createBucket } from '@ch99q/bucket';

await using bucket = createBucket({
  drivers: [myDriver],
  storage: myAdapter,
});

// First fetch: hits driver, writes through to storage
const first = await bucket.fetch(query);

// Second fetch (same range): served from storage, driver is not called
const second = await bucket.fetch(query);
```

## The `missing` Array

The `missing` array is the key concept. It tells the bucket which time ranges the adapter doesn't have, so the bucket knows exactly what to fetch from drivers.

### Return Patterns

**No cached data — fetch everything:**
```js
async fetch(query) {
  return {
    rows: [],
    missing: [{ from: query.from, to: query.to }],
  };
}
```

**Full cache hit — no driver fetch needed:**
```js
async fetch(query) {
  return {
    rows: cachedRows,
    missing: [],  // empty = fully covered
  };
}
```

**Partial cache — only fetch the gap:**
```js
// Cached: Jan 1 – Jan 15
// Query:  Jan 1 – Jan 31
// Missing: Jan 15 – Jan 31
async fetch(query) {
  return {
    rows: cachedRows,  // Jan 1 – Jan 15 data
    missing: [{ from: '2024-01-15T00:00:00Z', to: '2024-01-31T00:00:00Z' }],
  };
}
```

**Multiple gaps:**
```js
async fetch(query) {
  return {
    rows: cachedRows,
    missing: [
      { from: '2024-01-01T00:00:00Z', to: '2024-01-05T00:00:00Z' },
      { from: '2024-01-20T00:00:00Z', to: '2024-01-25T00:00:00Z' },
    ],
  };
}
```

## Coverage Tracking

Most adapters need to track which time ranges they've already cached. This is how you know what's missing when a query comes in.

A coverage tracker stores ranges like `[{ from, to }, { from, to }, ...]` per data key (combination of kind + symbol + interval + type).

### Example: Simple Range Tracker

```js
const coverage = new Map(); // key → [{ from, to }, ...]

function storageKey(query) {
  return `${query.kind}|${query.symbol}|${query.interval ?? '*'}|${query.type ?? '*'}`;
}

function addCoverage(key, range) {
  const existing = coverage.get(key) ?? [];
  // Merge overlapping ranges
  const all = [...existing, range].sort((a, b) =>
    Date.parse(a.from) - Date.parse(b.from)
  );
  const merged = [];
  for (const r of all) {
    const last = merged.at(-1);
    if (last && Date.parse(r.from) <= Date.parse(last.to)) {
      last.to = Date.parse(r.to) > Date.parse(last.to) ? r.to : last.to;
    } else {
      merged.push({ ...r });
    }
  }
  coverage.set(key, merged);
}

function findMissing(key, query) {
  const ranges = coverage.get(key) ?? [];
  if (!ranges.length) return [{ from: query.from, to: query.to }];
  // Walk covered ranges and find gaps within query bounds
  // ... (see built-in adapters for reference)
}
```

## Complete Example: Redis Adapter

```js
import { storageAdapter } from '@ch99q/bucket/storage/adapter';

export function redisAdapter(client, options = {}) {
  const prefix = options.prefix ?? 'bucket:';
  const ttl = options.ttlSeconds ?? 3600;

  const dataKey = (query) =>
    `${prefix}data:${query.kind}:${query.symbol}:${query.interval ?? '*'}:${query.type ?? '*'}`;
  const coverageKey = (query) =>
    `${prefix}coverage:${query.kind}:${query.symbol}:${query.interval ?? '*'}:${query.type ?? '*'}`;

  return storageAdapter({
    id: options.id ?? 'redis-storage',

    async fetch(query) {
      // Get cached records
      const raw = await client.zRangeByScore(
        dataKey(query),
        query.from ? Date.parse(query.from) : '-inf',
        query.to ? Date.parse(query.to) : '+inf'
      );
      const rows = raw.map(r => JSON.parse(r));

      // Get coverage ranges
      const covRaw = await client.get(coverageKey(query));
      const ranges = covRaw ? JSON.parse(covRaw) : [];
      const missing = computeGaps(ranges, query);

      return { rows, missing };
    },

    async write(rows, ctx) {
      if (!rows.length) return;
      const key = dataKey(ctx.query);

      // Store each record in a sorted set scored by timestamp
      const pipeline = client.multi();
      for (const row of rows) {
        pipeline.zAdd(key, {
          score: Date.parse(row.ts),
          value: JSON.stringify(row),
        });
      }
      pipeline.expire(key, ttl);
      await pipeline.exec();

      // Update coverage
      const covKey = coverageKey(ctx.query);
      const existing = JSON.parse(await client.get(covKey) ?? '[]');
      const updated = mergeRange(existing, {
        from: ctx.query.from ?? rows[0].ts,
        to: ctx.query.to ?? rows.at(-1).ts,
      });
      await client.set(covKey, JSON.stringify(updated), { EX: ttl });
    },

    async close() {
      // Don't close the shared client — let the caller manage it
    },
  });
}
```

## Multi-Query Fetch Behavior

When a storage adapter is present, multi-query fetches (`bucket.fetch({ aapl: query1, msft: query2 })`) run each query independently through the storage layer in parallel. This means driver `fetchBatch()` is **not** used when storage is active — each query goes through the full storage read-through path individually.

This is by design: the storage layer needs to check coverage and fill gaps per-query, which isn't compatible with batch fetching. If batch performance matters more than storage caching for your use case, omit the storage adapter.

```
// With storage: each query goes through storage → driver individually (parallel)
bucket.fetch({ a: q1, b: q2 })  →  Promise.all([fetchSingle(q1), fetchSingle(q2)])

// Without storage: queries are grouped by driver and batched
bucket.fetch({ a: q1, b: q2 })  →  driver.fetchBatch([q1, q2])
```

## Streaming Support

When the bucket streams data (via `bucket.stream()`), it automatically:

1. Pre-fetches historical data through the storage layer
2. Yields cached + freshly-fetched records
3. Wraps the live portion to batch-write incoming records (256 at a time)

You don't need to do anything special — the storage layer handles this for you.

## Write Behavior

Writes are **asynchronous and best-effort**:
- Records are queued for writing via `queueMicrotask`
- If a write fails, the error is silently dropped to avoid stalling the fetch path
- This means `fetch()` is never blocked by slow storage writes

If you need guaranteed writes, do it in your driver or application layer.

## Built-in Adapters

### Memory Adapter
```js
import { memoryAdapter } from '@ch99q/bucket/storage/memory';

await using storage = memoryAdapter({ id: 'my-cache' });
```
- Stores everything in `Map` objects
- Fast but volatile — data is lost when the process exits
- Great for tests and short-lived jobs

### Filesystem Adapter
```js
import { fsAdapter } from '@ch99q/bucket/storage/fs';

await using storage = fsAdapter({
  id: 'my-fs-cache',
  baseDir: './data',      // defaults to .bucket-storage
  namespace: 'backtest',  // isolate different tenants
});
```
- Human-readable JSON chunks on disk
- Coverage metadata in `coverage.json`
- Data organized by namespace and query key
- Survives restarts

### SQLite Adapter
```js
import { sqliteAdapter } from '@ch99q/bucket/storage/sqlite';

await using storage = sqliteAdapter({
  id: 'my-sqlite',
  path: './cache.sqlite',  // defaults to bucket-storage.sqlite
  tune: true,              // auto-tunes WAL, synchronous, mmap (default: true)
  mmapSize: 256 * 1024 * 1024,
  cachePages: 4096,
});
```
- Auto-detects `bun:sqlite` or `better-sqlite3`
- WAL mode for concurrent reads
- Two tables: `records` (sorted set by timestamp) and `coverage` (range tracking)
- Best for production persistence with moderate write loads

## Checklist

When building a storage adapter:

- [ ] Return `{ rows, missing }` from `fetch()` — `rows` for cached data, `missing` for gaps
- [ ] Track coverage ranges so you can compute `missing` accurately
- [ ] Implement `write()` to persist records and update coverage
- [ ] Merge overlapping coverage ranges to prevent redundant fetches
- [ ] Implement `close()` if you hold connections or file handles
- [ ] Use `storageAdapter()` helper for `Symbol.asyncDispose` support
- [ ] Return records sorted by timestamp (ascending)
