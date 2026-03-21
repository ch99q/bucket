import { describe, it, expect } from 'vitest';
import { tradingViewDriver } from '../../drivers/tradingview.mjs';

class FakeSeries {
  constructor(history, updates = []) {
    this.history = history;
    this.updates = updates;
    this.closed = false;
  }
  async close() {
    this.closed = true;
  }
  async *stream() {
    for (const update of this.updates) yield update;
  }
}

const createClient = (seriesList) => {
  const session = { close: async () => {} };
  const chart = {
    close: () => {},
    resolve: async () => ({ id: 'resolved' }),
  };
  return {
    createSession: async () => session,
    createChart: async () => chart,
    createSeries: async (...args) => {
      const series = seriesList.shift();
      if (!series) throw new Error('no series queued');
      series.lastCallArgs = args;
      return series;
    },
  };
};

const sampleTs = (idx) => 1_700_000_000 + idx * 60;

describe('tradingViewDriver', () => {
  it('produces filtered candles from the stubbed history', async () => {
    const history = [
      [sampleTs(0), 100, 110, 90, 105, 1_000],
      [sampleTs(1), 200, 210, 190, 205, 2_000],
      [sampleTs(2), 300, 320, 280, 290, 3_000],
    ];
    const series = new FakeSeries(history);
    const driver = tradingViewDriver({
      defaultExchange: 'NASDAQ',
      client: createClient([series]),
      historyLimit: 10,
    });
    const from = new Date(sampleTs(0) * 1000).toISOString();
    const to = new Date(sampleTs(1) * 1000).toISOString();
    const rows = [];
    for await (const row of driver.fetch({
      symbol: 'NASDAQ:AAPL',
      kind: 'candle',
      interval: '1m',
      from,
      to,
    }, { limit: 1 })) {
      rows.push(row);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]?.open).toBe(100);
    expect(rows[0]?.symbol).toBe('NASDAQ:AAPL');
    expect(series.closed).toBe(true);
    await driver.close();
  });

  it('streams live updates from the stub', async () => {
    const updates = [
      [sampleTs(10), 10, 15, 9, 12, 500],
      [sampleTs(11), 12, 16, 11, 14, 600],
    ];
    const series = new FakeSeries([], updates);
    const driver = tradingViewDriver({
      defaultExchange: 'BINANCE',
      client: createClient([series]),
      liveWarmupBars: 1,
    });
    const iterator = driver.subscribe({
      symbol: 'BINANCE:BTCUSDT',
      kind: 'candle',
      interval: '1m',
    })[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value?.close).toBe(12);
    const second = await iterator.next();
    expect(second.value?.close).toBe(14);
    const done = await iterator.next();
    expect(done.done).toBe(true);
    expect(series.closed).toBe(true);
    await driver.close();
  });

  it(
    'fetches real BTC monthly candles via TradingView',
    { timeout: 60000 },
    async () => {
      const driver = tradingViewDriver({
        id: 'tv-real-btc',
        defaultExchange: 'BINANCE',
        historyLimit: 10,
      });
      const rows = [];
      try {
        const query = {
          symbol: 'BINANCE:BTCUSDT',
          kind: 'candle',
          interval: '1M',
        };
        for await (const row of driver.fetch(query, { limit: 3 })) {
          rows.push(row);
          if (rows.length >= 3) break;
        }
      } finally {
        await driver.close();
      }
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.symbol).toBe('BINANCE:BTCUSDT');
      expect(rows[0]?.kind).toBe('candle');
    },
  );
});
