import { mkdtemp, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { sqliteAdapter } from '../storage/sqlite.mjs';

const minute = 60_000;
const bytesPerMB = 1024 * 1024;
const chunkSize = Number(process.env.SQLITE_BENCH_CHUNK ?? 10_000);
const targets = [50, 500];

const recordAt = (symbol, offset) => ({
  kind: 'candle',
  symbol,
  interval: '1m',
  ts: new Date(Date.now() - offset * minute).toISOString(),
  open: 100 + offset,
  high: 101 + offset,
  low: 99 + offset,
  close: 100.5 + offset,
  volume: 1_000 + offset,
});

const buildBatch = (symbol, start, count) => Array.from({ length: count }, (_, i) => recordAt(symbol, start + i));

const growUntil = async (adapter, dbPath, targetMB) => {
  let bytes = 0;
  let offset = 0;
  const query = { symbol: 'AAPL', kind: 'candle', interval: '1m' };
  while (bytes < targetMB * bytesPerMB) {
    const batch = buildBatch('AAPL', offset, chunkSize);
    offset += chunkSize;
    await adapter.write(batch, { query });
    const stats = await stat(dbPath);
    bytes = stats.size;
  }
  const from = recordAt('AAPL', offset - chunkSize).ts;
  const to = recordAt('AAPL', 0).ts;
  return { query: { ...query, from, to }, bytes };
};

const run = async () => {
  for (const target of targets) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-bench-'));
    const dbPath = path.join(dir, 'cache.sqlite');
    const adapter = sqliteAdapter({ path: dbPath });

    const { query } = await growUntil(adapter, dbPath, target);
    const writeBatch = buildBatch('AAPL', 1_000_000, chunkSize);
    const writeStart = performance.now();
    await adapter.write(writeBatch, { query });
    const writeMs = performance.now() - writeStart;

    const fetchStart = performance.now();
    const rows = await adapter.fetch(query);
    const fetchMs = performance.now() - fetchStart;

    await adapter.close();
    await rm(dir, { recursive: true, force: true });

    console.log(`[sqlite][${target}MB] write=${writeMs.toFixed(2)}ms fetch=${fetchMs.toFixed(2)}ms rows=${rows.rows.length}`);
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
