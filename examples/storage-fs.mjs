#!/usr/bin/env node
/**
 * Demonstrates the filesystem storage adapter.
 *
 * Data is persisted as JSON chunks under .bucket-storage/. On a second
 * run the adapter serves the cached data without hitting the driver.
 */

import { createBucket, memoryDriver } from '../index.mjs';
import { fsAdapter } from '../storage/fs.mjs';

function generateCandles(symbol, count) {
  const start = Date.now() - count * 60_000;
  let price = 200;
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
      volume: Math.floor(Math.random() * 3000) + 200,
    };
  });
}

async function main() {
  const data = generateCandles('MSFT', 200);
  const driver = memoryDriver('example', data, [
    { kind: 'candle', supports: { fetch: true }, priority: 1 },
  ]);

  const storage = fsAdapter({
    baseDir: '.bucket-storage',
    namespace: 'fs-example',
  });

  const bucket = createBucket({ drivers: [driver], storage });

  const query = {
    symbol: 'MSFT',
    kind: 'candle',
    interval: '1m',
    from: data[50].ts,
    to: data[150].ts,
  };

  const candles = await bucket.fetch(query);
  console.log(`Fetched ${candles.length} candles`);
  console.log(`Range: ${candles[0]?.ts} → ${candles.at(-1)?.ts}`);
  console.log(`Stored to .bucket-storage/fs-example/`);

  await bucket.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
