import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fsAdapter } from '../../storage/fs.mjs';

const iso = (base, offset) => new Date(base + offset).toISOString();

describe('fsAdapter', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'bucket-storage-'));
  });

  it('persists fetched ranges and reports missing gaps', async () => {
    const adapter = fsAdapter({ baseDir: tempDir, namespace: 'tests' });
    const baseTs = Date.now() - 60_000;
    const query = {
      symbol: 'BINANCE:BTCUSDT',
      kind: 'candle',
      interval: '1m',
      from: iso(baseTs, 0),
      to: iso(baseTs, 60_000),
    };
    const rows = [
      { symbol: query.symbol, kind: 'candle', interval: '1m', ts: query.from, open: 1, high: 2, low: 0.5, close: 1.5 },
      { symbol: query.symbol, kind: 'candle', interval: '1m', ts: query.to, open: 1.5, high: 2, low: 1.4, close: 1.8 },
    ];
    await adapter.write(rows, { query });

    const first = await adapter.fetch(query);
    expect(first.rows).toHaveLength(2);
    expect(first.missing).toEqual([]);

    const extended = { ...query, to: iso(baseTs, 120_000) };
    const second = await adapter.fetch(extended);
    expect(second.rows).toHaveLength(2);
    expect(second.missing).toHaveLength(1);
    expect(second.missing[0].from).toBe(rows.at(-1)?.ts);

    await adapter.close();
    await rm(tempDir, { recursive: true, force: true });
  });
});
