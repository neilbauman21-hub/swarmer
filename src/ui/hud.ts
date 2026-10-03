import { DIFFICULTY, FORMATIONS, MAX_RESEARCH_LEVEL, RESEARCH_TRACKS, ROLES, SHIPS, TEAM_COLORS, TEAM_NAMES } from '../sim/config';
import type { Action, Game } from '../game';

interface ButtonDef {
  action: Action;
  key: string;
  label: string;
  desc: string;
  section: string;
  icon: string;
}

const ICONS = {
  split: '<path d="M12 3v6m0 0-6 6m6-6 6 6M6 15v6m12-6v6"/>',
  merge: '<path d="M6 3v6l6 6 6-6V3M12 15v6"/>',
  replicate: '<circle cx="8" cy="12" r="4"/><circle cx="16" cy="12" r="4"/><path d="M12 4v2M12 18v2"/>',
  research: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  dash: '<path d="M3 12h11M10 6l6 6-6 6M18 6v12"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  nova: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3"/>',
  f0: '<circle cx="8" cy="9" r="1.5"/><circle cx="14" cy="7" r="1.5"/><circle cx="16" cy="14" r="1.5"/><circle cx="9" cy="16" r="1.5"/><circle cx="12" cy="12" r="1.5"/>',
  f1: '<path d="M4 18 12 6l8 12"/>',
  f2: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3.5"/>',
  f3: '<path d="M3 10h18M3 14h18"/>',
  m0: '<circle cx="12" cy="12" r="5"/>',
  m1: '<path d="M4 20 20 4M14 4h6v6"/>',
  m2: '<rect x="5" y="5" width="14" height="14" rx="3"/><rect x="9" y="9" width="6" height="6"/>',
  m3: '<path d="M12 3c-4 5-6 8-6 11a6 6 0 0 0 12 0c0-3-2-6-6-11z"/>',
  m4: '<path d="M4 20c4-10 12-14 16-16M14 4h6v6"/><circle cx="6" cy="18" r="2"/>',
} as const;

const BUTTONS: ButtonDef[] = [
  { action: 'split', key: 'S', label: 'Split', desc: 'Split each selected group in half. The half facing your cursor stays selected.', section: 'Swarm', icon: ICONS.split },
  { action: 'merge', key: 'G', label: 'Merge', desc: 'Merge all selected groups into one. Tip: right-click a friendly group to fly over and join it.', section: 'Swarm', icon: ICONS.merge },
  { action: 'replicate', key: 'B', label: 'Replicate', desc: 'Stay here and grow new units. Needs 20+ units. Bigger groups grow faster (with diminishing returns).', section: 'Swarm', icon: ICONS.replicate },
  { action: 'research', key: 'T', label: 'Research', desc: 'Stay here and earn research points. Spend them in the research panel (Y).', section: 'Swarm', icon: ICONS.research },
  { action: 'stop', key: 'H', label: 'Hold', desc: 'Stop and hold position.', section: 'Swarm', icon: ICONS.stop },
  { action: 'dash', key: 'Q', label: 'Dash', desc: 'Surge toward the cursor at 4x speed, ramming enemies in the way. Strikers ram for huge damage. 30 energy.', section: 'Abilities', icon: ICONS.dash },
  { action: 'shield', key: 'E', label: 'Shield', desc: 'Hex shield: 75% less damage for 3 seconds. 40 energy.', section: 'Abilities', icon: ICONS.shield },
  { action: 'nova', key: 'R', label: 'Nova', desc: 'The swarm implodes and detonates, sacrificing 15% of its units for a massive blast. 60 energy.', section: 'Abilities', icon: ICONS.nova },
  ...FORMATIONS.map((f, i) => ({
    action: `f${i}` as Action, key: 'ZXCV'[i], label: f.name, desc: f.blurb, section: 'Formation', icon: ICONS[`f${i}` as keyof typeof ICONS],
  })),
  ...ROLES.map((r, i) => ({
    action: `m${i}` as Action, key: String(i + 1), label: r.name,
    desc: `${r.blurb} HP ${r.hp} · DMG ${r.damage} · Range ${r.range}. Morphing takes 2 seconds.`, section: 'Morph',
    icon: ICONS[`m${i}` as keyof typeof ICONS],
  })),
];

const TUTORIAL: { key: string; text: string }[] = [
  { key: 'select', text: '<b>Drag a box</b> or <b>click</b> your cyan swarm to select it.' },
  { key: 'harvest', text: '<b>Right-click an asteroid</b> to harvest it. Its mass turns into new units.' },
  { key: 'split', text: 'Press <kbd>S</kbd> to <b>split</b> toward the cursor, then send the new half to another rock.' },
  { key: 'path', text: '<b>Hold right mouse and drag</b> to draw a route. <kbd>Shift</kbd>+right-click queues waypoints.' },
  { key: 'replicate', text: 'Press <kbd>B</kbd> to <b>replicate</b> (needs 20+ units). The group stays put and multiplies.' },
  { key: 'research', text: 'Press <kbd>T</kbd> to <b>research</b> with a group. Spend points with <kbd>Y</kbd>.' },
  { key: 'formation', text: '<b>Formations</b>: <kbd>Z</kbd> Swarm · <kbd>X</kbd> Wedge · <kbd>C</kbd> Ring · <kbd>V</kbd> Line.' },
  { key: 'morph', text: '<b>Morph</b> roles with <kbd>1</kbd>–<kbd>5</kbd>: Drone, Striker, Tank, Harvester, Artillery.' },
  { key: 'ability', text: '<b>Abilities</b>: <kbd>Q</kbd> Dash toward cursor · <kbd>E</kbd> Shield · <kbd>R</kbd> Nova.' },
];

export class Hud {
  private el: HTMLDivElement;
  private stats: HTMLDivElement;
  private teams: HTMLDivElement;
  private bar: HTMLDivElement;
  private selInfo: HTMLDivElement;
  private buttons = new Map<Action, HTMLButtonElement>();
  private research: HTMLDivElement;
  private researchBtn: HTMLButtonElement;
  private banners: HTMLDivElement;
  private tip: HTMLDivElement;
  private tutorial: HTMLDivElement;
  private tutStep = 0;
  private tutDone = new Set<string>();
  private mini: HTMLCanvasElement;
  private miniCtx: CanvasRenderingContext2D;
  private acc = 0;
  private miniAcc = 0;
  private soundBtn: HTMLButtonElement;

  constructor(root: HTMLElement, private game: Game) {
    const el = (this.el = div('hud'));
    root.append(el);

    this.stats = div('panel stats');
    this.teams = div('panel teams');
    const topRight = div('top-right');
    const tools = div('tools');
    this.researchBtn = button('tool-btn research-btn', 'Research <kbd>Y</kbd>', () => this.toggleResearch());
    this.soundBtn = button('tool-btn', 'Sound: on', () => {
      this.game.audio.setMuted(!this.game.audio.muted);
      this.soundBtn.textContent = `Sound: ${this.game.audio.muted ? 'off' : 'on'}`;
    });
    if (this.game.audio.muted) this.soundBtn.textContent = 'Sound: off';
    tools.append(this.researchBtn, this.soundBtn, button('tool-btn', 'Pause <kbd>P</kbd>', () => this.game.setPaused(true)));
    topRight.append(this.teams, tools);

    this.research = div('panel research hidden');
    this.buildResearch();

    // Command bar.
    this.bar = div('command-bar');
    this.selInfo = div('sel-info');
    this.bar.append(this.selInfo);
    const sections = new Map<string, HTMLDivElement>();
    for (const b of BUTTONS) {
      let sec = sections.get(b.section);
      if (!sec) {
        sec = div('cmd-section');
        const title = div('cmd-title');
        title.textContent = b.section;
        const row = div('cmd-row');
        sec.append(title, row);
        sections.set(b.section, sec);
        this.bar.append(sec);
      }
      const btn = document.createElement('button');
      btn.className = 'cmd';
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${b.icon}</svg><span class="cmd-label">${b.label}</span><kbd>${b.key}</kbd><span class="cd"></span>`;
      btn.addEventListener('click', () => this.game.action(b.action));
      btn.addEventListener('mouseenter', () => this.showTip(btn, b));
      btn.addEventListener('mouseleave', () => this.tip.classList.add('hidden'));
      sec.querySelector('.cmd-row')!.append(btn);
      this.buttons.set(b.action, btn);
    }

    this.mini = document.createElement('canvas');
    this.mini.className = 'minimap';
    this.mini.width = 200;
    this.mini.height = 200;
    this.miniCtx = this.mini.getContext('2d')!;
    this.bindMinimap();

    this.banners = div('banners');
    this.tip = div('tooltip hidden');
    this.tutorial = div('tutorial');
    el.append(this.stats, topRight, this.research, this.bar, this.mini, this.banners, this.tip, this.tutorial);
    this.renderTutorial();
    this.update(1);
  }

  destroy(): void {
    this.el.remove();
  }

  private showTip(btn: HTMLElement, b: ButtonDef): void {
    this.tip.innerHTML = `<div class="tip-title">${b.label} <kbd>${b.key}</kbd></div><div>${b.desc}</div>`;
    this.tip.classList.remove('hidden');
    const r = btn.getBoundingClientRect();
    const host = this.el.getBoundingClientRect();
    this.tip.style.left = `${Math.min(host.width - 270, Math.max(8, r.left - host.left + r.width / 2 - 130))}px`;
    this.tip.style.bottom = `${host.bottom - r.top + 10}px`;
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
    hint.innerHTML = 'Select a group and press <kbd>T</kbd> to earn points.';
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
    this.researchBtn.classList.toggle('glow', team.points > 0);
  }

  banner(text: string, color: string): void {
    const b = div('banner');
    b.style.setProperty('--c', color);
    b.textContent = text;
    this.banners.append(b);
    setTimeout(() => b.classList.add('out'), 4200);
    setTimeout(() => b.remove(), 5000);
  }

  notify(kind: string): void {
    this.tutDone.add(kind);
    const step = TUTORIAL[this.tutStep];
    if (step && this.tutDone.has(step.key)) {
      while (this.tutStep < TUTORIAL.length && this.tutDone.has(TUTORIAL[this.tutStep].key)) this.tutStep++;
      this.renderTutorial();
    }
  }

  private renderTutorial(): void {
    if (this.tutStep >= TUTORIAL.length) {
      this.tutorial.innerHTML = '<div class="tut-text">You know the basics. <b>Destroy every rival swarm.</b> Raider wrecks are rich asteroids.</div>';
      setTimeout(() => this.tutorial.classList.add('out'), 6000);
      return;
    }
    const step = TUTORIAL[this.tutStep];
    this.tutorial.innerHTML = `<div class="tut-step">${this.tutStep + 1}/${TUTORIAL.length}</div><div class="tut-text">${step.text}</div>`;
    const skip = button('tut-skip', 'Skip', () => this.tutorial.classList.add('out'));
    this.tutorial.append(skip);
    this.tutorial.classList.remove('flash');
    void this.tutorial.offsetWidth;
    this.tutorial.classList.add('flash');
  }

  update(dt: number): void {
    this.acc += dt;
    this.miniAcc += dt;
    this.updateButtons();
    if (this.miniAcc > 0.1) {
      this.miniAcc = 0;
      this.drawMinimap();
    }
    if (this.acc < 0.15) return;
    this.acc = 0;
    const w = this.game.world;
    const me = w.teams[0];
    const t = Math.floor(w.time);
    const next = Math.max(0, Math.ceil(w.nextWave - w.time));
    const cost = w.researchCost(0);
    this.stats.innerHTML = `
      <div class="stat big"><span>${me.units}</span><small>units / ${me.cap}</small></div>
      <div class="stat"><span>${w.groupsOf(0).length}</span><small>groups</small></div>
      <div class="stat"><span>${me.points}</span><small>research pts</small><div class="mini-bar"><div style="width:${(100 * me.progress) / cost}%"></div></div></div>
      <div class="stat"><span>${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}</span><small>${DIFFICULTY[w.difficulty].name}</small></div>
      <div class="stat warn"><span>${next}s</span><small>raid ${w.waveNum + 1}</small></div>`;
    let html = '';
    for (const tm of w.teams) {
      const c = TEAM_COLORS[tm.id].map((v) => Math.round(v * 255)).join(',');
      html += `<div class="team ${tm.alive ? '' : 'dead'}"><i style="background:rgb(${c});box-shadow:0 0 8px rgb(${c})"></i><span>${TEAM_NAMES[tm.id]}</span><b>${tm.alive ? tm.units : '✕'}</b></div>`;
    }
    const raiders = w.ships.filter((s) => s.alive).length;
    if (raiders) html += `<div class="team"><i style="background:#ffc04d;box-shadow:0 0 8px #ffc04d"></i><span>Raiders</span><b>${raiders}</b></div>`;
    this.teams.innerHTML = html;
    if (!this.research.classList.contains('hidden')) this.refreshResearch();
    else this.researchBtn.classList.toggle('glow', me.points > 0);
  }

  private updateButtons(): void {
    const g = this.game;
    const ids = g.selectedIds();
    this.bar.classList.toggle('empty', ids.length === 0);
    if (!ids.length) {
      this.selInfo.innerHTML = '<div class="sel-empty">No selection<small>Drag to select · <kbd>Tab</kbd> cycle groups · <kbd>`</kbd> all</small></div>';
      return;
    }
    const w = g.world;
    const gs = ids.map((id) => w.groups[id]);
    const units = gs.reduce((s, x) => s + x.count, 0);
    const energy = gs.reduce((s, x) => s + x.energy, 0) / gs.length;
    const roles = new Set(gs.map((x) => (x.morphT > 0 ? x.morphTo : x.role)));
    const forms = new Set(gs.map((x) => x.formation));
    const morphing = gs.some((x) => x.morphT > 0);
    this.selInfo.innerHTML = `<div class="sel-count">${units}<small>${gs.length > 1 ? `${gs.length} groups` : 'units'}</small></div>
      <div class="sel-meta">${roles.size === 1 ? ROLES[[...roles][0]].name : 'Mixed'}${morphing ? ' <em>morphing…</em>' : ''}<br><small>${forms.size === 1 ? FORMATIONS[[...forms][0]].name : 'Mixed'}</small></div>
      <div class="energy"><div style="width:${energy}%"></div></div>`;
    for (const kind of ['dash', 'shield', 'nova'] as const) {
      const st = g.abilityState(kind);
      const btn = this.buttons.get(kind)!;
      const cd = btn.querySelector('.cd') as HTMLElement;
      cd.style.setProperty('--p', `${st.ready * 360}deg`);
      btn.classList.toggle('cooling', st.ready < 1);
      btn.classList.toggle('no-energy', !st.energy);
    }
    for (let i = 0; i < 4; i++) this.buttons.get(`f${i}` as Action)!.classList.toggle('active', forms.size === 1 && forms.has(i));
    for (let i = 0; i < 5; i++) this.buttons.get(`m${i}` as Action)!.classList.toggle('active', roles.size === 1 && roles.has(i));
    this.buttons.get('replicate')!.classList.toggle('active', gs.every((x) => x.order.type === 'replicate'));
    this.buttons.get('research')!.classList.toggle('active', gs.every((x) => x.order.type === 'research'));
    this.buttons.get('merge')!.classList.toggle('disabled', gs.length < 2);
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
