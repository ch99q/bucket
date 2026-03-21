import { describe, it, expect } from 'vitest';
import { memoryAdapter } from '../../storage/memory.mjs';

const candle = (symbol, ts, close) => ({
  symbol,
  kind: 'candle',
  interval: '1m',
  ts,
  open: close,
  high: close,
  low: close,
  close,
});

describe('memoryAdapter', () => {
  it('tracks coverage and serves cached rows', async () => {
    const adapter = memoryAdapter();
    const base = Date.now();
    const query = {
      symbol: 'AAPL',
      kind: 'candle',
      interval: '1m',
      from: new Date(base).toISOString(),
      to: new Date(base + 60_000).toISOString(),
    };
    const rows = [
      candle('AAPL', query.from, 1),
      candle('AAPL', query.to, 2),
    ];
    await adapter.write(rows, { query });
    const first = await adapter.fetch(query);
    expect(first.rows).toHaveLength(2);
    expect(first.missing).toEqual([]);

    const extended = { ...query, to: new Date(base + 120_000).toISOString() };
    const second = await adapter.fetch(extended);
    expect(second.rows).toHaveLength(2);
    expect(second.missing.length).toBe(1);

    await adapter.close();
  });
});
