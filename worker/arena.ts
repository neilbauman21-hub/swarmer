// The one endless multiplayer arena (a Cloudflare Durable Object).
//
// Deterministic lockstep: every client runs the same simulation and the arena only relays orders. Every
// TURN_MS it broadcasts a numbered turn with every order received since the last one, tagged with the
// sender's player id; the simulation maps player ids to swarms. Clients apply turn n right before
// simulating tick n * 6.
//
// Joining mid-game: the oldest connected client (the host) sends a snapshot of the world; the newcomer
// loads it, replays the turns since, and a `join` order gives them a swarm. The host also saves a snapshot
// every 30 s to durable storage, so the arena resumes where it left off when the next player arrives.
// State hashes are compared every 2 s and a host snapshot repairs any client that drifted.

const TURN_TICKS = 6;
const TURN_MS = 100;
const MAX_PLAYERS = 24; // 8 swarms; the rest watch until a slot frees up
const MAX_CMDS_PER_TURN = 60;
const SAVE_EVERY_MS = 30_000;
const HISTORY = 400; // turns kept for late joiners (40 s)
const PART = 200_000; // websocket/storage chunk size for snapshots (characters)

interface Player {
  pid: number;
  name: string;
  ws: WebSocket;
  ready: boolean; // has the world and receives turns
  left: boolean;
  joinedAt: number;
  seen: number; // last message from this client; silent ones are dropped
}

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
  put(entries: Record<string, unknown>): Promise<void>;
}

type Msg = Record<string, unknown>;

export class Arena {
  private storage: Storage;
  private players: Player[] = [];
  private nextPid = 1;
  private turn = 0;
  private pending: [number, unknown][] = [];
  private perTurn = new Map<number, number>();
  private history: { n: number; s: string }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private hashes = new Map<number, Map<number, number>>();
  private lastResync = 0;
  private build = '';
  private waiting: Player[] = []; // joiners waiting for a host snapshot
  private snapAsked = 0;
  private incoming = new Map<string, string[]>(); // chunked snapshots being received

  constructor(state: { storage: Storage }, _env: unknown) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') {
      const live = this.players.filter((p) => !p.left);
      return Response.json({ players: live.length, names: live.map((p) => p.name).slice(0, 12) });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const build = url.searchParams.get('v') ?? '';
    const sv = url.searchParams.get('sv') ?? '';
    const live = () => this.players.filter((p) => !p.left);
    if (live().length && build !== this.build) {
      if (build > this.build) {
        // A newer client arrived: everyone on the old build reloads, and the arena restarts on the new one.
        for (const p of live()) {
          this.sendTo(p.ws, { t: 'err', msg: 'Swarmer was just updated. Reloading…', reload: true });
          this.drop(p, false);
        }
        this.stop();
      } else {
        this.sendTo(server, { t: 'err', msg: 'Swarmer was just updated. Reloading…', reload: true });
        server.close(4001, 'old build');
        return new Response(null, { status: 101, webSocket: client });
      }
    }
    if (live().length >= MAX_PLAYERS) {
      this.sendTo(server, { t: 'err', msg: 'The arena is full right now. Try again in a minute.' });
      server.close(4000, 'full');
      return new Response(null, { status: 101, webSocket: client });
    }
    const p: Player = { pid: this.nextPid++, name: cleanName(url.searchParams.get('name')), ws: server, ready: false, left: false, joinedAt: Date.now(), seen: Date.now() };
    this.players.push(p);
    server.addEventListener('message', (e) => this.onMessage(p, e.data));
    server.addEventListener('close', () => this.drop(p));
    server.addEventListener('error', () => this.drop(p));

    if (!this.players.some((x) => x.ready && !x.left)) {
      // First one in: resume the saved arena (or start a new one) and run the turn clock.
      this.build = build;
      await this.startWith(p, sv);
    } else {
      this.waiting.push(p);
      this.askSnapshot();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private async startWith(p: Player, sv: string): Promise<void> {
    let z = '';
    let tick = 0;
    this.saveVersion = sv;
    try {
      const meta = await this.storage.get<{ tick: number; parts: number; sv: string }>('meta');
      if (meta && meta.sv === sv && meta.parts > 0) {
        const keys = Array.from({ length: meta.parts }, (_, i) => `z${i}`);
        const got = await this.storage.get<string>(keys);
        const parts = keys.map((k) => got.get(k));
        if (parts.every((x) => typeof x === 'string')) { z = parts.join(''); tick = meta.tick; }
      }
    } catch { /* no save: fresh arena */ }
    if (p.left) return;
    this.turn = Math.floor(tick / TURN_TICKS);
    this.history = [];
    this.pending = [];
    this.hashes.clear();
    const seed = (Math.random() * 2 ** 31) | 0;
    this.sendBlob(p.ws, { t: 'welcome', pid: p.pid, tick, seed, stored: !!z }, z);
    p.ready = true;
    this.pending.push([p.pid, { op: 'join', name: p.name }]);
    this.timer ??= setInterval(() => this.emitTurn(), TURN_MS);
    this.saveTimer ??= setInterval(() => this.requestSave(), SAVE_EVERY_MS);
    this.notice(`${p.name} entered the arena`, p);
  }

  private host(): Player | undefined {
    return this.players.find((x) => x.ready && !x.left);
  }

  private askSnapshot(): void {
    const host = this.host();
    if (!host || !this.waiting.length) return;
    if (this.snapAsked && Date.now() - this.snapAsked > 8000) {
      // The host never answered: treat it as gone and ask the next one.
      this.snapAsked = 0;
      this.drop(host);
      return;
    }
    if (this.snapAsked) return;
    this.snapAsked = Date.now();
    this.sendTo(host.ws, { t: 'snapReq', for: 'join' });
  }

  private requestSave(): void {
    const host = this.host();
    if (host) this.sendTo(host.ws, { t: 'snapReq', for: 'save' });
  }

  private onMessage(p: Player, data: unknown): void {
    if (typeof data !== 'string' || p.left) return;
    p.seen = Date.now();
    if (data.length > PART + 2000) return;
    let m: Msg;
    try { m = JSON.parse(data); } catch { return; }
    switch (m.t) {
      case 'ping':
        this.sendTo(p.ws, { t: 'pong', c: m.c });
        break;
      case 'cmd': {
        if (!p.ready || !Array.isArray(m.cmds)) break;
        const used = this.perTurn.get(p.pid) ?? 0;
        for (const c of m.cmds.slice(0, Math.max(0, MAX_CMDS_PER_TURN - used))) {
          // join/leave are system orders only the arena may issue.
          const op = c && typeof c === 'object' ? (c as Msg).op : null;
          if (op && op !== 'join' && op !== 'leave') this.pending.push([p.pid, c]);
        }
        this.perTurn.set(p.pid, used + m.cmds.length);
        break;
      }
      case 'chat':
        if (typeof m.text === 'string' && m.text.trim()) this.broadcast({ t: 'notice', text: `${p.name}: ${m.text.trim().slice(0, 160)}` });
        break;
      case 'hash':
        if (p.ready && typeof m.tick === 'number' && typeof m.h === 'number') this.onHash(p, m.tick, m.h);
        break;
      case 'snap': {
        // Snapshots come from the host in parts: {for, tick, i, n, z}.
        if (p !== this.host() || typeof m.z !== 'string' || typeof m.n !== 'number' || typeof m.i !== 'number') break;
        const key = `${m.for}:${m.tick}`;
        const parts = this.incoming.get(key) ?? [];
        parts[m.i] = m.z;
        this.incoming.set(key, parts);
        if (parts.filter((x) => x !== undefined).length < m.n) break;
        this.incoming.delete(key);
        void this.onSnapshot(String(m.for), m.tick as number, parts.join(''));
        break;
      }
    }
  }

  private async onSnapshot(kind: string, tick: number, z: string): Promise<void> {
    const n = Math.floor(tick / TURN_TICKS);
    if (kind === 'join') {
      const joiners = this.waiting.filter((x) => !x.left);
      this.waiting = [];
      this.snapAsked = 0;
      const turns = this.history.filter((h) => h.n >= n);
      for (const j of joiners) {
        if (turns.length && turns[0].n !== n && n < this.turn) {
          // Snapshot older than our history: try again.
          this.waiting.push(j);
          continue;
        }
        this.sendBlob(j.ws, { t: 'welcome', pid: j.pid, tick, stored: false }, z);
        for (const h of turns) this.sendRaw(j.ws, h.s);
        j.ready = true;
        this.pending.push([j.pid, { op: 'join', name: j.name }]);
        this.notice(`${j.name} entered the arena`, j);
      }
      if (this.waiting.length) this.askSnapshot();
    } else if (kind === 'sync') {
      for (const o of this.players) if (o.ready && !o.left && o !== this.host()) this.sendBlob(o.ws, { t: 'resync', tick }, z);
    } else if (kind === 'save') {
      const entries: Record<string, unknown> = {};
      const parts = Math.ceil(z.length / PART);
      for (let i = 0; i < parts; i++) entries[`z${i}`] = z.slice(i * PART, (i + 1) * PART);
      entries.meta = { tick, parts, sv: this.saveVersion };
      try { await this.storage.put(entries); } catch { /* best effort */ }
    }
  }

  private saveVersion = '';

  private onHash(p: Player, tick: number, h: number): void {
    let row = this.hashes.get(tick);
    if (!row) {
      row = new Map();
      this.hashes.set(tick, row);
      for (const k of this.hashes.keys()) if (k < tick - 1200) this.hashes.delete(k);
    }
    row.set(p.pid, h);
    const ready = this.players.filter((x) => x.ready && !x.left);
    if (row.size < ready.length) return;
    const first = row.values().next().value;
    if ([...row.values()].every((v) => v === first)) return;
    if (Date.now() - this.lastResync < 8000) return;
    this.lastResync = Date.now();
    const host = this.host();
    if (host) this.sendTo(host.ws, { t: 'snapReq', for: 'sync' });
  }

  private drop(p: Player, announce = true): void {
    if (p.left) return;
    p.left = true;
    try { p.ws.close(); } catch { /* already closed */ }
    if (p.ready) {
      // Their swarm keeps fighting as a bot; applied in lockstep like any order.
      this.pending.push([p.pid, { op: 'leave' }]);
      if (announce) this.notice(`${p.name} left the arena`, p);
    }
    this.players = this.players.filter((x) => !x.left);
    if (!this.players.some((x) => x.ready)) this.stop();
    else if (this.waiting.length) { this.snapAsked = 0; this.askSnapshot(); }
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.timer = this.saveTimer = null;
    this.pending = [];
    this.history = [];
    this.waiting = this.waiting.filter((x) => !x.left);
    // Anyone still waiting becomes the first player of a resumed arena.
    const next = this.waiting.shift();
    if (next) void this.startWith(next, this.saveVersion);
  }

  private emitTurn(): void {
    // Clients ping every 2 s; one that has been silent for 12 s is gone (closed tab, lost network).
    const now = Date.now();
    for (const p of this.players) if (!p.left && now - p.seen > 12_000) this.drop(p);
    if (!this.timer) return;
    const msg: Msg = { t: 'turn', n: this.turn++ };
    if (this.pending.length) msg.c = this.pending;
    this.pending = [];
    this.perTurn.clear();
    const s = JSON.stringify(msg);
    this.history.push({ n: msg.n as number, s });
    if (this.history.length > HISTORY) this.history.shift();
    for (const p of this.players) if (p.ready && !p.left) this.sendRaw(p.ws, s);
    if (this.waiting.length) this.askSnapshot();
  }

  private notice(text: string, except?: Player): void {
    for (const p of this.players) if (p.ready && !p.left && p !== except) this.sendTo(p.ws, { t: 'notice', text });
  }

  private broadcast(m: Msg): void {
    const s = JSON.stringify(m);
    for (const p of this.players) if (p.ready && !p.left) this.sendRaw(p.ws, s);
  }

  /** A header message followed by the payload in parts ({t:'part', z}). */
  private sendBlob(ws: WebSocket, header: Msg, z: string): void {
    const parts = z ? Math.ceil(z.length / PART) : 0;
    this.sendTo(ws, { ...header, parts });
    for (let i = 0; i < parts; i++) this.sendTo(ws, { t: 'part', z: z.slice(i * PART, (i + 1) * PART) });
  }

  private sendTo(ws: WebSocket, m: Msg): void {
    this.sendRaw(ws, JSON.stringify(m));
  }

  private sendRaw(ws: WebSocket, s: string): void {
    try { ws.send(s); } catch { /* closed; the close handler cleans up */ }
  }
}

function cleanName(v: string | null): string {
  const n = (v ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
  return n || `Pilot ${Math.floor(Math.random() * 900 + 100)}`;
}
