import { describe, it, expect } from 'vitest';
import {
  BucketError,
  createBucket,
  memoryDriver,
} from '../index.mjs';
import { minute, buildCandles } from './helpers.mjs';

describe('session', () => {
  const setup = (count = 20) => {
    const start = Date.now() - count * minute;
    const data = buildCandles('AAPL', count, start);
    const driver = memoryDriver('session', data, [
      { kind: 'candle', supports: { fetch: true }, priority: 1 },
    ]);
    const bucket = createBucket({ drivers: [driver] });
    return { data, bucket, start };
  };

  describe('advance()', () => {
    it('advances asOf forward', async () => {
      const { data, bucket } = setup();
      const session = bucket.session({ asOf: data[5].ts });

      expect(session.asOf()).toBe(data[5].ts);

      await session.advance(data[10].ts);
      expect(session.asOf()).toBe(data[10].ts);

      await bucket.close();
    });

    it('rejects backward advance', async () => {
      const { data, bucket } = setup();
      const session = bucket.session({ asOf: data[10].ts });

      await expect(
        session.advance(data[5].ts),
      ).rejects.toThrow(/forward/i);

      expect(session.asOf()).toBe(data[10].ts);

      await bucket.close();
    });

    it('allows advance to same time (no-op)', async () => {
      const { data, bucket } = setup();
      const session = bucket.session({ asOf: data[10].ts });

      await session.advance(data[10].ts);
      expect(session.asOf()).toBe(data[10].ts);

      await bucket.close();
    });

    it('fetches more data after advancing', async () => {
      const { data, bucket } = setup();
      const session = bucket.session({ asOf: data[5].ts, strict: true });

      const first = await session.fetch({
        symbol: 'AAPL', kind: 'candle', interval: '1m',
        from: data[0].ts,
      });
      expect(first.at(-1)?.ts).toBe(data[5].ts);

      await session.advance(data[15].ts);

      const second = await session.fetch({
        symbol: 'AAPL', kind: 'candle', interval: '1m',
        from: data[0].ts,
      });
      expect(second.at(-1)?.ts).toBe(data[15].ts);
      expect(second.length).toBeGreaterThan(first.length);

      await bucket.close();
    });
  });

  describe('strict mode', () => {
    it('defaults to strict=true', async () => {
      const { data, bucket } = setup();
      const session = bucket.session({ asOf: data[5].ts });

      expect(session.strict).toBe(true);

      await bucket.close();
    });

    it('clamps to to asOf in strict mode', async () => {
      const { data, bucket } = setup();
      const session = bucket.session({ asOf: data[10].ts, strict: true });

      const result = await session.fetch({
        symbol: 'AAPL', kind: 'candle', interval: '1m',
        from: data[0].ts,
        to: data[19].ts, // beyond asOf
      });

      for (const r of result) {
        expect(Date.parse(r.ts)).toBeLessThanOrEqual(Date.parse(data[10].ts));
      }

      await bucket.close();
    });

    it('throws when from > asOf in strict mode', async () => {
      const { data, bucket } = setup();
      const session = bucket.session({ asOf: data[5].ts, strict: true });

      await expect(
        session.fetch({
          symbol: 'AAPL', kind: 'candle', interval: '1m',
          from: data[10].ts,
        }),
      ).rejects.toThrow(/session\.asOf/i);

      await bucket.close();
    });
  });

  describe('non-strict mode', () => {
    it('does not clamp to when strict=false', async () => {
      const { data, bucket } = setup();
      const session = bucket.session({ asOf: data[5].ts, strict: false });

      expect(session.strict).toBe(false);

      const result = await session.fetch({
        symbol: 'AAPL', kind: 'candle', interval: '1m',
        from: data[0].ts,
        to: data[19].ts,
      });

      // Non-strict should return all data up to the explicit 'to'
      expect(result.length).toBe(20);

      await bucket.close();
    });

    it('allows from > asOf when strict=false', async () => {
      const { data, bucket } = setup();
      const session = bucket.session({ asOf: data[5].ts, strict: false });

      const result = await session.fetch({
        symbol: 'AAPL', kind: 'candle', interval: '1m',
        from: data[10].ts,
        to: data[15].ts,
      });

      expect(result.length).toBe(6);

      await bucket.close();
    });
  });

  describe('session streaming', () => {
    it('clamps single stream to asOf', async () => {
      const { data, bucket } = setup();
      const session = bucket.session({ asOf: data[10].ts, strict: true });

      const results = [];
      for await (const r of session.stream({
        symbol: 'AAPL', kind: 'candle', interval: '1m',
        from: data[0].ts,
      })) {
        results.push(r);
      }

      for (const r of results) {
        expect(Date.parse(r.ts)).toBeLessThanOrEqual(Date.parse(data[10].ts));
      }

      await bucket.close();
    });
  });
});
