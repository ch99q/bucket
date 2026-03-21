import { storageAdapter } from './adapter.mjs';

let backend;
try {
  const mod = await import('bun:sqlite');
  if (mod?.Database) backend = { type: 'bun', Database: mod.Database };
} catch {}

if (!backend) {
  try {
    const mod = await import('better-sqlite3');
    const Database = mod.default ?? mod;
    backend = { type: 'better', Database };
  } catch {}
}

if (!backend) {
  throw new Error('SQLite adapter requires bun:sqlite or better-sqlite3.');
}

const ensureDb = (options) => {
  const dbPath = options.path ?? 'bucket-storage.sqlite';
  if (backend.type === 'bun') {
    const db = new backend.Database(dbPath);
    if (options.tune !== false) {
      db.exec('PRAGMA journal_mode=WAL;');
      db.exec('PRAGMA synchronous=NORMAL;');
      db.exec('PRAGMA temp_store=MEMORY;');
      db.exec(`PRAGMA mmap_size=${options.mmapSize ?? 256 * 1024 * 1024};`);
      if (options.cachePages) db.exec(`PRAGMA cache_size=-${options.cachePages};`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS records (
      key TEXT NOT NULL,
      kind TEXT NOT NULL,
      symbol TEXT,
      interval TEXT,
      type TEXT,
      ts TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (key, ts)
    );`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_records_symbol_ts ON records(symbol, interval, ts);');
    db.exec(`CREATE TABLE IF NOT EXISTS coverage (
      key TEXT NOT NULL,
      from_ts TEXT,
      to_ts TEXT,
      PRIMARY KEY (key, from_ts, to_ts)
    );`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_coverage_key ON coverage(key);');
    return { db, type: 'bun' };
  }
  const Database = backend.Database;
  const db = new Database(dbPath);
  if (options.tune !== false) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
  }
  db.prepare(`CREATE TABLE IF NOT EXISTS records (
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    symbol TEXT,
    interval TEXT,
    type TEXT,
    ts TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (key, ts)
  );`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_records_symbol_ts ON records(symbol, interval, ts);').run();
  db.prepare(`CREATE TABLE IF NOT EXISTS coverage (
    key TEXT NOT NULL,
    from_ts TEXT,
    to_ts TEXT,
    PRIMARY KEY (key, from_ts, to_ts)
  );`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_coverage_key ON coverage(key);').run();
  return { db, type: 'better' };
};

const storageKey = (query) => [
  query.kind ?? 'custom',
  query.symbol ?? '*',
  query.interval ?? '*',
  query.type ?? '*',
].join('|');

const buildRange = (query) => ({ from: query?.from, to: query?.to });

const MIN_TS = '0000-01-01T00:00:00Z';
const MAX_TS = '9999-12-31T23:59:59Z';

const normalizeMissing = (ranges, query) => {
  if (!query.from && !query.to) return ranges.length ? [] : [{ from: undefined, to: undefined }];
  if (ranges.length === 0) return [{ from: query.from, to: query.to }];
  const start = Date.parse(query.from ?? MIN_TS);
  const end = Date.parse(query.to ?? MAX_TS);
  let cursor = start;
  const ordered = ranges
    .map((r) => ({ from: Date.parse(r.from ?? MIN_TS), to: Date.parse(r.to ?? MAX_TS) }))
    .sort((a, b) => a.from - b.from);
  const gaps = [];
  for (const cov of ordered) {
    if (cov.to <= cursor) continue;
    if (cov.from > cursor) {
      gaps.push({ from: new Date(cursor).toISOString(), to: new Date(Math.min(cov.from, end)).toISOString() });
    }
    cursor = Math.max(cursor, cov.to);
    if (cursor >= end) break;
  }
  if (cursor < end) gaps.push({ from: new Date(cursor).toISOString(), to: new Date(end).toISOString() });
  return gaps;
};

export function sqliteAdapter(options = {}) {
  const { db, type } = ensureDb(options);
  const selectSQL = `SELECT payload FROM records WHERE key = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`;
  const selectStmt = type === 'bun' ? db.query(selectSQL) : db.prepare(selectSQL);
  const insertSQL = `INSERT OR REPLACE INTO records (key, kind, symbol, interval, type, ts, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)`;
  const insertStmt = type === 'bun' ? db.query(insertSQL) : db.prepare(insertSQL);
  const selectCoverageSQL = `SELECT from_ts, to_ts FROM coverage WHERE key = ?`;
  const selectCoverage = type === 'bun' ? db.query(selectCoverageSQL) : db.prepare(selectCoverageSQL);
  const insertCoverageSQL = `INSERT OR REPLACE INTO coverage (key, from_ts, to_ts) VALUES (?, ?, ?)`;
  const insertCoverage = type === 'bun' ? db.query(insertCoverageSQL) : db.prepare(insertCoverageSQL);
  const transaction = db.transaction?.bind(db);

  return storageAdapter({
    id: options.id ?? 'sqlite-storage',
    async fetch(query) {
      const key = storageKey(query);
      const lower = query.from ?? MIN_TS;
      const upper = query.to ?? MAX_TS;
      const rowsRaw = selectStmt.all(key, lower, upper);
      const rows = rowsRaw.map((row) => JSON.parse(row.payload));
      const coverageRows = selectCoverage.all(key).map((row) => ({ from: row.from_ts ?? undefined, to: row.to_ts ?? undefined }));
      return { rows, missing: normalizeMissing(coverageRows, query) };
    },
    async write(records, ctx) {
      if (!records?.length) return;
      if (!transaction) throw new Error('SQLite backend missing transaction support');
      const query = ctx?.query ?? {};
      const spanQuery = query.symbol ? query : records[0];
      const key = storageKey(spanQuery);
      transaction((rows) => {
        for (const record of rows) {
          insertStmt.run(
            key,
            record.kind,
            record.symbol ?? null,
            record.interval ?? null,
            record.type ?? null,
            record.ts,
            JSON.stringify(record)
          );
        }
      })(records);
      const range = buildRange(query) ?? { from: records[0].ts, to: records.at(-1)?.ts };
      insertCoverage.run(key, range.from ?? null, range.to ?? null);
    },
    async close() {
      db.close();
    },
  });
}
