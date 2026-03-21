import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { sqliteAdapter } from '../../storage/sqlite.mjs';

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

describe('sqliteAdapter', () => {
  it('stores and retrieves rows from sqlite backend', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'bucket-sqlite-'));
    const dbPath = path.join(tmp, 'store.sqlite');
    const adapter = sqliteAdapter({ path: dbPath });
    const base = Date.now();
    const query = {
      symbol: 'TSLA',
      kind: 'candle',
      interval: '1m',
      from: new Date(base).toISOString(),
      to: new Date(base + 60_000).toISOString(),
    };
    const rows = [
      candle('TSLA', query.from, 1),
      candle('TSLA', query.to, 2),
    ];
    await adapter.write(rows, { query });
    const hit = await adapter.fetch(query);
    expect(hit.rows).toHaveLength(2);
    expect(hit.missing).toEqual([]);

    const extended = { ...query, to: new Date(base + 120_000).toISOString() };
    const miss = await adapter.fetch(extended);
    expect(miss.missing.length).toBeGreaterThan(0);

    await adapter.close();
    await rm(tmp, { recursive: true, force: true });
  });
});
