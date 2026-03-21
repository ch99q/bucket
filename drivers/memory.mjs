import { BucketError } from "../errors.mjs";
import { defineDriver } from "../driver-utils.mjs";

/**
 * @typedef {import('../types.d.ts').DataRecord} DataRecord
 * @typedef {import('../types.d.ts').Capability} Capability
 * @typedef {import('../types.d.ts').Driver} Driver
 * @typedef {import('../types.d.ts').ISOTime} ISOTime
 */

const tsCache = Symbol("bucketMemoryTs");
const tsOfRecord = (record) => record[tsCache] ?? (record[tsCache] = Date.parse(record.ts));
const cmpTs = (a, b) => tsOfRecord(a) - tsOfRecord(b);
const ms = (t) => (t ? Date.parse(t) : undefined);

/**
 * Normalize the different invocation styles supported by memoryDriver.
 * @param {string | { id?: string; rows?: DataRecord[]; capabilities?: Capability[] }} maybeOpts
 * @param {DataRecord[]} [rows]
 * @param {Capability[]} [caps]
 */
const normalizeArgs = (maybeOpts, rows, caps) => {
  if (Array.isArray(rows) && Array.isArray(caps)) {
    return { id: typeof maybeOpts === "string" ? maybeOpts : "memory", rows, capabilities: caps };
  }
  if (maybeOpts && typeof maybeOpts === "object" && !Array.isArray(maybeOpts)) {
    return {
      id: maybeOpts.id ?? "memory",
      rows: maybeOpts.rows,
      capabilities: maybeOpts.capabilities ?? maybeOpts.caps,
    };
  }
  return { id: typeof maybeOpts === "string" ? maybeOpts : "memory", rows: rows ?? [], capabilities: caps ?? [] };
};

/**
 * Creates an in-memory driver for testing and backtesting.
 * Accepts either positional params `(id, rows, capabilities)` for backwards compatibility
 * or an options object `{ id, rows, capabilities }`.
 * @returns {Driver} Configured memory driver
 */
export function memoryDriver(maybeOpts, rows, caps) {
  const { id, rows: dataRows, capabilities: capsResolved } = normalizeArgs(maybeOpts, rows, caps);
  const capabilities = capsResolved;
  if (!Array.isArray(dataRows)) throw new BucketError("BAD_REQUEST", "memoryDriver rows[] required");
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new BucketError("BAD_REQUEST", "memoryDriver capabilities[] required");
  }
  const sorted = dataRows.slice().sort(cmpTs);
  const combinedIndex = new Map();

  for (let i = 0; i < sorted.length; i++) {
    const record = sorted[i];
    const combinedKey = `${record.symbol ?? "*"}:${record.kind}`;
    if (!combinedIndex.has(combinedKey)) combinedIndex.set(combinedKey, []);
    combinedIndex.get(combinedKey).push(i);
  }

  return defineDriver({
    id,
    capabilities,
    async *fetch(q, opt) {
      const indices = combinedIndex.get(`${q.symbol}:${q.kind}`);
      const f = ms(q.from) ?? -Infinity;
      const t = ms(q.to) ?? Infinity;
      let n = 0;

      const consume = function* (source) {
        for (const record of source) {
          if (opt?.signal?.aborted) throw new BucketError("ABORTED", "memory fetch aborted");
          if (record.kind !== q.kind) continue;
          if (record.symbol && record.symbol !== q.symbol) continue;
          if (q.kind === "custom" && q.type && record.type !== q.type) continue;
          if (q.interval && record.interval && record.interval !== q.interval) continue;
          const ts = tsOfRecord(record);
          if (ts < f || ts > t) continue;
          yield record;
          n++;
          if (opt?.limit !== undefined && n >= opt.limit) break;
        }
      };

      if (indices) {
        for (const idx of indices) {
          if (opt?.signal?.aborted) throw new BucketError("ABORTED", "memory fetch aborted");
          const record = sorted[idx];
          if (q.kind === "custom" && q.type && record.type !== q.type) continue;
          if (q.interval && record.interval && record.interval !== q.interval) continue;
          const ts = tsOfRecord(record);
          if (ts < f || ts > t) continue;
          yield record;
          n++;
          if (opt?.limit !== undefined && n >= opt.limit) break;
        }
      } else {
        yield* consume(sorted);
      }
    },
    async fetchBatch(queries, opt) {
      return queries.map((query) => {
        const f = ms(query.from) ?? -Infinity;
        const t = ms(query.to) ?? Infinity;
        const limit = opt?.limit;
        const indices = combinedIndex.get(`${query.symbol}:${query.kind}`);
        const acc = [];
        let n = 0;
        const consumeRecord = (record) => {
          if (query.kind === "custom" && query.type && record.type !== query.type) return;
          if (query.interval && record.interval && record.interval !== query.interval) return;
          const ts = tsOfRecord(record);
          if (ts < f || ts > t) return;
          acc.push(record);
          n++;
          if (limit !== undefined && n >= limit) return true;
          return false;
        };
        if (indices) {
          for (const idx of indices) {
            if (consumeRecord(sorted[idx])) break;
          }
        } else {
          for (const record of sorted) {
            if (record.kind !== query.kind) continue;
            if (record.symbol && record.symbol !== query.symbol) continue;
            if (consumeRecord(record)) break;
          }
        }
        return acc;
      });
    },
  });
}
