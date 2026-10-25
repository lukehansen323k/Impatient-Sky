// Impatient Sky — worker pool. Splits the catalog across workers so a night's
// pass search runs on several cores, plus one more worker for the live sky.

const WORKER_URL = new URL('./worker.js', import.meta.url);

class Port {
  constructor() {
    this.w = new Worker(WORKER_URL, { type: 'module' });
    this.seq = 0;
    this.pending = new Map();
    this.w.onmessage = (e) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m);
    };
    this.w.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'worker error'));
      this.pending.clear();
    };
  }
  call(msg, transfer) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.w.postMessage({ ...msg, id }, transfer || []);
    });
  }
}

export class Engine {
  constructor() {
    const hc = navigator.hardwareConcurrency || 4;
    this.size = Math.max(2, Math.min(4, hc - 1));
    this.ports = Array.from({ length: this.size }, () => new Port());
    this.live = null;
    this.catalog = null;
    this.version = null;
    this.queue = Promise.resolve();
  }

  async load(catalog) {
    this.catalog = catalog;
    this.version = catalog.v;
    // Round-robin over a magnitude-sorted list spreads the expensive bright objects evenly.
    const chunks = this.ports.map(() => []);
    catalog.sats.forEach((s, i) => chunks[i % chunks.length].push(s));
    await Promise.all(this.ports.map((p, i) =>
      p.call({ type: 'catalog', catalog: { v: catalog.v, fields: catalog.fields, sats: chunks[i] } })));
    if (this.live) await this.live.call({ type: 'catalog', catalog });
  }

  // Serialised so successive requests (several nights) don't fight for cores.
  night(params) {
    const run = async () => {
      const t = performance.now();
      const res = await Promise.all(this.ports.map((p) => p.call({ type: 'night', ...params })));
      const passes = res.flatMap((r) => r.passes).sort((a, b) => a.start.t - b.start.t);
      return { passes, ms: performance.now() - t, tested: res.reduce((a, r) => a + r.tested, 0) };
    };
    const job = this.queue.then(run, run);
    this.queue = job.catch(() => {});
    return job;
  }

  async startLive(lat, lon, hKm) {
    if (!this.live) {
      this.live = new Port();
      await this.live.call({ type: 'catalog', catalog: this.catalog });
    }
    await this.live.call({ type: 'live-start', lat, lon, hKm });
  }

  liveTick(t, opts, maxMag) {
    return this.live.call({ type: 'live', t, opts, maxMag });
  }
}
