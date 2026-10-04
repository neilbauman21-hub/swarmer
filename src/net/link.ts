import { applyCommands, type ResultFn } from '../ai/protocol';
import type { World } from '../sim/world';

/** Ticks per lockstep turn; must match worker/room.ts. */
export const TURN_TICKS = 6;
const HASH_EVERY = 120; // ticks between desync checks

/** How the game gets orders into the simulation: straight away (offline/demo) or through a room (multiplayer). */
export interface Link {
  readonly team: number; // the team this client controls, -1 = spectator/demo
  readonly networked: boolean;
  send(cmds: object[]): void;
  /** How many ticks may be simulated right now (Infinity when local). */
  ahead(tick: number): number;
  /** Apply the orders due before simulating the world's current tick. Returns false if they haven't arrived yet. */
  apply(w: World, onResult: ResultFn): boolean;
  /** Called once per frame: flush queued orders, load a resync snapshot if one arrived. */
  frame(w: World): void;
  close(): void;
}

/** Offline link: orders apply on the next tick. Used by the menu's attract mode and tests. */
export class LocalLink implements Link {
  readonly networked = false;
  private queue: object[] = [];
  constructor(readonly team: number) {}
  send(cmds: object[]): void { this.queue.push(...cmds); }
  ahead(): number { return Infinity; }
  apply(w: World, onResult: ResultFn): boolean {
    if (this.queue.length && this.team >= 0) applyCommands(w, this.team, this.queue.splice(0), 200, onResult);
    return true;
  }
  frame(): void {}
  close(): void {}
}

export interface LobbyInfo {
  code: string;
  you: number;
  host: number;
  public: boolean;
  startsIn: number | null;
  players: { id: number; name: string }[];
  settings: { difficulty: number; size: number; bots: number };
}

export interface StartInfo {
  seed: number;
  teams: number;
  humans: number[];
  names: Record<number, string>;
  you: number;
  size: number;
  difficulty: number;
  code: string;
}

/** One websocket to a room: lobby first, then the lockstep match. */
export class Connection {
  private ws: WebSocket;
  link: NetLink | null = null;
  onLobby: ((l: LobbyInfo) => void) | null = null;
  onStart: ((s: StartInfo, link: NetLink) => void) | null = null;
  onError: ((msg: string, retry: boolean) => void) | null = null;
  onClose: (() => void) | null = null;
  onNotice: ((text: string) => void) | null = null;
  rtt = 0;
  private pingTimer = 0;
  private closed = false;

  constructor(code: string, name: string, isPublic: boolean) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ name, ...(isPublic ? { public: '1' } : {}) });
    this.ws = new WebSocket(`${proto}//${location.host}/api/room/${code}?${q}`);
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

  sendRaw(s: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
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
    switch (m.t) {
      case 'lobby': this.onLobby?.(m as unknown as LobbyInfo); break;
      case 'start': {
        const s = m as unknown as StartInfo;
        this.link = new NetLink(this, s.you);
        this.onStart?.(s, this.link);
        break;
      }
      case 'turn': this.link?.onTurn(m.n as number, (m.c as [number, object][]) ?? []); break;
      case 'snapReq': if (this.link) this.link.snapRequested = true; break;
      case 'snap': void this.link?.onSnap(m.tick as number, m.z as string); break;
      case 'pong': this.rtt = performance.now() - (m.c as number); break;
      case 'left': this.onNotice?.(`${m.name} left the match. An AI took over their swarm.`); break;
      case 'chat': this.onNotice?.(`${m.from}: ${m.text}`); break;
      case 'err': this.onError?.(String(m.msg), m.retry === true); break;
    }
  }
}

/** Lockstep link: orders go to the room and come back, for everyone, inside numbered turns. */
export class NetLink implements Link {
  readonly networked = true;
  private turns = new Map<number, [number, object][]>();
  private latest = -1;
  private outbox: object[] = [];
  snapRequested = false;
  private pendingSnap: { tick: number; data: Record<string, unknown> } | null = null;
  resyncs = 0;
  readonly hashLog = new Map<number, number>(); // recent state hashes, for debugging desyncs

  constructor(private conn: Connection, readonly team: number) {}

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
    if (w.tick % HASH_EVERY === 0) {
      if (this.snapRequested) {
        this.snapRequested = false;
        void this.sendSnap(w.tick, w.serialize());
      }
      const h = w.hash();
      this.hashLog.set(w.tick, h);
      this.hashLog.delete(w.tick - HASH_EVERY * 30);
      this.conn.send({ t: 'hash', tick: w.tick, h });
    }
    for (const [team, c] of cmds) {
      if ((c as { op?: string }).op === 'leave') w.handOver(team);
      else applyCommands(w, team, [c], 1, team === this.team ? onResult : undefined);
    }
    this.turns.delete(n - 600); // keep ~1 minute of history for resyncs
    return true;
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

  private async sendSnap(tick: number, data: Record<string, unknown>): Promise<void> {
    const z = await pack(JSON.stringify(data));
    this.conn.sendRaw(JSON.stringify({ t: 'snap', tick, z }));
  }

  async onSnap(tick: number, z: string): Promise<void> {
    try {
      this.pendingSnap = { tick, data: JSON.parse(await unpack(z)) };
    } catch (err) {
      console.warn('bad snapshot', err);
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

/** Quick match: ask the matchmaker for the open public room. */
export async function quickCode(): Promise<string> {
  const r = await fetch('/api/quick');
  if (!r.ok) throw new Error(`Matchmaking unavailable (${r.status})`);
  return ((await r.json()) as { code: string }).code;
}

export async function newRoomCode(): Promise<string> {
  const r = await fetch('/api/new');
  if (!r.ok) throw new Error(`Could not create a room (${r.status})`);
  return ((await r.json()) as { code: string }).code;
}
