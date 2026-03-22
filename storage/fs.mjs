import { promises as fs } from 'fs';
import path from 'path';
import { storageAdapter } from './adapter.mjs';

const sanitize = (input) => input.replace(/[^a-zA-Z0-9._-]/g, '_');

const overlaps = (a, b) => {
  const aFrom = a.from ? Date.parse(a.from) : -Infinity;
  const aTo = a.to ? Date.parse(a.to) : Infinity;
  const bFrom = b.from ? Date.parse(b.from) : -Infinity;
  const bTo = b.to ? Date.parse(b.to) : Infinity;
  return aFrom <= bTo && bFrom <= aTo;
};

const mergeRanges = (ranges, range) => {
  const next = [...ranges, range].filter(Boolean).map((r) => ({ ...r }));
  next.sort((a, b) => (a.from ? Date.parse(a.from) : -Infinity) - (b.from ? Date.parse(b.from) : -Infinity));
  const merged = [];
  for (const cur of next) {
    if (!merged.length) {
      merged.push(cur);
      continue;
    }
    const last = merged[merged.length - 1];
    if (overlaps(last, cur)) {
      if (!last.from || (cur.from && Date.parse(cur.from) < Date.parse(last.from))) last.from = cur.from;
      if (!last.to || (cur.to && Date.parse(cur.to) > Date.parse(last.to))) last.to = cur.to;
    } else {
      merged.push(cur);
    }
  }
  return merged;
};

const chunkFileName = (range) => `${range.from ?? 'open'}__${range.to ?? 'open'}.json`;

const keyOf = (query) => [
  query.kind ?? 'custom',
  query.symbol ?? '*',
  query.interval ?? '*',
  query.type ?? '*',
].join('__');

const matchesQuery = (record, query) => {
  if (record.kind !== query.kind) return false;
  if (record.symbol && record.symbol !== query.symbol) return false;
  if (query.interval && record.interval && record.interval !== query.interval) return false;
  if (record.kind === 'custom' && query.type && record.type !== query.type) return false;
  const ts = Date.parse(record.ts);
  if (query.from && ts < Date.parse(query.from)) return false;
  if (query.to && ts > Date.parse(query.to)) return false;
  return true;
};

const computeMissing = (query, ranges) => {
  if (!query.from && !query.to) return ranges.length ? [] : [{ from: undefined, to: undefined }];
  const baseFrom = query.from ? Date.parse(query.from) : -Infinity;
  const baseTo = query.to ? Date.parse(query.to) : Infinity;
  if (baseFrom === -Infinity && baseTo === Infinity) return [];
  const ordered = ranges
    .map((r) => ({ from: r.from ? Date.parse(r.from) : undefined, to: r.to ? Date.parse(r.to) : undefined }))
    .filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to))
    .sort((a, b) => a.from - b.from);
  let cursor = baseFrom;
  const out = [];
  for (const cov of ordered) {
    if (cov.to <= cursor) continue;
    const covStart = Math.max(cov.from, baseFrom);
    const covEnd = Math.min(cov.to, baseTo);
    if (covStart > cursor) {
      out.push({
        from: cursor === -Infinity ? undefined : new Date(cursor).toISOString(),
        to: covStart === Infinity ? undefined : new Date(covStart).toISOString(),
      });
    }
    cursor = Math.max(cursor, covEnd);
    if (cursor >= baseTo) break;
  }
  if (cursor < baseTo) {
    out.push({
      from: cursor === -Infinity ? undefined : new Date(cursor).toISOString(),
      to: baseTo === Infinity ? undefined : new Date(baseTo).toISOString(),
    });
  }
  return out;
};

const deriveRange = (query, records) => {
  if (!records.length) return undefined;
  const ordered = records.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const from = query?.from ?? ordered[0]?.ts;
  const to = query?.to ?? ordered.at(-1)?.ts;
  if (!from || !to) return undefined;
  return { from, to };
};

export function fsAdapter(options = {}) {
  const baseDir = path.resolve(options.baseDir ?? path.join(process.cwd(), '.bucket-storage'));
  const namespace = sanitize(options.namespace ?? 'default');
  const storeDir = path.join(baseDir, namespace);
  const dataDir = path.join(storeDir, 'data');
  const metaPath = path.join(storeDir, 'coverage.json');
  const coverage = new Map(); // key -> { ranges: Range[], chunks: Chunk[] }
  let ready;

  const ensureReady = () =>
    ready ??
    (ready = (async () => {
      await fs.mkdir(dataDir, { recursive: true });
      try {
        const raw = await fs.readFile(metaPath, 'utf8');
        if (raw) {
          const parsed = JSON.parse(raw);
          for (const [key, entry] of Object.entries(parsed)) {
            coverage.set(key, {
              ranges: entry.ranges ?? entry,
              chunks: entry.chunks ?? [],
            });
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    })());

  const storageKey = (src) => sanitize(keyOf(src));
  const chunkDir = (key) => path.join(dataDir, key);

  const persistCoverage = async () => {
    const payload = {};
    for (const [key, entry] of coverage.entries()) payload[key] = entry;
    await fs.writeFile(metaPath, JSON.stringify(payload, null, 2), 'utf8');
  };

  const getEntry = (key) => {
    if (!coverage.has(key)) coverage.set(key, { ranges: [], chunks: [] });
    return coverage.get(key);
  };

  return storageAdapter({
    id: options.id ?? 'fs-storage',
    async fetch(query) {
      await ensureReady();
      const key = storageKey(query);
      const entry = coverage.get(key);
      if (!entry) return { rows: [], missing: [{ from: query.from, to: query.to }] };
      const rows = [];
      for (const chunk of entry.chunks.filter((c) => overlaps(c, query))) {
        try {
          const chunkPath = path.join(storeDir, chunk.file);
          const data = await fs.readFile(chunkPath, 'utf8');
          if (!data) continue;
          const parsed = JSON.parse(data);
          for (const record of parsed) {
            if (matchesQuery(record, query)) rows.push(record);
          }
        } catch (err) {
          if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
        }
      }
      rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      return { rows, missing: computeMissing(query, entry.ranges) };
    },
    async write(records, ctx) {
      if (!records?.length) return;
      await ensureReady();
      const baseQuery = ctx?.query ?? {};
      const spanQuery = baseQuery.symbol ? baseQuery : records[0];
      const range = deriveRange(spanQuery, records);
      if (!range) return;
      const key = storageKey(spanQuery);
      const entry = getEntry(key);
      const relPath = path.join('data', key, chunkFileName(range));
      await fs.mkdir(chunkDir(key), { recursive: true });
      await fs.writeFile(path.join(storeDir, relPath), JSON.stringify(records), 'utf8');
      entry.chunks = entry.chunks.filter((chunk) => chunk.file !== relPath);
      entry.chunks.push({ ...range, file: relPath });
      entry.ranges = mergeRanges(entry.ranges, range);
      await persistCoverage();
    },
    async close() {
      await ensureReady();
    },
  });
}
