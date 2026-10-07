import { compute } from './compute.js';

self.onmessage = (e) => {
  const msg = e.data;
  try {
    const { out, transfer } = compute(msg);
    self.postMessage(out, transfer);
  } catch (err) {
    self.postMessage({ type: msg.type, id: msg.id, error: String(err && err.stack || err) });
  }
};
