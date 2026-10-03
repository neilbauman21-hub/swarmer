import { SHIP_COLOR, SHIP_TEAM, TEAM_COLORS } from '../sim/config';
import type { GameEvent } from '../sim/world';
import { Shape, SpriteBatch } from './renderer';

const CAP = 9000;

export type RGB = [number, number, number];

export function teamColor(team: number | undefined): RGB {
  if (team === undefined || team < 0) return [0.75, 0.68, 0.6];
  if (team === SHIP_TEAM) return SHIP_COLOR;
  return TEAM_COLORS[team] ?? [1, 1, 1];
}

interface Ring { x: number; y: number; r0: number; r1: number; t: number; dur: number; c: RGB; th: number; a: number }
interface Beam { x1: number; y1: number; x2: number; y2: number; t: number; dur: number; c: RGB; w: number }
export interface FloatText { x: number; y: number; text: string; t: number; dur: number; color: string; size: number }

export interface Bounds { x0: number; y0: number; x1: number; y1: number }

/** Purely visual particles and feedback (screen shake, hit-stop, flashes). */
export class Fx {
  private px = new Float32Array(CAP);
  private py = new Float32Array(CAP);
  private vx = new Float32Array(CAP);
  private vy = new Float32Array(CAP);
  private life = new Float32Array(CAP);
  private max = new Float32Array(CAP);
  private size = new Float32Array(CAP);
  private cr = new Float32Array(CAP);
  private cg = new Float32Array(CAP);
  private cb = new Float32Array(CAP);
  private drag = new Float32Array(CAP);
  private n = 0;
  private rings: Ring[] = [];
  private beams: Beam[] = [];
  texts: FloatText[] = [];

  trauma = 0; // screen shake, 0..1
  hitstop = 0; // seconds of slowed time remaining
  flash = 0;
  flashColor: RGB = [1, 1, 1];

  spark(x: number, y: number, vx: number, vy: number, life: number, size: number, c: RGB, drag = 3, bright = 1): void {
    let i = this.n;
    if (i >= CAP) i = (Math.random() * CAP) | 0; // overwrite a random one when saturated
    else this.n++;
    this.px[i] = x; this.py[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.max[i] = life; this.size[i] = size;
    this.cr[i] = c[0] * bright; this.cg[i] = c[1] * bright; this.cb[i] = c[2] * bright;
    this.drag[i] = drag;
  }

  burst(x: number, y: number, count: number, speed: number, life: number, size: number, c: RGB, bright = 1): void {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.9);
      this.spark(x, y, Math.cos(a) * s, Math.sin(a) * s, life * (0.5 + Math.random() * 0.8), size * (0.6 + Math.random() * 0.8), c, 3, bright);
    }
  }

  ring(x: number, y: number, r0: number, r1: number, dur: number, c: RGB, th = 0.15, a = 1): void {
    this.rings.push({ x, y, r0, r1, t: 0, dur, c, th, a });
  }

  text(x: number, y: number, text: string, color: string, size = 14, dur = 1.2): void {
    this.texts.push({ x, y, text, t: 0, dur, color, size });
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  handle(events: GameEvent[], view: Bounds): void {
    const inView = (x: number, y: number, m = 200) => x > view.x0 - m && x < view.x1 + m && y > view.y0 - m && y < view.y1 + m;
    let tracers = 0;
    for (const e of events) {
      const c = teamColor(e.team);
      switch (e.t) {
        case 'tracer':
          if (!inView(e.x, e.y) || tracers++ > 260) break;
          this.beams.push({ x1: e.x, y1: e.y, x2: e.x2!, y2: e.y2!, t: 0, dur: e.r ? 0.16 : 0.09, c, w: e.r ? 3.5 : 1.3 });
          if (Math.random() < 0.35) this.spark(e.x2!, e.y2!, (Math.random() - 0.5) * 80, (Math.random() - 0.5) * 80, 0.15, 2.2, c, 6, 1.4);
          break;
        case 'melee':
          if (!inView(e.x, e.y)) break;
          this.burst(e.x, e.y, 2, 140, 0.18, 2, c, 1.6);
          break;
        case 'hitShip':
          if (!inView(e.x, e.y)) break;
          this.burst(e.x, e.y, 2, 160, 0.25, 2.2, [1, 0.9, 0.6], 1.5);
          break;
        case 'death':
          if (!inView(e.x, e.y)) break;
          for (let k = 0; k < 5; k++) {
            const a = Math.random() * Math.PI * 2, s = 40 + Math.random() * 120;
            this.spark(e.x, e.y, Math.cos(a) * s + (e.x2 ?? 0) * 0.3, Math.sin(a) * s + (e.y2 ?? 0) * 0.3, 0.35 + Math.random() * 0.3, 2.4, c, 4, 1.3);
          }
          this.spark(e.x, e.y, 0, 0, 0.18, 9, c, 0, 0.9);
          break;
        case 'spawn':
          if (!inView(e.x, e.y)) break;
          this.spark(e.x, e.y, 0, 0, 0.35, 7, c, 0, 0.7);
          break;
        case 'harvest':
          if (!inView(e.x, e.y)) break;
          this.burst(e.x, e.y, 3, 60, 0.4, 2.2, [0.9, 0.8, 0.6], 1.1);
          break;
        case 'explode': {
          if (!inView(e.x, e.y, 400)) break;
          const r = e.r ?? 40;
          const col: RGB = e.team === SHIP_TEAM ? [1, 0.55, 0.2] : e.team === -1 ? [0.9, 0.75, 0.55] : c;
          this.ring(e.x, e.y, r * 0.2, r * 1.15, 0.35, col, 0.12);
          this.spark(e.x, e.y, 0, 0, 0.22, r * 1.1, col, 0, 1.2);
          this.burst(e.x, e.y, Math.min(16, 4 + r / 6), r * 4, 0.45, 2.6, col, 1.3);
          this.shake(Math.min(0.25, r / 500));
          break;
        }
        case 'bomb':
          this.ring(e.x, e.y, 10, e.r ?? 80, 0.3, [1, 0.3, 0.2], 0.05, 0.6);
          break;
        case 'shellFire':
          if (!inView(e.x, e.y)) break;
          this.spark(e.x, e.y, 0, 0, 0.12, e.r ? 18 : 8, e.r ? [1, 0.6, 0.25] : c, 0, 1.4);
          break;
        case 'shipDeath': {
          const r = e.r ?? 20;
          this.ring(e.x, e.y, r, r * 7, 0.6, [1, 0.7, 0.35], 0.08);
          this.ring(e.x, e.y, r * 0.5, r * 4, 0.4, [1, 1, 1], 0.2);
          this.spark(e.x, e.y, 0, 0, 0.35, r * 3.5, [1, 0.7, 0.4], 0, 1.4);
          this.burst(e.x, e.y, 30 + r, 420, 0.9, 3.2, [1, 0.65, 0.3], 1.4);
          this.burst(e.x, e.y, 12, 200, 1.4, 4, [0.8, 0.8, 0.9], 0.9);
          if (inView(e.x, e.y)) {
            this.shake(0.35 + r / 120);
            this.hitstop = Math.max(this.hitstop, 0.07);
          }
          break;
        }
        case 'nova': {
          const r = e.r ?? 150;
          this.ring(e.x, e.y, 10, r, 0.45, [1, 1, 1], 0.25);
          this.ring(e.x, e.y, r * 0.3, r * 1.4, 0.8, c, 0.08);
          this.spark(e.x, e.y, 0, 0, 0.3, r * 1.2, c, 0, 1.6);
          this.burst(e.x, e.y, 90, r * 5, 0.8, 3, c, 1.5);
          this.shake(0.75);
          this.hitstop = Math.max(this.hitstop, 0.12);
          this.flash = 0.35;
          this.flashColor = c;
          break;
        }
        case 'novaCharge':
          this.ring(e.x, e.y, (e.r ?? 40) + 160, (e.r ?? 40) * 0.4, 0.8, c, 0.06, 0.8);
          break;
        case 'dash': {
          const r = e.r ?? 30;
          const dx = e.x2 ?? 0, dy = e.y2 ?? 0;
          for (let k = 0; k < 26; k++) {
            const a = Math.random() * Math.PI * 2, rr = Math.random() * r;
            this.spark(e.x + Math.cos(a) * rr, e.y + Math.sin(a) * rr, -dx * (200 + Math.random() * 300), -dy * (200 + Math.random() * 300), 0.4, 2.5, c, 5, 1.3);
          }
          this.ring(e.x, e.y, r, r * 2.2, 0.3, c, 0.08, 0.7);
          if (inView(e.x, e.y)) this.shake(0.12);
          break;
        }
        case 'shield':
          this.ring(e.x, e.y, (e.r ?? 30) * 0.5, (e.r ?? 30) + 20, 0.35, [0.6, 0.9, 1], 0.1);
          break;
        case 'morph':
          this.ring(e.x, e.y, (e.r ?? 30) + 30, (e.r ?? 30) * 0.6, 0.5, e.n ? [1, 1, 1] : c, 0.08, 0.8);
          if (e.n) this.burst(e.x, e.y, 20, 160, 0.5, 2.5, c, 1.4);
          break;
        case 'research':
          this.burst(e.x, e.y, 24, 120, 1, 2.5, [0.7, 0.9, 1], 1.4);
          if (e.team === 0) this.text(e.x, e.y - 30, '+1 Research point', '#9fe0ff', 16, 1.8);
          break;
        case 'fail':
          if (e.team === 0 && e.msg) this.text(e.x, e.y - 20, e.msg, '#ff8f7a', 14, 1.6);
          break;
        case 'wave':
          break;
      }
    }
  }

  update(dt: number): void {
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // Swap-remove.
        n--;
        this.px[i] = this.px[n]; this.py[i] = this.py[n]; this.vx[i] = this.vx[n]; this.vy[i] = this.vy[n];
        this.life[i] = this.life[n]; this.max[i] = this.max[n]; this.size[i] = this.size[n];
        this.cr[i] = this.cr[n]; this.cg[i] = this.cg[n]; this.cb[i] = this.cb[n]; this.drag[i] = this.drag[n];
        i--;
        continue;
      }
      const k = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= k;
      this.vy[i] *= k;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
    }
    this.n = n;
    for (const r of this.rings) r.t += dt;
    this.rings = this.rings.filter((r) => r.t < r.dur);
    for (const b of this.beams) b.t += dt;
    this.beams = this.beams.filter((b) => b.t < b.dur);
    for (const t of this.texts) { t.t += dt; t.y -= dt * 24; }
    this.texts = this.texts.filter((t) => t.t < t.dur);
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.flash = Math.max(0, this.flash - dt * 2.5);
  }

  draw(glow: SpriteBatch, minW: number): void {
    for (let i = 0; i < this.n; i++) {
      const f = this.life[i] / this.max[i];
      const w = Math.max(minW, this.size[i] * (0.4 + 0.6 * f));
      glow.push(this.px[i], this.py[i], this.vx[i] * 0.04, this.vy[i] * 0.04, w, Shape.Glow, this.cr[i], this.cg[i], this.cb[i], f);
    }
    for (const r of this.rings) {
      const f = r.t / r.dur;
      const e = 1 - (1 - f) * (1 - f) * (1 - f);
      const rad = r.r0 + (r.r1 - r.r0) * e;
      glow.push(r.x, r.y, rad, 0, rad, Shape.Ring, r.c[0], r.c[1], r.c[2], (1 - f) * r.a, r.th);
    }
    for (const b of this.beams) {
      const f = 1 - b.t / b.dur;
      const mx = (b.x1 + b.x2) / 2, my = (b.y1 + b.y2) / 2;
      glow.push(mx, my, (b.x2 - b.x1) / 2, (b.y2 - b.y1) / 2, Math.max(minW, b.w), Shape.Tracer, b.c[0], b.c[1], b.c[2], f);
    }
  }
}
