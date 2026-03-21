import { describe, it, expect } from 'vitest';
import {
  createBucket,
  defineDriver,
  memoryDriver,
  ttlCache,
} from '../index.mjs';
import { buildCandles } from './helpers.mjs';

describe('batch fetch', () => {
  it('fetches multiple symbols in a single call', async () => {
    const dataset = [
      ...buildCandles('AAPL', 10),
      ...buildCandles('GOOGL', 10),
      ...buildCandles('MSFT', 10),
    ];
    const driver = memoryDriver('batch', dataset, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver] });

    const result = await bucket.fetch({
      aapl: { symbol: 'AAPL', kind: 'candle', interval: '1m' },
      googl: { symbol: 'GOOGL', kind: 'candle', interval: '1m' },
      msft: { symbol: 'MSFT', kind: 'candle', interval: '1m' },
    });

    expect(result.aapl).toHaveLength(10);
    expect(result.googl).toHaveLength(10);
    expect(result.msft).toHaveLength(10);

    // Verify each key returns the correct symbol
    for (const r of result.aapl) expect(r.symbol).toBe('AAPL');
    for (const r of result.googl) expect(r.symbol).toBe('GOOGL');
    for (const r of result.msft) expect(r.symbol).toBe('MSFT');

    await bucket.close();
  });

  it('returns results keyed by the labels provided', async () => {
    const dataset = buildCandles('AAPL', 5);
    const driver = memoryDriver('labels', dataset, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver] });

    const result = await bucket.fetch({
      myCustomLabel: { symbol: 'AAPL', kind: 'candle', interval: '1m' },
    });

    expect(Object.keys(result)).toEqual(['myCustomLabel']);
    expect(result.myCustomLabel).toHaveLength(5);

    await bucket.close();
  });

  it('uses cache across batch queries', async () => {
    let fetchCalls = 0;
    const data = buildCandles('AAPL', 5);
    const driver = defineDriver({
      id: 'cached-batch',
      capabilities: [{ kind: 'candle', supports: { fetch: true }, priority: 1 }],
      async *fetch(q) {
        fetchCalls++;
        for (const r of data) {
          if (r.symbol === q.symbol) yield r;
        }
      },
    });
    const bucket = createBucket({
      drivers: [driver],
      cache: ttlCache({ ms: 10_000 }),
    });

    // First batch fetch
    await bucket.fetch({
      a: { symbol: 'AAPL', kind: 'candle', interval: '1m' },
    });
    expect(fetchCalls).toBe(1);

    // Same query again — should hit cache
    await bucket.fetch({
      b: { symbol: 'AAPL', kind: 'candle', interval: '1m' },
    });
    expect(fetchCalls).toBe(1);

    await bucket.close();
  });

  it('handles batch with time bounds', async () => {
    const dataset = [
      ...buildCandles('AAPL', 20),
      ...buildCandles('GOOGL', 20),
    ];
    const driver = memoryDriver('bounded-batch', dataset, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver] });

    const aaplData = dataset.filter(r => r.symbol === 'AAPL');
    const from = aaplData[5].ts;
    const to = aaplData[10].ts;

    const result = await bucket.fetch({
      aapl: { symbol: 'AAPL', kind: 'candle', interval: '1m', from, to },
      googl: { symbol: 'GOOGL', kind: 'candle', interval: '1m', from, to },
    });

    expect(result.aapl.length).toBe(6);
    expect(result.googl.length).toBe(6);

    await bucket.close();
  });
});
