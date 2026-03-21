#!/usr/bin/env bun
/**
 * Basic memory-driver example: create a bucket, fetch candles, and auto-close.
 */

import { createBucket, memoryDriver, ttlCache } from '../index.mjs';

function generateCandles(symbol, points) {
  const start = Date.now() - points * 60_000;
  let price = 120;
  return Array.from({ length: points }, (_, i) => {
    const drift = (Math.random() - 0.5) * 1.5;
    price = Math.max(1, price + drift);
    const open = price;
    const high = open + Math.random() * 0.8;
    const low = open - Math.random() * 0.8;
    const close = low + Math.random() * (high - low);
    return {
      kind: 'candle',
      symbol,
      interval: '1m',
      ts: new Date(start + i * 60_000).toISOString(),
      open,
      high,
      low,
      close,
      volume: Math.floor(Math.random() * 5000) + 500,
    };
  });
}

async function main() {
  const driver = memoryDriver('example-memory', generateCandles('AAPL', 3_000), [
    { kind: 'candle', supports: { fetch: true }, priority: 1 },
  ]);

  await using bucket = createBucket({
    drivers: [driver],
    cache: ttlCache({ ms: 60_000, max: 256 }),
  });

  const candles = await bucket.fetch({
    symbol: 'AAPL',
    kind: 'candle',
    interval: '1m',
    from: new Date(Date.now() - 30 * 60_000).toISOString(),
    to: new Date().toISOString(),
  });

  console.log(`Fetched ${candles.length} candles`);
  console.log(`Most recent close: ${candles.at(-1)?.close?.toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
