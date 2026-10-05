import { COUNTER, DASH, DT, MAX_UNITS, TEAM_NAMES, Difficulty, FORMATIONS, Formation, NOVA, REPLICATE_MIN, ROLES, Role, SHIELD, SHIPS, TEAM_COLORS } from './sim/config';
import { World, type GameEvent } from './sim/world';
import type { Link } from './net/link';
import { ContextMenu } from './ui/context';
import { Fx } from './render/fx';
import { Trails } from './render/trails';
import { Renderer, SpriteBatch } from './render/renderer';
import { buildScene } from './render/scene';
import type { Audio } from './ui/audio';
import { Hud } from './ui/hud';

export interface GameOptions {
  seed: number;
  arena?: boolean; // the endless multiplayer arena
  difficulty?: Difficulty;
  teams?: number; // non-arena worlds (attract mode): total swarms
  humans?: number[];
  size?: number;
  demo?: boolean; // attract mode behind the main menu: all AI, no HUD or input
  init?: (w: World) => void; // e.g. load the arena snapshot before the first frame
}

export type Action =
  | 'split' | 'merge' | 'replicate' | 'research' | 'stop' | 'dash' | 'shield' | 'nova'
  | 'f0' | 'f1' | 'f2' | 'f3' | 'm0' | 'm1' | 'm2' | 'm3' | 'm4' | 'selectAll' | 'cycle' | 'center';

const KEYMAP: Record<string, Action> = {
  s: 'split', g: 'merge', b: 'replicate', t: 'research', h: 'stop', q: 'dash', e: 'shield', r: 'nova',
  z: 'f0', x: 'f1', c: 'f2', v: 'f3', '1': 'm0', '2': 'm1', '3': 'm2', '4': 'm3', '5': 'm4',
  tab: 'cycle', ' ': 'center',
};

interface Camera { x: number; y: number; zoom: number; tx: number; ty: number; tzoom: number }
interface Ping { x: number; y: number; t: number; color: string; label?: string }

export class Game {
  readonly world: World;
  readonly renderer: Renderer;
  readonly fx = new Fx();
  private trails = new Trails(MAX_UNITS);
  private frameDt = 0;
  readonly hud: Hud | null;
  readonly selected = new Set<number>();
  readonly cam: Camera;
  private under = new SpriteBatch(1024);
  private solid = new SpriteBatch(512);
  private glow = new SpriteBatch(16384);
  private overlay: CanvasRenderingContext2D;
  private dpr = 1;
  private cssW = 1;
  private cssH = 1;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private time = 0;
  paused = false;
  private destroyed = false;
  private mouse = { x: 0, y: 0, wx: 0, wy: 0, in: false };
  private drag: { x: number; y: number; button: number; cx: number; cy: number; moved: boolean; box: boolean } | null = null;
  private keys = new Set<string>();
  private hoverGroup = -1;
  private hoverRock = -1;
  private hoverShip = -1;
  private pings: Ping[] = [];
  private alerts: Ping[] = [];
  private lastClick = 0;
  private cycleIdx = 0;
  private cleanup: (() => void)[] = [];
  onPause: ((paused: boolean) => void) | null = null;
  onNotice: ((text: string) => void) | null = null;
  /** The team this client controls (-1 = not deployed yet, or watching). Changes when the player joins. */
  me = -1;
  menuOpen = false; // multiplayer menu overlay: the match keeps running underneath
  readonly context: ContextMenu | null;
  private targeting: 'split' | 'dash' | null = null;
  private bgTimer = 0;

  constructor(readonly root: HTMLElement, readonly opts: GameOptions, readonly audio: Audio, readonly link: Link) {
    this.world = new World({ seed: opts.seed, arena: opts.arena, size: opts.size, teams: opts.teams, humans: opts.humans, difficulty: opts.difficulty });
    opts.init?.(this.world);
    this.syncMe();
    const canvas = document.createElement('canvas');
    canvas.className = 'gl';
    const over = document.createElement('canvas');
    over.className = 'overlay';
    root.append(canvas, over);
    this.renderer = new Renderer(canvas);
    this.overlay = over.getContext('2d')!;
    const home = this.world.teams[this.me] ?? { homeX: this.world.size / 2, homeY: this.world.size / 2 };
    this.cam = { x: home.homeX, y: home.homeY, zoom: 1.1, tx: home.homeX, ty: home.homeY, tzoom: 1.1 };
    this.resize();
    if (opts.demo) {
      this.hud = null;
      this.context = null;
      this.cam.zoom = this.cam.tzoom = 0.7;
    } else {
      this.hud = new Hud(root, this);
      this.context = new ContextMenu(root, this);
      this.bindInput(canvas);
      const start = this.world.groupsOf(this.me)[0];
      if (start) this.selected.add(start.id);
      // Background tabs get no animation frames; keep the lockstep simulation up with the room anyway.
      this.bgTimer = window.setInterval(() => {
        if (!document.hidden || this.destroyed) return;
        this.onEvents(this.advance(0, 240));
        this.syncMe();
      }, 250);
    }
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Player or bot name for a team. */
  teamName(t: number): string {
    return this.world.teams[t]?.name ?? TEAM_NAMES[t] ?? 'Raiders';
  }

  /** Follow which swarm is mine (it appears when my join order lands, and keeps its slot on respawn). */
  private syncMe(): void {
    const me = this.world.teamOfPlayer(this.link.pid);
    if (me === this.me) return;
    this.me = me;
    this.fx.me = me;
    this.audio.me = me;
    if (me >= 0) this.onDeployed();
  }

  private onDeployed(): void {
    const t = this.world.teams[this.me];
    if (!t?.alive) return;
    this.selected.clear();
    for (const g of this.world.groupsOf(this.me)) this.selected.add(g.id);
    this.cam.tx = this.cam.x = t.homeX;
    this.cam.ty = this.cam.y = t.homeY;
    this.hud?.dock.refreshDesigns();
  }

  /** Back into the arena with a fresh swarm after being wiped out. */
  respawn(): void {
    const t = this.world.teams[this.me];
    if (t && !t.alive) this.link.send([{ op: 'respawn' }]);
  }

  /** Queue orders for my team. They take effect on every client at the same tick. */
  issue(...cmds: object[]): void {
    if (this.me < 0 || !this.world.teams[this.me]?.alive) return;
    this.link.send(cmds);
  }

  /** Orders that created or replaced a group come back here so the selection can follow them. */
  private onResult = (cmd: Record<string, unknown>, id: number): void => {
    const op = cmd.op;
    if (op === 'split' && cmd.sel && this.selected.has(cmd.id as number)) {
      if (this.splitFresh !== cmd.batch) { this.splitFresh = cmd.batch as number; this.selected.clear(); }
      this.selected.add(id);
    } else if (op === 'merge' || op === 'build') {
      const src = [...(Array.isArray(cmd.ids) ? cmd.ids : []), cmd.id] as number[];
      if (src.some((x) => this.selected.has(x))) {
        for (const x of src) this.selected.delete(x);
        this.selected.add(id);
      }
      if (op === 'build') this.hud?.dock.onBuilt(id);
    } else if (op === 'design') this.hud?.dock.refreshDesigns();
  };
  private splitFresh = -1;
  skipTicks = 0;
  private batchId = 0;

  /** Run as many simulation ticks as are due (and allowed by the lockstep link). */
  private advance(dt: number, cap: number): GameEvent[] {
    const events: GameEvent[] = [];
    const w = this.world;
    const ahead = this.link.ahead(w.tick);
    this.acc += dt;
    let budget = Math.floor(this.acc / DT);
    // Fell behind the room (slow frame, hidden tab): catch up a bit faster than real time.
    if (Number.isFinite(ahead) && ahead > 18) budget += Math.ceil((ahead - 12) / 4);
    budget = Math.min(budget, cap, ahead);
    let steps = 0;
    while (steps < budget) {
      if (!this.link.apply(w, this.onResult)) break;
      w.step();
      for (const e of w.drainEvents()) events.push(e);
      if (w.tick % 15 === 0) this.hud?.dock.tick();
      steps++;
    }
    this.acc = Math.max(0, Math.min(DT, this.acc - steps * DT));
    if (steps < budget || (steps === 0 && this.acc >= DT)) this.acc = Math.min(this.acc, DT * 0.999);
    this.link.frame(w);
    return events;
  }

  destroy(): void {
    this.destroyed = true;
    this.audio.setIntensity(0);
    cancelAnimationFrame(this.raf);
    clearInterval(this.bgTimer);
    for (const c of this.cleanup) c();
    this.link.close();
    this.context?.destroy();
    this.hud?.destroy();
    this.root.innerHTML = '';
  }

  /** In multiplayer the menu never pauses the match; it only blocks input. */
  setPaused(p: boolean): void {
    if (this.link.networked) {
      this.menuOpen = p;
      this.onPause?.(p);
      return;
    }
    this.paused = p;
    this.onPause?.(p);
  }

  // ------------------------------------------------------------------ loop

  private frame = (now: number): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.frameDt = dt;
    this.last = now;
    this.resize();
    let events: GameEvent[] = [];
    if (this.skipTicks > 0) {
      // Attract mode fast-forwards its opening a slice per frame instead of freezing the page.
      const n = Math.min(this.skipTicks, 200);
      for (let k = 0; k < n; k++) this.world.step();
      this.world.drainEvents();
      this.skipTicks -= n;
    } else if (!this.paused) {
      let scale = 1;
      if (this.fx.hitstop > 0) {
        this.fx.hitstop -= dt;
        // Hit-stop is a local slow-motion effect; in lockstep it would only make us fall behind the room.
        if (!this.link.networked) scale = 0.12;
      }
      events = this.advance(dt * scale, this.link.networked ? 30 : 4);
      this.time += dt;
      this.fx.update(dt * (this.fx.hitstop > 0 ? 0.25 : 1));
    }
    const bounds = this.viewBounds();
    this.fx.handle(events, bounds);
    if (!this.paused) this.mineDust(dt);
    this.audio.tick(dt);
    if (this.opts.demo) this.directDemoCamera(dt);
    else {
      this.audio.play(events, (x, y) => this.audibility(x, y));
      this.audio.startMusic();
      let fighting = 0;
      for (const g of this.world.groupsOf(this.me)) if (g.combatT < 1.5) fighting += g.count;
      this.musicIntensity += (Math.min(1, fighting / 120) - this.musicIntensity) * Math.min(1, dt * 0.8);
      this.audio.setIntensity(this.paused ? 0 : this.musicIntensity);
    }
    this.onEvents(events);
    this.pruneSelection();
    this.updateCamera(dt);
    this.updateHover();
    this.render();
    this.hud?.update(dt);
    this.syncMe();
  };

  private onEvents(events: GameEvent[]): void {
    if (this.opts.demo) return;
    for (const e of events) {
      if (e.t === 'teamIn' && e.team === this.me) {
        this.onDeployed();
        continue;
      }
      if (e.t === 'teamOut' && e.team === this.me && e.n !== -1) {
        this.selected.clear();
        continue;
      }
      // Keep chatter low: only your own big losses and incoming raids get a line of text.
      if (e.t === 'groupLost' && e.team === this.me && (e.n ?? 0) >= 40) this.hud?.banner(`Lost a swarm of ${e.n}`, '#ff8f7a');
      if (e.t === 'wave') this.hud?.banner(`Raiders incoming from the ${this.compass(e.x, e.y)}`, '#ffd59a');
    }
    // Alert when an off-screen player group is in a fight.
    for (const g of this.world.groupsOf(this.me)) {
      if (g.combatT < 0.05 && g.recentLoss > 2 && !this.onScreen(g.cx, g.cy)) {
        if (!this.alerts.some((a) => Math.hypot(a.x - g.cx, a.y - g.cy) < 300 && a.t > 2)) {
          this.alerts.push({ x: g.cx, y: g.cy, t: 4, color: '#ff6b5a', label: 'Under attack' });
        }
      }
    }
  }

  /** Grit drifting off rocks that are being mined (purely visual, so it can use Math.random). */
  private mineDust(dt: number): void {
    const w = this.world;
    for (const g of w.groups) {
      if (!g.alive || !g.harvesting) continue;
      const r = w.rocks[g.order.rock];
      if (!r?.alive || !this.onScreen(r.x, r.y)) continue;
      const col: [number, number, number] = r.wreck ? [0.95, 0.6, 0.3] : [0.68, 0.64, 0.6];
      for (let n = Math.min(5, g.count * dt * 0.35); n > 0; n--) {
        if (Math.random() > n) break;
        const a = Math.random() * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const out = 15 + Math.random() * 35, tan = (Math.random() - 0.5) * 40;
        this.fx.spark(r.x + ca * r.r * 0.95, r.y + sa * r.r * 0.95, ca * out - sa * tan, sa * out + ca * tan,
          0.6 + Math.random() * 0.7, 1 + Math.random() * 1.1, col, 1.2, 0.6 + Math.random() * 0.4);
      }
    }
  }

  private compass(x: number, y: number): string {
    const s = this.world.size;
    const dx = x - s / 2, dy = y - s / 2;
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'east' : 'west';
    return dy > 0 ? 'south' : 'north';
  }

  /** Attract mode: drift toward the most interesting action. */
  private musicIntensity = 0;
  private demoFocus = -1;
  private demoTimer = 0;
  private directDemoCamera(dt: number): void {
    this.demoTimer -= dt;
    const w = this.world;
    let g = w.groups[this.demoFocus];
    if (this.demoTimer <= 0 || !g?.alive) {
      // Prefer groups in combat, then the largest.
      const live = w.groups.filter((x) => x.alive && x.count > 10);
      live.sort((a, b) => (b.combatT < 1 ? 1000 : 0) + b.count - ((a.combatT < 1 ? 1000 : 0) + a.count));
      g = live[0];
      this.demoFocus = g?.id ?? -1;
      this.demoTimer = 9;
    }
    if (!g) return;
    const k = 1 - Math.exp(-dt * 0.6);
    this.cam.tx += (g.cx - this.cam.tx) * k;
    this.cam.ty += (g.cy - this.cam.ty) * k;
    this.cam.tzoom = 0.75 + 0.15 * Math.sin(this.time * 0.1);
  }

  // ------------------------------------------------------------------ camera

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.root.clientWidth, h = this.root.clientHeight;
    if (w === this.cssW && h === this.cssH && dpr === this.dpr) return;
    this.cssW = w; this.cssH = h; this.dpr = dpr;
    this.renderer.resize(w * dpr, h * dpr);
    const oc = this.overlay.canvas;
    oc.width = w * dpr;
    oc.height = h * dpr;
  }

  private updateCamera(dt: number): void {
    const c = this.cam;
    const pan = (900 / c.zoom) * dt;
    if (this.keys.has('arrowleft')) c.tx -= pan;
    if (this.keys.has('arrowright')) c.tx += pan;
    if (this.keys.has('arrowup')) c.ty -= pan;
    if (this.keys.has('arrowdown')) c.ty += pan;
    const S = this.world.size;
    c.tx = Math.max(-200, Math.min(S + 200, c.tx));
    c.ty = Math.max(-200, Math.min(S + 200, c.ty));
    // Zoom toward the cursor: keep the world point under the mouse fixed.
    const k = 1 - Math.exp(-dt * 12);
    const before = this.screenToWorld(this.mouse.x, this.mouse.y);
    c.zoom += (c.tzoom - c.zoom) * k;
    const after = this.screenToWorld(this.mouse.x, this.mouse.y);
    if (this.mouse.in && Math.abs(c.tzoom - c.zoom) > 1e-4) {
      c.x += before[0] - after[0]; c.y += before[1] - after[1];
      c.tx += before[0] - after[0]; c.ty += before[1] - after[1];
    }
    c.x += (c.tx - c.x) * k;
    c.y += (c.ty - c.y) * k;
  }

  private shakeOffset(): [number, number] {
    const t = this.fx.trauma;
    const s = t * t * 22 / this.cam.zoom;
    const tt = this.time * 40;
    return [Math.sin(tt * 1.3) * s + Math.sin(tt * 3.1) * s * 0.5, Math.cos(tt * 1.7) * s + Math.sin(tt * 2.3) * s * 0.5];
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return [this.cam.x + (sx - this.cssW / 2) / this.cam.zoom, this.cam.y + (sy - this.cssH / 2) / this.cam.zoom];
  }

  worldToScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.cam.x) * this.cam.zoom + this.cssW / 2, (wy - this.cam.y) * this.cam.zoom + this.cssH / 2];
  }

  private viewBounds() {
    const hw = this.cssW / 2 / this.cam.zoom, hh = this.cssH / 2 / this.cam.zoom;
    return { x0: this.cam.x - hw, y0: this.cam.y - hh, x1: this.cam.x + hw, y1: this.cam.y + hh };
  }

  private onScreen(x: number, y: number): boolean {
    const b = this.viewBounds();
    return x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1;
  }

  private audibility(x: number, y: number): number {
    const b = this.viewBounds();
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const r = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.6;
    const d = Math.hypot(x - cx, y - cy);
    const zoomFade = Math.min(1, 0.35 + this.cam.zoom * 0.7);
    return Math.max(0, 1 - Math.max(0, d - r) / (r * 0.8)) * zoomFade;
  }

  focus(x: number, y: number): void {
    this.cam.tx = x;
    this.cam.ty = y;
  }

  // ------------------------------------------------------------------ render

  private render(): void {
    const w = this.world;
    const [sx, sy] = this.shakeOffset();
    const zoom = this.cam.zoom * this.dpr;
    const bounds = this.viewBounds();
    if (!this.paused) this.trails.sample(w, this.frameDt, this.acc / DT);
    buildScene(w, this.fx, bounds, {
      selected: this.selected, hoverGroup: this.hoverGroup, hoverRock: this.hoverRock, hoverShip: this.hoverShip,
      alpha: this.paused ? 1 : this.acc / DT, time: this.time, zoom, trails: this.trails,
    }, this.under, this.solid, this.glow);
    this.renderer.render({
      cx: this.cam.x + sx, cy: this.cam.y + sy, zoom, time: this.time, size: w.size,
      aberration: this.fx.trauma * this.fx.trauma * 0.012, flash: this.fx.flash, flashColor: this.fx.flashColor,
    }, this.under, this.solid, this.glow);
    this.drawOverlay();
  }

  private drawOverlay(): void {
    const ctx = this.overlay;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    const w = this.world;
    ctx.font = '500 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Route being drawn with the right mouse button.
    if (this.drawn && this.drawn.length >= 4) {
      ctx.strokeStyle = 'rgba(127,227,255,0.85)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = '#5ad8ff';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(this.drawn[0], this.drawn[1]);
      for (let k = 2; k < this.drawn.length; k += 2) ctx.lineTo(this.drawn[k], this.drawn[k + 1]);
      ctx.lineTo(this.mouse.x, this.mouse.y);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1;
    }

    // Group labels: selected + hovered + large on-screen enemy groups when zoomed out.
    // Only the swarm under the cursor gets a label; everything else stays clean.
    const labelled = new Set<number>();
    if (this.hoverGroup >= 0) labelled.add(this.hoverGroup);
    for (const id of labelled) {
      const g = w.groups[id];
      if (!g?.alive || !this.onScreen(g.cx, g.cy)) continue;
      const [x, y] = this.worldToScreen(g.cx, g.cy - g.radius - 18);
      const own = g.team === this.me;
      const col = TEAM_COLORS[g.team] ?? [1, 1, 1];
      const css = `rgb(${col.map((v) => Math.round(v * 255)).join(',')})`;
      let label = `${g.count}`;
      if (g.design) {
        label = `${g.design.name} · ${g.count}/${g.design.cells.length} cells`;
        const state = orderLabel(g.order.type, false);
        if (own && state) label += ` · ${state}`;
      } else if (own) {
        label += ` · ${ROLES[g.role].name}`;
        if (g.formation !== Formation.Swarm) label += ` · ${FORMATIONS[g.formation].name}`;
        const state = orderLabel(g.order.type, g.harvesting);
        if (state) label += ` · ${state}`;
        if (g.morphT > 0) label = `${g.count} · morphing → ${ROLES[g.morphTo].name}`;
      } else {
        label += ` · ${ROLES[g.role].name}`;
      }
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 6;
      ctx.fillStyle = css;
      ctx.globalAlpha = 0.85;
      ctx.fillText(label, x, y + 0.5);
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    // Ship health bars.
    for (const s of w.ships) {
      if (!s.alive || (s.hp >= s.maxHp && this.hoverShip !== s.id) || !this.onScreen(s.x, s.y)) continue;
      const st = SHIPS[s.type];
      const [x, y] = this.worldToScreen(s.x, s.y - st.radius - 10);
      const bw = Math.max(26, st.radius * 1.6 * this.cam.zoom);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x - bw / 2 - 1, y - 1, bw + 2, 5);
      ctx.fillStyle = '#ffb357';
      ctx.fillRect(x - bw / 2, y, (bw * s.hp) / s.maxHp, 3);
      if (this.hoverShip === s.id) {
        ctx.fillStyle = '#ffd59a';
        ctx.fillText(st.name, x, y - 9);
      }
    }

    // Rock tooltip.
    if (this.hoverRock >= 0) {
      const r = w.rocks[this.hoverRock];
      if (r?.alive) {
        const [x, y] = this.worldToScreen(r.x, r.y - r.r - 16);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillText(`${Math.round(r.mass / 3)} units inside`, x, y + 0.5);
      }
    }

    // Floating texts.
    for (const t of this.fx.texts) {
      const [x, y] = this.worldToScreen(t.x, t.y);
      ctx.globalAlpha = Math.min(1, (1 - t.t / t.dur) * 2);
      ctx.font = `500 ${t.size - 2}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, x, y);
    }
    ctx.globalAlpha = 1;

    // Command pings.
    for (const p of this.pings) {
      const [x, y] = this.worldToScreen(p.x, p.y);
      // Move marker: a ring that snaps shut on the spot, so the click reads instantly even before the order lands.
      const f = p.t / 0.6;
      const k = 1 - (1 - f) * (1 - f);
      ctx.strokeStyle = p.color;
      ctx.fillStyle = p.color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = (1 - f) * 0.9;
      ctx.beginPath();
      ctx.arc(x, y, 16 - k * 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Off-screen alerts as edge arrows.
    for (const a of this.alerts) {
      if (this.onScreen(a.x, a.y)) continue;
      const [sx, sy] = this.worldToScreen(a.x, a.y);
      const cx = this.cssW / 2, cy = this.cssH / 2;
      const ang = Math.atan2(sy - cy, sx - cx);
      const m = 28;
      const tx = Math.max(m, Math.min(this.cssW - m, cx + Math.cos(ang) * 4000));
      const ty = Math.max(m + 40, Math.min(this.cssH - m - 120, cy + Math.sin(ang) * 4000));
      ctx.save();
      ctx.translate(tx, ty);
      ctx.globalAlpha = Math.min(1, a.t) * (0.7 + 0.3 * Math.sin(this.time * 8));
      ctx.rotate(ang);
      ctx.fillStyle = a.color;
      ctx.beginPath();
      ctx.moveTo(12, 0);
      ctx.lineTo(-8, -9);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-8, 9);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      if (a.label) {
        ctx.globalAlpha = Math.min(1, a.t);
        ctx.fillStyle = a.color;
        ctx.font = '500 10px Inter, system-ui, sans-serif';
        ctx.fillText(a.label, tx - Math.cos(ang) * 26, ty - Math.sin(ang) * 22);
        ctx.globalAlpha = 1;
      }
    }

    // Drag box.
    if (this.drag && this.drag.button === 0 && this.drag.box && this.drag.moved) {
      const x = Math.min(this.drag.x, this.mouse.x), y = Math.min(this.drag.y, this.mouse.y);
      const bw = Math.abs(this.mouse.x - this.drag.x), bh = Math.abs(this.mouse.y - this.drag.y);
      ctx.fillStyle = 'rgba(90,210,255,0.08)';
      ctx.strokeStyle = 'rgba(120,220,255,0.7)';
      ctx.lineWidth = 1;
      ctx.fillRect(x, y, bw, bh);
      ctx.strokeRect(x + 0.5, y + 0.5, bw, bh);
    }

    // Context cursor hint.
    const hint = this.targeting
      ? [this.targeting === 'split' ? 'Split: click where the new swarm goes' : 'Dash: click a target', '#9fe0ff'] as [string, string]
      : this.cursorHint();
    if (hint && this.mouse.in && !this.drag) {
      ctx.font = '500 11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = hint[1];
      ctx.fillText(hint[0], this.mouse.x + 16, this.mouse.y + 18);
      ctx.textAlign = 'center';
    }

    const dt = 1 / 60;
    for (const p of this.pings) p.t += dt;
    this.pings = this.pings.filter((p) => p.t < 0.6);
    for (const a of this.alerts) a.t -= dt;
    this.alerts = this.alerts.filter((a) => a.t > 0);
  }

  /** Damage advantage of the current selection against a role (>1 = we hit harder than they do). */
  private matchup(enemy: Role): number {
    let mine = 0, theirs = 0, n = 0;
    for (const id of this.selectedIds()) {
      const g = this.world.groups[id];
      mine += COUNTER[g.role][enemy] * g.count;
      theirs += COUNTER[enemy][g.role] * g.count;
      n += g.count;
    }
    return n ? mine / theirs : 1;
  }

  private cursorHint(): [string, string] | null {
    if (!this.selected.size) return null;
    if (this.hoverShip >= 0) return ['Attack', 'rgba(255,255,255,0.8)'];
    if (this.hoverGroup >= 0) {
      const g = this.world.groups[this.hoverGroup];
      if (g && g.team !== this.me) {
        const m = this.matchup(g.role);
        if (m > 1.25) return ['Attack · you have the edge', 'rgba(157,255,180,0.9)'];
        if (m < 0.8) return ['Attack · they counter you', 'rgba(255,143,122,0.9)'];
        return ['Attack', 'rgba(255,255,255,0.8)'];
      }
      return null;
    }
    if (this.hoverRock >= 0) return ['Harvest', 'rgba(255,255,255,0.8)'];
    return null;
  }

  // ------------------------------------------------------------------ input

  private bindInput(canvas: HTMLCanvasElement): void {
    const on = <K extends keyof WindowEventMap>(t: EventTarget, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    on(canvas, 'contextmenu', (e: MouseEvent) => e.preventDefault());
    on(canvas, 'pointerdown', (e: PointerEvent) => {
      this.audio.unlock();
      this.context?.close();
      // Hover is normally refreshed once per frame; refresh it now so a fast move-then-click hits what's under the cursor.
      this.mouse.x = e.offsetX;
      this.mouse.y = e.offsetY;
      this.mouse.in = true;
      this.updateHover();
      if (this.targeting && (e.button === 0 || e.button === 2)) {
        this.fireTargeting();
        return;
      }
      canvas.setPointerCapture(e.pointerId);
      // Like nohope: dragging pans the map; Shift+drag draws a selection box.
      this.drag = { x: e.offsetX, y: e.offsetY, button: e.button, cx: this.cam.tx, cy: this.cam.ty, moved: false, box: e.button === 0 && e.shiftKey };
      if (e.button === 2) this.drawn = [e.offsetX, e.offsetY];
    });
    on(canvas, 'pointermove', (e: PointerEvent) => {
      this.mouse.x = e.offsetX;
      this.mouse.y = e.offsetY;
      this.mouse.in = true;
      if (this.drag) {
        const d = Math.hypot(e.offsetX - this.drag.x, e.offsetY - this.drag.y);
        if (d > 5) this.drag.moved = true;
        if (this.drag.button === 2 && this.drag.moved && this.drawn) {
          const n = this.drawn.length;
          if (Math.hypot(e.offsetX - this.drawn[n - 2], e.offsetY - this.drawn[n - 1]) > 16) this.drawn.push(e.offsetX, e.offsetY);
        }
        if (this.drag.button === 1 || (this.drag.button === 0 && !this.drag.box && this.drag.moved)) {
          this.cam.tx = this.drag.cx - (e.offsetX - this.drag.x) / this.cam.zoom;
          this.cam.ty = this.drag.cy - (e.offsetY - this.drag.y) / this.cam.zoom;
          this.cam.x = this.cam.tx;
          this.cam.y = this.cam.ty;
        }
      }
    });
    on(canvas, 'pointerup', (e: PointerEvent) => {
      if (!this.drag) return;
      this.mouse.x = e.offsetX;
      this.mouse.y = e.offsetY;
      this.updateHover();
      const d = this.drag;
      this.drag = null;
      if (d.button === 2) {
        const pts = this.drawn;
        this.drawn = null;
        if (d.moved && pts && pts.length >= 6) this.pathOrder(pts);
        else if (this.hoverGroup >= 0 && this.world.groups[this.hoverGroup]?.team === this.me) this.openContext(this.hoverGroup);
        else this.rightClick(e.shiftKey);
        return;
      }
      if (d.button !== 0) return;
      if (d.moved) { if (d.box) this.boxSelect(d.x, d.y, e.offsetX, e.offsetY, false); }
      else this.clickSelect(e.shiftKey);
    });
    on(canvas, 'pointerleave', () => { this.mouse.in = false; });
    on(canvas, 'pointerenter', (e: PointerEvent) => {
      this.mouse.x = e.offsetX;
      this.mouse.y = e.offsetY;
      this.mouse.in = true;
    });
    on(canvas, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      this.cam.tzoom = Math.max(0.08, Math.min(4, this.cam.tzoom * f));
    }, { passive: false });
    on(window, 'keydown', (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.target instanceof HTMLInputElement) return;
      this.audio.unlock();
      if (k === 'escape' || k === 'p') {
        if (k === 'escape' && this.context?.isOpen) { this.context.close(); return; }
        if (k === 'escape' && this.targeting) { this.targeting = null; return; }
        if (k === 'escape' && this.selected.size && !this.paused && !this.menuOpen) { this.selected.clear(); return; }
        this.setPaused(this.link.networked ? !this.menuOpen : !this.paused);
        return;
      }
      if (this.paused || this.menuOpen) return;
      if (k === ' ' && this.world.teams[this.me] && !this.world.teams[this.me].alive) { e.preventDefault(); this.respawn(); return; }
      if (k === 'enter' || k === '/') { e.preventDefault(); this.hud?.dock.focus(); return; }
      if (k === 'y') { this.hud?.toggleResearch(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'a') { e.preventDefault(); this.action('selectAll'); return; }
      if (k === '`') { this.action('selectAll'); return; }
      if (k === 'tab' || k === ' ') e.preventDefault();
      if (k.startsWith('arrow')) { this.keys.add(k); e.preventDefault(); return; }
      const a = KEYMAP[k];
      if (a && !e.repeat) this.action(a);
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase()));
    on(window, 'blur', () => this.keys.clear());
  }

  private updateHover(): void {
    const [wx, wy] = this.screenToWorld(this.mouse.x, this.mouse.y);
    this.mouse.wx = wx;
    this.mouse.wy = wy;
    this.hoverGroup = this.hoverRock = this.hoverShip = -1;
    if (!this.mouse.in) return;
    const w = this.world;
    for (const s of w.ships) {
      if (s.alive && Math.hypot(s.x - wx, s.y - wy) < SHIPS[s.type].radius + 8 / this.cam.zoom) { this.hoverShip = s.id; return; }
    }
    // Nearest unit under cursor, with a generous screen-space radius.
    const r = Math.max(10, 14 / this.cam.zoom);
    let best = -1, bestD = r * r;
    w.grid.query(wx, wy, r, (i) => {
      if (!w.ualive[i]) return;
      const dx = w.ux[i] - wx, dy = w.uy[i] - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; best = i; }
    });
    if (best >= 0) { this.hoverGroup = w.ugroup[best]; return; }
    // Fall back to group discs (handy when zoomed far out).
    for (const g of w.groups) {
      if (g.alive && Math.hypot(g.cx - wx, g.cy - wy) < g.radius + 6 / this.cam.zoom) { this.hoverGroup = g.id; return; }
    }
    for (const rk of w.rocks) {
      if (rk.alive && Math.hypot(rk.x - wx, rk.y - wy) < rk.r * 1.15 + 6) { this.hoverRock = rk.id; return; }
    }
  }

  private clickSelect(shift: boolean): void {
    const now = performance.now();
    const dbl = now - this.lastClick < 300;
    this.lastClick = now;
    const g = this.hoverGroup >= 0 ? this.world.groups[this.hoverGroup] : null;
    if (g && g.team === this.me) {
      if (dbl) {
        // Double-click: all own groups on screen.
        for (const o of this.world.groupsOf(this.me)) if (this.onScreen(o.cx, o.cy)) this.selected.add(o.id);
      } else if (shift) {
        if (this.selected.has(g.id)) this.selected.delete(g.id);
        else this.selected.add(g.id);
      } else {
        this.selected.clear();
        this.selected.add(g.id);
      }
      this.audio.ui('select');
      this.hud?.notify('select');
    } else {
      // Click to move (or attack / harvest what's under the cursor), nohope-style.
      // With nothing selected, the click commands every swarm you have.
      if (!this.selectedIds().length) for (const o of this.world.groupsOf(this.me)) this.selected.add(o.id);
      this.rightClick(shift);
    }
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, shift: boolean): void {
    const [ax, ay] = this.screenToWorld(Math.min(x0, x1), Math.min(y0, y1));
    const [bx, by] = this.screenToWorld(Math.max(x0, x1), Math.max(y0, y1));
    if (!shift) this.selected.clear();
    const w = this.world;
    for (let i = 0; i < w.hi; i++) {
      if (!w.ualive[i] || w.uteam[i] !== this.me) continue;
      const x = w.ux[i], y = w.uy[i];
      if (x >= ax && x <= bx && y >= ay && y <= by) this.selected.add(w.ugroup[i]);
    }
    if (this.selected.size) {
      this.audio.ui('select');
      this.hud?.notify('select');
    }
  }

  private rightClick(shift: boolean): void {
    const ids = this.selectedIds();
    if (!ids.length) return;
    const w = this.world;
    const [wx, wy] = this.screenToWorld(this.mouse.x, this.mouse.y);
    if (this.hoverShip >= 0) {
      this.issue({ op: 'attackShip', ids, target: this.hoverShip });
      this.ping(wx, wy, '#ff7b6b');
    } else if (this.hoverGroup >= 0 && w.groups[this.hoverGroup].team !== this.me) {
      this.issue({ op: 'attack', ids, target: this.hoverGroup });
      this.ping(wx, wy, '#ff7b6b');
    } else if (this.hoverGroup >= 0 && !this.selected.has(this.hoverGroup)) {
      this.joinGroup(this.hoverGroup);
    } else if (this.hoverRock >= 0) {
      this.issue({ op: 'harvest', ids, rock: this.hoverRock });
      const r = w.rocks[this.hoverRock];
      this.ping(r.x, r.y, '#e8c98f');
    } else if (shift) {
      this.issue({ op: 'queue', ids, x: wx, y: wy });
      this.ping(wx, wy, '#7fe3ff');
    } else {
      this.issue({ op: 'move', ids, x: wx, y: wy });
      this.ping(wx, wy, '#7fe3ff');
    }
    this.audio.ui('order');
  }

  /** Send the selection over to a friendly swarm and merge when they meet. */
  joinGroup(target: number): void {
    const ids = this.selectedIds().filter((id) => id !== target);
    const t = this.world.groups[target];
    if (!ids.length || !t?.alive) return;
    this.issue({ op: 'move', ids, x: t.cx, y: t.cy });
    this.pendingMerges.push({ target, ids, sent: new Set(), at: performance.now() });
    this.ping(t.cx, t.cy, '#9fe0ff');
    this.audio.ui('order');
  }

  private openContext(id: number): void {
    if (!this.context) return;
    const others = this.selectedIds().filter((x) => x !== id);
    const joinable = !this.selected.has(id) && others.length > 0;
    if (!this.selected.has(id)) {
      // Right-clicking a swarm outside the selection targets that swarm (and can absorb the current selection).
      this.context.open(this.mouse.x, this.mouse.y, [id], joinable ? others : []);
    } else this.context.open(this.mouse.x, this.mouse.y, this.selectedIds(), []);
    this.audio.ui('select');
  }

  /** Split and Dash from the context menu aim with the next click. */
  startTargeting(kind: 'split' | 'dash', ids: number[]): void {
    this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.targeting = kind;
  }

  private fireTargeting(): void {
    const kind = this.targeting;
    this.targeting = null;
    this.drag = null;
    if (kind) this.action(kind);
  }

  private pendingMerges: { target: number; ids: number[]; sent: Set<number>; at: number }[] = [];
  private drawn: number[] | null = null; // screen-space polyline while right-dragging

  private pathOrder(screenPts: number[]): void {
    const ids = this.selectedIds();
    if (!ids.length) return;
    // Resample to evenly spaced world waypoints so swarms flow smoothly along the stroke.
    const world: number[] = [];
    for (let k = 0; k < screenPts.length; k += 2) world.push(...this.screenToWorld(screenPts[k], screenPts[k + 1]));
    const step = 70;
    const out: number[] = [];
    let carry = 0;
    for (let k = 2; k < world.length; k += 2) {
      const x0 = world[k - 2], y0 = world[k - 1], x1 = world[k], y1 = world[k + 1];
      const seg = Math.hypot(x1 - x0, y1 - y0);
      let t = step - carry;
      while (t <= seg) {
        out.push(x0 + ((x1 - x0) * t) / seg, y0 + ((y1 - y0) * t) / seg);
        t += step;
      }
      carry = (carry + seg) % step;
    }
    out.push(world[world.length - 2], world[world.length - 1]);
    this.issue({ op: 'path', ids, points: pairs(out) });
    this.ping(out[out.length - 2], out[out.length - 1], '#7fe3ff');
    this.audio.ui('order');
    this.hud?.notify('path');
  }

  private pruneSelection(): void {
    const w = this.world;
    for (const id of this.selected) if (!w.groups[id]?.alive) this.selected.delete(id);
    // Resolve fly-over merges.
    this.pendingMerges = this.pendingMerges.filter((pm) => {
      const t = w.groups[pm.target];
      if (!t?.alive) return false;
      const live = pm.ids.filter((id) => w.groups[id]?.alive && w.groups[id].team === this.me && w.groups[id].order.type === 'move' && !pm.sent.has(id));
      if (!live.length) return pm.sent.size > 0 && performance.now() - pm.at < 3000 && pm.ids.some((id) => w.groups[id]?.alive && !pm.sent.has(id));
      const ready = live.filter((id) => Math.hypot(w.groups[id].cx - t.cx, w.groups[id].cy - t.cy) < t.radius + w.groups[id].radius + 30);
      if (ready.length) {
        this.issue({ op: 'merge', ids: [t.id, ...ready] });
        for (const id of ready) pm.sent.add(id);
        pm.at = performance.now();
      }
      return live.length > ready.length;
    });
  }

  private ping(x: number, y: number, color: string): void {
    this.pings.push({ x, y, t: 0, color });
  }

  selectedIds(): number[] {
    return [...this.selected].filter((id) => this.world.groups[id]?.alive);
  }

  /** Execute a command on the current selection (keyboard or HUD button). */
  action(a: Action): void {
    const w = this.world;
    const ids = this.selectedIds();
    const [mx, my] = this.screenToWorld(this.mouse.x, this.mouse.y);
    let ok = true;
    switch (a) {
      case 'selectAll':
        for (const g of w.groupsOf(this.me)) this.selected.add(g.id);
        this.audio.ui('select');
        return;
      case 'cycle': {
        const own = w.groupsOf(this.me);
        if (!own.length) return;
        this.cycleIdx = (this.cycleIdx + 1) % own.length;
        const g = own[this.cycleIdx];
        this.selected.clear();
        this.selected.add(g.id);
        this.focus(g.cx, g.cy);
        this.audio.ui('select');
        return;
      }
      case 'center': {
        if (!ids.length) return;
        let x = 0, y = 0;
        for (const id of ids) { x += w.groups[id].cx; y += w.groups[id].cy; }
        this.focus(x / ids.length, y / ids.length);
        return;
      }
    }
    if (!ids.length) {
      this.audio.ui('error');
      return;
    }
    const batch = ++this.batchId;
    switch (a) {
      case 'split':
        // The new halves get selected when the split lands (see onResult).
        for (const id of ids) {
          const g = w.groups[id];
          ok = ok && g.count >= 2;
          this.issue({ op: 'split', id, dx: mx - g.cx || 1, dy: my - g.cy, sel: true, batch });
        }
        break;
      case 'merge':
        if (ids.length < 2) { ok = false; break; }
        this.issue({ op: 'merge', ids });
        break;
      case 'replicate':
        ok = ids.some((id) => w.groups[id].count >= REPLICATE_MIN && !w.groups[id].cells);
        this.issue({ op: 'replicate', ids });
        break;
      case 'research':
        this.issue({ op: 'research', ids });
        break;
      case 'stop':
        this.issue({ op: 'hold', ids });
        break;
      case 'dash':
        ok = this.abilityState('dash').energy;
        this.issue({ op: 'dash', ids, x: mx, y: my });
        break;
      case 'shield':
        ok = this.abilityState('shield').energy;
        this.issue({ op: 'shield', ids });
        break;
      case 'nova':
        ok = this.abilityState('nova').energy;
        this.issue({ op: 'nova', ids });
        break;
      case 'f0': case 'f1': case 'f2': case 'f3':
        this.issue({ op: 'formation', ids, name: FORMATIONS[Number(a[1])].name });
        break;
      case 'm0': case 'm1': case 'm2': case 'm3': case 'm4': {
        const role = Number(a[1]) as Role;
        this.issue({ op: 'morph', ids, role: ROLES[role].name });
        break;
      }
    }
    this.audio.ui(ok ? 'click' : 'error');
  }

  /** For HUD: cooldown fraction 0..1 (1 = ready) and whether affordable, across selection. */
  abilityState(kind: 'dash' | 'shield' | 'nova', ids = this.selectedIds()): { ready: number; energy: boolean } {
    let best = 0, energy = false;
    const def = kind === 'dash' ? DASH : kind === 'shield' ? SHIELD : NOVA;
    for (const id of ids) {
      const g = this.world.groups[id];
      const cd = kind === 'dash' ? g.cdDash : kind === 'shield' ? g.cdShield : g.cdNova;
      best = Math.max(best, 1 - cd / def.cooldown);
      if (g.energy >= def.cost) energy = true;
    }
    return { ready: best, energy };
  }
}

function orderLabel(t: string, harvesting: boolean): string {
  switch (t) {
    case 'replicate': return 'Replicating';
    case 'research': return 'Researching';
    case 'harvest': return harvesting ? 'Harvesting' : 'To rock';
    case 'attack': return 'Attacking';
    case 'move': return 'Moving';
    default: return '';
  }
}


function pairs(flat: number[]): number[][] {
  const out: number[][] = [];
  for (let k = 0; k + 1 < flat.length; k += 2) out.push([flat[k], flat[k + 1]]);
  return out;
}
