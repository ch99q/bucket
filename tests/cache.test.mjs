import { describe, it, expect } from 'vitest';
import {
  createBucket,
  defineDriver,
  ttlCache,
} from '../index.mjs';
import { buildCandles } from './helpers.mjs';

describe('ttlCache', () => {
  it('returns undefined for missing keys', () => {
    const cache = ttlCache({ ms: 10_000 });
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('stores and retrieves values', () => {
    const cache = ttlCache({ ms: 10_000 });
    cache.set('key', [1, 2, 3]);
    expect(cache.get('key')).toEqual([1, 2, 3]);
  });

  it('expires entries after TTL', async () => {
    const cache = ttlCache({ ms: 50 }); // 50ms TTL
    cache.set('key', 'value');
    expect(cache.get('key')).toBe('value');

    await new Promise(r => setTimeout(r, 80));
    expect(cache.get('key')).toBeUndefined();
  });

  it('evicts oldest entry when max is reached', () => {
    const cache = ttlCache({ ms: 10_000, max: 3 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4); // should evict 'a'

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('clears all entries', () => {
    const cache = ttlCache({ ms: 10_000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('integrates with bucket — expired cache triggers re-fetch', async () => {
    let fetchCalls = 0;
    const data = buildCandles('AAPL', 3);
    const driver = defineDriver({
      id: 'ttl-test',
      capabilities: [{ kind: 'candle', supports: { fetch: true }, priority: 1 }],
      async *fetch() {
        fetchCalls++;
        for (const r of data) yield r;
      },
    });
    const bucket = createBucket({
      drivers: [driver],
      cache: ttlCache({ ms: 50 }), // 50ms TTL
    });
    const query = { symbol: 'AAPL', kind: 'candle', interval: '1m' };

    await bucket.fetch(query);
    expect(fetchCalls).toBe(1);

    await bucket.fetch(query); // cache hit
    expect(fetchCalls).toBe(1);

    await new Promise(r => setTimeout(r, 80)); // wait for expiry

    await bucket.fetch(query); // cache miss, re-fetch
    expect(fetchCalls).toBe(2);

    await bucket.close();
  });

  it('useCache: false bypasses cache', async () => {
    let fetchCalls = 0;
    const data = buildCandles('AAPL', 3);
    const driver = defineDriver({
      id: 'bypass',
      capabilities: [{ kind: 'candle', supports: { fetch: true }, priority: 1 }],
      async *fetch() {
        fetchCalls++;
        for (const r of data) yield r;
      },
    });
    const bucket = createBucket({
      drivers: [driver],
      cache: ttlCache({ ms: 60_000 }),
    });
    const query = { symbol: 'AAPL', kind: 'candle', interval: '1m' };

    await bucket.fetch(query);
    expect(fetchCalls).toBe(1);

    await bucket.fetch(query, { useCache: false });
    expect(fetchCalls).toBe(2);

    await bucket.close();
  });
});
