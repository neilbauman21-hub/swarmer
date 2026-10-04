// Runs LLM-written swarm programs in an isolated Web Worker.
// The worker has no DOM, its network APIs are removed before the program loads,
// and a tick that doesn't answer in time gets the worker killed. Programs can only
// emit game commands, which the main thread validates before applying.

import type { Command, SwarmState } from './protocol';

const WORKER_SOURCE = `
'use strict';
for (const k of ['fetch','XMLHttpRequest','WebSocket','EventSource','importScripts','indexedDB','caches','BroadcastChannel','Worker','SharedWorker','WebTransport','navigator']) {
  try { Object.defineProperty(self, k, { value: undefined, configurable: false, writable: false }); } catch (e) {}
}
const send = self.postMessage.bind(self);
let tick = null;
let memory = {};
const pt = (p) => {
  if (p && typeof p === 'object' && !Array.isArray(p)) return { x: +p.x, y: +p.y };
  if (Array.isArray(p)) return { x: +p[0], y: +p[1] };
  if (typeof p === 'string') { const m = p.split(','); return { x: +m[0], y: +m[1] }; }
  return { x: NaN, y: NaN };
};
// Forgiving helpers: accept objects, [x,y] arrays, "x,y" strings, or dist(x1,y1,x2,y2).
const dist = (a, b, c, d) => {
  if (typeof a === 'number' && typeof b === 'number' && typeof c === 'number' && typeof d === 'number') return Math.hypot(a - c, b - d);
  const p = pt(a), q = pt(b);
  return Math.hypot(p.x - q.x, p.y - q.y);
};
const nearest = (from, list) => { let best = null, bd = Infinity; for (const it of list || []) { const d = dist(from, it); if (d < bd) { bd = d; best = it; } } return best; };
const byDistance = (from, list) => [...(list || [])].sort((a, b) => dist(from, a) - dist(from, b));
const centroid = (list) => { let x = 0, y = 0, n = 0; for (const g of list || []) { const p = pt(g); x += p.x * (g.count || 1); y += p.y * (g.count || 1); n += g.count || 1; } return n ? { x: x / n, y: y / n } : null; };
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    try {
      const factory = new Function('dist', 'nearest', 'byDistance', 'centroid', '"use strict";\\n' + m.code + '\\n;return typeof tick === "function" ? tick : null;');
      tick = factory(dist, nearest, byDistance, centroid);
      if (!tick) throw new Error('The program must define function tick(state, api, memory).');
      memory = {};
      send({ type: 'loaded' });
    } catch (err) { send({ type: 'error', message: String(err && err.message || err) }); }
    return;
  }
  if (m.type === 'tick' && tick) {
    const cmds = [], logs = [];
    let done = false;
    const c = (op, extra) => { if (cmds.length < 200) cmds.push(Object.assign({ op }, extra)); };
    const api = {
      move: (ids, x, y) => c('move', { ids, x, y }),
      path: (ids, points) => c('path', { ids, points }),
      attack: (ids, target) => c('attack', { ids, target: typeof target === 'object' && target ? target.id : target }),
      attackShip: (ids, target) => c('attackShip', { ids, target: typeof target === 'object' && target ? target.id : target }),
      harvest: (ids, rock) => c('harvest', { ids, rock: typeof rock === 'object' && rock ? rock.id : rock }),
      split: (id, dx, dy) => c('split', { id: typeof id === 'object' && id ? id.id : id, dx: dx === undefined ? 1 : dx, dy: dy === undefined ? 0 : dy }),
      merge: (ids) => c('merge', { ids }),
      replicate: (ids) => c('replicate', { ids }),
      research: (ids) => c('research', { ids }),
      hold: (ids) => c('hold', { ids }),
      formation: (ids, name) => c('formation', { ids, name }),
      morph: (ids, role) => c('morph', { ids, role }),
      dash: (ids, x, y) => c('dash', { ids, x, y }),
      shield: (ids) => c('shield', { ids }),
      nova: (ids) => c('nova', { ids }),
      unlock: (type) => c('unlock', { type }),
      build: (id, design) => c('build', { id: typeof id === 'object' && id ? id.id : id, design: typeof design === 'object' && design ? design.name : design }),
      log: (...a) => { if (logs.length < 5) logs.push(a.map(String).join(' ').slice(0, 160)); },
      done: () => { done = true; },
    };
    // Normalise group objects passed instead of ids.
    for (const k of Object.keys(api)) {
      const f = api[k];
      if (['unlock', 'log', 'done', 'split', 'build'].includes(k)) continue;
      api[k] = (ids, ...rest) => f(Array.isArray(ids) ? ids.map((g) => (g && typeof g === 'object' ? g.id : g)) : (ids && typeof ids === 'object' ? ids.id : ids), ...rest);
    }
    try { tick(m.state, Object.freeze(api), memory); }
    catch (err) { send({ type: 'error', message: String(err && err.message || err) }); return; }
    send({ type: 'result', cmds, logs, done });
  }
};
`;

export interface ProgramEvents {
  onCommands(cmds: Command[]): void;
  onLog(lines: string[]): void;
  onError(message: string): void;
  onDone(): void;
}

export class SwarmSandbox {
  private worker: Worker | null = null;
  private url: string | null = null;
  private pending = false;
  private sentAt = 0;
  private code = '';
  running = false;

  constructor(private events: ProgramEvents, private timeoutMs = 500) {}

  private spawn(): Worker {
    this.kill();
    if (!this.url) this.url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    const w = new Worker(this.url);
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; message?: string; cmds?: Command[]; logs?: string[]; done?: boolean };
      this.pending = false;
      if (m.type === 'error') {
        this.running = false;
        this.events.onError(m.message ?? 'Program error');
      } else if (m.type === 'result') {
        if (m.cmds?.length) this.events.onCommands(m.cmds);
        if (m.logs?.length) this.events.onLog(m.logs);
        if (m.done) {
          this.running = false;
          this.events.onDone();
        }
      }
    };
    w.onerror = (e) => {
      this.pending = false;
      this.running = false;
      this.events.onError(e.message || 'Program crashed');
      e.preventDefault();
    };
    this.worker = w;
    return w;
  }

  load(code: string): void {
    this.code = code;
    const w = this.spawn();
    this.pending = false;
    this.running = true;
    w.postMessage({ type: 'load', code });
  }

  /** Send a state snapshot; skipped while the previous tick is still running. */
  tick(state: SwarmState): void {
    if (!this.running || !this.worker) return;
    const now = performance.now();
    if (this.pending) {
      if (now - this.sentAt > this.timeoutMs) {
        this.running = false;
        this.kill();
        this.events.onError(`Program took longer than ${this.timeoutMs} ms (infinite loop?) and was stopped.`);
      }
      return;
    }
    this.pending = true;
    this.sentAt = now;
    this.worker.postMessage({ type: 'tick', state });
  }

  stop(): void {
    this.running = false;
    this.kill();
  }

  get source(): string {
    return this.code;
  }

  private kill(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending = false;
  }

  dispose(): void {
    this.stop();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}
