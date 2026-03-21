import { describe, bench } from 'vitest';
import { createBucket, memoryDriver, ttlCache, pipe, map, filter, take, resample, defineDriver } from '../index.mjs';
import { memoryAdapter } from '../storage/memory.mjs';
import { minute, buildCandles, buildSeries, generateMultiSymbolData, generateSentimentData, getMemoryUsage } from '../tests/helpers.mjs';

// ── shared data (built once, reused across iterations) ──────────────────────

const singleStreamData = buildCandles('AAPL', 100_000);
const multiSymbolData = generateMultiSymbolData(['AAPL', 'GOOGL', 'MSFT', 'TSLA', 'NVDA'], 20_000);
const cacheData = buildCandles('AAPL', 10_000);
const operatorData = buildCandles('AAPL', 50_000);
const resampleData = buildSeries('AAPL', 60_000, '1s', 1_000);
const batchData = generateMultiSymbolData(['AAPL', 'GOOGL', 'MSFT', 'TSLA', 'NVDA', 'META', 'AMZN', 'NFLX'], 5_000);
const memoryData = buildCandles('AAPL', 200_000);
const sentimentData = generateSentimentData(['AAPL', 'TSLA', 'NVDA', 'MSFT'], 50_000);
const mixedCandleData = buildCandles('META', 150_000);

// ── shared helpers ──────────────────────────────────────────────────────────

const candleCap = [{ kind: 'candle', supports: { fetch: true }, priority: 1 }];

const makeBucket = (id, data, opts = {}) => {
  const driver = memoryDriver(id, data, candleCap);
  return createBucket({ drivers: [driver], ...opts });
};

const liveDriver = defineDriver({
  id: 'bench-live',
  capabilities: [{ kind: 'tick', supports: { fetch: true, live: true }, priority: 1 }],
  async *fetch(q) {
    for (let i = 0; i < 10; i++) {
      yield { kind: 'tick', symbol: q.symbol, ts: new Date(Date.now() - (10 - i) * 1_000).toISOString(), price: 100 + i * 0.01 };
    }
  },
  async *subscribe(q) {
    let price = 101;
    for (let i = 0; i < 50_000; i++) {
      price += (Math.random() - 0.5) * 0.05;
      yield { kind: 'tick', symbol: q.symbol, ts: new Date(Date.now() + i).toISOString(), price };
    }
  },
});

// ── streaming ───────────────────────────────────────────────────────────────

describe('streaming', () => {
  bench('single symbol (100k records)', async () => {
    const bucket = makeBucket('bench-single', singleStreamData);
    for await (const _ of bucket.stream({ symbol: 'AAPL', kind: 'candle', interval: '1m' })) {}
    await bucket.close();
  });

  bench('multi-symbol merged (5 x 20k)', async () => {
    const bucket = makeBucket('bench-multi', multiSymbolData);
    for await (const _ of bucket.stream({
      AAPL: { symbol: 'AAPL', kind: 'candle', interval: '1m' },
      GOOGL: { symbol: 'GOOGL', kind: 'candle', interval: '1m' },
      MSFT: { symbol: 'MSFT', kind: 'candle', interval: '1m' },
      TSLA: { symbol: 'TSLA', kind: 'candle', interval: '1m' },
      NVDA: { symbol: 'NVDA', kind: 'candle', interval: '1m' },
    }, { merge: true })) {}
    await bucket.close();
  });

  bench('live ticks (50k)', async () => {
    const bucket = createBucket({ drivers: [liveDriver] });
    let n = 0;
    for await (const _ of bucket.stream({ symbol: 'AAPL', kind: 'tick' })) {
      if (++n >= 50_000) break;
    }
    await bucket.close();
  });
});

// ── fetch ───────────────────────────────────────────────────────────────────

describe('fetch', () => {
  const query = { symbol: 'AAPL', kind: 'candle', interval: '1m' };

  bench('no cache (10k records)', async () => {
    const bucket = makeBucket('bench-no-cache', cacheData);
    await bucket.fetch(query);
    await bucket.close();
  });

  bench('ttl cache hit (10k records)', async () => {
    const bucket = makeBucket('bench-cache', cacheData, { cache: ttlCache({ ms: 60_000, max: 512 }) });
    await bucket.fetch(query); // warm
    await bucket.fetch(query); // hit
    await bucket.close();
  });

  bench('batch (8 symbols x 3 intervals)', async () => {
    const symbols = ['AAPL', 'GOOGL', 'MSFT', 'TSLA', 'NVDA', 'META', 'AMZN', 'NFLX'];
    const intervals = ['1m', '5m', '15m'];
    const querySet = {};
    let idx = 0;
    for (const symbol of symbols) {
      for (const interval of intervals) {
        querySet[`q${idx++}`] = { symbol, kind: 'candle', interval, from: new Date(Date.now() - 60 * minute).toISOString(), to: new Date().toISOString() };
      }
    }
    const bucket = makeBucket('bench-batch', batchData, { cache: ttlCache({ ms: 30_000, max: 1024 }) });
    await bucket.fetch(querySet);
    await bucket.close();
  });
});

// ── storage layer ───────────────────────────────────────────────────────────

describe('storage', () => {
  const query = {
    symbol: 'AAPL', kind: 'candle', interval: '1m',
    from: new Date(Date.now() - 10 * minute).toISOString(),
    to: new Date(Date.now() - 9 * minute).toISOString(),
  };

  bench('cache hit (primed storage)', async () => {
    const storage = memoryAdapter();
    const bucket = makeBucket('bench-storage-hit', cacheData, { storage });
    await bucket.fetch(query); // prime
    await bucket.fetch(query); // hit
    await bucket.close();
  });

  bench('gap fill (sliding window)', async () => {
    const storage = memoryAdapter();
    const bucket = makeBucket('bench-storage-gap', cacheData, { storage });
    const base = Date.now() - 120 * minute;
    for (let i = 0; i < 10; i++) {
      await bucket.fetch({ ...query, from: new Date(base + i * minute).toISOString(), to: new Date(base + (i + 1) * minute).toISOString() });
    }
    await bucket.close();
  });

  bench('mixed drivers (candles + sentiment)', async () => {
    const candleDriver = memoryDriver('bench-mixed-c', mixedCandleData, candleCap);
    const sentimentDriver = memoryDriver('bench-mixed-s', sentimentData, [
      { kind: 'custom', supports: { fetch: true }, priority: 1, types: [/sentiment/] },
    ]);
    const storage = memoryAdapter();
    const bucket = createBucket({ storage, drivers: [candleDriver, sentimentDriver] });
    await bucket.fetch({
      candle: { symbol: 'META', kind: 'candle', interval: '1m', from: mixedCandleData[0].ts, to: mixedCandleData.at(-1).ts },
      sentiment: { symbol: 'AAPL', kind: 'custom', type: 'sentiment', from: sentimentData[0].ts, to: sentimentData.at(-1).ts },
    });
    await bucket.close();
  });
});

// ── operators ───────────────────────────────────────────────────────────────

describe('operators', () => {
  bench('filter + map + take (50k → 25k)', async () => {
    const bucket = makeBucket('bench-ops', operatorData);
    const stream = pipe(
      bucket.stream({ symbol: 'AAPL', kind: 'candle', interval: '1m' }),
      filter((r) => r.close > r.open),
      map((r) => ({ ...r, change: r.close - r.open })),
      take(25_000),
    );
    for await (const _ of stream) {}
    await bucket.close();
  });

  bench('resample 60k 1s → 5m', async () => {
    const bucket = makeBucket('bench-resample', resampleData);
    const stream = pipe(
      bucket.stream({ symbol: 'AAPL', kind: 'candle', interval: '1s' }),
      resample('5m'),
    );
    for await (const _ of stream) {}
    await bucket.close();
  });
});

// ── memory ──────────────────────────────────────────────────────────────────

describe('memory', () => {
  bench('stream 200k records (heap delta)', async () => {
    const bucket = makeBucket('bench-mem', memoryData);
    for await (const _ of bucket.stream({ symbol: 'AAPL', kind: 'candle', interval: '1m' })) {}
    await bucket.close();
  });
});
