# Streaming & Operators

Bucket is streaming-first. All data flows through async iterables, and operators let you transform streams functionally without buffering.

## Basic Streaming

`bucket.stream()` returns an `AsyncIterable`:

```js
for await (const candle of bucket.stream({
  symbol: 'AAPL',
  kind: 'candle',
  interval: '1m',
  from: '2024-01-01T00:00:00Z',
  to: '2024-01-02T00:00:00Z',
})) {
  console.log(candle.ts, candle.close);
}
```

## Historical-to-Live Transition

The bucket automatically transitions between modes based on your query bounds:

| Query                     | Behavior                                    |
|---------------------------|---------------------------------------------|
| Has `to`                  | Historical only (bounded)                   |
| No `from`, no `to`        | Live only (or historical if no live driver)  |
| Has `from`, no `to`       | Historical first, then seamless live         |
| `from` is in the future   | Wait until `from`, then go live              |

```js
// Streams history from 5 minutes ago, then continues with live data
for await (const tick of bucket.stream({
  symbol: 'AAPL',
  kind: 'tick',
  from: new Date(Date.now() - 5 * 60_000).toISOString(),
  // no 'to' → transitions to live
})) {
  console.log(tick.price);
}
```

## Multi-Symbol Streams

### Independent Streams

Get separate iterables per symbol:

```js
const streams = bucket.stream({
  aapl: { symbol: 'AAPL', kind: 'candle', interval: '1m' },
  msft: { symbol: 'MSFT', kind: 'candle', interval: '1m' },
});

// Consume independently
for await (const candle of streams.aapl) { /* ... */ }
```

### Merged Stream

Interleave multiple streams by timestamp:

```js
const merged = bucket.stream(
  {
    aapl: { symbol: 'AAPL', kind: 'candle', interval: '1m' },
    msft: { symbol: 'MSFT', kind: 'candle', interval: '1m' },
  },
  { merge: true }
);

for await (const msg of merged) {
  // msg.sourceId → 'aapl' or 'msft'
  // msg.query    → the original query
  // msg.record   → the data record
  console.log(msg.sourceId, msg.record.close);
}
```

The merged stream uses a min-heap to guarantee global timestamp ordering.

## Operators

Operators are functions that take an `AsyncIterable` and return a new `AsyncIterable`. Chain them with `pipe()`:

```js
import { pipe, filter, map, take, resample } from '@ch99q/bucket';
```

### `pipe(source, ...operators)`

Compose operators left to right:

```js
const result = pipe(
  bucket.stream({ symbol: 'AAPL', kind: 'candle', interval: '1s' }),
  filter(c => c.volume > 1000),
  map(c => ({ ...c, spread: c.high - c.low })),
  take(50)
);

for await (const candle of result) {
  console.log(candle.spread);
}
```

### `filter(predicate)`

Keep only records matching the predicate:

```js
pipe(
  stream,
  filter(c => c.close > c.open),  // only green candles
)
```

### `map(transform)`

Transform each record:

```js
pipe(
  stream,
  map(c => ({
    ts: c.ts,
    symbol: c.symbol,
    change: ((c.close - c.open) / c.open) * 100,
  })),
)
```

### `take(n)`

Stop after `n` records:

```js
pipe(
  stream,
  take(100),  // first 100 records, then stop
)
```

### `resample(interval)`

Aggregate candles into larger time intervals. Only works on `kind: 'candle'` records.

```js
// Convert 1-second candles to 5-minute candles
pipe(
  bucket.stream({ symbol: 'AAPL', kind: 'candle', interval: '1s' }),
  resample('5m'),
)
```

Resample:
- Combines OHLCV correctly (first open, max high, min low, last close, sum volume)
- Uses right-closed windows (a window closes when a record beyond it arrives)
- Does **not** emit the final partial window — this prevents look-ahead bias in backtests
- Supports intervals: `s` (seconds), `m` (minutes), `h` (hours), `d` (days), `w` (weeks)

## Writing Custom Operators

An operator is any function `(src: AsyncIterable<T>) => AsyncIterable<U>`:

```js
// Moving average operator
const sma = (period) => async function* (src) {
  const window = [];
  for await (const candle of src) {
    window.push(candle.close);
    if (window.length > period) window.shift();
    if (window.length === period) {
      const avg = window.reduce((a, b) => a + b, 0) / period;
      yield { ...candle, sma: avg };
    }
  }
};

// Use it
const result = pipe(
  bucket.stream({ symbol: 'AAPL', kind: 'candle', interval: '1m' }),
  sma(20),
);
```

### Combining Built-in and Custom Operators

```js
const enrichedStream = pipe(
  bucket.stream({ symbol: 'AAPL', kind: 'candle', interval: '1s' }),
  resample('1m'),           // 1s → 1m candles
  sma(20),                  // add 20-period SMA
  filter(c => c.sma > 0),   // only when SMA is valid
  map(c => ({               // shape the output
    ts: c.ts,
    close: c.close,
    sma: c.sma,
    signal: c.close > c.sma ? 'BUY' : 'SELL',
  })),
  take(1000),               // first 1000 signals
);
```

## `mergeOrdered(iterables, opt?)`

Low-level utility for merging pre-sorted async iterables. Used internally by multi-symbol streams:

```js
import { mergeOrdered } from '@ch99q/bucket';

const merged = mergeOrdered([stream1, stream2, stream3], {
  signal: controller.signal,
});

for await (const record of merged) {
  // Records arrive in global timestamp order
}
```

Input streams must yield records in ascending timestamp order for correct results.

## Cancellation

Use `AbortSignal` to cancel any stream:

```js
const controller = new AbortController();

setTimeout(() => controller.abort(), 5000); // cancel after 5s

try {
  for await (const tick of bucket.stream(query, { signal: controller.signal })) {
    process.stdout.write(`$${tick.price.toFixed(2)}\r`);
  }
} catch (err) {
  if (err.code === 'ABORTED') console.log('Stream cancelled');
}
```

Or simply `break` out of the loop:

```js
for await (const candle of bucket.stream(query)) {
  if (candle.close > 200) break; // stops consuming the stream
}
```
