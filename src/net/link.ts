import { applyTurn, type ResultFn } from '../ai/protocol';
import { SNAPSHOT_VERSION, type World } from '../sim/world';

/** Ticks per lockstep turn; must match worker/arena.ts. */
export const TURN_TICKS = 6;
const HASH_EVERY = 120; // ticks between desync checks
const PART = 200_000;

declare const __BUILD__: string;
export const BUILD_ID: string = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

/** How the game gets orders into the simulation: straight away (offline/demo) or through the arena. */
export interface Link {
  readonly pid: number; // this client's player id (-1 = watching only)
  readonly networked: boolean;
  send(cmds: object[]): void;
  /** How many ticks may be simulated right now (Infinity when local). */
  ahead(tick: number): number;
  /** Apply the orders due before simulating the world's current tick. Returns false if they haven't arrived. */
  apply(w: World, onResult: ResultFn): boolean;
  /** Called once per frame: flush queued orders, load a resync snapshot if one arrived. */
  frame(w: World): void;
  close(): void;
}

/** Offline link: orders apply on the next tick. Used by the menu's attract mode and tests. */
export class LocalLink implements Link {
  readonly networked = false;
  private queue: object[] = [];
  constructor(readonly pid: number, name = 'You') {
    if (pid >= 0) this.queue.push({ op: 'join', name });
  }
  send(cmds: object[]): void { this.queue.push(...cmds); }
  ahead(): number { return Infinity; }
  apply(w: World, onResult: ResultFn): boolean {
    if (this.pid >= 0) for (const c of this.queue.splice(0)) applyTurn(w, this.pid, c, onResult);
    return true;
  }
  frame(): void {}
  close(): void {}
}

export interface Welcome {
  pid: number;
  tick: number;
  seed: number;
  stored: boolean; // resuming a saved arena nobody is in
  snapshot: Record<string, unknown> | null;
}

/** The websocket to the arena. */
export class Connection {
  private ws: WebSocket;
  link: NetLink | null = null;
  onWelcome: ((w: Welcome, link: NetLink) => void) | null = null;
  onError: ((msg: string, reload: boolean) => void) | null = null;
  onClose: (() => void) | null = null;
  onNotice: ((text: string) => void) | null = null;
  rtt = 0;
  private pingTimer = 0;
  private closed = false;
  private blob: { header: Record<string, unknown>; parts: string[] } | null = null;

  constructor(name: string) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ name, v: BUILD_ID, sv: String(SNAPSHOT_VERSION) });
    this.ws = new WebSocket(`${proto}//${location.host}/api/arena?${q}`);
    this.ws.addEventListener('message', (e) => this.onMessage(e.data));
    this.ws.addEventListener('close', () => {
      clearInterval(this.pingTimer);
      if (!this.closed) this.onClose?.();
      this.closed = true;
    });
    this.ws.addEventListener('open', () => {
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
    });
  }

  send(m: object): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close(): void {
    this.closed = true;
    clearInterval(this.pingTimer);
    this.ws.close();
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let m: Record<string, unknown>;
    try { m = JSON.parse(data); } catch { return; }
    // Big payloads (snapshots) arrive as a header with `parts` followed by that many {t:'part'} messages.
    if (m.t === 'part') {
      if (!this.blob) return;
      this.blob.parts.push(m.z as string);
      if (this.blob.parts.length < (this.blob.header.parts as number)) return;
      const { header, parts } = this.blob;
      this.blob = null;
      void this.onBlob(header, parts.join(''));
      return;
    }
    // Create the turn buffer right away: turns keep arriving while the snapshot downloads and unpacks.
    if (m.t === 'welcome') this.link ??= new NetLink(this, m.pid as number);
    if ((m.t === 'welcome' || m.t === 'resync') && (m.parts as number) > 0) {
      this.blob = { header: m, parts: [] };
      return;
    }
    switch (m.t) {
      case 'welcome': void this.onBlob(m, ''); break;
      case 'turn': this.link?.onTurn(m.n as number, (m.c as [number, object][]) ?? []); break;
      case 'snapReq': if (this.link) this.link.snapFor = String(m.for); break;
      case 'pong': this.rtt = performance.now() - (m.c as number); break;
      case 'notice': this.onNotice?.(String(m.text)); break;
      case 'err': this.onError?.(String(m.msg), m.reload === true); break;
    }
  }

  private async onBlob(header: Record<string, unknown>, z: string): Promise<void> {
    const snap = z ? JSON.parse(await unpack(z)) as Record<string, unknown> : null;
    if (header.t === 'welcome') {
      // The link exists before the world does, so turns that arrive meanwhile are buffered.
      this.link ??= new NetLink(this, header.pid as number);
      this.onWelcome?.({ pid: header.pid as number, tick: header.tick as number, seed: header.seed as number, stored: header.stored === true, snapshot: snap }, this.link);
    } else if (header.t === 'resync' && snap) this.link?.queueResync(header.tick as number, snap);
  }

  /** Snapshots go up to the arena in parts too. */
  sendSnap(kind: string, tick: number, z: string): void {
    const n = Math.max(1, Math.ceil(z.length / PART));
    for (let i = 0; i < n; i++) this.send({ t: 'snap', for: kind, tick, i, n, z: z.slice(i * PART, (i + 1) * PART) });
  }
}

/** Lockstep link: orders go to the arena and come back, for everyone, inside numbered turns. */
export class NetLink implements Link {
  readonly networked = true;
  private turns = new Map<number, [number, object][]>();
  private latest = -1;
  private outbox: object[] = [];
  snapFor = ''; // the arena asked for a snapshot (join / save / sync)
  private pendingSnap: { tick: number; data: Record<string, unknown> } | null = null;
  resyncs = 0;
  readonly hashLog = new Map<number, number>(); // recent state hashes, for debugging desyncs

  constructor(private conn: Connection, readonly pid: number) {}

  get rtt(): number { return this.conn.rtt; }

  send(cmds: object[]): void { this.outbox.push(...cmds); }

  onTurn(n: number, cmds: [number, object][]): void {
    this.turns.set(n, cmds);
    if (n > this.latest) this.latest = n;
  }

  ahead(tick: number): number {
    return (this.latest + 1) * TURN_TICKS - tick;
  }

  apply(w: World, onResult: ResultFn): boolean {
    if (w.tick % TURN_TICKS !== 0) return true;
    const n = w.tick / TURN_TICKS;
    const cmds = this.turns.get(n);
    if (!cmds) return false;
    if (this.snapFor) {
      // Snapshot of the state right before this turn: whoever loads it replays from turn n.
      const kind = this.snapFor, tick = w.tick;
      this.snapFor = '';
      void pack(JSON.stringify(w.serialize())).then((z) => this.conn.sendSnap(kind, tick, z));
    }
    if (w.tick % HASH_EVERY === 0) {
      const h = w.hash();
      this.hashLog.set(w.tick, h);
      this.hashLog.delete(w.tick - HASH_EVERY * 30);
      this.conn.send({ t: 'hash', tick: w.tick, h });
    }
    for (const [pid, c] of cmds) applyTurn(w, pid, c, pid === this.pid ? onResult : undefined);
    this.turns.delete(n - 600); // keep ~1 minute of history for resyncs
    return true;
  }

  queueResync(tick: number, data: Record<string, unknown>): void {
    this.pendingSnap = { tick, data };
  }

  frame(w: World): void {
    if (this.outbox.length) this.conn.send({ t: 'cmd', cmds: this.outbox.splice(0, 60) });
    if (this.pendingSnap) {
      const { tick, data } = this.pendingSnap;
      this.pendingSnap = null;
      try {
        w.restore(data);
        w.tick = tick;
        this.resyncs++;
      } catch (err) {
        console.warn('resync failed', err);
      }
    }
  }

  close(): void { this.conn.close(); }
}

async function pack(s: string): Promise<string> {
  const stream = new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function unpack(z: string): Promise<string> {
  const bin = atob(z);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** How many pilots are in the arena right now (for the menu). */
export async function arenaStatus(): Promise<{ players: number; names: string[] } | null> {
  try {
    const r = await fetch('/api/arena');
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
