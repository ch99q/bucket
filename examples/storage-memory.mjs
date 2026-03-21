#!/usr/bin/env node
/**
 * Demonstrates the memory storage adapter as a write-through cache.
 *
 * The bucket fetches from the driver on the first call, writes through
 * to the storage adapter, and serves subsequent requests from storage
 * without touching the driver again.
 */

import { createBucket, memoryDriver } from '../index.mjs';
import { memoryAdapter } from '../storage/memory.mjs';

function generateCandles(symbol, count) {
  const start = Date.now() - count * 60_000;
  let price = 150;
  return Array.from({ length: count }, (_, i) => {
    price += (Math.random() - 0.5) * 2;
    return {
      kind: 'candle',
      symbol,
      interval: '1m',
      ts: new Date(start + i * 60_000).toISOString(),
      open: price,
      high: price + Math.random(),
      low: price - Math.random(),
      close: price + (Math.random() - 0.5),
      volume: Math.floor(Math.random() * 5000) + 500,
    };
  });
}

async function main() {
  let driverFetchCount = 0;

  const data = generateCandles('AAPL', 500);
  const driver = {
    id: 'counting-driver',
    capabilities: [{ kind: 'candle', supports: { fetch: true }, priority: 1 }],
    async *fetch(q) {
      driverFetchCount++;
      console.log(`  [driver] fetch #${driverFetchCount}`);
      for (const row of data) {
        if (row.symbol !== q.symbol) continue;
        const ts = Date.parse(row.ts);
        if (q.from && ts < Date.parse(q.from)) continue;
        if (q.to && ts > Date.parse(q.to)) continue;
        yield row;
      }
    },
  };

  await using storage = memoryAdapter();
  await using bucket = createBucket({ drivers: [driver], storage });

  const query = {
    symbol: 'AAPL',
    kind: 'candle',
    interval: '1m',
    from: data[100].ts,
    to: data[200].ts,
  };

  // First fetch — hits the driver and writes through to storage
  console.log('First fetch:');
  const first = await bucket.fetch(query);
  console.log(`  Got ${first.length} candles (driver fetches: ${driverFetchCount})`);

  // Second fetch — served entirely from storage, driver is not called
  console.log('Second fetch (same range):');
  const second = await bucket.fetch(query);
  console.log(`  Got ${second.length} candles (driver fetches: ${driverFetchCount})`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
