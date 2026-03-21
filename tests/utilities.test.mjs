import { describe, it, expect } from 'vitest';
import { mergeOrdered } from '../index.mjs';

describe('utilities', () => {
  it('mergeOrdered yields globally sorted data', async () => {
    async function* source(records) {
      for (const row of records) yield row;
    }
    const a = source([
      { ts: '2024-01-01T00:00:00.000Z' },
      { ts: '2024-01-01T00:01:00.000Z' },
    ]);
    const b = source([
      { ts: '2024-01-01T00:00:30.000Z' },
      { ts: '2024-01-01T00:01:30.000Z' },
    ]);
    const merged = [];
    for await (const row of mergeOrdered([a, b])) merged.push(row.ts);
    expect(merged).toEqual([
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:00:30.000Z',
      '2024-01-01T00:01:00.000Z',
      '2024-01-01T00:01:30.000Z',
    ]);
  });
});
