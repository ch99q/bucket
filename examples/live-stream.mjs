#!/usr/bin/env bun
/**
 * Demonstrates how to expose both historical and live data from a custom driver.
 * The bucket returned by createBucket remains the only entry point, keeping the
 * call graph shallow and predictable per CONVENTIONS.md.
 */
import { createBucket, defineDriver } from '../index.mjs';

function liveTickDriver() {
  const history = [
    { kind: 'tick', symbol: 'AAPL', ts: new Date(Date.now() - 2_000).toISOString(), price: 187.1 },
    { kind: 'tick', symbol: 'AAPL', ts: new Date(Date.now() - 1_500).toISOString(), price: 187.2 },
    { kind: 'tick', symbol: 'AAPL', ts: new Date(Date.now() - 1_000).toISOString(), price: 187.25 },
  ];

  return defineDriver({
    id: 'live-demo',
    capabilities: [
      {
        kind: 'tick',
        supports: { fetch: true, live: true },
        symbols: [/^AAPL$/],
        priority: 1,
      },
    ],
    async *fetch(query) {
      for (const tick of history) {
        if (tick.symbol === query.symbol) yield tick;
      }
    },
    async *subscribe(query) {
      let price = history.at(-1)?.price ?? 187;
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const change = (Math.random() - 0.5) * 0.1;
        price = Math.max(1, price + change);
        yield { kind: 'tick', symbol: query.symbol, ts: new Date().toISOString(), price };
      }
    },
  });
}

async function main() {
  const bucket = createBucket({ drivers: [liveTickDriver()] });

  let count = 0;
  for await (const tick of bucket.stream({ symbol: 'AAPL', kind: 'tick', from: new Date(Date.now() - 5_000).toISOString() })) {
    console.log(`[${tick.ts}] $${tick.price.toFixed(2)}`);
    count++;
    if (count >= 10) break;
  }

  await bucket.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
