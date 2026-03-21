# Architecture

This guide explains how bucket's components fit together and how data flows through the system.

## Components

```
┌─────────────────────────────────────────────────────┐
│                      Bucket                         │
│                                                     │
│  ┌────────────┐   ┌───────────────┐   ┌───────────┐ │
│  │ TTL Cache  │ → │ Storage Layer │ → │  Drivers  │ │
│  │ (optional) │   │  (optional)   │   │ (required)│ │
│  └────────────┘   └───────────────┘   └───────────┘ │
│                                                     │
│  ┌────────────┐   ┌───────────────┐                 │
│  │ Sessions   │   │  Operators    │                 │
│  │ (optional) │   │ pipe/map/etc  │                 │
│  └────────────┘   └───────────────┘                 │
└─────────────────────────────────────────────────────┘
```

**Bucket** — the main entry point. Orchestrates queries across all other components.

**Drivers** — data sources. Each driver declares what it can serve (capabilities) and implements `fetch()` and/or `subscribe()`. At least one driver is required.

**Storage Layer** — optional write-through cache. Sits between the bucket and drivers. Tracks which time ranges it has cached and only asks drivers for missing gaps.

**TTL Cache** — optional in-memory cache. Sits in front of everything else. Returns exact query matches without touching storage or drivers.

**Sessions** — time-controlled wrappers over the bucket. Clamp all queries to a simulated "now" for backtesting without look-ahead bias.

**Operators** — functional stream transforms (`filter`, `map`, `take`, `resample`). Composed with `pipe()` over any `AsyncIterable`.

## Data Flow

### Fetch (single query)

```
bucket.fetch(query)
    │
    ▼
┌─ TTL Cache hit? ──── yes ──→ return cached result
│   no
│   ▼
├─ Storage adapter present?
│   ├── yes ──→ adapter.fetch(query)
│   │              │
│   │              ▼
│   │          returns { rows, missing }
│   │              │
│   │              ▼
│   │          for each missing range:
│   │              driver.fetch(subquery) ──→ results
│   │              adapter.write(results)     (async, best-effort)
│   │              │
│   │              ▼
│   │          merge cached rows + fetched rows
│   │              │
│   │              ▼
│   │          store in TTL cache → return
│   │
│   └── no ───→ driver.fetch(query) → store in TTL cache → return
```

### Fetch (multi-query)

```
bucket.fetch({ aapl: query1, msft: query2 })
    │
    ▼
┌─ Storage adapter present?
│   ├── yes ──→ run each query through single-fetch path (in parallel)
│   │           (fetchBatch is NOT used when storage is present)
│   │
│   └── no ───→ group queries by driver
│                   │
│                   ▼
│               driver has fetchBatch()?
│               ├── yes → driver.fetchBatch([query1, query2])
│               └── no  → driver.fetch(query1) + driver.fetch(query2) in parallel
```

### Stream

```
bucket.stream(query)
    │
    ▼
┌─ query has 'to'? ──────────────→ historical only (fetch)
│
├─ no 'from', no 'to'? ─────────→ live only (subscribe)
│                                  (falls back to fetch if no live driver)
│
├─ 'from' is in the future? ────→ wait, then go live (subscribe)
│
└─ has 'from', no 'to'? ────────→ historical (fetch) → seamless live (subscribe)
```

When a storage adapter is present, streaming pre-fetches historical data through the storage layer and wraps the live portion to batch-write incoming records back to storage.

## Driver Selection

When a query arrives, the bucket selects a driver:

1. Filter drivers by capability — match `kind`, `supports` (fetch or live), `symbols`, `intervals`, `types`
2. Sort by `priority` (highest first)
3. Deduplicate (same driver matched by multiple capabilities)
4. Use the first (highest priority) match

This runs once per unique query shape and is cached internally.

```
query { symbol: 'AAPL', kind: 'candle', interval: '1m' }
    │
    ▼
Driver A: kind=candle, symbols=[/^BINANCE:/], priority=10 ──→ skip (symbol mismatch)
Driver B: kind=candle, symbols=[/^AAPL$/],    priority=5  ──→ match
Driver C: kind=candle, no symbol filter,       priority=1  ──→ match (lower priority)
    │
    ▼
Selected: Driver B (priority 5)
```

## Layered Caching

The TTL cache and storage adapter serve different purposes and can be used independently or together:

```
         TTL Cache                  Storage Adapter
    ┌──────────────────┐      ┌──────────────────────┐
    │ exact key match  │      │ range-aware          │
    │ in-memory only   │      │ persistent           │
    │ expires after ms │      │ tracks coverage gaps │
    │ ~14M hits/sec    │      │ write-through        │
    └──────────────────┘      └──────────────────────┘
```

When both are present, the TTL cache is checked first. On a miss, the storage adapter is consulted. On a storage miss (partial or full), drivers fill the gaps.

## Sessions

Sessions wrap the bucket with time control:

```
session.fetch(query)
    │
    ▼
clamp query.to to asOf (strict mode)
validate query.from <= asOf (strict mode)
    │
    ▼
bucket.fetch(clamped query)
```

Sessions don't introduce a new caching layer — they delegate to the same bucket internals (TTL cache, storage, drivers). The only difference is query clamping.

## Further Reading

- [Getting Started](./getting-started.md) — installation and first bucket
- [Creating Drivers](./creating-drivers.md) — build custom data sources
- [Creating Storage Adapters](./creating-storage-adapters.md) — build persistent caches
- [Streaming & Operators](./streaming-and-operators.md) — transform data streams
- [Sessions & Backtesting](./sessions-and-backtesting.md) — time-controlled replay
- [Caching](./caching.md) — TTL cache configuration
- [Error Handling](./error-handling.md) — handle errors gracefully
