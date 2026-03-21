import { describe, bench } from 'vitest';
import { createBucket, memoryDriver, ttlCache, pipe, map, filter, take, resample, defineDriver } from '../index.mjs';
import { minute, buildCandles, buildSeries, generateMultiSymbolData, generateSentimentData, getMemoryUsage } from '../tests/helpers.mjs';

const singleStreamData = buildCandles('AAPL', 100_000);
const multiSymbolData = generateMultiSymbolData(['AAPL', 'GOOGL', 'MSFT', 'TSLA', 'NVDA'], 20_000);
const cacheData = buildCandles('AAPL', 10_000);
const operatorData = buildCandles('AAPL', 50_000);
const resampleData = buildSeries('AAPL', 60_000, '1s', 1_000);
const batchSymbols = ['AAPL', 'GOOGL', 'MSFT', 'TSLA', 'NVDA', 'META', 'AMZN', 'NFLX'];
const batchIntervals = ['1m', '5m', '15m'];
const memoryData = buildCandles('AAPL', 200_000);

const storageKeyOf = (query) => [
  query.kind ?? 'custom',
  query.symbol ?? '*',
  query.interval ?? '*',
  query.type ?? '*',
].join('|');

const recordKey = (record) => [
  record.kind,
  record.symbol ?? '*',
  record.interval ?? '*',
  record.type ?? '*',
  record.ts,
].join('|');

const matchesQuery = (record, query) => {
  if (record.kind !== query.kind) return false;
  if (record.symbol && record.symbol !== query.symbol) return false;
  if (query.interval && record.interval && record.interval !== query.interval) return false;
  if (record.kind === 'custom' && query.type && record.type !== query.type) return false;
  const ts = Date.parse(record.ts);
  if (query.from && ts < Date.parse(query.from)) return false;
  if (query.to && ts > Date.parse(query.to)) return false;
  return true;
};

const mergeRange = (ranges, range) => {
  if (!range?.from && !range?.to) return ranges;
  const normalized = [...ranges, range].filter(Boolean).map((r) => ({ ...r }));
  normalized.sort((a, b) => Date.parse(a.from ?? '1970-01-01T00:00:00Z') - Date.parse(b.from ?? '1970-01-01T00:00:00Z'));
  const merged = [];
  for (const cur of normalized) {
    if (merged.length === 0) {
      merged.push(cur);
      continue;
    }
    const last = merged[merged.length - 1];
    const lastTo = Date.parse(last.to ?? cur.to ?? last.from ?? cur.from ?? Date.now());
    const curFrom = Date.parse(cur.from ?? last.to ?? cur.to ?? last.from ?? Date.now());
    if (curFrom <= lastTo) {
      if (cur.to && (!last.to || Date.parse(cur.to) > lastTo)) last.to = cur.to;
    } else {
      merged.push(cur);
    }
  }
  return merged;
};

const coversRange = (ranges, query) => {
  if (ranges.length === 0) return false;
  const targetFrom = query.from ? Date.parse(query.from) : -Infinity;
  const targetTo = query.to ? Date.parse(query.to) : Infinity;
  return ranges.some((range) => {
    const from = range.from ? Date.parse(range.from) : -Infinity;
    const to = range.to ? Date.parse(range.to) : Infinity;
    return from <= targetFrom && to >= targetTo;
  });
};

const deriveRange = (query, records) => {
  if (!records.length) return undefined;
  const sorted = records.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return {
    from: query?.from ?? sorted[0]?.ts,
    to: query?.to ?? sorted.at(-1)?.ts,
  };
};

const createMemoryStorageAdapter = () => {
  const store = new Map();
  return {
    id: 'bench-storage',
    async fetch(query) {
      const key = storageKeyOf(query);
      const entry = store.get(key);
      if (!entry) return { rows: [], missing: [{ from: query.from, to: query.to }] };
      const rows = entry.rows.filter((row) => matchesQuery(row, query));
      const missing = coversRange(entry.coverage, query) ? [] : [{ from: query.from, to: query.to }];
      return { rows, missing };
    },
    async write(records, ctx) {
      if (!records?.length) return;
      const baseQuery = ctx?.query ?? {};
      const key = storageKeyOf(baseQuery.symbol ? baseQuery : records[0]);
      const entry = store.get(key) ?? { rows: [], coverage: [] };
      const deduped = new Map(entry.rows.map((row) => [recordKey(row), row]));
      for (const record of records) deduped.set(recordKey(record), record);
      entry.rows = [...deduped.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      const range = deriveRange(baseQuery, records);
      if (range) entry.coverage = mergeRange(entry.coverage, range);
      store.set(key, entry);
    },
  };
};

const liveDriver = defineDriver({
  id: 'bench-live',
  capabilities: [{ kind: 'tick', supports: { fetch: true, live: true }, priority: 1 }],
  async *fetch(q) {
    for (let i = 0; i < 10; i++) {
      yield {
        kind: 'tick',
        symbol: q.symbol,
        ts: new Date(Date.now() - (10 - i) * 1_000).toISOString(),
        price: 100 + i * 0.01,
      };
    }
  },
  async *subscribe(q) {
    let price = 101;
    for (let i = 0; i < 50_000; i++) {
      price += (Math.random() - 0.5) * 0.05;
      yield {
        kind: 'tick',
        symbol: q.symbol,
        ts: new Date(Date.now() + i).toISOString(),
        price,
      };
    }
  },
});

describe('bucket performance benchmarks', () => {
  bench('single symbol streaming (100k records)', async () => {
    const driver = memoryDriver('bench-single', singleStreamData, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver] });
    for await (const _ of bucket.stream({ symbol: 'AAPL', kind: 'candle', interval: '1m' })) {
      // no-op
    }
    await bucket.close();
  });

  bench('multi-symbol merged streaming (5 x 20k)', async () => {
    const driver = memoryDriver('bench-multi', multiSymbolData, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver] });
    const queries = {
      AAPL: { symbol: 'AAPL', kind: 'candle', interval: '1m' },
      GOOGL: { symbol: 'GOOGL', kind: 'candle', interval: '1m' },
      MSFT: { symbol: 'MSFT', kind: 'candle', interval: '1m' },
      TSLA: { symbol: 'TSLA', kind: 'candle', interval: '1m' },
      NVDA: { symbol: 'NVDA', kind: 'candle', interval: '1m' },
    };
    for await (const _ of bucket.stream(queries, { merge: true })) {
      // no-op
    }
    await bucket.close();
  });
});

describe('cache fetch throughput', () => {
  const query = { symbol: 'AAPL', kind: 'candle', interval: '1m' };

  bench('fetch without cache (100 iterations)', async () => {
    const driver = memoryDriver('bench-cache-none', cacheData, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver] });
    for (let i = 0; i < 100; i++) {
      await bucket.fetch(query);
    }
    await bucket.close();
  });

  bench('fetch with ttl cache (100 iterations)', async () => {
    const driver = memoryDriver('bench-cache-ttl', cacheData, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver], cache: ttlCache({ ms: 60_000, max: 512 }) });
    await bucket.fetch(query); // warm cache
    for (let i = 0; i < 100; i++) {
      await bucket.fetch(query);
    }
    await bucket.close();
  });
});

describe('storage persistence throughput', () => {
  const query = {
    symbol: 'AAPL',
    kind: 'candle',
    interval: '1m',
    from: new Date(Date.now() - 10 * minute).toISOString(),
    to: new Date(Date.now() - 9 * minute).toISOString(),
  };

  bench('storage cache hit fetch (100 iterations)', async () => {
    const driver = memoryDriver('bench-storage-hit', cacheData, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const storage = createMemoryStorageAdapter();
    const bucket = createBucket({ storage, drivers: [driver] });
    await bucket.fetch(query); // prime storage
    for (let i = 0; i < 100; i++) {
      await bucket.fetch(query);
    }
    await bucket.close();
  });

  bench('storage gap fill fetch (sliding window, 50 iterations)', async () => {
    const driver = memoryDriver('bench-storage-gap', cacheData, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const storage = createMemoryStorageAdapter();
    const bucket = createBucket({ storage, drivers: [driver] });
    const base = Date.now() - 120 * minute;
    for (let i = 0; i < 50; i++) {
      const from = new Date(base + i * minute).toISOString();
      const to = new Date(base + (i + 1) * minute).toISOString();
      await bucket.fetch({ ...query, from, to });
    }
    await bucket.close();
  });
});

describe('mixed driver throughput', () => {
  const sentimentData = generateSentimentData(['AAPL', 'TSLA', 'NVDA', 'MSFT'], 50_000);
  const candleData = buildCandles('META', 150_000);

  bench('concurrent candle + sentiment fetch (storage hit)', async () => {
    const candleDriver = memoryDriver('bench-mixed-candle', candleData, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const sentimentDriver = memoryDriver('bench-mixed-sentiment', sentimentData, [
      { kind: 'custom', supports: { fetch: true }, priority: 1, types: [/sentiment/] },
    ]);
    const storage = createMemoryStorageAdapter();
    const bucket = createBucket({ storage, drivers: [candleDriver, sentimentDriver] });
    const candleQuery = { symbol: 'META', kind: 'candle', interval: '1m', from: candleData[0].ts, to: candleData.at(-1).ts };
    const sentimentQuery = { symbol: 'AAPL', kind: 'custom', type: 'sentiment', from: sentimentData[0].ts, to: sentimentData.at(-1).ts };
    await bucket.fetch({ candle: candleQuery, sentiment: sentimentQuery });
    for (let i = 0; i < 50; i++) {
      await Promise.all([
        bucket.fetch(candleQuery),
        bucket.fetch(sentimentQuery),
      ]);
    }
    await bucket.close();
  });

  bench('merged stream candle + sentiment (storage gap fills)', async () => {
    const candleDriver = memoryDriver('bench-mixed-candle-stream', candleData, [
      { kind: 'candle', supports: { fetch: true, live: true }, priority: 1 },
    ]);
    const sentimentDriver = memoryDriver('bench-mixed-sentiment-stream', sentimentData, [
      { kind: 'custom', supports: { fetch: true }, priority: 1, types: [/sentiment/] },
    ]);
    const storage = createMemoryStorageAdapter();
    const bucket = createBucket({ storage, drivers: [candleDriver, sentimentDriver] });
    const queries = {
      candles: { symbol: 'META', kind: 'candle', interval: '1m', from: candleData[0].ts, to: candleData.at(-1).ts },
      sentiment: { symbol: 'NVDA', kind: 'custom', type: 'sentiment', from: sentimentData[0].ts, to: sentimentData.at(-1).ts },
    };
    for await (const _ of bucket.stream(queries, { merge: true })) {
      // consume merged stream
    }
    await bucket.close();
  });
});

describe('operator and resample pipelines', () => {
  bench('streaming operator chain (filter/map/take)', async () => {
    const driver = memoryDriver('bench-ops', operatorData, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver] });
    const stream = pipe(
      bucket.stream({ symbol: 'AAPL', kind: 'candle', interval: '1m' }),
      filter((r) => r.close > r.open),
      map((r) => ({ ...r, change: r.close - r.open })),
      take(25_000),
    );
    for await (const _ of stream) {
      // no-op
    }
    await bucket.close();
  });

  bench('resample 60k 1s candles → 5m bars', async () => {
    const driver = memoryDriver('bench-resample', resampleData, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver] });
    const stream = pipe(
      bucket.stream({ symbol: 'AAPL', kind: 'candle', interval: '1s' }),
      resample('5m'),
    );
    for await (const _ of stream) {
      // no-op
    }
    await bucket.close();
  });
});

describe('batch fetch throughput', () => {
  const querySet = {};
  let idx = 0;
  for (const symbol of batchSymbols) {
    for (const interval of batchIntervals) {
      querySet[`q${idx++}`] = {
        symbol,
        kind: 'candle',
        interval,
        from: new Date(Date.now() - 60 * minute).toISOString(),
        to: new Date().toISOString(),
      };
    }
  }

  bench('batch fetch (24 queries per batch)', async () => {
    const data = generateMultiSymbolData(batchSymbols, 5_000);
    const driver = memoryDriver('bench-batch', data, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver], cache: ttlCache({ ms: 30_000, max: 1024 }) });
    for (let i = 0; i < 10; i++) {
      await bucket.fetch(querySet);
    }
    await bucket.close();
  });
});

describe('live streaming', () => {
  bench('live only stream (50k ticks)', async () => {
    const bucket = createBucket({ drivers: [liveDriver] });
    let processed = 0;
    for await (const _ of bucket.stream({ symbol: 'AAPL', kind: 'tick' })) {
      processed++;
      if (processed >= 50_000) break;
    }
    await bucket.close();
  });
});

describe('memory stress', () => {
  let logged = false;

  bench('historical stream memory delta (200k records)', async () => {
    const driver = memoryDriver('bench-memory', memoryData, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver] });
    const before = getMemoryUsage();
    for await (const _ of bucket.stream({ symbol: 'AAPL', kind: 'candle', interval: '1m' })) {
      // no-op
    }
    const after = getMemoryUsage();
    if (!logged) {
      console.log(`[memory] approx delta: ${after.heapUsed - before.heapUsed}MB`);
      logged = true;
    }
    await bucket.close();
  });
});
