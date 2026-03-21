import type { StorageAdapter } from '../types';

export interface MemoryAdapterOptions {
  id?: string;
}

export function memoryAdapter(options?: MemoryAdapterOptions): StorageAdapter;
