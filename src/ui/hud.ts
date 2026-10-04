import { SHIPS, TEAM_COLORS } from '../sim/config';
import type { Game } from '../game';
import { PromptDock } from './prompt';
import { PARTS, PART_BY_ID, type PartDef } from '../sim/parts';

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
  private knownUnlocks = 0;
  private respawnEl: HTMLDivElement;
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
    this.respawnEl = div('respawn');
    this.respawnEl.hidden = true;
    this.respawnEl.innerHTML = '<div class="rs-k">Signal lost</div><div class="rs-t">SWARM DESTROYED</div><p class="rs-s"></p><button type="button" class="rs-b">Redeploy <kbd>Space</kbd></button>';
    this.respawnEl.querySelector('button')!.addEventListener('click', () => this.game.respawn());
    el.append(this.stats, this.teams, this.research, this.mini, this.banners, this.respawnEl);
    this.dock = new PromptDock(el, game);
    this.update(1);
  }

  destroy(): void {
    this.dock.dispose();
    this.el.remove();
  }

  toggleResearch(force?: boolean): void {
    this.research.classList.toggle('hidden', force === undefined ? undefined : !force);
    this.refreshResearch();
  }

  private buildResearch(): void {
    // Research only unlocks particle types: swarm roles first, then construct parts by requirement depth.
    const depth = (id: string): number => {
      const p = PART_BY_ID.get(id)!;
      return p.requires.length ? 1 + Math.max(...p.requires.map(depth)) : 0;
    };
    const tiers: PartDef[][] = [];
    for (const p of PARTS) {
      if (p.id === 'drone') continue;
      (tiers[depth(p.id)] ??= []).push(p);
    }
    const node = (id: string, name: string, blurb: string, cost: number, tint: number[], req = '') =>
      `<button class="node" data-part="${id}" title="${req}${blurb}"><i style="background:rgb(${tint.map((v) => Math.round(v * 255)).join(',')})"></i><b>${name}</b><small>${blurb}</small><span class="cost">${cost} pt${cost > 1 ? 's' : ''}</span></button>`;
    let html = '<div class="panel-title">Research <span class="pts"></span></div><div class="progress"><div></div></div>';
    html += '<div class="tree-head">Particle types <small>parts for constructs: describe one in the Fabrication tab. Swarm morphs are always available.</small></div><div class="tree">';
    tiers.forEach((tier, i) => {
      html += `<div class="tier"><div class="tier-label">TIER ${i + 1}</div>`;
      for (const p of tier) {
        const req = p.requires.length ? `Needs ${p.requires.map((r) => PART_BY_ID.get(r)!.name).join(' + ')}. ` : '';
        html += node(p.id, p.name, p.blurb, p.cost, p.tint, req);
      }
      html += '</div>';
    });
    html += '</div><div class="hint">Earn points: right-click a swarm and pick <b>Research</b> (or press <kbd>T</kbd>). <kbd>Y</kbd> closes this panel.</div>';
    this.research.innerHTML = html;
    this.research.querySelectorAll<HTMLButtonElement>('.node').forEach((b) =>
      b.addEventListener('click', () => {
        // Unlocks are orders too, so every client applies them on the same tick.
        if (b.disabled) { this.game.audio.ui('error'); return; }
        this.game.issue({ op: 'unlock', type: b.dataset.part! });
        b.disabled = true;
        b.classList.add('pending');
        this.game.audio.ui('order');
      }));
  }

  private refreshResearch(): void {
    const team = this.game.world.teams[this.game.me];
    if (!team) return;
    this.research.querySelector('.pts')!.textContent = `${team.points} point${team.points === 1 ? '' : 's'}`;
    (this.research.querySelector('.progress > div') as HTMLElement).style.width = `${(100 * team.progress) / this.game.world.researchCost(this.game.me)}%`;
    if (team.unlocked.size !== this.knownUnlocks) {
      this.knownUnlocks = team.unlocked.size;
      this.dock.refreshDesigns();
    }
    this.research.querySelectorAll<HTMLButtonElement>('.node').forEach((b) => {
      const id = b.dataset.part!;
      const part = PART_BY_ID.get(id);
      const cost = part?.cost ?? 1;
      const owned = team.unlocked.has(id);
      const ready = !owned && (part ? part.requires.every((r) => team.unlocked.has(r)) : true);
      if (owned) b.classList.remove('pending');
      b.classList.toggle('owned', owned);
      b.classList.toggle('ready', ready && team.points >= cost);
      b.classList.toggle('locked', !owned && !ready);
      b.disabled = owned || !ready || team.points < cost || b.classList.contains('pending');
    });
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
    const me = w.teams[this.game.me] ?? { units: 0, points: 0 };
    const link = this.game.link as { rtt?: number; networked: boolean };
    const net = link.networked ? `<div class="st"><span>Ping</span><b>${Math.round(link.rtt ?? 0)}ms</b></div>` : '';
    const next = Math.max(0, Math.ceil(w.nextWave - w.time));
    const pilots = w.teams.filter((tm) => tm.owner >= 0).length;
    this.stats.innerHTML = `<div class="st"><span>Units</span><b class="units">${me.units}</b></div>
      <div class="st"><span>Kills</span><b>${'kills' in me ? me.kills : 0}</b></div>
      <div class="st warn"><span>Next raid</span><b>${next}s</b></div>
      <div class="st"><span>Research</span><b class="${me.points ? 'pts' : ''}">${me.points}</b></div>
      <div class="st"><span>Pilots</span><b>${pilots}</b></div>${net}`;
    // Leaderboard: biggest living swarms first.
    let html = '<div class="lb-h">Arena</div>';
    const total = w.teams.reduce((n, tm) => n + (tm.alive ? tm.units : 0), 0);
    const ranked = w.teams.filter((tm) => tm.alive || tm.id === this.game.me).sort((a, b) => b.units - a.units);
    for (const tm of ranked) {
      const c = TEAM_COLORS[tm.id].map((v) => Math.round(v * 255)).join(',');
      const share = tm.alive ? Math.min(100, (100 * tm.units) / Math.max(1, total)) : 0;
      const you = tm.id === this.game.me ? ' you' : '';
      const bot = tm.owner < 0 ? ' <small>bot</small>' : '';
      const name = esc(this.game.teamName(tm.id)) + (you ? ' <em>you</em>' : bot);
      html += `<div class="team${you} ${tm.alive ? '' : 'dead'}" style="--c:rgb(${c})"><span>${name}</span><b>${tm.alive ? tm.units : 'Down'}</b><i style="width:${share}%"></i></div>`;
    }
    // Wiped out: offer a fresh swarm.
    const mine = w.teams[this.game.me];
    const down = !!mine && !mine.alive;
    this.respawnEl.hidden = !down;
    if (down) {
      const wait = Math.max(0, Math.ceil(2 - (w.time - mine.deadAt)));
      this.respawnEl.querySelector('.rs-s')!.textContent = `Peak ${mine.peak} units · ${mine.kills} kills. The arena fights on.`;
      const b = this.respawnEl.querySelector<HTMLButtonElement>('.rs-b')!;
      b.disabled = wait > 0;
      b.innerHTML = wait > 0 ? `Redeploy in ${wait}s` : 'Redeploy <kbd>Space</kbd>';
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
          this.game.issue({ op: 'move', ids, x, y });
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

function esc(t: string): string {
  return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
