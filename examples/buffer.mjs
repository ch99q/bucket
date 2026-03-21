#!/usr/bin/env bun
import { Worker } from 'node:worker_threads';
import { createBucket, memoryDriver } from '../index.mjs';

const RECORD_SIZE = Float64Array.BYTES_PER_ELEMENT;
const HEADER_SIZE = 8;

function createRing(capacity) {
  const buffer = new SharedArrayBuffer(HEADER_SIZE + capacity * RECORD_SIZE);
  const cursor = new Int32Array(buffer, 0, 2);
  const data = new Float64Array(buffer, HEADER_SIZE);
  return {
    buffer,
    capacity,
    write(value) {
      const idx = Atomics.add(cursor, 0, 1);
      data[idx % capacity] = value;
    },
    read(callback) {
      let local = Atomics.load(cursor, 0);
      return () => {
        const total = Atomics.load(cursor, 0);
        while (local < total) {
          callback(data[local % capacity]);
          local++;
        }
      };
    },
  };
}

const bucket = createBucket({
  drivers: [
    memoryDriver(
      'demo',
      Array.from({ length: 10_000 }, (_, i) => ({
        kind: 'candle',
        symbol: 'BTC',
        interval: '1m',
        ts: new Date(Date.now() - (10_000 - i) * 60_000).toISOString(),
        open: 100 + i,
        high: 100 + i + 1,
        low: 100 + i - 1,
        close: 100 + i + 0.5,
      })),
      [{ kind: 'candle', supports: { fetch: true }, priority: 1 }],
    ),
  ],
});

const streams = new Map();

async function ensureStream(key, query) {
  if (streams.has(key)) return streams.get(key);
  const ring = createRing(2048);
  const readers = new Set();
  const loop = (async () => {
    for await (const candle of bucket.stream(query)) {
      ring.write(candle.close);
      readers.forEach((fn) => fn());
    }
  })();
  const entry = { ring, readers, loop };
  streams.set(key, entry);
  return entry;
}

async function spawnWorker(label, query) {
  const key = `${query.symbol}:${query.interval}`;
  const entry = await ensureStream(key, query);
  const worker = new Worker(new URL('./buffer-worker.mjs', import.meta.url), {
    type: 'module',
    workerData: { label, capacity: entry.ring.capacity },
  });
  const poke = () => worker.postMessage({ type: 'poke' });
  entry.readers.add(poke);
  worker.postMessage({ type: 'attach', buffer: entry.ring.buffer });
  worker.once('exit', () => {
    entry.readers.delete(poke);
    if (entry.readers.size === 0) {
      streams.delete(key);
      entry.loop.return?.();
    }
  });
}

const workers = await Promise.all([
  spawnWorker('worker-A', { symbol: 'BTC', kind: 'candle', interval: '1m' }),
  spawnWorker('worker-B', { symbol: 'BTC', kind: 'candle', interval: '1m' }),
]);

setTimeout(() => {
  workers.forEach((w) => w.terminate());
  bucket.close();
}, 2000);
