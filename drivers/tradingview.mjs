import { createChart, createSeries, createSession } from "@ch99q/twc";
import { BucketError } from "../errors.mjs";
import { defineDriver } from "../driver-utils.mjs";

/**
 * @typedef {import('../types.d.ts').Query} Query
 * @typedef {import('../types.d.ts').FetchOpts} FetchOpts
 * @typedef {import('../types.d.ts').LiveOpts} LiveOpts
 * @typedef {import('../types.d.ts').Capability} Capability
 * @typedef {import('../types.d.ts').Driver} Driver
 * @typedef {import('../types.d.ts').DataRecord} DataRecord
 */

const toMs = (value) => (value ? Date.parse(value) : undefined);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const defaultSymbolMapper = (defaultExchange) => (query) => {
  if (!query.symbol) return null;
  const parts = query.symbol.split(":");
  if (parts.length >= 2) {
    const [exchange, ...rest] = parts;
    return { exchange: exchange || defaultExchange, symbol: rest.join(":") };
  }
  if (!defaultExchange) return null;
  return { exchange: defaultExchange, symbol: query.symbol };
};

const defaultIntervalMapper = (interval) => {
  if (!interval) return null;
  const normalized = interval.trim();
  const directNumeric = normalized.match(/^\d+$/);
  if (directNumeric) {
    const minutes = Number(directNumeric[0]);
    return { timeframe: normalized, durationMs: minutes * 60_000 };
  }
  const m = normalized.match(/^(\d+)\s*([smhdw]|mo)$/i);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2].toLowerCase();
  switch (unit) {
    case "s":
      return { timeframe: `${value}S`, durationMs: value * 1_000 };
    case "m":
      return { timeframe: `${value}`, durationMs: value * 60_000 };
    case "h":
      return { timeframe: `${value * 60}`, durationMs: value * 3_600_000 };
    case "d":
      return { timeframe: `${value}D`, durationMs: value * 86_400_000 };
    case "w":
      return { timeframe: `${value}W`, durationMs: value * 604_800_000 };
    case "mo":
      return { timeframe: `${value}M`, durationMs: value * 30 * 86_400_000 };
    default:
      return null;
  }
};

const inferDurationFromTimeframe = (timeframe) => {
  if (!timeframe) return undefined;
  if (/^\d+$/.test(timeframe)) return Number(timeframe) * 60_000;
  const m = timeframe.match(/^(\d+)([SDWM])$/);
  if (!m) return undefined;
  const value = Number(m[1]);
  const unit = m[2];
  switch (unit) {
    case "S": return value * 1_000;
    case "D": return value * 86_400_000;
    case "W": return value * 604_800_000;
    case "M": return value * 30 * 86_400_000;
    default: return undefined;
  }
};

const toRecord = (query, payload) => {
  if (!Array.isArray(payload) || payload.length < 5) return null;
  const [ts, open, high, low, close, volume] = payload;
  if (typeof ts !== "number") return null;
  const toNumber = (value) => {
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? num : undefined;
  };
  const openNum = toNumber(open);
  const highNum = toNumber(high);
  const lowNum = toNumber(low);
  const closeNum = toNumber(close);
  if ([openNum, highNum, lowNum, closeNum].some((v) => typeof v !== "number")) return null;
  const volumeNum = toNumber(volume);
  return {
    kind: "candle",
    symbol: query.symbol,
    interval: query.interval,
    ts: new Date(ts * 1000).toISOString(),
    open: openNum,
    high: highNum,
    low: lowNum,
    close: closeNum,
    volume: typeof volumeNum === "number" ? volumeNum : undefined,
    meta: { provider: "tradingview" },
  };
};

const wrapError = (err, message) => {
  if (err instanceof BucketError) return err;
  if (err?.name === "AbortError" || err?.code === "ABORT_ERR") return new BucketError("ABORTED", message ?? "tradingview aborted", err);
  return new BucketError("PROVIDER_FAILED", message ?? err?.message ?? "tradingview error", err);
};

const buildRange = (query, durationMs, bars, now) => {
  const from = toMs(query.from);
  const to = toMs(query.to);
  if (from === undefined && to === undefined) return undefined;
  const fallbackDuration = durationMs ?? 60_000;
  const span = bars * fallbackDuration;
  const rangeEnd = to ?? now;
  const rangeStart = from ?? Math.max(rangeEnd - span, 0);
  return [Math.floor(rangeStart / 1000), Math.floor((to ?? rangeEnd) / 1000)];
};

const computeBars = (query, limit, durationMs, now, maxBars, defaultLimit) => {
  const baseLimit = limit ?? defaultLimit;
  const from = toMs(query.from);
  const to = toMs(query.to) ?? now;
  if (from !== undefined && durationMs) {
    const needed = Math.ceil(Math.max(1, (to - from) / durationMs)) + 2;
    return clamp(Math.max(baseLimit, needed), 1, maxBars);
  }
  return clamp(baseLimit, 1, maxBars);
};

const assertCandleQuery = (query) => {
  if (query.kind !== "candle") throw new BucketError("UNSUPPORTED", "tradingview driver only supports candle queries");
  if (!query.interval) throw new BucketError("BAD_REQUEST", "candle interval required");
};

/**
 * Create a TradingView-backed driver using the @ch99q/twc client.
 * @param {object} [options]
 * @param {string} [options.id]
 * @param {Capability[]} [options.capabilities]
 * @param {string} [options.token]
 * @param {boolean} [options.verbose=false]
 * @param {string} [options.defaultExchange]
 * @param {number} [options.historyLimit=500]
 * @param {number} [options.maxHistoryBars=5000]
 * @param {number} [options.liveWarmupBars=5]
 * @param {{ createSession?: typeof createSession; createChart?: typeof createChart; createSeries?: typeof createSeries }} [options.client]
 * @returns {Driver}
 */
export function tradingViewDriver(options = {}) {
  const {
    id = "tradingview",
    capabilities = [{
      kind: "candle",
      supports: { fetch: true, live: true },
      priority: 5,
    }],
    token,
    verbose = false,
    defaultExchange,
    historyLimit = 500,
    maxHistoryBars = 5000,
    liveWarmupBars = 5,
    client = {},
  } = options;
  const mapSymbol = defaultSymbolMapper(defaultExchange);
  const mapInterval = defaultIntervalMapper;

  const createSessionFn = client.createSession ?? createSession;
  const createChartFn = client.createChart ?? createChart;
  const createSeriesFn = client.createSeries ?? createSeries;

  let sessionPromise;
  let chartPromise;
  const activeSeries = new Set();
  const symbolCache = new Map();

  const ensureSession = () => {
    if (!sessionPromise) {
      sessionPromise = createSessionFn(token, verbose).catch((err) => {
        sessionPromise = undefined;
        throw err;
      });
    }
    return sessionPromise;
  };

  const ensureChart = async () => {
    if (!chartPromise) {
      const session = await ensureSession();
      chartPromise = createChartFn(session).catch((err) => {
        chartPromise = undefined;
        throw err;
      });
    }
    return chartPromise;
  };

  const resolveSymbol = async (query) => {
    const mapped = mapSymbol(query);
    if (!mapped?.symbol || !mapped?.exchange) {
      throw new BucketError("BAD_REQUEST", `tradingview: unable to resolve exchange for symbol "${query.symbol}"`);
    }
    const key = `${mapped.exchange}:${mapped.symbol}`;
    if (symbolCache.has(key)) return symbolCache.get(key);
    const chart = await ensureChart();
    try {
      const resolved = await chart.resolve(mapped.symbol, mapped.exchange);
      symbolCache.set(key, resolved);
      return resolved;
    } catch (err) {
      throw wrapError(err, `tradingview: failed to resolve symbol "${key}"`);
    }
  };

  const attachSeries = (series) => {
    activeSeries.add(series);
    return async () => {
      if (activeSeries.delete(series)) {
        try { await series.close(); } catch { /* noop */ }
      }
    };
  };

  const prepareSeries = async (query, desiredBars, providedRange) => {
    const intervalInfo = mapInterval(query.interval);
    if (!intervalInfo) throw new BucketError("BAD_REQUEST", `tradingview: unsupported interval "${query.interval}"`);
    const durationMs = intervalInfo.durationMs ?? inferDurationFromTimeframe(intervalInfo.timeframe);
    const bars = clamp(desiredBars, 1, maxHistoryBars);
    const now = Date.now();
    const range = providedRange ?? buildRange(query, durationMs ?? 60_000, bars, now);
    const session = await ensureSession();
    const chart = await ensureChart();
    const resolved = await resolveSymbol(query);
    try {
      const series = await createSeriesFn(session, chart, resolved, intervalInfo.timeframe, bars, range);
      const cleanup = attachSeries(series);
      return { series, cleanup };
    } catch (err) {
      throw wrapError(err, "tradingview: failed to create series");
    }
  };

  const fetch = async function* (query, opt) {
    assertCandleQuery(query);
    const now = Date.now();
    const intervalInfo = mapInterval(query.interval);
    if (!intervalInfo) throw new BucketError("BAD_REQUEST", `tradingview: unsupported interval "${query.interval}"`);
    const desiredBars = computeBars(query, opt?.limit, intervalInfo.durationMs ?? inferDurationFromTimeframe(intervalInfo.timeframe), now, maxHistoryBars, historyLimit);
    const { series, cleanup } = await prepareSeries(query, desiredBars);
    try {
      let yielded = 0;
      const from = toMs(query.from);
      const to = toMs(query.to);
      for (const payload of series.history ?? []) {
        if (opt?.signal?.aborted) throw new BucketError("ABORTED", "tradingview fetch aborted");
        const record = toRecord(query, payload);
        if (!record) continue;
        const ts = Date.parse(record.ts);
        if (from !== undefined && ts < from) continue;
        if (to !== undefined && ts > to) continue;
        yield record;
        yielded++;
        if (opt?.limit !== undefined && yielded >= opt.limit) break;
      }
    } catch (err) {
      throw wrapError(err, "tradingview: fetch failed");
    } finally {
      await cleanup();
    }
  };

  const subscribe = async function* (query, opt) {
    assertCandleQuery(query);
    const { series, cleanup } = await prepareSeries(query, Math.max(liveWarmupBars, 1));
    const signal = opt?.signal;
    const onAbort = () => cleanup();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const payload of series.stream()) {
        if (signal?.aborted) throw new BucketError("ABORTED", "tradingview live aborted");
        const record = toRecord(query, payload);
        if (record) yield record;
      }
    } catch (err) {
      throw wrapError(err, "tradingview: subscribe failed");
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await cleanup();
    }
  };

  const close = async () => {
    await Promise.allSettled([...activeSeries].map((series) => series.close().catch(() => {})));
    activeSeries.clear();
    if (chartPromise) {
      try { (await chartPromise).close?.(); } catch { /* noop */ }
      chartPromise = undefined;
    }
    if (sessionPromise) {
      try { await (await sessionPromise).close?.(); } catch { /* noop */ }
      sessionPromise = undefined;
    }
  };

  return defineDriver({
    id,
    capabilities,
    fetch,
    subscribe,
    close,
  });
}
