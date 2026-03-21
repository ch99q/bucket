# Caching

Bucket has two layers of caching: an in-memory **TTL cache** for hot data and **storage adapters** for persistent caching. This guide covers the TTL cache. For storage adapters, see [Creating Storage Adapters](./creating-storage-adapters.md).

## TTL Cache

The TTL (Time-To-Live) cache stores fetch results in memory with automatic expiration:

```js
import { createBucket, ttlCache } from '@ch99q/bucket';

const bucket = createBucket({
  drivers: [myDriver],
  cache: ttlCache({
    ms: 60_000,  // entries expire after 60 seconds
    max: 512,    // max entries before FIFO eviction (default: 512)
  }),
});
```

### How It Works

1. When `bucket.fetch(query)` is called, the cache is checked first
2. Cache key is derived from the query (symbol + kind + interval + type + from + to + options)
3. On a hit, the cached result is returned immediately (no driver call)
4. On a miss, the driver is called and the result is stored in the cache
5. Entries older than `ms` are evicted on access
6. When the cache exceeds `max` entries, the oldest entry is evicted (FIFO, not LRU)

### Bypassing the Cache

Skip the cache for specific queries:

```js
const fresh = await bucket.fetch(query, { useCache: false });
```

### Clearing the Cache

The cache is cleared when the bucket is closed:

```js
await bucket.close(); // clears cache, closes drivers
```

## Cache vs Storage

| Feature | TTL Cache | Storage Adapter |
|---------|-----------|-----------------|
| Speed | ~14M hits/sec | Varies (33ms–564ms for 1MB) |
| Persistence | In-memory only | Disk, database, etc. |
| Scope | Exact query matches | Range-aware (fills gaps) |
| Eviction | TTL + size limit | Adapter-defined |
| Use case | Hot path dedup | Historical data persistence |

The TTL cache sits **in front of** storage. The flow is:

```
Query → TTL Cache → Storage Adapter → Driver
```

Both layers can be used together:

```js
import { memoryAdapter } from '@ch99q/bucket/storage/memory';

const bucket = createBucket({
  drivers: [myDriver],
  cache: ttlCache({ ms: 30_000 }),   // short-lived hot cache
  storage: memoryAdapter(),           // persistent range cache
});
```

## Custom Cache

You can provide any object implementing the `Cache` interface:

```ts
type Cache<V> = {
  get: (k: string) => V | undefined;
  set: (k: string, v: V) => void;
  clear?: () => void;
};
```

Example with a Map-based cache (no TTL, no size limit):

```js
const simpleCache = {
  _map: new Map(),
  get(key) { return this._map.get(key); },
  set(key, value) { this._map.set(key, value); },
  clear() { this._map.clear(); },
};

const bucket = createBucket({
  drivers: [myDriver],
  cache: simpleCache,
});
```

## When to Use Caching

**TTL cache is useful when:**
- The same query is repeated frequently within a short window
- You want to deduplicate concurrent identical requests
- Latency matters more than freshness

**Skip the TTL cache when:**
- Data changes rapidly and staleness is unacceptable
- You're already using a storage adapter for persistence
- Memory is constrained and you're running many unique queries

**Storage adapters are better when:**
- You want to avoid re-fetching historical ranges across restarts
- You're running backtests repeatedly over the same date range
- You need range-aware gap filling (storage knows *what* it has)
