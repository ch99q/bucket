#!/usr/bin/env bun
/**
 * Shows how to use sessions to enforce historical consistency in a backtest.
 * Each category (session → fetch/stream/advance) keeps single-word actions to
 * respect the conventions.
 */
import { createBucket, memoryDriver } from '../index.mjs';

function seed(symbol) {
  const now = Date.now();
  return Array.from({ length: 1_000 }, (_, i) => ({
    kind: 'candle',
    symbol,
    interval: '1m',
    ts: new Date(now - (1_000 - i) * 60_000).toISOString(),
    open: 100 + Math.random(),
    high: 101 + Math.random(),
    low: 99 + Math.random(),
    close: 100 + Math.random(),
    volume: 1_000 + Math.random() * 500,
  }));
}

async function main() {
  const driver = memoryDriver('session-demo', seed('MSFT'), [
    { kind: 'candle', supports: { fetch: true }, priority: 1 },
  ]);
  const bucket = createBucket({ drivers: [driver] });

  const session = bucket.session({ asOf: new Date(Date.now() - 6 * 60_000).toISOString(), strict: true });
  const window = await session.fetch({ symbol: 'MSFT', kind: 'candle', interval: '1m' });
  console.log(`Initial window size: ${window.length}`);

  await session.advance(new Date(Date.now() - 3 * 60_000).toISOString());
  const next = await session.fetch({ symbol: 'MSFT', kind: 'candle', interval: '1m' });
  console.log(`Window size after advance: ${next.length}`);

  await bucket.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
