import { MAX_RESEARCH_LEVEL, RESEARCH_TRACKS, SHIPS, TEAM_COLORS, TEAM_NAMES } from '../sim/config';
import type { Game } from '../game';
import { PromptDock } from './prompt';

/**
 * Minimal HUD: a slim status line, rival list, minimap, and the prompt dock as the main control.
 * All commands remain on hotkeys (see the pause screen for the list).
 */
export class Hud {
  private el: HTMLDivElement;
  private stats: HTMLDivElement;
  private teams: HTMLDivElement;
  private research: HTMLDivElement;
  private banners: HTMLDivElement;
  private mini: HTMLCanvasElement;
  private miniCtx: CanvasRenderingContext2D;
  private acc = 0;
  private miniAcc = 0;
  readonly dock: PromptDock;

  constructor(root: HTMLElement, private game: Game) {
    const el = (this.el = div('hud'));
    root.append(el);
    this.stats = div('stats');
    this.teams = div('teams');
    this.research = div('panel research hidden');
    this.buildResearch();
    this.mini = document.createElement('canvas');
    this.mini.className = 'minimap';
    this.mini.width = 180;
    this.mini.height = 180;
    this.miniCtx = this.mini.getContext('2d')!;
    this.bindMinimap();
    this.banners = div('banners');
    el.append(this.stats, this.teams, this.research, this.mini, this.banners);
    this.dock = new PromptDock(el, game);
    this.update(1);
  }

  destroy(): void {
    this.dock.dispose();
    this.el.remove();
  }

  toggleResearch(): void {
    this.research.classList.toggle('hidden');
    this.refreshResearch();
  }

  private buildResearch(): void {
    this.research.innerHTML = '<div class="panel-title">Research <span class="pts"></span></div><div class="progress"><div></div></div>';
    for (const t of RESEARCH_TRACKS) {
      const row = div('track');
      row.dataset.track = t.id;
      row.innerHTML = `<div class="track-name">${t.name}<small>${t.per} per level</small></div><div class="pips">${'<i></i>'.repeat(MAX_RESEARCH_LEVEL)}</div>`;
      const b = button('buy', 'Upgrade', () => {
        if (this.game.world.buyResearch(0, t.id)) {
          this.game.audio.ui('order');
          this.refreshResearch();
        } else this.game.audio.ui('error');
      });
      row.append(b);
      this.research.append(row);
    }
    const hint = div('hint');
    hint.innerHTML = 'Earn points with <kbd>T</kbd> on a group. <kbd>Y</kbd> closes this panel.';
    this.research.append(hint);
  }

  private refreshResearch(): void {
    const team = this.game.world.teams[0];
    this.research.querySelector('.pts')!.textContent = `${team.points} point${team.points === 1 ? '' : 's'}`;
    (this.research.querySelector('.progress > div') as HTMLElement).style.width = `${(100 * team.progress) / this.game.world.researchCost(0)}%`;
    for (const row of this.research.querySelectorAll<HTMLElement>('.track')) {
      const id = row.dataset.track as keyof typeof team.levels;
      const lvl = team.levels[id];
      row.querySelectorAll('i').forEach((p, i) => p.classList.toggle('on', i < lvl));
      const b = row.querySelector('button')!;
      b.disabled = team.points < 1 || lvl >= MAX_RESEARCH_LEVEL;
      b.textContent = lvl >= MAX_RESEARCH_LEVEL ? 'Max' : 'Upgrade';
    }
  }

  banner(text: string, color: string): void {
    const b = div('banner');
    b.style.setProperty('--c', color);
    b.textContent = text;
    this.banners.append(b);
    setTimeout(() => b.classList.add('out'), 4200);
    setTimeout(() => b.remove(), 5000);
  }

  /** Kept for callers; the step-by-step tutorial was removed in favour of the prompt. */
  notify(_kind: string): void {}

  update(dt: number): void {
    this.acc += dt;
    this.miniAcc += dt;
    this.dock.update(dt);
    if (this.miniAcc > 0.1) {
      this.miniAcc = 0;
      this.drawMinimap();
    }
    if (this.acc < 0.2) return;
    this.acc = 0;
    const w = this.game.world;
    const me = w.teams[0];
    const t = Math.floor(w.time);
    const next = Math.max(0, Math.ceil(w.nextWave - w.time));
    const pts = me.points ? ` · <b class="pts">${me.points} research pt${me.points > 1 ? 's' : ''} (Y)</b>` : '';
    this.stats.innerHTML = `<b class="units">${me.units}</b> units · ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} · <span class="warn">raid in ${next}s</span>${pts}`;
    let html = '';
    for (const tm of w.teams) {
      if (tm.id === 0) continue;
      const c = TEAM_COLORS[tm.id].map((v) => Math.round(v * 255)).join(',');
      html += `<span class="team ${tm.alive ? '' : 'dead'}"><i style="background:rgb(${c})"></i>${TEAM_NAMES[tm.id]} ${tm.alive ? tm.units : '✕'}</span>`;
    }
    this.teams.innerHTML = html;
    if (!this.research.classList.contains('hidden')) this.refreshResearch();
  }

  private bindMinimap(): void {
    const toWorld = (e: MouseEvent): [number, number] => {
      const r = this.mini.getBoundingClientRect();
      const s = this.game.world.size;
      return [((e.clientX - r.left) / r.width) * s, ((e.clientY - r.top) / r.height) * s];
    };
    let dragging = false;
    this.mini.addEventListener('contextmenu', (e) => e.preventDefault());
    this.mini.addEventListener('pointerdown', (e) => {
      const [x, y] = toWorld(e);
      if (e.button === 2) {
        const ids = this.game.selectedIds();
        if (ids.length) {
          this.game.world.cmdMove(ids, x, y);
          this.game.audio.ui('order');
        }
        return;
      }
      dragging = true;
      this.mini.setPointerCapture(e.pointerId);
      this.game.focus(x, y);
    });
    this.mini.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const [x, y] = toWorld(e);
      this.game.focus(x, y);
    });
    this.mini.addEventListener('pointerup', () => { dragging = false; });
  }

  private drawMinimap(): void {
    const ctx = this.miniCtx;
    const w = this.game.world;
    const W = this.mini.width;
    const k = W / w.size;
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = 'rgba(4,8,18,0.85)';
    ctx.fillRect(0, 0, W, W);
    for (const r of w.rocks) {
      if (!r.alive) continue;
      ctx.fillStyle = r.wreck ? '#a0724a' : '#6b6560';
      ctx.beginPath();
      ctx.arc(r.x * k, r.y * k, Math.max(1.5, r.r * k), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const g of w.groups) {
      if (!g.alive) continue;
      const c = TEAM_COLORS[g.team].map((v) => Math.round(v * 255)).join(',');
      ctx.fillStyle = `rgba(${c},0.85)`;
      ctx.beginPath();
      ctx.arc(g.cx * k, g.cy * k, Math.max(2, g.radius * k * 1.3), 0, Math.PI * 2);
      ctx.fill();
      if (this.game.selected.has(g.id)) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const s of w.ships) {
      if (!s.alive) continue;
      ctx.fillStyle = '#ffc04d';
      const r = Math.max(2, SHIPS[s.type].radius * k * 1.5);
      ctx.fillRect(s.x * k - r, s.y * k - r, r * 2, r * 2);
    }
    // Camera viewport.
    const g = this.game;
    const hw = g.root.clientWidth / 2 / g.cam.zoom, hh = g.root.clientHeight / 2 / g.cam.zoom;
    ctx.strokeStyle = 'rgba(160,220,255,0.8)';
    ctx.lineWidth = 1;
    ctx.strokeRect((g.cam.x - hw) * k, (g.cam.y - hh) * k, hw * 2 * k, hh * 2 * k);
  }
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function button(cls: string, html: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.innerHTML = html;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    fn();
  });
  return b;
}
