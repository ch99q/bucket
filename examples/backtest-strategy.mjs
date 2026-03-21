#!/usr/bin/env bun
/**
 * Multi-symbol mean-reversion backtest with performance analytics.
 *
 * Strategy: when a symbol's close drops below its 20-bar SMA by more than
 * 1 standard deviation, go long. Exit when price reverts to the SMA.
 * Runs across AAPL, MSFT, and TSLA simultaneously with no look-ahead.
 */
import { createBucket, memoryDriver } from '../index.mjs';

// ── data generation ─────────────────────────────────────────────────────────

const SYMBOLS = ['AAPL', 'MSFT', 'TSLA'];
const BARS = 2_000;
const INTERVAL_MS = 60_000;

function generateData(symbols, bars) {
  const start = Date.now() - bars * INTERVAL_MS;
  const records = [];
  for (const symbol of symbols) {
    let price = symbol === 'TSLA' ? 240 : symbol === 'AAPL' ? 180 : 400;
    for (let i = 0; i < bars; i++) {
      const drift = (Math.random() - 0.498) * 2;
      price = Math.max(10, price + drift);
      const open = price;
      const high = open + Math.random() * 1.5;
      const low = open - Math.random() * 1.5;
      const close = low + Math.random() * (high - low);
      records.push({
        kind: 'candle', symbol, interval: '1m',
        ts: new Date(start + i * INTERVAL_MS).toISOString(),
        open, high, low, close,
        volume: Math.floor(Math.random() * 10_000) + 1_000,
      });
    }
  }
  return records;
}

// ── strategy ────────────────────────────────────────────────────────────────

const SMA_PERIOD = 20;
const ENTRY_THRESHOLD = -1; // enter when price < SMA - 1 * stddev
const INITIAL_CAPITAL = 100_000;
const POSITION_SIZE = 0.3; // risk 30% of capital per trade

function sma(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddev(values, mean) {
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

// ── backtest engine ─────────────────────────────────────────────────────────

async function main() {
  const data = generateData(SYMBOLS, BARS);
  const driver = memoryDriver('backtest', data, [
    { kind: 'candle', supports: { fetch: true }, priority: 1 },
  ]);
  await using bucket = createBucket({ drivers: [driver] });

  const startTs = data.find(r => r.symbol === SYMBOLS[0]).ts;
  const startMs = Date.parse(startTs) + SMA_PERIOD * INTERVAL_MS;
  const endMs = Date.parse(data.at(-1).ts);

  const session = bucket.session({ asOf: new Date(startMs).toISOString(), strict: true });

  // state
  const positions = {}; // symbol -> { entry, shares, bar }
  const trades = [];
  let capital = INITIAL_CAPITAL;
  let peak = capital;
  let maxDrawdown = 0;
  const equityCurve = [];

  // step through each bar
  for (let t = startMs; t <= endMs; t += INTERVAL_MS) {
    await session.advance(new Date(t).toISOString());

    const result = await session.fetch(
      Object.fromEntries(SYMBOLS.map(s => [s, { symbol: s, kind: 'candle', interval: '1m' }]))
    );

    let unrealised = 0;

    for (const symbol of SYMBOLS) {
      const candles = result[symbol];
      if (!candles || candles.length < SMA_PERIOD) continue;

      const recent = candles.slice(-SMA_PERIOD);
      const closes = recent.map(c => c.close);
      const mean = sma(closes);
      const sd = stddev(closes, mean);
      const last = candles.at(-1);

      // check exit
      if (positions[symbol]) {
        const pos = positions[symbol];
        unrealised += (last.close - pos.entry) * pos.shares;

        if (last.close >= mean) {
          const pnl = (last.close - pos.entry) * pos.shares;
          capital += pos.entry * pos.shares + pnl; // return capital + profit
          trades.push({
            symbol,
            entry: pos.entry,
            exit: last.close,
            shares: pos.shares,
            pnl,
            bars: Math.round((t - pos.entryMs) / INTERVAL_MS),
          });
          delete positions[symbol];
        }
        continue;
      }

      // check entry — price below SMA by more than 1 stddev
      if (sd > 0 && last.close < mean + ENTRY_THRESHOLD * sd) {
        const alloc = capital * POSITION_SIZE;
        if (alloc < 100) continue; // skip if not enough capital
        const shares = Math.floor(alloc / last.close);
        if (shares <= 0) continue;
        capital -= shares * last.close;
        positions[symbol] = { entry: last.close, shares, entryMs: t };
      }
    }

    // track equity
    const equity = capital + unrealised +
      Object.values(positions).reduce((s, p) => s + p.entry * p.shares, 0);
    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // close any remaining positions at last price
  for (const symbol of Object.keys(positions)) {
    const last = data.filter(r => r.symbol === symbol).at(-1);
    const pos = positions[symbol];
    const pnl = (last.close - pos.entry) * pos.shares;
    capital += pos.entry * pos.shares + pnl;
    trades.push({
      symbol, entry: pos.entry, exit: last.close,
      shares: pos.shares, pnl,
      bars: Math.round((endMs - pos.entryMs) / INTERVAL_MS),
    });
    delete positions[symbol];
  }

  // ── analytics ───────────────────────────────────────────────────────────

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const avgBars = trades.length ? trades.reduce((s, t) => s + t.bars, 0) / trades.length : 0;
  const finalEquity = equityCurve.at(-1) ?? INITIAL_CAPITAL;

  console.log('═══════════════════════════════════════');
  console.log(' Mean-Reversion Backtest Results');
  console.log('═══════════════════════════════════════');
  console.log(`  Symbols:        ${SYMBOLS.join(', ')}`);
  console.log(`  Bars:           ${BARS} x 1m`);
  console.log(`  SMA Period:     ${SMA_PERIOD}`);
  console.log('───────────────────────────────────────');
  console.log(`  Total Trades:   ${trades.length}`);
  console.log(`  Win Rate:       ${trades.length ? (wins.length / trades.length * 100).toFixed(1) : 0}%`);
  console.log(`  Avg Win:        $${avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:       $${avgLoss.toFixed(2)}`);
  console.log(`  Profit Factor:  ${losses.length && avgLoss ? (Math.abs(avgWin * wins.length) / Math.abs(avgLoss * losses.length)).toFixed(2) : '∞'}`);
  console.log(`  Avg Hold:       ${avgBars.toFixed(0)} bars`);
  console.log('───────────────────────────────────────');
  console.log(`  Initial:        $${INITIAL_CAPITAL.toLocaleString()}`);
  console.log(`  Final:          $${finalEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  console.log(`  Return:         ${((finalEquity / INITIAL_CAPITAL - 1) * 100).toFixed(2)}%`);
  console.log(`  Max Drawdown:   ${(maxDrawdown * 100).toFixed(2)}%`);
  console.log('═══════════════════════════════════════');

  // show last few trades
  console.log('\nLast 5 trades:');
  for (const t of trades.slice(-5)) {
    const dir = t.pnl > 0 ? '+' : '';
    console.log(`  ${t.symbol.padEnd(5)} ${t.shares} shares @ ${t.entry.toFixed(2)} → ${t.exit.toFixed(2)}  ${dir}$${t.pnl.toFixed(2)} (${t.bars} bars)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
