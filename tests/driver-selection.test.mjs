import { describe, it, expect } from 'vitest';
import {
  BucketError,
  createBucket,
  defineDriver,
} from '../index.mjs';
import { buildCandles } from './helpers.mjs';

describe('driver selection', () => {
  it('selects the highest-priority driver', async () => {
    const calls = [];
    const lowPrio = defineDriver({
      id: 'low',
      capabilities: [{ kind: 'candle', supports: { fetch: true }, priority: 1 }],
      async *fetch(q) {
        calls.push('low');
        yield* buildCandles(q.symbol, 3);
      },
    });
    const highPrio = defineDriver({
      id: 'high',
      capabilities: [{ kind: 'candle', supports: { fetch: true }, priority: 10 }],
      async *fetch(q) {
        calls.push('high');
        yield* buildCandles(q.symbol, 3);
      },
    });
    const bucket = createBucket({ drivers: [lowPrio, highPrio] });

    await bucket.fetch({ symbol: 'AAPL', kind: 'candle', interval: '1m' });
    expect(calls).toEqual(['high']);

    await bucket.close();
  });

  it('filters drivers by kind', async () => {
    const candleDriver = defineDriver({
      id: 'candle-only',
      capabilities: [{ kind: 'candle', supports: { fetch: true }, priority: 1 }],
      async *fetch(q) {
        yield* buildCandles(q.symbol, 3);
      },
    });
    const tickDriver = defineDriver({
      id: 'tick-only',
      capabilities: [{ kind: 'tick', supports: { fetch: true }, priority: 1 }],
      async *fetch(q) {
        yield { kind: 'tick', symbol: q.symbol, ts: new Date().toISOString(), price: 100 };
      },
    });
    const bucket = createBucket({ drivers: [candleDriver, tickDriver] });

    const candles = await bucket.fetch({ symbol: 'AAPL', kind: 'candle', interval: '1m' });
    expect(candles[0].kind).toBe('candle');

    const ticks = await bucket.fetch({ symbol: 'AAPL', kind: 'tick' });
    expect(ticks[0].kind).toBe('tick');

    await bucket.close();
  });

  it('respects symbol regex filter on capabilities', async () => {
    const nasdaqDriver = defineDriver({
      id: 'nasdaq',
      capabilities: [{
        kind: 'candle',
        supports: { fetch: true },
        priority: 10,
        symbols: [/^NASDAQ:/],
      }],
      async *fetch(q) {
        yield* buildCandles(q.symbol, 2);
      },
    });
    const fallback = defineDriver({
      id: 'fallback',
      capabilities: [{
        kind: 'candle',
        supports: { fetch: true },
        priority: 1,
      }],
      async *fetch(q) {
        yield* buildCandles(q.symbol, 2);
      },
    });
    const bucket = createBucket({ drivers: [nasdaqDriver, fallback] });

    // NASDAQ: symbol should use the nasdaq driver (higher priority + matching)
    const result = await bucket.fetch({ symbol: 'NASDAQ:AAPL', kind: 'candle', interval: '1m' });
    expect(result).toHaveLength(2);

    // Non-NASDAQ symbol should fall through to fallback
    const result2 = await bucket.fetch({ symbol: 'NYSE:IBM', kind: 'candle', interval: '1m' });
    expect(result2).toHaveLength(2);

    await bucket.close();
  });

  it('supports custom select function', async () => {
    const driverA = defineDriver({
      id: 'a',
      capabilities: [{ kind: 'candle', supports: { fetch: true }, priority: 1 }],
      async *fetch(q) {
        yield* buildCandles(q.symbol, 1).map(r => ({ ...r, meta: { source: 'a' } }));
      },
    });
    const driverB = defineDriver({
      id: 'b',
      capabilities: [{ kind: 'candle', supports: { fetch: true }, priority: 10 }],
      async *fetch(q) {
        yield* buildCandles(q.symbol, 1).map(r => ({ ...r, meta: { source: 'b' } }));
      },
    });

    // Custom select always picks driver A regardless of priority
    const bucket = createBucket({
      drivers: [driverA, driverB],
      select: ({ drivers }) => drivers.filter(d => d.id === 'a'),
    });

    const result = await bucket.fetch({ symbol: 'AAPL', kind: 'candle', interval: '1m' });
    expect(result[0].meta?.source).toBe('a');

    await bucket.close();
  });

  it('separates fetch vs live driver selection', async () => {
    let fetchUsed = false;
    let liveUsed = false;

    const fetchDriver = defineDriver({
      id: 'hist',
      capabilities: [{ kind: 'candle', supports: { fetch: true, live: false }, priority: 1 }],
      async *fetch(q) {
        fetchUsed = true;
        yield* buildCandles(q.symbol, 2);
      },
    });
    const liveDriver = defineDriver({
      id: 'live',
      capabilities: [{ kind: 'candle', supports: { fetch: false, live: true }, priority: 1 }],
      async *subscribe(q) {
        liveUsed = true;
        yield { kind: 'candle', symbol: q.symbol, interval: q.interval, ts: new Date().toISOString(), open: 1, high: 1, low: 1, close: 1 };
      },
    });

    const bucket = createBucket({ drivers: [fetchDriver, liveDriver] });

    // Bounded query → fetch driver
    const result = await bucket.fetch({
      symbol: 'AAPL', kind: 'candle', interval: '1m',
      from: '2024-01-01T00:00:00Z', to: '2024-01-02T00:00:00Z',
    });
    expect(fetchUsed).toBe(true);

    // Live stream (no bounds) → live driver
    const liveResults = [];
    for await (const r of bucket.stream({ symbol: 'AAPL', kind: 'candle', interval: '1m' })) {
      liveResults.push(r);
      break; // just grab one
    }
    expect(liveUsed).toBe(true);

    await bucket.close();
  });

  it('handles empty driver list', async () => {
    const bucket = createBucket({ drivers: [] });

    const err = await bucket.fetch({
      symbol: 'AAPL', kind: 'candle', interval: '1m',
    }).catch(e => e);

    expect(err).toBeInstanceOf(BucketError);
    expect(err.code).toBe('NO_PROVIDER');

    await bucket.close();
  });
});
