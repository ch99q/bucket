import { describe, bench, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

import { fsAdapter } from '../storage/fs.mjs';
import { sqliteAdapter } from '../storage/sqlite.mjs';
import { memoryAdapter } from '../storage/memory.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpBase = path.join(__dirname, '.tmp');
await mkdir(tmpBase, { recursive: true });

const minute = 60_000;
const chunkSize = Number(process.env.STORAGE_BENCH_CHUNK ?? 10_000);
const targetsMB = [1, 10];
const bytesPerMB = 1024 * 1024;

const makeRecord = (symbol, offset) => ({
  kind: 'candle',
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

const buildBatch = (symbol, start, count) =>
  Array.from({ length: count }, (_, i) => makeRecord(symbol, start + i));

const query = { symbol: 'AAPL', kind: 'candle', interval: '1m' };

const growDataset = async (adapter, targetMB) => {
  let written = 0;
  let offset = 0;
  while (written < targetMB * bytesPerMB) {
    const batch = buildBatch('AAPL', offset, chunkSize);
    offset += chunkSize;
    await adapter.write(batch, { query });
    written += Buffer.byteLength(JSON.stringify(batch));
  }
};

// ── adapter factories ───────────────────────────────────────────────────────

const createFs = async () => {
  const dir = await mkdtemp(path.join(tmpBase, 'fs-'));
  return {
    adapter: fsAdapter({ baseDir: dir, namespace: 'bench' }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};

const createSqlite = async () => {
  const dir = await mkdtemp(path.join(tmpBase, 'sqlite-'));
  const dbPath = path.join(dir, 'cache.sqlite');
  return {
    adapter: sqliteAdapter({ path: dbPath }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};

const createMemory = async () => ({
  adapter: memoryAdapter(),
  cleanup: async () => {},
});

afterAll(async () => {
  await rm(tmpBase, { recursive: true, force: true });
});

// ── per-adapter benchmarks ──────────────────────────────────────────────────

for (const [name, factory] of [['fs', createFs], ['sqlite', createSqlite], ['memory', createMemory]]) {
  describe(`${name} adapter`, () => {
    for (const target of targetsMB) {
      bench(`write ${target}MB`, async () => {
        const { adapter, cleanup } = await factory();
        await growDataset(adapter, target);
        await adapter.close?.();
        await cleanup();
      }, { timeout: 0 });

      bench(`fetch ${target}MB`, async () => {
        const { adapter, cleanup } = await factory();
        await growDataset(adapter, target);
        await adapter.fetch(query);
        await adapter.close?.();
        await cleanup();
      }, { timeout: 0 });
    }
  });
}
