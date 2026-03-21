# Error Handling

All bucket errors use the `BucketError` class with a `code` field for programmatic handling.

## BucketError

```js
import { BucketError } from '@ch99q/bucket';

try {
  const data = await bucket.fetch(query);
} catch (err) {
  if (err instanceof BucketError) {
    console.error(`[${err.code}] ${err.message}`);
  }
}
```

### Error Codes

| Code | When | Meaning |
|------|------|---------|
| `BAD_REQUEST` | Invalid query or parameters | Missing `symbol`, bad `from`/`to`, `from > to`, missing `interval` for candles, missing `type` for custom |
| `NO_PROVIDER` | No driver matches the query | No registered driver has capabilities matching the requested kind/symbol/interval |
| `UNSUPPORTED` | Driver found but missing method | Driver matched by capability but doesn't implement `fetch()` or `subscribe()` |
| `PROVIDER_FAILED` | Driver threw during execution | The driver's `fetch`/`subscribe` call failed — `err.cause` has the original error |
| `ABORTED` | Operation cancelled | Query was aborted via `AbortSignal` or the stream was stopped |

## Handling by Code

```js
try {
  const data = await bucket.fetch(query);
} catch (err) {
  if (!(err instanceof BucketError)) throw err;

  switch (err.code) {
    case 'BAD_REQUEST':
      // Fix the query — something is missing or invalid
      console.error('Invalid query:', err.message);
      break;

    case 'NO_PROVIDER':
      // No driver can serve this query
      // Check that the symbol/kind/interval is supported by your drivers
      console.error('No driver for:', query.symbol, query.kind);
      break;

    case 'UNSUPPORTED':
      // Driver exists but doesn't support the operation
      console.error('Driver cannot handle this:', err.message);
      break;

    case 'PROVIDER_FAILED':
      // Driver had an error — retry or use a fallback
      console.error('Driver error:', err.message);
      console.error('Cause:', err.cause);
      break;

    case 'ABORTED':
      // Normal — query was cancelled
      break;
  }
}
```

## Stream Errors

Errors in streams surface when you iterate:

```js
try {
  for await (const record of bucket.stream(query)) {
    process.stdout.write('.');
  }
} catch (err) {
  if (err instanceof BucketError && err.code === 'ABORTED') {
    console.log('Stream ended');
  } else {
    throw err;
  }
}
```

## Abort Signals

Use `AbortController` to cancel long-running operations:

```js
const controller = new AbortController();

// Cancel after 10 seconds
const timeout = setTimeout(() => controller.abort(), 10_000);

try {
  const data = await bucket.fetch(query, { signal: controller.signal });
  clearTimeout(timeout);
} catch (err) {
  if (err.code === 'ABORTED') {
    console.log('Query timed out');
  }
}
```

## Session Errors

Sessions throw `BAD_REQUEST` for time violations:

```js
const session = bucket.session({ asOf: '2024-01-01T00:00:00Z', strict: true });

// Throws: "from > session.asOf"
await session.fetch({
  symbol: 'AAPL', kind: 'candle', interval: '1m',
  from: '2024-02-01T00:00:00Z',
});

// Throws: "asOf can only move forward"
await session.advance('2023-12-31T00:00:00Z');
```

## Throwing Errors in Drivers

When building custom drivers, use `BucketError` for consistency:

```js
import { BucketError } from '@ch99q/bucket';

const myDriver = {
  id: 'my-api',
  capabilities: [/* ... */],
  async *fetch(query, opt) {
    const res = await fetch(url, { signal: opt?.signal });

    if (res.status === 429) {
      throw new BucketError('PROVIDER_FAILED', 'Rate limited — try again later');
    }
    if (!res.ok) {
      throw new BucketError('PROVIDER_FAILED', `HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    for (const item of data) yield toRecord(item);
  },
};
```

The `cause` parameter chains errors for debugging:

```js
try {
  const data = await externalApi.getData();
} catch (err) {
  throw new BucketError('PROVIDER_FAILED', 'External API failed', err);
  // err.cause → original error
}
```
