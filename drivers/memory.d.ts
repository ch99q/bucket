import type { Capability, DataRecord, Driver } from "../types";

export function memoryDriver(
  id: string,
  rows: DataRecord[],
  caps: Capability[]
): Driver;
export function memoryDriver(opts: {
  id?: string;
  rows: DataRecord[];
  capabilities: Capability[];
}): Driver;
