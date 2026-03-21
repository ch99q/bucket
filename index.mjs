/**
 * @fileoverview High-Performance Trading Data Bucket
 * 
 * A streaming-first, cache-optimized data access layer designed for 
 * high-frequency trading applications. Supports multiple data sources,
 * time-series operations, and dependency-aware processing.
 * 
 * @author Christian
 * @version 1.0.0
 */

import { BucketError } from "./errors.mjs";

export { BucketError } from "./errors.mjs";
export { defineDriver } from "./driver-utils.mjs";

/**
 * @typedef {import('./types.d.ts').ISOTime} ISOTime
 * @typedef {import('./types.d.ts').Candle} Candle
 * @typedef {import('./types.d.ts').Tick} Tick
 * @typedef {import('./types.d.ts').Custom} Custom
 * @typedef {import('./types.d.ts').DataRecord} DataRecord
 * @typedef {import('./types.d.ts').Query} Query
 * @typedef {import('./types.d.ts').FetchOpts} FetchOpts
 * @typedef {import('./types.d.ts').LiveOpts} LiveOpts
 * @typedef {import('./types.d.ts').MuxMsg} MuxMsg
 * @typedef {import('./types.d.ts').Driver} Driver
 * @typedef {import('./types.d.ts').Capability} Capability
 * @typedef {import('./types.d.ts').Cache} Cache
 * @typedef {import('./types.d.ts').Operator} Operator
 * @typedef {import('./types.d.ts').SelectContext} SelectContext
 * @typedef {import('./types.d.ts').BucketContext} BucketContext
 * @typedef {import('./types.d.ts').Session} Session
 * @typedef {import('./types.d.ts').Bucket} Bucket
 */

// ==================== INTERNAL UTILITIES ====================

/**
 * Convert ISO time string to milliseconds
 * @param {ISOTime} [t] ISO time string
 * @returns {number | undefined} Milliseconds since epoch or undefined
 */
const ms = (t) => t ? Date.parse(t) : undefined;

/**
 * Compare two data records by timestamp (for sorting)
 * @param {DataRecord} a First record
 * @param {DataRecord} b Second record  
 * @returns {number} Comparison result (-1, 0, 1)
 */
const tsCache = Symbol("bucketTs");
const tsOfRecord = (record) => record[tsCache] ?? (record[tsCache] = Date.parse(record.ts));
const cmpTs = (a, b) => tsOfRecord(a) - tsOfRecord(b);

/**
 * Clamp 'to' time to not exceed 'asOf' time (for time travel prevention)
 * @param {ISOTime} [to] Target end time
 * @param {ISOTime} [asOf] Maximum allowed time
 * @returns {ISOTime | undefined} Clamped time or undefined
 */
const clampTo = (to, asOf) =>
  (!to || !asOf) ? to : (Date.parse(to) > Date.parse(asOf) ? asOf : to);

/**
 * Validate query parameters and throw descriptive errors
 * @param {Query} q Query object to validate
 * @throws {BucketError} When query is invalid
 */
function assertQuery(q) {
  if (!q || typeof q !== "object") throw new BucketError("BAD_REQUEST", "Query required");
  if (!q.symbol) throw new BucketError("BAD_REQUEST", "symbol required");
  if (!q.kind) throw new BucketError("BAD_REQUEST", "kind required");
  if (q.kind === "candle" && !q.interval) throw new BucketError("BAD_REQUEST", "interval required for candles");
  if (q.kind === "custom" && !q.type) throw new BucketError("BAD_REQUEST", "type required for custom");
  const f = ms(q.from), t = ms(q.to);
  if (f !== undefined && Number.isNaN(f)) throw new BucketError("BAD_REQUEST", `Invalid from=${q.from}`);
  if (t !== undefined && Number.isNaN(t)) throw new BucketError("BAD_REQUEST", `Invalid to=${q.to}`);
  if (f !== undefined && t !== undefined && f > t) throw new BucketError("BAD_REQUEST", "from > to");
}

// ==================== CACHING SYSTEM ====================

/**
 * Create a TTL (Time To Live) cache with automatic expiration
 * 
 * Performance: ~14M cache hits/sec, ~1.2M cache sets/sec
 * 
 * @template V Value type
 * @param {{ ms: number, max?: number }} options Cache configuration
 * @param {number} options.ms Time to live in milliseconds
 * @param {number} [options.max=512] Maximum cache entries (LRU eviction)
 * @returns {Cache<V>} Cache instance
 * 
 * @example
 * const cache = ttlCache({ ms: 60000, max: 1000 });
 * cache.set('key', data);
 * const result = cache.get('key'); // null if expired
 */
export const ttlCache = ({ ms, max = 512 }) => {
  const map = new Map();
  return {
    get(k) { 
      const hit = map.get(k); 
      if (!hit) return; 
      if (hit.exp < Date.now()) { 
        map.delete(k); 
        return; 
      } 
      return hit.v; 
    },
    set(k, v) { 
      if (map.size >= max) { 
        const first = map.keys().next().value; 
        if (first) map.delete(first); 
      } 
      map.set(k, { v, exp: Date.now() + ms }); 
    },
    clear() { map.clear(); }
  };
};

// ==================== DRIVER SELECTION ====================

/**
 * Default driver selection strategy - matches capabilities and prioritizes by priority
 * @param {SelectContext} ctx Selection context
 * @returns {readonly Driver[]} Ordered drivers (highest priority first)
 */
const defaultSelect = ({ drivers, query, need }) =>
  drivers
    .flatMap(p => p.capabilities
      .filter(c => {
        if (c.kind !== query.kind) return false;
        if (need === "fetch" && c.supports.fetch !== true) return false;
        if (need === "live"  && c.supports.live  !== true) return false;
        if (query.interval && c.intervals && !c.intervals.some(r => r.test(query.interval))) return false;
        if (query.kind === "custom" && query.type && c.types && !c.types.some(r => r.test(query.type))) return false;
        if (c.symbols && !c.symbols.some(r => r.test(query.symbol))) return false;
        return true;
      })
      .map(c => ({ p, prio: c.priority ?? 0 })))
    .sort((a,b)=>b.prio - a.prio)
    .map(x => x.p)
    .filter((p, i, arr) => arr.indexOf(p) === i);

// ==================== STREAM MERGING ====================

/**
 * Merges multiple ordered streams into a single ordered stream
 * Assumes input streams are ordered by timestamp
 * @template T
 * @param {AsyncIterable<T>[]} iters
 * @param {{ signal?: AbortSignal }} [opt]
 * @returns {AsyncIterable<T>}
 */
export async function* mergeOrdered(iters, opt) {
  const states = await Promise.all(iters.map(async (iterator) => {
    const it = iterator[Symbol.asyncIterator]();
    return { it, cur: await it.next() };
  }));
  const keyOf = (val) => val?.ts ?? val?.record?.ts ?? '';
  const heap = [];
  const push = (node) => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].key <= heap[i].key) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = () => {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < heap.length && heap[left].key < heap[smallest].key) smallest = left;
        if (right < heap.length && heap[right].key < heap[smallest].key) smallest = right;
        if (smallest === i) break;
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
        i = smallest;
      }
    }
    return top;
  };

  for (let idx = 0; idx < states.length; idx++) {
    const s = states[idx];
    if (!s.cur.done) push({ index: idx, key: keyOf(s.cur.value) });
  }

  for (;;) {
    if (opt?.signal?.aborted) throw new BucketError("ABORTED","merge aborted");
    const next = pop();
    if (!next) return;
    const state = states[next.index];
    yield state.cur.value;
    state.cur = await state.it.next();
    if (!state.cur.done) push({ index: next.index, key: keyOf(state.cur.value) });
  }
}

// ==================== STREAMING OPERATORS ====================

/**
 * Pipe source through operators (functional composition)
 * @template T
 * @param {AsyncIterable<T>} src Source stream
 * @param {...Operator<any, any>} ops Operator functions to apply
 * @returns {AsyncIterable<any>} Transformed stream
 */
export const pipe = (src, ...ops) => ops.reduce((a, op) => op(a), src);

/**
 * Map transform operator - applies function to each element
 * @template T, U
 * @param {(x: T) => U} fn Transform function
 * @returns {Operator<T, U>} Map operator
 */
export const map = (fn) => async function* (src) { 
  for await (const x of src) yield fn(x); 
};

/**
 * Filter operator - only yields elements matching predicate
 * @template T
 * @param {(x: T) => boolean} p Predicate function
 * @returns {Operator<T>} Filter operator
 */
export const filter = (p) => async function* (src) { 
  for await (const x of src) if (p(x)) yield x; 
};

/**
 * Take operator - limits stream to first n elements
 * @template T
 * @param {number} n Number of elements to take
 * @returns {Operator<T>} Take operator
 */
export const take = (n) => async function* (src) { 
  let i = 0; 
  for await (const x of src) { 
    if (i++ >= n) break; 
    yield x; 
  } 
};

// ==================== RESAMPLING ====================

/**
 * Parse interval string to milliseconds
 * @param {string} s Interval string (e.g., "1m", "5s", "1h", "1d", "1w")
 * @returns {number} Interval in milliseconds
 */
function parseInterval(s) {
  const m = /^(\d+)([smhdw])$/.exec(s); 
  if (!m) throw new BucketError("BAD_REQUEST", `Bad interval: ${s}`);
  const n = Number(m[1]); 
  const unit = m[2];
  const mult = unit==="s"?1e3: unit==="m"?6e4: unit==="h"?3.6e6: unit==="d"?8.64e7: 6.048e8;
  return n*mult;
}

/**
 * Resample operator - converts candles to different time intervals
 * Uses right-closed windows and prevents look-ahead bias
 * @param {string} interval Target interval (e.g., "1m", "5m", "1h")
 * @returns {Operator<DataRecord, Candle>} Resample operator
 */
export function resample(interval) {
  const step = parseInterval(interval);
  return async function* (src) {
    let wStartMs = null;
    let acc = null;
    for await (const r of src) {
      if (r.kind !== "candle") continue;
      const t = tsOfRecord(r);
      if (wStartMs === null) wStartMs = Math.floor(t / step) * step;
      // close windows until r fits
      while (wStartMs !== null && t >= wStartMs + step) {
        if (acc) yield acc;
        wStartMs += step; acc = null;
      }
      if (!acc) acc = { kind:"candle", ts: new Date(wStartMs).toISOString(), open:r.open, high:r.high, low:r.low, close:r.close, volume:r.volume };
      else {
        acc.high = Math.max(acc.high, r.high);
        acc.low  = Math.min(acc.low, r.low);
        acc.close = r.close;
        if (r.volume !== undefined) acc.volume = (acc.volume ?? 0) + r.volume;
      }
    }
    // Do not emit partial last window: avoids look-ahead bias.
  };
}

// ==================== BUCKET IMPLEMENTATION ====================

/**
 * Generate cache key for query and options
 * @param {Query} q Query object
 * @param {FetchOpts} [opt] Fetch options
 * @param {ISOTime} [asOf] As-of timestamp for historical queries
 * @returns {string} Unique cache key
 */
const keyOf = (q, opt, asOf) => {
  if (!opt && !asOf && !q.from && !q.to) {
    return `${q.symbol ?? ""}:${q.kind ?? ""}:${q.interval ?? ""}:${q.type ?? ""}`;
  }
  return [
    q.symbol ?? "",
    q.kind ?? "",
    q.interval ?? "",
    q.type ?? "",
    q.from ?? "",
    q.to ?? "",
    opt?.limit ?? "",
    opt?.descending ?? "",
    asOf ?? ""
  ].join("|");
};

/**
 * Create a new bucket instance with configured drivers, caching, and optional storage adapter
 * @param {{ drivers: readonly Driver[], cache?: Cache<DataRecord[]>, select?: (ctx: SelectContext) => readonly Driver[], storage?: StorageAdapter }} opts Configuration options
 * @returns {Bucket} Configured bucket instance
 */
export function createBucket(opts) {
  const ctx = { drivers: opts.drivers ?? [], cache: opts.cache, select: opts.select ?? defaultSelect, storage: opts.storage };
  const storageLayer = ctx.storage ? createStorageLayer(ctx.storage) : undefined;
  const selectDrivers = (() => {
    const cache = new Map();
    return (query, need) => {
      const key = `${need}:${query.kind ?? ""}:${query.symbol ?? ""}:${query.interval ?? ""}:${query.type ?? ""}`;
      let picks = cache.get(key);
      if (!picks) {
        picks = ctx.select({ drivers: ctx.drivers, query, need });
        cache.set(key, picks);
      }
      return picks;
    };
  })();
  const batchProcess = createBatchProcessor(ctx, selectDrivers);
  const describeDriver = (driver) => driver?.id ? `driver "${driver.id}"` : "driver";

  // single fetch impl (core)
  /**
   * @param {Query} q
   * @param {FetchOpts} [opt]
   * @returns {AsyncIterable<DataRecord>}
  */
  async function* _fetchStream(q, opt) {
    assertQuery(q);
    const picks = selectDrivers(q, "fetch");
    if (picks.length === 0) throw new BucketError("NO_PROVIDER","No driver for fetch");
    const p = picks[0];
    if (!p.fetch) throw new BucketError("UNSUPPORTED",`${describeDriver(p)} missing fetch()`);
    const it = p.fetch(q, opt);
    let n = 0;
    for await (const rec of it) {
      if (opt?.signal?.aborted) throw new BucketError("ABORTED","fetch aborted");
      yield rec;
      n++; if (opt?.limit !== undefined && n >= opt.limit) break;
    }
  }

  const fetchFromDrivers = async (q, opt) => {
    const out = [];
    for await (const r of _fetchStream(q, opt)) out.push(r);
    sortInPlace(out, opt);
    return out;
  };

  // overloads
  /**
   * @param {Query | Record<string, Query>} arg
   * @param {FetchOpts} [opt]
   * @returns {Promise<DataRecord[] | Record<string, DataRecord[]>>}
   */
  const fetchSingle = async (q, opt) => {
    assertQuery(q);
    const cacheKey = ctx.cache && (opt?.useCache ?? true) ? keyOf(q, opt, opt?.asOf) : undefined;
    if (cacheKey) {
      const hit = ctx.cache.get(cacheKey);
      if (hit) return sortMaybe(hit.slice(), opt);
    }
    const rows = storageLayer
      ? await storageLayer.readThrough(q, opt, fetchFromDrivers)
      : await fetchFromDrivers(q, opt);
    if (cacheKey) ctx.cache.set(cacheKey, rows.slice());
    return rows;
  };

  async function fetch(arg, opt) {
    if (isQuery(arg)) {
      return fetchSingle(arg, opt);
    }
    if (storageLayer) {
      const entries = await Promise.all(Object.entries(arg).map(async ([key, query]) => {
        return [key, await fetchSingle(query, opt)];
      }));
      return Object.fromEntries(entries);
    }
    return batchProcess(arg, opt);
  }

  /**
   * @param {Query | Record<string, Query>} arg
   * @param {any} [opt]
   * @returns {AsyncIterable<DataRecord> | AsyncIterable<MuxMsg> | Record<string, AsyncIterable<DataRecord>>}
   */
  /**
   * Smart streaming that automatically transitions from historical to live based on time bounds
   * @param {Query} q 
   * @param {any} [opt]
   * @returns {AsyncIterable<DataRecord>}
   */
  async function* _smartStream(q, opt) {
    // Fast path: if query has 'to', it's definitely historical
    if (q.to) {
      yield* _fetchStream(q, opt);
      return;
    }

    // Fast path: if no from/to and no live drivers, use historical
    if (!q.from && !q.to) {
      const liveDrivers = ctx.select({ drivers: ctx.drivers, query: q, need: "live" });
      if (liveDrivers.length === 0) {
        yield* _fetchStream(q, opt);
        return;
      }
      yield* _liveStream(q, opt);
      return;
    }

    // Complex case: has 'from' but no 'to' - potential transition
    if (q.from) {
      const now = new Date();
      const fromMs = Date.parse(q.from);
      const nowMs = now.getTime();

      // Future live (from > now)
      if (fromMs > nowMs) {
        const delay = fromMs - nowMs;
        await new Promise(resolve => setTimeout(resolve, delay));
        yield* _liveStream(q, opt);
        return;
      }

      // Historical → Live transition (from <= now)
      const historicalQuery = { ...q, to: now.toISOString() };
      yield* _fetchStream(historicalQuery, opt);
      yield* _liveStream(q, opt);
      return;
    }

    // Fallback: just do historical
    yield* _fetchStream(q, opt);
  }

  function stream(arg, opt) {
    const hasLiveDrivers = ctx.drivers.some(d =>
      d.capabilities.some(c => c.supports.live === true)
    );
    const baseStreamFn = hasLiveDrivers ? _smartStream : _fetchStream;

    if (isQuery(arg)) {
      if (!storageLayer) return baseStreamFn(arg, opt);
      return streamWithStorage(arg, opt, baseStreamFn);
    }

    const qs = arg;
    const labels = Object.keys(qs);
    const buildStream = (query) => storageLayer ? streamWithStorage(query, opt, baseStreamFn) : baseStreamFn(query, opt);

    if (opt?.merge) {
      const iters = labels.map(label =>
        map((r) => ({ sourceId: label, query: qs[label], record: r }))(buildStream(qs[label]))
      );
      return mergeOrdered(iters);
    } else {
      const out = {};
      for (const k of labels) out[k] = buildStream(qs[k]);
      return out;
    }
  }

  const streamWithStorage = (query, opt, baseStreamFn) => (async function* () {
    const preloadOpt = opt ? { ...opt, useCache: false, descending: false } : { useCache: false, descending: false };
    const historical = await fetchSingle(query, preloadOpt);
    for (const row of historical) yield row;
    if (query.to) return;
    const lastTs = historical.at(-1)?.ts;
    const from = lastTs ? nextIso(lastTs) : query.from;
    const restQuery = from ? { ...query, from } : query;
    const liveIter = storageLayer ? storageLayer.wrapStream(baseStreamFn(restQuery, opt), restQuery) : baseStreamFn(restQuery, opt);
    for await (const record of liveIter) yield record;
  })();

  // ==================== LIVE STREAMING ====================

  /**
   * Internal live stream for a single query
   * @param {Query} q 
   * @param {LiveOpts} [opt]
   * @returns {AsyncIterable<DataRecord>}
   */
  async function* _liveStream(q, opt) {
    assertQuery(q);
    const picks = selectDrivers(q, "live");
    if (picks.length === 0) throw new BucketError("NO_PROVIDER","No driver for live streaming");
    const p = picks[0];
    if (!p.subscribe) throw new BucketError("UNSUPPORTED",`${describeDriver(p)} missing subscribe()`);
    const it = p.subscribe(q, opt);
    for await (const rec of it) {
      if (opt?.signal?.aborted) throw new BucketError("ABORTED","live stream aborted");
      yield rec;
    }
  }

  // sessions — clamp to asOf, monotonic advance
  /**
   * @param {{ asOf: ISOTime, strict?: boolean }} init
   * @returns {Session}
   */
  function session(init) {
    let asOf = init.asOf;
    const strict = init.strict !== false;

    /**
     * @param {Query} q
     * @returns {Query}
     */
    const clamp = (q) => {
      const toClamped = strict ? clampTo(q.to ?? asOf, asOf) : q.to;
      const out = { ...q, to: toClamped };
      if (strict && out.from && ms(out.from) > ms(asOf)) {
        throw new BucketError("BAD_REQUEST", `from ${out.from} > session.asOf ${asOf}`);
      }
      return out;
    };

    /**
     * @param {Query} q
     * @param {FetchOpts} [opt]
     * @returns {AsyncIterable<DataRecord>}
     */
    async function* sFetchStream(q, opt) {
      yield* _fetchStream(clamp(q), opt);
    }

    /**
     * @param {Query | Record<string, Query>} arg
     * @param {FetchOpts} [opt]
     * @returns {Promise<DataRecord[] | Record<string, DataRecord[]>>}
     */
    async function sFetch(arg, opt) {
      if (isQuery(arg)) return fetch(clamp(arg), withAsOf(opt, asOf));
      const res = {};
      for (const [k,q] of Object.entries(arg)) res[k] = await fetch(clamp(q), withAsOf(opt, asOf));
      return res;
    }

    /**
     * @param {Query | Record<string, Query>} arg
     * @param {any} [opt]
     * @returns {AsyncIterable<DataRecord> | AsyncIterable<MuxMsg> | Record<string, AsyncIterable<DataRecord>>}
     */
    function sStream(arg, opt) {
      if (isQuery(arg)) return sFetchStream(arg, opt);
      const qs = Object.fromEntries(Object.entries(arg).map(([k,q]) => [k, clamp(q)]));
      if (opt?.merge) {
        const iters = Object.keys(qs).map(k => map((r) => ({ sourceId:k, query: qs[k], record:r }))(sFetchStream(qs[k], opt)));
        return mergeOrdered(iters);
      } else {
        const out = {};
        for (const k of Object.keys(qs)) out[k] = sFetchStream(qs[k], opt);
        return out;
      }
    }

    /**
     * @param {ISOTime} nextAsOf
     * @returns {Promise<void>}
     */
    async function advance(nextAsOf) {
      if (Date.parse(nextAsOf) < Date.parse(asOf)) throw new BucketError("BAD_REQUEST", "asOf can only move forward");
      asOf = nextAsOf;
    }

    return { asOf: () => asOf, strict, fetch: sFetch, stream: sStream, advance };
  }

  async function close() { 
    await Promise.allSettled(ctx.drivers.map(d => d.close?.())); 
    if (storageLayer) await storageLayer.close();
    ctx.cache?.clear?.(); 
  }

  return { fetch, stream, session, close, [Symbol.asyncDispose]: close };
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Type guard to check if object is a valid Query
 * @param {unknown} x Object to check
 * @returns {x is Query} True if x is a Query
 */
const isQuery = (x) => !!x && typeof x === "object" && "symbol" in x && "kind" in x;

/**
 * Sort array in-place by timestamp (ascending by default)
 * @param {DataRecord[]} arr Array to sort
 * @param {FetchOpts} [opt] Options (descending flag)
 */
function sortInPlace(arr, opt) { 
  arr.sort(cmpTs); 
  if (opt?.descending) arr.reverse(); 
}

/**
 * Sort array by timestamp (returns sorted copy)
 * @param {DataRecord[]} arr Array to sort
 * @param {FetchOpts} [opt] Options (descending flag)
 * @returns {DataRecord[]} Sorted array
 */
function sortMaybe(arr, opt) { 
  sortInPlace(arr, opt); 
  return arr; 
}

/**
 * Add asOf timestamp to fetch options for session queries
 * @param {FetchOpts | undefined} opt Original options
 * @param {ISOTime} asOf Session asOf timestamp
 * @returns {FetchOpts} Options with asOf baked into cache key
 */
const withAsOf = (opt, asOf) => {
  if (!asOf) return opt;
  return { ...(opt ?? {}), asOf };
};

const createBatchProcessor = (ctx, selectDrivers) => {
  const processGroup = async (driver, items, opt, out) => {
    const pending = [];
    for (const { key, query } of items) {
      const cacheKey = ctx.cache && (opt?.useCache ?? true) ? keyOf(query, opt, opt?.asOf) : undefined;
      if (cacheKey) {
        const hit = ctx.cache.get(cacheKey);
        if (hit) {
          out[key] = sortMaybe(hit.slice(), opt);
          continue;
        }
      }
      pending.push({ key, query, cacheKey });
    }
    if (pending.length === 0) return;

    if (typeof driver.fetchBatch === "function") {
      let batchResults;
      try {
        batchResults = await driver.fetchBatch(pending.map(p => p.query), opt);
      } catch {
        batchResults = pending.map(() => []);
      }
      pending.forEach((item, idx) => {
        const arr = Array.isArray(batchResults?.[idx]) ? batchResults[idx].slice() : [];
        sortInPlace(arr, opt);
        out[item.key] = arr;
        if (item.cacheKey) ctx.cache.set(item.cacheKey, arr.slice());
      });
      return;
    }

    await Promise.all(pending.map(async ({ key, query, cacheKey }) => {
      const arr = [];
      let n = 0;
      const limit = opt?.limit;
      try {
        for await (const rec of driver.fetch(query, opt)) {
          if (opt?.signal?.aborted) throw new BucketError("ABORTED","fetch aborted");
          arr.push(rec);
          n++; if (limit !== undefined && n >= limit) break;
        }
      } catch (error) {
        throw new BucketError("PROVIDER_FAILED", `Driver fetch failed: ${error.message}`, error);
      }
      sortInPlace(arr, opt);
      out[key] = arr;
      if (cacheKey) ctx.cache.set(cacheKey, arr.slice());
    }));
  };

  return async (queryMap, opt) => {
    const entries = Object.entries(queryMap);
    if (entries.length === 0) return {};
    const out = {};
    const groups = new Map();

    for (const [key, query] of entries) {
      assertQuery(query);
      const picks = selectDrivers(query, "fetch");
      if (picks.length === 0) throw new BucketError("NO_PROVIDER","No driver for fetch");
      const driver = picks[0];
      if (!driver.fetch) throw new BucketError("UNSUPPORTED",`${describeDriver(driver)} missing fetch()`);
      if (!groups.has(driver)) groups.set(driver, []);
      groups.get(driver).push({ key, query });
    }

    await Promise.all([...groups.entries()].map(([driver, items]) => processGroup(driver, items, opt, out)));
    return out;
  };
};

const recordKey = (record) => [
  record.kind,
  record.symbol ?? "*",
  record.interval ?? "*",
  record.type ?? "*",
  record.ts
].join("|");

const mergeRecords = (base, addition) => {
  if (base.length === 0) return addition.slice();
  if (addition.length === 0) return base.slice();
  const merged = [];
  let i = 0;
  let j = 0;
  while (i < base.length && j < addition.length) {
    const left = base[i];
    const right = addition[j];
    const delta = tsOfRecord(left) - tsOfRecord(right);
    if (delta <= 0) {
      merged.push(left);
      if (delta === 0 && recordKey(left) === recordKey(right)) {
        j++;
      }
      i++;
    } else {
      merged.push(right);
      j++;
    }
  }
  while (i < base.length) merged.push(base[i++]);
  while (j < addition.length) merged.push(addition[j++]);
  return merged;
};

const applyLimitAndOrder = (records, opt) => {
  const limit = opt?.limit;
  if (!opt?.descending) {
    if (limit === undefined || records.length <= limit) return records;
    return records.slice(0, limit);
  }
  if (limit === undefined) return records.slice().reverse();
  if (records.length <= limit) return records.slice().reverse();
  const out = new Array(limit);
  for (let i = 0; i < limit; i++) {
    out[i] = records[records.length - 1 - i];
  }
  return out;
};

const nextIso = (iso) => {
  if (!iso) return undefined;
  const next = new Date(Date.parse(iso) + 1);
  return next.toISOString();
};

const normalizeMissingRanges = (ranges, query) => {
  if (ranges === undefined) return [{ from: query.from, to: query.to }];
  return ranges
    .map(r => {
      if (!r) return undefined;
      return { from: r.from ?? undefined, to: r.to ?? undefined };
    })
    .filter(Boolean);
};

const applyRangeToQuery = (query, range) => {
  if (!range) return { ...query };
  const next = { ...query };
  if (range.from !== undefined) next.from = range.from;
  if (range.to !== undefined) next.to = range.to;
  return next;
};

const createStorageLayer = (adapter) => {
  const hasWrite = typeof adapter.write === "function";
  const flushQueue = [];
  let flushing = false;

  const enqueueWrite = (rows, ctx) => {
    if (!hasWrite || !rows?.length) return;
    flushQueue.push({ rows, ctx });
    if (flushing) return;
    flushing = true;
    queueMicrotask(async () => {
      while (flushQueue.length) {
        const batch = flushQueue.shift();
        try {
          await adapter.write(batch.rows, batch.ctx);
        } catch {
          // Best-effort: drop failures to avoid stalling fetch path
        }
      }
      flushing = false;
    });
  };
  const readThrough = async (query, opt, fetcher) => {
    const res = await adapter.fetch(query, opt) ?? { rows: [] };
    const stored = Array.isArray(res.rows) ? res.rows.slice() : [];
    const missing = normalizeMissingRanges(res.missing, query);
    if (missing.length === 0) {
      return applyLimitAndOrder(stored, opt);
    }
    let merged = stored.slice();
    for (const span of missing) {
      const spanQuery = applyRangeToQuery(query, span);
      const pulled = await fetcher(spanQuery, opt);
      if (pulled.length) {
        if (hasWrite) enqueueWrite(pulled.slice(), { query: spanQuery });
        merged = mergeRecords(merged, pulled);
      }
    }
    return applyLimitAndOrder(merged, opt);
  };

  const wrapStream = (iterable, query) => {
    if (typeof adapter.write !== "function") return iterable;
    const batchSize = 256;
    return (async function* () {
      const buffer = [];
      const flush = async () => {
        if (buffer.length === 0) return;
        const chunk = buffer.splice(0);
        const ctxQuery = {
          ...query,
          from: chunk[0]?.ts ?? query.from,
          to: chunk.at(-1)?.ts ?? query.to
        };
        await adapter.write(chunk, { query: ctxQuery });
      };
      for await (const record of iterable) {
        buffer.push(record);
        if (buffer.length >= batchSize) await flush();
        yield record;
      }
      if (buffer.length) await flush();
    })();
  };

  const close = async () => {
    await adapter.close?.();
  };

  return { readThrough, wrapStream, close };
};

// ==================== MEMORY DRIVER ====================

/**
 * Creates an in-memory driver for testing and backtesting
 * Stores data in memory and provides efficient range queries
 * @param {string} id Unique driver identifier
 * @param {DataRecord[]} rows Data records to serve
 * @param {Capability[]} caps Driver capabilities
 * @returns {Driver} Configured memory driver
 */
export { memoryDriver } from "./drivers/memory.mjs";
