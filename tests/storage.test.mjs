import { describe, it, expect } from 'vitest';
import { createBucket, defineDriver } from '../index.mjs';

const candle = (symbol, ts, close) => ({
  symbol,
  kind: 'candle',
  interval: '1m',
  ts: new Date(ts).toISOString(),
  open: close,
  high: close,
  low: close,
  close,
});

describe('storage integration', () => {
  it('serves cached ranges without touching upstream drivers', async () => {
    let driverFetches = 0;
    const driver = defineDriver({
      id: 'upstream',
      capabilities: [{ kind: 'candle', supports: { fetch: true }, priority: 1 }],
      async *fetch() {
        driverFetches++;
        yield* [];
      },
    });
    const cachedRow = candle('AAPL', Date.now(), 1);
    const storage = {
      id: 'storage',
      async fetch() {
        return { rows: [cachedRow], missing: [] };
      },
      async write() {},
    };
    const bucket = createBucket({ storage, drivers: [driver] });
    const query = { symbol: 'AAPL', kind: 'candle', interval: '1m', from: cachedRow.ts, to: cachedRow.ts };
    const rows = await bucket.fetch(query);
    expect(rows).toEqual([cachedRow]);
    expect(driverFetches).toBe(0);
    await bucket.close();
  });

  it('fills gaps via drivers and persists fetched data', async () => {
    const baseTs = Date.now() - 60_000;
    const upstreamRows = [
      candle('MSFT', baseTs, 1),
      candle('MSFT', baseTs + 60_000, 2),
    ];
    let driverFetches = 0;
    const driver = defineDriver({
      id: 'gap-driver',
      capabilities: [{ kind: 'candle', supports: { fetch: true }, priority: 1 }],
      async *fetch() {
        driverFetches++;
        for (const row of upstreamRows) yield row;
      },
    });
    const stored = [];
    const storage = {
      id: 'storage',
      async fetch(query) {
        const missing = stored.length ? [] : [{ from: query.from, to: query.to }];
        return { rows: stored.slice(), missing };
      },
      async write(rows) {
        stored.push(...rows);
      },
    };
    const bucket = createBucket({ storage, drivers: [driver] });
    const query = {
      symbol: 'MSFT',
      kind: 'candle',
      interval: '1m',
      from: upstreamRows[0].ts,
      to: upstreamRows.at(-1)?.ts,
    };
    const rows = await bucket.fetch(query);
    expect(rows).toHaveLength(2);
    expect(driverFetches).toBe(1);
    expect(stored).toHaveLength(2);
    const second = await bucket.fetch(query);
    expect(second).toHaveLength(2);
    expect(driverFetches).toBe(1);
    await bucket.close();
  });
});
