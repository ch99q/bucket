export const minute = 60_000;

export function buildSeries(symbol, count, intervalLabel = '1m', spacingMs = minute) {
  const start = Date.now() - count * spacingMs;
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + i * 0.1;
    return {
      kind: 'candle',
      symbol,
      interval: intervalLabel,
      ts: new Date(start + i * spacingMs).toISOString(),
      open: base,
      high: base + 1,
      low: base - 1,
      close: base + 0.5,
      volume: 100 + i,
    };
  });
}

export function buildCandles(symbol, count, start = Date.now() - count * minute) {
  const spacing = minute;
  const rows = buildSeries(symbol, count, '1m', spacing);
  const offset = start - (Date.now() - count * spacing);
  if (offset !== 0) {
    return rows.map((row, idx) => ({
      ...row,
      ts: new Date(start + idx * spacing).toISOString(),
    }));
  }
  return rows;
}

export function generateMultiSymbolData(symbols, countPerSymbol, intervalLabel = '1m', spacingMs = minute) {
  return symbols.flatMap((symbol) => buildSeries(symbol, countPerSymbol, intervalLabel, spacingMs));
}

export function generateSentimentData(symbols, countPerSymbol, spacingMs = 30_000) {
  const start = Date.now() - countPerSymbol * spacingMs;
  return symbols.flatMap((symbol, idx) => Array.from({ length: countPerSymbol }, (_, i) => ({
    kind: 'custom',
    type: 'sentiment',
    symbol,
    ts: new Date(start + i * spacingMs).toISOString(),
    payload: {
      score: Math.sin(i / 10 + idx),
      buzz: 1000 + i,
      source: 'synthetic',
    },
  })));
}

export function getMemoryUsage() {
  const mem = process.memoryUsage();
  return {
    rss: Math.round(mem.rss / 1024 / 1024),
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
  };
}
