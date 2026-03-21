# Sessions & Backtesting

Sessions provide time-controlled access to data, preventing accidental look-ahead bias. They are the backbone of backtesting with bucket.

## What Is Look-Ahead Bias?

In backtesting, look-ahead bias occurs when your strategy uses data that wouldn't have been available at the simulated time. For example, using tomorrow's closing price to make today's trading decision. Sessions prevent this by clamping all queries to a simulated "current time."

## Creating a Session

```js
import { createBucket, memoryDriver } from '@ch99q/bucket';

await using bucket = createBucket({ drivers: [driver] });

const session = bucket.session({
  asOf: '2024-01-01T00:00:00Z',  // simulated "now"
  strict: true,                   // enforce time clamping (default)
});
```

## How Sessions Work

In strict mode (the default), every query is automatically clamped so that:

- The `to` parameter never exceeds `session.asOf()`
- The `from` parameter cannot be ahead of `session.asOf()` (throws an error)
- If no `to` is specified, `asOf` is used as the upper bound

This means your strategy can only see data up to the simulated current time.

```js
session.asOf(); // '2024-01-01T00:00:00Z'

// This query is automatically clamped to { ..., to: '2024-01-01T00:00:00Z' }
const candles = await session.fetch({
  symbol: 'AAPL',
  kind: 'candle',
  interval: '1m',
  from: '2023-12-31T00:00:00Z',
  // no 'to' → clamped to asOf
});

// This throws — from is ahead of asOf
await session.fetch({
  symbol: 'AAPL',
  kind: 'candle',
  interval: '1m',
  from: '2024-01-02T00:00:00Z',  // BucketError: from > session.asOf
});
```

## Advancing Time

Use `session.advance()` to move the simulated clock forward. Time can only move forward (monotonic):

```js
session.asOf(); // '2024-01-01T00:00:00Z'

// Move forward 1 hour
await session.advance('2024-01-01T01:00:00Z');
session.asOf(); // '2024-01-01T01:00:00Z'

// Now you can see data up to 01:00
const candles = await session.fetch({
  symbol: 'AAPL',
  kind: 'candle',
  interval: '1m',
});

// Moving backward throws
await session.advance('2024-01-01T00:30:00Z'); // BucketError: asOf can only move forward
```

## Backtest Loop

A typical backtest loop advances time step by step and queries data at each step:

```js
const session = bucket.session({
  asOf: '2024-01-01T09:30:00Z',
  strict: true,
});

const endTime = Date.parse('2024-01-01T16:00:00Z');
const stepMs = 60_000; // 1 minute steps

while (Date.parse(session.asOf()) < endTime) {
  // Fetch the most recent candles visible at this point in time
  const candles = await session.fetch({
    symbol: 'AAPL',
    kind: 'candle',
    interval: '1m',
    from: new Date(Date.parse(session.asOf()) - 20 * 60_000).toISOString(),
  });

  // Run your strategy
  const signal = myStrategy(candles);
  if (signal === 'BUY')  portfolio.buy('AAPL', candles.at(-1).close);
  if (signal === 'SELL') portfolio.sell('AAPL', candles.at(-1).close);

  // Advance time
  const nextTime = new Date(Date.parse(session.asOf()) + stepMs).toISOString();
  await session.advance(nextTime);
}

console.log('Final P&L:', portfolio.pnl());
```

## Multi-Symbol Backtest

Sessions work with multi-query fetches and merged streams:

```js
const session = bucket.session({
  asOf: '2024-01-01T09:30:00Z',
});

// Fetch multiple symbols at the same point in time
const data = await session.fetch({
  aapl: { symbol: 'AAPL', kind: 'candle', interval: '1m' },
  msft: { symbol: 'MSFT', kind: 'candle', interval: '1m' },
  goog: { symbol: 'GOOG', kind: 'candle', interval: '1m' },
});

// Or stream them merged
const merged = session.stream(
  {
    aapl: { symbol: 'AAPL', kind: 'candle', interval: '1m' },
    msft: { symbol: 'MSFT', kind: 'candle', interval: '1m' },
  },
  { merge: true }
);

for await (const msg of merged) {
  // All records are clamped to asOf
}
```

## Streaming with Sessions

Sessions expose `stream()` which returns historical data clamped to `asOf`:

```js
const session = bucket.session({ asOf: '2024-01-15T00:00:00Z' });

for await (const candle of session.stream({
  symbol: 'AAPL',
  kind: 'candle',
  interval: '1m',
  from: '2024-01-14T00:00:00Z',
  // to is automatically clamped to asOf
})) {
  process.stdout.write('.');
}
```

> **Note:** Session streams always use `fetch` under the hood (never live), since sessions represent historical simulations.

## Non-Strict Mode

Set `strict: false` to disable time clamping. Useful for post-hoc analysis where you want to compare decisions against future data:

```js
const session = bucket.session({
  asOf: '2024-01-01T00:00:00Z',
  strict: false,
});

// This works — no clamping
const future = await session.fetch({
  symbol: 'AAPL',
  kind: 'candle',
  interval: '1m',
  from: '2024-01-01T00:00:00Z',
  to: '2024-01-02T00:00:00Z',  // beyond asOf
});
```

## Resample Without Bias

The `resample()` operator is designed for backtesting — it deliberately does **not** emit the final partial window, preventing look-ahead bias:

```js
import { pipe, resample } from '@ch99q/bucket';

const candles5m = pipe(
  session.stream({
    symbol: 'AAPL',
    kind: 'candle',
    interval: '1s',
    from: '2024-01-01T09:30:00Z',
  }),
  resample('5m'),
);
```

A 5-minute window is only emitted once a record from the **next** window arrives, ensuring the aggregated candle is fully formed.

## Session API Reference

| Method / Property | Description |
|-------------------|-------------|
| `session.asOf()` | Returns the current simulated time (ISO string) |
| `session.strict` | `true` if time clamping is enforced |
| `session.fetch(query, opt?)` | Fetch data clamped to `asOf` |
| `session.fetch(queries, opt?)` | Multi-query fetch clamped to `asOf` |
| `session.stream(query, opt?)` | Stream data clamped to `asOf` |
| `session.stream(queries, { merge: true })` | Merged multi-symbol stream |
| `session.advance(nextAsOf)` | Move time forward (monotonic only) |
