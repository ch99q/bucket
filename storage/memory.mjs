import { storageAdapter } from './adapter.mjs';

const recordKey = (record) => [
  record.kind,
  record.symbol ?? '*',
  record.interval ?? '*',
  record.type ?? '*',
  record.ts,
].join('|');

const ts = (val) => (val ? Date.parse(val) : undefined);

const overlaps = (a, b) => {
  const aFrom = ts(a.from) ?? -Infinity;
  const aTo = ts(a.to) ?? Infinity;
  const bFrom = ts(b.from) ?? -Infinity;
  const bTo = ts(b.to) ?? Infinity;
  return aFrom <= bTo && bFrom <= aTo;
};

const mergeRanges = (ranges, range) => {
  if (!range?.from && !range?.to) return ranges;
  const next = [...ranges, range].filter(Boolean).map((r) => ({ ...r }));
  next.sort((a, b) => (ts(a.from) ?? -Infinity) - (ts(b.from) ?? -Infinity));
  const merged = [];
  for (const cur of next) {
    if (!merged.length) {
      merged.push(cur);
      continue;
    }
    const last = merged[merged.length - 1];
    if (overlaps(last, cur)) {
      if (!last.from || (cur.from && ts(cur.from) < ts(last.from))) last.from = cur.from;
      if (!last.to || (cur.to && ts(cur.to) > ts(last.to))) last.to = cur.to;
    } else {
      merged.push(cur);
    }
  }
  return merged;
};

const coverageMissing = (ranges, query) => {
  if (!query.from && !query.to) return ranges.length ? [] : [{ from: undefined, to: undefined }];
  const needed = [{ from: query.from, to: query.to }];
  for (const covered of ranges) {
    for (let i = needed.length - 1; i >= 0; i--) {
      const span = needed[i];
      if (!overlaps(span, covered)) continue;
      const spans = [];
      const spanFrom = ts(span.from) ?? -Infinity;
      const spanTo = ts(span.to) ?? Infinity;
      const coverFrom = ts(covered.from) ?? -Infinity;
      const coverTo = ts(covered.to) ?? Infinity;
      if (coverFrom > spanFrom) spans.push({ from: span.from, to: covered.from });
      if (coverTo < spanTo) spans.push({ from: covered.to, to: span.to });
      needed.splice(i, 1, ...spans.filter((r) => r.from !== r.to));
    }
  }
  return needed.filter((r) => r.from !== undefined || r.to !== undefined);
};

const keyOf = (query) => [
  query.kind ?? 'custom',
  query.symbol ?? '*',
  query.interval ?? '*',
  query.type ?? '*',
].join('|');

const matchesQuery = (record, query) => {
  if (record.kind !== query.kind) return false;
  if (record.symbol && record.symbol !== query.symbol) return false;
  if (query.interval && record.interval && record.interval !== query.interval) return false;
  if (record.kind === 'custom' && query.type && record.type !== query.type) return false;
  const time = Date.parse(record.ts);
  if (query.from && time < Date.parse(query.from)) return false;
  if (query.to && time > Date.parse(query.to)) return false;
  return true;
};

const sortByTs = (records) => records.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

const mergeRecords = (base, addition) => {
  if (!base.length) return addition.slice();
  if (!addition.length) return base.slice();
  const left = base;
  const right = addition;
  const merged = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const l = left[i];
    const r = right[j];
    const delta = Date.parse(l.ts) - Date.parse(r.ts);
    if (delta < 0) {
      merged.push(l);
      i++;
    } else if (delta > 0) {
      merged.push(r);
      j++;
    } else {
      merged.push(recordKey(r) === recordKey(l) ? r : r);
      i++;
      j++;
    }
  }
  while (i < left.length) merged.push(left[i++]);
  while (j < right.length) merged.push(right[j++]);
  return merged;
};

export function memoryAdapter(options = {}) {
  const store = new Map();
  const ranges = new Map();

  return storageAdapter({
    id: options.id ?? 'memory-storage',
    async fetch(query) {
      const key = keyOf(query);
      const rows = (store.get(key) ?? []).filter((row) => matchesQuery(row, query));
      const missing = coverageMissing(ranges.get(key) ?? [], query);
      return { rows, missing };
    },
    async write(records, ctx) {
      if (!records?.length) return;
      const baseQuery = ctx?.query ?? {};
      const key = keyOf(baseQuery.symbol ? baseQuery : records[0]);
      const existing = store.get(key) ?? [];
      const orderedIncoming = sortByTs(records);
      store.set(key, mergeRecords(existing, orderedIncoming));
      const range = ctx?.query?.from || ctx?.query?.to ? { from: ctx.query.from, to: ctx.query.to } : { from: records[0].ts, to: records.at(-1)?.ts };
      if (range.from || range.to) {
        const merged = mergeRanges(ranges.get(key) ?? [], range);
        ranges.set(key, merged);
      }
    },
    async close() {
      store.clear();
      ranges.clear();
    },
  });
}
