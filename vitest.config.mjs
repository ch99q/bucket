import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    coverage: {
      enabled: false,
    },
  },
  benchmark: {
    include: ['benchs/**/*.bench.mjs'],
  },
});
