/**
 * Helper for defining storage adapters with future validation hooks.
 * @param {import('../types').StorageAdapter} adapter
 * @returns {import('../types').StorageAdapter}
 */
export function storageAdapter(adapter) {
  if (adapter.close && !adapter[Symbol.asyncDispose]) {
    adapter[Symbol.asyncDispose] = () => adapter.close();
  }
  return adapter;
}
