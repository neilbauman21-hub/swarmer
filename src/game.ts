import { DASH, DT, Difficulty, FORMATIONS, Formation, NOVA, ROLES, Role, SHIELD, SHIPS, TEAM_COLORS } from './sim/config';
import { World, type GameEvent } from './sim/world';
import { Fx } from './render/fx';
import { Renderer, SpriteBatch } from './render/renderer';
import { buildScene } from './render/scene';
import type { Audio } from './ui/audio';
import { Hud } from './ui/hud';

export interface GameOptions {
  difficulty: Difficulty;
  rivals: number;
  size: number;
  seed?: number;
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
  readonly hud: Hud;
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
  private drag: { x: number; y: number; button: number; cx: number; cy: number; moved: boolean } | null = null;
  private keys = new Set<string>();
  private hoverGroup = -1;
  private hoverRock = -1;
  private hoverShip = -1;
  private pings: Ping[] = [];
  private alerts: Ping[] = [];
  private lastClick = 0;
  private cycleIdx = 0;
  private ended = false;
  private cleanup: (() => void)[] = [];
  onEnd: ((won: boolean) => void) | null = null;
  onPause: ((paused: boolean) => void) | null = null;

  constructor(readonly root: HTMLElement, readonly opts: GameOptions, readonly audio: Audio) {
    this.world = new World({ seed: opts.seed, size: opts.size, rivals: opts.rivals, difficulty: opts.difficulty });
    const canvas = document.createElement('canvas');
    canvas.className = 'gl';
    const over = document.createElement('canvas');
    over.className = 'overlay';
    root.append(canvas, over);
    this.renderer = new Renderer(canvas);
    this.overlay = over.getContext('2d')!;
    const home = this.world.teams[0];
    this.cam = { x: home.homeX, y: home.homeY, zoom: 1.1, tx: home.homeX, ty: home.homeY, tzoom: 1.1 };
    this.hud = new Hud(root, this);
    this.bindInput(canvas);
    this.resize();
    const start = this.world.groupsOf(0)[0];
    if (start) this.selected.add(start.id);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    for (const c of this.cleanup) c();
    this.hud.destroy();
    this.root.innerHTML = '';
  }

  setPaused(p: boolean): void {
    if (this.ended) return;
    this.paused = p;
    this.onPause?.(p);
  }

  // ------------------------------------------------------------------ loop

  private frame = (now: number): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.resize();
    const events: GameEvent[] = [];
    if (!this.paused) {
      let scale = 1;
      if (this.fx.hitstop > 0) {
        this.fx.hitstop -= dt;
        scale = 0.12;
      }
      this.acc += dt * scale;
      let steps = 0;
      while (this.acc >= DT && steps < 4) {
        this.world.step();
        for (const e of this.world.drainEvents()) events.push(e);
        this.acc -= DT;
        steps++;
      }
      if (steps === 4) this.acc = 0;
      this.time += dt;
      this.fx.update(dt * (this.fx.hitstop > 0 ? 0.25 : 1));
    }
    const bounds = this.viewBounds();
    this.fx.handle(events, bounds);
    this.audio.tick(dt);
    this.audio.play(events, (x, y) => this.audibility(x, y));
    this.onEvents(events);
    this.pruneSelection();
    this.updateCamera(dt);
    this.updateHover();
    this.render();
    this.hud.update(dt);
    this.checkEnd();
  };

  private onEvents(events: GameEvent[]): void {
    for (const e of events) {
      if (e.t === 'wave') {
        const dir = this.compass(e.x, e.y);
        this.hud.banner(`Raider fleet inbound from the ${dir} — ${e.n} ships`, '#ffb357');
        this.alerts.push({ x: e.x, y: e.y, t: 8, color: '#ffb357', label: 'Raiders' });
      }
    }
    // Alert when an off-screen player group is in a fight.
    for (const g of this.world.groupsOf(0)) {
      if (g.combatT < 0.05 && g.recentLoss > 2 && !this.onScreen(g.cx, g.cy)) {
        if (!this.alerts.some((a) => Math.hypot(a.x - g.cx, a.y - g.cy) < 300 && a.t > 2)) {
          this.alerts.push({ x: g.cx, y: g.cy, t: 4, color: '#ff6b5a', label: 'Under attack' });
        }
      }
    }
  }

  private compass(x: number, y: number): string {
    const s = this.world.size;
    const dx = x - s / 2, dy = y - s / 2;
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'east' : 'west';
    return dy > 0 ? 'south' : 'north';
  }

  private checkEnd(): void {
    if (this.ended || this.world.winner < 0) return;
    this.ended = true;
    const won = this.world.winner === 0;
    setTimeout(() => this.onEnd?.(won), won ? 1200 : 1800);
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
    // Edge panning.
    if (this.mouse.in && !this.drag && document.pointerLockElement == null) {
      const m = 6;
      if (this.mouse.x < m) c.tx -= pan;
      if (this.mouse.x > this.cssW - m) c.tx += pan;
      if (this.mouse.y < m) c.ty -= pan;
      if (this.mouse.y > this.cssH - m) c.ty += pan;
    }
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
    buildScene(w, this.fx, bounds, {
      selected: this.selected, hoverGroup: this.hoverGroup, hoverRock: this.hoverRock, hoverShip: this.hoverShip,
      alpha: this.paused ? 0 : this.acc / DT, time: this.time, zoom,
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
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Order lines for selected groups.
    ctx.setLineDash([4, 6]);
    ctx.lineDashOffset = -this.time * 20;
    for (const id of this.selected) {
      const g = w.groups[id];
      if (!g?.alive) continue;
      const tgt = this.orderTarget(id);
      if (!tgt) continue;
      const [x1, y1] = this.worldToScreen(g.cx, g.cy);
      const [x2, y2] = this.worldToScreen(tgt[0], tgt[1]);
      ctx.strokeStyle = tgt[2];
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Group labels: selected + hovered + large on-screen enemy groups when zoomed out.
    const labelled = new Set<number>(this.selected);
    if (this.hoverGroup >= 0) labelled.add(this.hoverGroup);
    for (const id of labelled) {
      const g = w.groups[id];
      if (!g?.alive || !this.onScreen(g.cx, g.cy)) continue;
      const [x, y] = this.worldToScreen(g.cx, g.cy - g.radius - 18);
      const own = g.team === 0;
      const col = TEAM_COLORS[g.team] ?? [1, 1, 1];
      const css = `rgb(${col.map((v) => Math.round(v * 255)).join(',')})`;
      let label = `${g.count}`;
      if (own) {
        label += ` · ${ROLES[g.role].name}`;
        if (g.formation !== Formation.Swarm) label += ` · ${FORMATIONS[g.formation].name}`;
        const state = orderLabel(g.order.type, g.harvesting);
        if (state) label += ` · ${state}`;
        if (g.morphT > 0) label = `${g.count} · morphing → ${ROLES[g.morphTo].name}`;
      }
      const tw = ctx.measureText(label).width + 14;
      ctx.fillStyle = 'rgba(6,10,20,0.72)';
      roundRect(ctx, x - tw / 2, y - 9, tw, 18, 9);
      ctx.fill();
      ctx.fillStyle = css;
      ctx.fillText(label, x, y + 0.5);
      if (own) {
        // Energy bar.
        const bw = Math.max(36, tw - 18);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x - bw / 2, y + 11, bw, 3);
        ctx.fillStyle = '#7fe3ff';
        ctx.fillRect(x - bw / 2, y + 11, (bw * g.energy) / 100, 3);
      }
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
        ctx.fillStyle = 'rgba(6,10,20,0.72)';
        const txt = `${r.wreck ? 'Wreck' : 'Asteroid'} · ${Math.round(r.mass / 3)} units of mass`;
        const tw = ctx.measureText(txt).width + 14;
        roundRect(ctx, x - tw / 2, y - 9, tw, 18, 9);
        ctx.fill();
        ctx.fillStyle = '#d9cbb5';
        ctx.fillText(txt, x, y + 0.5);
      }
    }

    // Floating texts.
    for (const t of this.fx.texts) {
      const [x, y] = this.worldToScreen(t.x, t.y);
      ctx.globalAlpha = Math.min(1, (1 - t.t / t.dur) * 2);
      ctx.font = `700 ${t.size}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, x, y);
    }
    ctx.globalAlpha = 1;

    // Command pings.
    for (const p of this.pings) {
      const [x, y] = this.worldToScreen(p.x, p.y);
      const f = 1 - p.t / 0.5;
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = 1 - f;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 6 + f * 18, 0, Math.PI * 2);
      ctx.stroke();
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
        ctx.font = '700 10px Inter, system-ui, sans-serif';
        ctx.fillText(a.label, tx - Math.cos(ang) * 26, ty - Math.sin(ang) * 22);
        ctx.globalAlpha = 1;
      }
    }

    // Drag box.
    if (this.drag && this.drag.button === 0 && this.drag.moved) {
      const x = Math.min(this.drag.x, this.mouse.x), y = Math.min(this.drag.y, this.mouse.y);
      const bw = Math.abs(this.mouse.x - this.drag.x), bh = Math.abs(this.mouse.y - this.drag.y);
      ctx.fillStyle = 'rgba(90,210,255,0.08)';
      ctx.strokeStyle = 'rgba(120,220,255,0.7)';
      ctx.lineWidth = 1;
      ctx.fillRect(x, y, bw, bh);
      ctx.strokeRect(x + 0.5, y + 0.5, bw, bh);
    }

    // Context cursor hint.
    const hint = this.cursorHint();
    if (hint && this.mouse.in && !this.drag) {
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = hint[1];
      ctx.fillText(hint[0], this.mouse.x + 16, this.mouse.y + 18);
      ctx.textAlign = 'center';
    }

    const dt = 1 / 60;
    for (const p of this.pings) p.t += dt;
    this.pings = this.pings.filter((p) => p.t < 0.5);
    for (const a of this.alerts) a.t -= dt;
    this.alerts = this.alerts.filter((a) => a.t > 0);
  }

  private orderTarget(id: number): [number, number, string] | null {
    const g = this.world.groups[id];
    const o = g.order;
    if (o.type === 'move') return [o.x, o.y, '#7fe3ff'];
    if (o.type === 'harvest') {
      const r = this.world.rocks[o.rock];
      return r?.alive && !g.harvesting ? [r.x, r.y, '#e8c98f'] : null;
    }
    if (o.type === 'attack') {
      if (o.group >= 0) {
        const t = this.world.groups[o.group];
        return t?.alive ? [t.cx, t.cy, '#ff7b6b'] : null;
      }
      const s = this.world.ships[o.ship];
      return s?.alive ? [s.x, s.y, '#ff7b6b'] : null;
    }
    return null;
  }

  private cursorHint(): [string, string] | null {
    if (!this.selected.size) return null;
    if (this.hoverShip >= 0) return ['Attack', '#ff8f7a'];
    if (this.hoverGroup >= 0) {
      const g = this.world.groups[this.hoverGroup];
      if (g && g.team !== 0) return ['Attack', '#ff8f7a'];
      if (g && !this.selected.has(g.id)) return ['Merge', '#9fe0ff'];
      return null;
    }
    if (this.hoverRock >= 0) return ['Harvest', '#e8c98f'];
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
      canvas.setPointerCapture(e.pointerId);
      this.drag = { x: e.offsetX, y: e.offsetY, button: e.button, cx: this.cam.tx, cy: this.cam.ty, moved: false };
      if (e.button === 2) {
        this.rightClick(e.shiftKey);
        this.drag = null;
      }
    });
    on(canvas, 'pointermove', (e: PointerEvent) => {
      this.mouse.x = e.offsetX;
      this.mouse.y = e.offsetY;
      this.mouse.in = true;
      if (this.drag) {
        const d = Math.hypot(e.offsetX - this.drag.x, e.offsetY - this.drag.y);
        if (d > 5) this.drag.moved = true;
        if (this.drag.button === 1) {
          this.cam.tx = this.drag.cx - (e.offsetX - this.drag.x) / this.cam.zoom;
          this.cam.ty = this.drag.cy - (e.offsetY - this.drag.y) / this.cam.zoom;
          this.cam.x = this.cam.tx;
          this.cam.y = this.cam.ty;
        }
      }
    });
    on(canvas, 'pointerup', (e: PointerEvent) => {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      if (d.button !== 0) return;
      if (d.moved) this.boxSelect(d.x, d.y, e.offsetX, e.offsetY, e.shiftKey);
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
        if (k === 'escape' && this.selected.size && !this.paused) { this.selected.clear(); return; }
        this.setPaused(!this.paused);
        return;
      }
      if (this.paused) return;
      if (k === 'y') { this.hud.toggleResearch(); return; }
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
    if (g && g.team === 0) {
      if (dbl) {
        // Double-click: all own groups on screen.
        for (const o of this.world.groupsOf(0)) if (this.onScreen(o.cx, o.cy)) this.selected.add(o.id);
      } else if (shift) {
        if (this.selected.has(g.id)) this.selected.delete(g.id);
        else this.selected.add(g.id);
      } else {
        this.selected.clear();
        this.selected.add(g.id);
      }
      this.audio.ui('select');
      this.hud.notify('select');
    } else if (!shift) {
      this.selected.clear();
    }
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, shift: boolean): void {
    const [ax, ay] = this.screenToWorld(Math.min(x0, x1), Math.min(y0, y1));
    const [bx, by] = this.screenToWorld(Math.max(x0, x1), Math.max(y0, y1));
    if (!shift) this.selected.clear();
    const w = this.world;
    for (let i = 0; i < w.hi; i++) {
      if (!w.ualive[i] || w.uteam[i] !== 0) continue;
      const x = w.ux[i], y = w.uy[i];
      if (x >= ax && x <= bx && y >= ay && y <= by) this.selected.add(w.ugroup[i]);
    }
    if (this.selected.size) {
      this.audio.ui('select');
      this.hud.notify('select');
    }
  }

  private rightClick(shift: boolean): void {
    const ids = this.selectedIds();
    if (!ids.length) return;
    const w = this.world;
    const [wx, wy] = this.screenToWorld(this.mouse.x, this.mouse.y);
    void shift;
    if (this.hoverShip >= 0) {
      w.cmdAttackShip(ids, this.hoverShip);
      this.ping(wx, wy, '#ff7b6b');
      this.hud.notify('attack');
    } else if (this.hoverGroup >= 0 && w.groups[this.hoverGroup].team !== 0) {
      w.cmdAttackGroup(ids, this.hoverGroup);
      this.ping(wx, wy, '#ff7b6b');
      this.hud.notify('attack');
    } else if (this.hoverGroup >= 0 && !this.selected.has(this.hoverGroup)) {
      // Join a friendly group: merge right away if close, otherwise fly over and merge.
      const target = w.groups[this.hoverGroup];
      w.cmdMove(ids, target.cx, target.cy);
      this.pendingMerges.push({ target: target.id, ids });
      this.ping(target.cx, target.cy, '#9fe0ff');
    } else if (this.hoverRock >= 0) {
      w.cmdHarvest(ids, this.hoverRock);
      const r = w.rocks[this.hoverRock];
      this.ping(r.x, r.y, '#e8c98f');
      this.hud.notify('harvest');
    } else {
      w.cmdMove(ids, wx, wy);
      this.ping(wx, wy, '#7fe3ff');
      this.hud.notify('move');
    }
    this.audio.ui('order');
  }

  private pendingMerges: { target: number; ids: number[] }[] = [];

  private pruneSelection(): void {
    const w = this.world;
    for (const id of this.selected) if (!w.groups[id]?.alive) this.selected.delete(id);
    // Resolve fly-over merges.
    this.pendingMerges = this.pendingMerges.filter((pm) => {
      const t = w.groups[pm.target];
      if (!t?.alive) return false;
      const live = pm.ids.filter((id) => w.groups[id]?.alive && w.groups[id].order.type === 'move');
      if (!live.length) return false;
      const ready = live.filter((id) => Math.hypot(w.groups[id].cx - t.cx, w.groups[id].cy - t.cy) < t.radius + w.groups[id].radius + 30);
      if (ready.length) {
        const keep = w.cmdMerge([t.id, ...ready]);
        for (const id of ready) this.selected.delete(id);
        if (keep >= 0 && ready.length) this.selected.add(keep);
        this.hud.notify('merge');
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
        for (const g of w.groupsOf(0)) this.selected.add(g.id);
        this.audio.ui('select');
        return;
      case 'cycle': {
        const own = w.groupsOf(0);
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
    switch (a) {
      case 'split': {
        const fresh: number[] = [];
        for (const id of ids) {
          const g = w.groups[id];
          const nid = w.cmdSplit(id, mx - g.cx, my - g.cy);
          if (nid >= 0) fresh.push(nid);
        }
        ok = fresh.length > 0;
        if (ok) {
          // Select the halves nearest the cursor so they can be sent off immediately.
          this.selected.clear();
          for (const id of fresh) this.selected.add(id);
          this.hud.notify('split');
        }
        break;
      }
      case 'merge': {
        if (ids.length < 2) { ok = false; break; }
        const keep = w.cmdMerge(ids);
        this.selected.clear();
        if (keep >= 0) this.selected.add(keep);
        this.hud.notify('merge');
        break;
      }
      case 'replicate':
        ok = w.cmdReplicate(ids);
        if (ok) this.hud.notify('replicate');
        break;
      case 'research':
        w.cmdResearch(ids);
        this.hud.notify('research');
        break;
      case 'stop':
        w.cmdStop(ids);
        break;
      case 'dash':
        ok = w.cmdDash(ids, mx, my);
        if (ok) this.hud.notify('ability');
        break;
      case 'shield':
        ok = w.cmdShield(ids);
        if (ok) this.hud.notify('ability');
        break;
      case 'nova':
        ok = w.cmdNova(ids);
        if (ok) this.hud.notify('ability');
        break;
      case 'f0': case 'f1': case 'f2': case 'f3':
        w.cmdFormation(ids, Number(a[1]) as Formation);
        this.hud.notify('formation');
        break;
      case 'm0': case 'm1': case 'm2': case 'm3': case 'm4':
        w.cmdMorph(ids, Number(a[1]) as Role);
        this.hud.notify('morph');
        break;
    }
    this.audio.ui(ok ? 'click' : 'error');
  }

  /** For HUD: cooldown fraction 0..1 (1 = ready) and whether affordable, across selection. */
  abilityState(kind: 'dash' | 'shield' | 'nova'): { ready: number; energy: boolean } {
    const ids = this.selectedIds();
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

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
