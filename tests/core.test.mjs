import { describe, it, expect } from 'vitest';
import {
  BucketError,
  createBucket,
  defineDriver,
  memoryDriver,
  ttlCache,
} from '../index.mjs';
import { minute, buildCandles } from './helpers.mjs';

describe('bucket core flows', () => {
  it('fetches bounded historical ranges', async () => {
    const data = buildCandles('AAPL', 50);
    const driver = memoryDriver('hist', data, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver] });
    const from = data[10].ts;
    const to = data[19].ts;

    const result = await bucket.fetch({
      symbol: 'AAPL',
      kind: 'candle',
      interval: '1m',
      from,
      to,
    });

    expect(result.length).toBe(10);
    expect(result[0].ts).toBe(from);
    expect(result.at(-1)?.ts).toBe(to);
    await bucket.close();
  });

  it('serves cached results without re-hitting fetch', async () => {
    const rows = buildCandles('MSFT', 5);
    let fetchCalls = 0;
    const driver = defineDriver({
      id: 'cached',
      capabilities: [{ kind: 'candle', supports: { fetch: true }, priority: 1 }],
      async *fetch() {
        fetchCalls++;
        for (const row of rows) yield row;
      },
    });
    const bucket = createBucket({
      drivers: [driver],
      cache: ttlCache({ ms: 10_000, max: 16 }),
    });
    const query = { symbol: 'MSFT', kind: 'candle', interval: '1m' };

    const first = await bucket.fetch(query);
    const second = await bucket.fetch(query);

    expect(first.length).toBe(rows.length);
    expect(second.length).toBe(rows.length);
    expect(fetchCalls).toBe(1);
    await bucket.close();
  });

  it('merges multi-symbol streams in timestamp order', async () => {
    const dataset = [
      ...buildCandles('AAPL', 3, 1_000_000),
      ...buildCandles('GOOGL', 3, 1_000_000 + 30_000),
    ];
    const driver = defineDriver({
      id: 'merge-driver',
      capabilities: [{ kind: 'candle', supports: { fetch: true }, priority: 1 }],
      async *fetch(q) {
        for (const row of dataset) {
          if (row.symbol === q.symbol) yield row;
        }
      },
    });
    const bucket = createBucket({ drivers: [driver] });

    const merged = bucket.stream(
      {
        aapl: { symbol: 'AAPL', kind: 'candle', interval: '1m' },
        googl: { symbol: 'GOOGL', kind: 'candle', interval: '1m' },
      },
      { merge: true },
    );

    const seen = [];
    for await (const msg of merged) {
      seen.push(msg);
    }

    expect(seen).toHaveLength(6);
    const timestamps = seen.map((msg) => msg.record.ts);
    expect([...timestamps].sort()).toEqual(timestamps);
    expect(new Set(seen.map((msg) => msg.sourceId))).toEqual(new Set(['aapl', 'googl']));

    await bucket.close();
  });

  it('transitions from historical to live streams automatically', async () => {
    const historical = buildCandles('TSLA', 2, Date.now() - minute * 5);
    const livePayloads = [
      { kind: 'candle', symbol: 'TSLA', interval: '1m', ts: new Date().toISOString(), open: 1, high: 1, low: 1, close: 1 },
      { kind: 'candle', symbol: 'TSLA', interval: '1m', ts: new Date(Date.now() + 1).toISOString(), open: 2, high: 2, low: 2, close: 2 },
    ];

    const driver = defineDriver({
      id: 'live',
      capabilities: [{ kind: 'candle', supports: { fetch: true, live: true }, priority: 1 }],
      async *fetch() {
        for (const row of historical) yield row;
      },
      async *subscribe() {
        for (const row of livePayloads) {
          await new Promise((r) => setTimeout(r, 5));
          yield row;
        }
      },
    });

    const bucket = createBucket({ drivers: [driver] });
    const query = { symbol: 'TSLA', kind: 'candle', interval: '1m', from: historical[0].ts };
    const results = [];
    for await (const row of bucket.stream(query)) {
      results.push(row);
      if (results.length === historical.length + livePayloads.length) break;
    }

    expect(results.slice(0, historical.length).map((r) => r.ts)).toEqual(historical.map((r) => r.ts));
    expect(results.slice(-livePayloads.length).map((r) => r.close)).toEqual([1, 2]);
    await bucket.close();
  });

  it('never transitions to live when query has an explicit `to` bound', async () => {
    const historical = buildCandles('TSLA', 2, Date.now() - minute * 5);
    let subscribeCalled = false;
    const driver = defineDriver({
      id: 'bounded-live',
      capabilities: [{ kind: 'candle', supports: { fetch: true, live: true }, priority: 1 }],
      async *fetch() {
        for (const row of historical) yield row;
      },
      async *subscribe() {
        subscribeCalled = true;
        yield* [];
      },
    });
    const bucket = createBucket({ drivers: [driver] });
    const query = {
      symbol: 'TSLA',
      kind: 'candle',
      interval: '1m',
      from: historical[0].ts,
      to: historical.at(-1)?.ts,
    };

    const rows = [];
    for await (const row of bucket.stream(query)) rows.push(row);

    expect(rows).toHaveLength(historical.length);
    expect(subscribeCalled).toBe(false);
    await bucket.close();
  });

  it('clamps session queries to the session asOf boundary', async () => {
    const data = buildCandles('NFLX', 20, Date.now() - 20 * minute);
    const driver = memoryDriver('session', data, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver] });
    const asOf = data[10].ts;
    const session = bucket.session({ asOf, strict: true });
    const response = await session.fetch({
      symbol: 'NFLX',
      kind: 'candle',
      interval: '1m',
      from: data[0].ts,
      to: data.at(-1)?.ts,
    });

    expect(response.at(-1)?.ts).toBe(asOf);
    await expect(
      session.fetch({
        symbol: 'NFLX',
        kind: 'candle',
        interval: '1m',
        from: new Date(Date.parse(asOf) + minute).toISOString(),
      }),
    ).rejects.toThrow(/from .*session\.asOf/i);
    await bucket.close();
  });

  it('caps merged session streams to session.asOf across all symbols', async () => {
    const dataset = [
      ...buildCandles('AAPL', 5, Date.now() - 5 * minute),
      ...buildCandles('GOOGL', 5, Date.now() - 5 * minute),
    ];
    const driver = memoryDriver('session-merge', dataset, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver] });
    const asOf = dataset[2].ts;
    const session = bucket.session({ asOf, strict: true });

    const merged = session.stream(
      {
        aapl: { symbol: 'AAPL', kind: 'candle', interval: '1m' },
        googl: { symbol: 'GOOGL', kind: 'candle', interval: '1m' },
      },
      { merge: true },
    );

    for await (const msg of merged) {
      expect(Date.parse(msg.record.ts)).toBeLessThanOrEqual(Date.parse(asOf));
    }

    await bucket.close();
  });

  it('throws descriptive BucketError for invalid queries', async () => {
    const data = buildCandles('AAPL', 5);
    const driver = memoryDriver('error', data, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver] });

    await expect(
      bucket.fetch({ symbol: 'AAPL', kind: 'candle' }),
    ).rejects.toBeInstanceOf(BucketError);

    await bucket.close();
  });
});
