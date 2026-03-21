import type { StorageAdapter } from '../types';

export interface SqliteAdapterOptions {
  path?: string;
  id?: string;
  indexHint?: string;
  tune?: boolean;
  mmapSize?: number;
  cachePages?: number;
}

export function sqliteAdapter(options?: SqliteAdapterOptions): StorageAdapter;
