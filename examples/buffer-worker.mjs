import { parentPort, workerData } from 'node:worker_threads';

const { label, capacity } = workerData;
let cursor;
let data;
let local = 0;
let logCount = 0;

function poll() {
  if (!cursor) return;
  const total = Atomics.load(cursor, 0);
  while (local < total) {
    const value = data[local % capacity];
    if (logCount < 20) {
      console.log(`[${label}] close=${value.toFixed(2)}`);
      logCount++;
      if (logCount === 20) console.log(`[${label}] ...`);
    }
    local++;
  }
}

parentPort.on('message', (msg) => {
  if (msg.type === 'attach') {
    cursor = new Int32Array(msg.buffer, 0, 2);
    data = new Float64Array(msg.buffer, 8);
    poll();
  } else if (msg.type === 'poke') {
    poll();
  }
});
