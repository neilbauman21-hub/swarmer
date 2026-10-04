// Multiplayer rooms (Cloudflare Durable Objects).
//
// The game uses deterministic lockstep: every client runs the same simulation, and the room only relays
// orders. Every TURN_MS the room broadcasts one "turn" holding every order received since the last one,
// tagged with the sender's team (so nobody can order another player's swarm). Clients apply turn n right
// before simulating tick n * TURN_TICKS. Clients report a state hash every few seconds; if they disagree,
// the host sends a full snapshot that the others load.

export const TURN_TICKS = 6; // 60 Hz sim -> 10 turns per second
const TURN_MS = 100;
const MAX_HUMANS = 4;
const PUBLIC_WAIT_MS = 15000; // quick-match rooms launch this long after the first player joins
const MAX_CMDS_PER_TURN = 60;

interface Player {
  id: number;
  name: string;
  ws: WebSocket;
  team: number;
  left: boolean;
}

interface Settings {
  difficulty: number;
  size: number;
  bots: number;
}

type Msg = Record<string, unknown>;

export class Room {
  private players: Player[] = [];
  private nextId = 1;
  private state: 'lobby' | 'playing' = 'lobby';
  private code = '';
  private isPublic = false;
  private firstJoin = 0;
  private settings: Settings = { difficulty: 1, size: 6000, bots: 2 };
  private turn = 0;
  private pending: [number, unknown][] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private countdown: ReturnType<typeof setTimeout> | null = null;
  private hashes = new Map<number, Map<number, number>>();
  private lastResync = 0;
  private perTurn = new Map<number, number>();

  constructor(_state: unknown, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return Response.json({ code: this.code, state: this.state, players: this.players.filter((p) => !p.left).length });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.code ||= (url.searchParams.get('code') ?? '').toUpperCase();
    const live = this.players.filter((p) => !p.left);
    if (this.state !== 'lobby' || live.length >= MAX_HUMANS) {
      server.send(JSON.stringify({ t: 'err', msg: this.state !== 'lobby' ? 'That match has already started.' : 'That room is full.', retry: true }));
      server.close(4000, 'unavailable');
      return new Response(null, { status: 101, webSocket: client });
    }
    if (!live.length) {
      this.isPublic = url.searchParams.get('public') === '1';
      this.firstJoin = Date.now();
      this.settings = { difficulty: 1, size: 6000, bots: this.isPublic ? 3 : 2 };
      if (this.isPublic) this.countdown = setTimeout(() => this.start(), PUBLIC_WAIT_MS);
    }
    const name = cleanName(url.searchParams.get('name'));
    const p: Player = { id: this.nextId++, name, ws: server, team: -1, left: false };
    this.players.push(p);
    server.addEventListener('message', (e) => this.onMessage(p, e.data));
    server.addEventListener('close', () => this.onClose(p));
    server.addEventListener('error', () => this.onClose(p));
    this.broadcastLobby();
    if (this.isPublic && this.players.filter((x) => !x.left).length >= MAX_HUMANS) this.start();
    return new Response(null, { status: 101, webSocket: client });
  }

  private host(): Player | undefined {
    return this.players.find((p) => !p.left);
  }

  private onMessage(p: Player, data: unknown): void {
    if (typeof data !== 'string') return;
    // Snapshots can be big; everything else is small.
    if (data.length > 64_000 && !(data.startsWith('{"t":"snap"') && p === this.host())) return;
    let m: Msg;
    try { m = JSON.parse(data); } catch { return; }
    switch (m.t) {
      case 'ping':
        this.send(p, { t: 'pong', c: m.c });
        break;
      case 'settings':
        if (this.state === 'lobby' && p === this.host() && !this.isPublic) {
          const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && v >= lo && v <= hi ? Math.round(v) : d);
          this.settings = {
            difficulty: n(m.difficulty, 0, 2, this.settings.difficulty),
            size: [4500, 6000, 8000].includes(m.size as number) ? (m.size as number) : this.settings.size,
            bots: n(m.bots, 0, 3, this.settings.bots),
          };
          this.broadcastLobby();
        }
        break;
      case 'start':
        if (this.state === 'lobby' && p === this.host()) this.start();
        break;
      case 'chat':
        if (typeof m.text === 'string' && m.text.trim()) this.broadcast({ t: 'chat', from: p.name, team: p.team, text: m.text.trim().slice(0, 200) });
        break;
      case 'cmd': {
        if (this.state !== 'playing' || p.team < 0 || p.left || !Array.isArray(m.cmds)) break;
        const used = this.perTurn.get(p.team) ?? 0;
        for (const c of m.cmds.slice(0, Math.max(0, MAX_CMDS_PER_TURN - used))) {
          // 'leave' is a system order only the room may issue.
          if (c && typeof c === 'object' && (c as Msg).op !== 'leave') this.pending.push([p.team, c]);
        }
        this.perTurn.set(p.team, used + m.cmds.length);
        break;
      }
      case 'hash':
        if (this.state === 'playing' && typeof m.tick === 'number' && typeof m.h === 'number') this.onHash(p, m.tick, m.h);
        break;
      case 'snap':
        // The host's full state after a desync: everyone else loads it.
        if (this.state === 'playing' && p === this.host()) {
          for (const o of this.players) if (o !== p && !o.left) this.sendRaw(o, data);
        }
        break;
    }
  }

  private onHash(p: Player, tick: number, h: number): void {
    let row = this.hashes.get(tick);
    if (!row) {
      row = new Map();
      this.hashes.set(tick, row);
      for (const k of this.hashes.keys()) if (k < tick - 1200) this.hashes.delete(k);
    }
    row.set(p.id, h);
    const live = this.players.filter((x) => !x.left);
    if (row.size < live.length) return;
    const first = row.values().next().value;
    if ([...row.values()].every((v) => v === first)) return;
    if (Date.now() - this.lastResync < 8000) return;
    this.lastResync = Date.now();
    const host = this.host();
    if (host) this.send(host, { t: 'snapReq' });
  }

  private onClose(p: Player): void {
    if (p.left) return;
    p.left = true;
    try { p.ws.close(); } catch { /* already closed */ }
    if (this.state === 'playing') {
      // An AI takes over the swarm of a player who left, applied in lockstep like any order.
      if (p.team >= 0) this.pending.push([p.team, { op: 'leave' }]);
      this.broadcast({ t: 'left', name: p.name, team: p.team });
      if (!this.players.some((x) => !x.left)) this.reset();
    } else {
      if (!this.players.some((x) => !x.left)) this.reset();
      else this.broadcastLobby();
    }
  }

  private reset(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.countdown) clearTimeout(this.countdown);
    this.timer = this.countdown = null;
    this.players = [];
    this.state = 'lobby';
    this.turn = 0;
    this.pending = [];
    this.hashes.clear();
  }

  private start(): void {
    if (this.state !== 'lobby') return;
    if (this.countdown) clearTimeout(this.countdown);
    this.countdown = null;
    const live = this.players.filter((p) => !p.left);
    if (!live.length) return;
    this.state = 'playing';
    const humans = live.length;
    const total = Math.min(4, Math.max(2, humans + this.settings.bots));
    // Spread humans over the map corners (0 and 1 are opposite corners).
    const order = [0, 1, 2, 3].slice(0, total);
    const names: Record<number, string> = {};
    live.forEach((p, k) => { p.team = order[k]; names[p.team] = p.name; });
    const seed = (Math.random() * 2 ** 31) | 0;
    for (const p of live) {
      this.send(p, {
        t: 'start', seed, teams: total, humans: live.map((x) => x.team), names, you: p.team,
        size: this.settings.size, difficulty: this.settings.difficulty, code: this.code,
      });
    }
    this.turn = 0;
    this.timer = setInterval(() => this.emitTurn(), TURN_MS);
  }

  private emitTurn(): void {
    const msg: Msg = { t: 'turn', n: this.turn++ };
    if (this.pending.length) msg.c = this.pending;
    this.pending = [];
    this.perTurn.clear();
    this.broadcast(msg);
  }

  private broadcastLobby(): void {
    const live = this.players.filter((p) => !p.left);
    const host = this.host();
    const startsIn = this.isPublic && this.countdown ? Math.max(0, PUBLIC_WAIT_MS - (Date.now() - this.firstJoin)) : null;
    for (const p of live) {
      this.send(p, {
        t: 'lobby', code: this.code, you: p.id, host: host?.id, public: this.isPublic, startsIn,
        players: live.map((x) => ({ id: x.id, name: x.name })), settings: this.settings,
      });
    }
  }

  private broadcast(m: Msg): void {
    const s = JSON.stringify(m);
    for (const p of this.players) if (!p.left) this.sendRaw(p, s);
  }

  private send(p: Player, m: Msg): void {
    this.sendRaw(p, JSON.stringify(m));
  }

  private sendRaw(p: Player, s: string): void {
    try { p.ws.send(s); } catch { this.onClose(p); }
  }
}

/** Hands out the current open quick-match room, or opens a new one. */
export class Matchmaker {
  private code = '';
  private opened = 0;
  private count = 0;

  constructor(_state: unknown, _env: unknown) {}

  async fetch(): Promise<Response> {
    const now = Date.now();
    // Stop sending people to a room shortly before it launches so they don't arrive too late.
    if (!this.code || now - this.opened > PUBLIC_WAIT_MS - 2500 || this.count >= MAX_HUMANS) {
      this.code = newCode();
      this.opened = now;
      this.count = 0;
    }
    this.count++;
    return Response.json({ code: this.code });
  }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newCode(): string {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return [...b].map((v) => ALPHABET[v % ALPHABET.length]).join('');
}

function cleanName(v: string | null): string {
  const n = (v ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
  return n || `Pilot ${Math.floor(Math.random() * 900 + 100)}`;
}
