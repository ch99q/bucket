import type { StorageAdapter } from "../types";

export interface FsAdapterOptions {
  baseDir?: string;
  namespace?: string;
  id?: string;
}

export function fsAdapter(options?: FsAdapterOptions): StorageAdapter;
