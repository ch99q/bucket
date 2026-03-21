export type ISOTime = string;

// ---------- Data ----------
export type Candle = {
  kind: "candle";
  symbol: string;
  ts: ISOTime;
  interval?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  meta?: Record<string, unknown>
};

export type Tick = {
  kind: "tick";
  symbol: string;
  ts: ISOTime;
  price: number;
  size?: number;
  meta?: Record<string, unknown>
};

export type Custom<T = unknown> = {
  kind: "custom";
  symbol: string;
  ts: ISOTime;
  type: string;
  payload: T;
  meta?: Record<string, unknown>
};

export type DataRecord = Candle | Tick | Custom;

export type Query = {
  symbol: string;                        // e.g. "BINANCE:BTCUSDT" or "NASDAQ:NVDA"
  kind: DataRecord["kind"];
  interval?: string;                     // when kind=candle (e.g. "1m","5m","1h")
  type?: string;                         // when kind=custom
  from?: ISOTime; 
  to?: ISOTime;
};

export type FetchOpts = { 
  limit?: number; 
  descending?: boolean; 
  signal?: AbortSignal; 
  useCache?: boolean 
};

export type LiveOpts = { 
  signal?: AbortSignal; 
  merge?: boolean 
};

export type MuxMsg = { 
  sourceId: string; 
  query: Query; 
  record: DataRecord 
};

// ---------- Errors ----------
export class BucketError extends Error {
  code: "NO_PROVIDER" | "UNSUPPORTED" | "BAD_REQUEST" | "PROVIDER_FAILED" | "ABORTED";
  cause?: unknown;
}

// ---------- Drivers ----------
export type Capability = {
  kind: Query["kind"];
  supports: { fetch?: boolean; live?: boolean };
  priority?: number;
  symbols?: RegExp[]; 
  intervals?: RegExp[]; 
  types?: RegExp[];
};

export type Driver = {
  id: string;
  capabilities: Capability[];
  fetch?: (q: Query, opt?: FetchOpts) => AsyncIterable<DataRecord>;
  subscribe?: (q: Query, opt?: LiveOpts) => AsyncIterable<DataRecord>;
  close?: () => Promise<void> | void;
};

export function defineDriver<T extends Driver>(driver: T): T;

export function memoryDriver(
  id: string,
  rows: DataRecord[],
  caps: Capability[]
): Driver;
export function memoryDriver(opts: {
  id?: string;
  rows: DataRecord[];
  capabilities: Capability[];
}): Driver;

// ---------- Cache ----------
export type Cache<V> = { 
  get: (k: string) => V | undefined; 
  set: (k: string, v: V) => void; 
  clear?: () => void 
};

export type StorageRange = { from?: ISOTime; to?: ISOTime };

export type StorageFetchResult = { 
  rows: DataRecord[]; 
  missing?: StorageRange[]; 
};

export type StorageWriteContext = { query: Query };

export type StorageAdapter = {
  id: string;
  fetch: (q: Query, opt?: FetchOpts) => Promise<StorageFetchResult>;
  write?: (rows: DataRecord[], ctx: StorageWriteContext) => Promise<void> | void;
  close?: () => Promise<void> | void;
};

// ---------- Operators ----------
export type Operator<T, U = T> = (src: AsyncIterable<T>) => AsyncIterable<U>;

// ---------- Context ----------
export type SelectContext = { 
  drivers: readonly Driver[]; 
  query: Query; 
  need: "fetch" | "live" 
};

export type BucketContext = Readonly<{
  drivers: readonly Driver[];
  storage?: StorageAdapter;
  cache?: Cache<DataRecord[]>;
  select: (ctx: SelectContext) => readonly Driver[];
}>;

// ---------- Session ----------
export interface Session {
  asOf(): ISOTime;
  strict: boolean;
  fetch(q: Query, opt?: FetchOpts): Promise<DataRecord[]>;
  fetch(qs: Record<string, Query>, opt?: FetchOpts): Promise<Record<string, DataRecord[]>>;
  stream(q: Query, opt?: FetchOpts): AsyncIterable<DataRecord>;
  stream(qs: Record<string, Query>, opt: FetchOpts & { merge: true }): AsyncIterable<MuxMsg>;
  stream(qs: Record<string, Query>, opt?: FetchOpts & { merge?: false }): Record<string, AsyncIterable<DataRecord>>;
  advance(nextAsOf: ISOTime): Promise<void>;
}

// ---------- Bucket ----------
export interface Bucket {
  fetch(q: Query, opt?: FetchOpts): Promise<DataRecord[]>;
  fetch(qs: Record<string, Query>, opt?: FetchOpts): Promise<Record<string, DataRecord[]>>;
  stream(q: Query, opt?: FetchOpts | LiveOpts): AsyncIterable<DataRecord>;
  stream(qs: Record<string, Query>, opt: (FetchOpts | LiveOpts) & { merge: true }): AsyncIterable<MuxMsg>;
  stream(qs: Record<string, Query>, opt?: (FetchOpts | LiveOpts) & { merge?: false }): Record<string, AsyncIterable<DataRecord>>;
  session(init: { asOf: ISOTime; strict?: boolean }): Session;
  close(): Promise<void>;
}

export interface TradingViewDriverOptions {
  id?: string;
  capabilities?: Capability[];
  token?: string;
  verbose?: boolean;
  defaultExchange?: string;
  historyLimit?: number;
  maxHistoryBars?: number;
  liveWarmupBars?: number;
  client?: {
    createSession?: typeof import("@ch99q/twc").createSession;
    createChart?: typeof import("@ch99q/twc").createChart;
    createSeries?: typeof import("@ch99q/twc").createSeries;
  };
}
