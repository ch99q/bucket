import { describe, bench } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fsAdapter } from '../storage/fs.mjs';
import { sqliteAdapter } from '../storage/sqlite.mjs';
import { memoryAdapter } from '../storage/memory.mjs';

const minute = 60_000;
const chunkSize = Number(process.env.STORAGE_BENCH_CHUNK ?? 10_000);
const targetsMB = [50, 500];
const bytesPerMB = 1024 * 1024;

const makeRecord = (symbol, offset, kind = 'candle') => ({
  kind,
  symbol,
  interval: '1m',
  ts: new Date(Date.now() - offset * minute).toISOString(),
  open: 100 + offset,
  high: 101 + offset,
  low: 99 + offset,
  close: 100.5 + offset,
  volume: 1_000 + offset,
  payload: randomBytes(16).toString('hex'),
});

const buildBatch = (symbol, start, count) => Array.from({ length: count }, (_, i) => makeRecord(symbol, start + i));

const growDataset = async (adapter, options, targetMB) => {
  let written = 0;
  let offset = 0;
  const query = { symbol: 'AAPL', kind: 'candle', interval: '1m' };
  while (written < targetMB * bytesPerMB) {
    const batch = buildBatch('AAPL', offset, chunkSize);
    offset += chunkSize;
    await adapter.write(batch, { query });
    if (options.measurePath) {
      const stats = await stat(options.measurePath());
      written = stats.size;
    } else {
      written += Buffer.byteLength(JSON.stringify(batch));
    }
  }
  return { query, totalBytes: written };
};

const adapters = {
  fs: async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'storage-bench-fs-'));
    const adapter = fsAdapter({ baseDir: dir, namespace: 'bench' });
    return {
      adapter,
      options: { measurePath: () => dir },
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  },
  sqlite: async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'storage-bench-sqlite-'));
    const dbPath = path.join(dir, 'cache.sqlite');
    const adapter = sqliteAdapter({ path: dbPath });
    return {
      adapter,
      options: { measurePath: () => dbPath },
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  },
  memory: async () => ({ adapter: memoryAdapter(), options: {}, cleanup: async () => {} }),
};

describe('storage adapter throughput', () => {
  for (const [name, factory] of Object.entries(adapters)) {
    for (const target of targetsMB) {
      bench(`${name} write ${target}MB`, async () => {
        const { adapter, options, cleanup } = await factory();
        const { query } = await growDataset(adapter, options, target);
        await adapter.close?.();
        await cleanup();
      }, { timeout: 0 });

      bench(`${name} fetch ${target}MB`, async () => {
        const { adapter, options, cleanup } = await factory();
        const { query } = await growDataset(adapter, options, target);
        await adapter.fetch(query);
        await adapter.close?.();
        await cleanup();
      }, { timeout: 0 });
    }
  }
});
