import { describe, it, expect } from 'vitest';
import { filter, map, pipe, resample, take } from '../index.mjs';
import { minute } from './helpers.mjs';

describe('operators', () => {
  it('resamples candles to larger intervals', async () => {
    const src = (async function* () {
      for (let i = 0; i < 4; i++) {
        yield {
          kind: 'candle',
          symbol: 'ETH',
          interval: '1m',
          ts: new Date(i * minute).toISOString(),
          open: 100 + i,
          high: 105 + i,
          low: 95 + i,
          close: 102 + i,
          volume: 10 + i,
        };
      }
    })();

    const output = [];
    for await (const candle of resample('2m')(src)) output.push(candle);

    expect(output).toHaveLength(1);
    expect(output[0].volume).toBe(10 + 11);
  });

  it('drops partial trailing windows to avoid look-ahead bias', async () => {
    const src = (async function* () {
      for (let i = 0; i < 3; i++) {
        yield {
          kind: 'candle',
          symbol: 'ETH',
          interval: '1m',
          ts: new Date(i * minute).toISOString(),
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 1,
        };
      }
    })();

    const output = [];
    for await (const candle of resample('2m')(src)) output.push(candle);

    expect(output).toHaveLength(1); // only first 2 minutes emitted
    expect(output[0].ts).toBe(new Date(0).toISOString());
  });

  it('pipe + filter + map + take transform async streams', async () => {
    const src = (async function* () {
      for (let i = 0; i < 5; i++) {
        yield { kind: 'tick', ts: new Date(i).toISOString(), price: i };
      }
    })();

    const collected = [];
    for await (const tick of pipe(
      src,
      filter((x) => x.price % 2 === 0),
      take(2),
      map((x) => ({ ...x, doubled: x.price * 2 })),
    )) {
      collected.push(tick.doubled);
    }

    expect(collected).toEqual([0, 4]);
  });
});
