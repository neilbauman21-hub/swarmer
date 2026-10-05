import { DASH, FORMATIONS, NOVA, REPLICATE_MIN, ROLES, SHIELD } from '../sim/config';
import { PRESETS, designUnits } from '../sim/parts';
import type { Action, Game } from '../game';

/**
 * Right-click a swarm of yours to get every order it can take, so no hotkeys are needed.
 * Hotkeys still work and are shown next to each entry.
 */
export class ContextMenu {
  private el: HTMLDivElement;
  private ids: number[] = [];
  private absorb: number[] = [];
  static more = false; // remembered while the page is open

  constructor(host: HTMLElement, private game: Game) {
    this.el = document.createElement('div');
    this.el.className = 'ctx';
    this.el.hidden = true;
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    host.append(this.el);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  close(): void {
    this.el.hidden = true;
  }

  destroy(): void {
    this.el.remove();
  }

  /** ids: the swarms the menu acts on; absorb: other selected swarms that can be merged into ids[0]. */
  open(x: number, y: number, ids: number[], absorb: number[]): void {
    this.ids = ids;
    this.absorb = absorb;
    this.render();
    this.el.hidden = false;
    this.at = [x, y];
    this.place();
  }

  private at: [number, number] = [0, 0];

  /** Keep it on screen. */
  private place(): void {
    const [x, y] = this.at;
    const host = this.el.parentElement!.getBoundingClientRect();
    const r = this.el.getBoundingClientRect();
    const left = Math.min(x + 6, host.width - r.width - 8);
    const top = Math.min(y + 6, host.height - r.height - 8);
    this.el.style.left = `${Math.max(8, left)}px`;
    this.el.style.top = `${Math.max(8, top)}px`;
  }

  private render(): void {
    const g = this.game;
    const w = g.world;
    const groups = this.ids.map((id) => w.groups[id]).filter((x) => x?.alive);
    if (!groups.length) { this.close(); return; }
    const team = w.teams[g.me];
    const units = groups.reduce((n, x) => n + x.count, 0);
    const swarms = groups.filter((x) => !x.cells);
    const lead = groups[0];
    const title = groups.length === 1
      ? lead.design ? `${lead.design.name} · ${lead.count}/${lead.design.cells.length} cells` : `${ROLES[lead.role].name} swarm · ${units}`
      : `${groups.length} swarms · ${units} units`;
    const btn = (act: string, label: string, key = '', opts: { off?: boolean; note?: string; cls?: string } = {}) =>
      `<button type="button" data-a="${act}" class="${opts.cls ?? ''}" ${opts.off ? 'disabled' : ''}>` +
      `<span>${label}</span>${opts.note ? `<small>${opts.note}</small>` : ''}${key ? `<kbd>${key}</kbd>` : ''}</button>`;

    let html = `<div class="ctx-h">${esc(title)}</div>`;
    if (this.absorb.length) html += `<div class="ctx-row">${btn('absorb', `Join with ${this.absorb.length} selected swarm${this.absorb.length > 1 ? 's' : ''}`, '', { cls: 'wide' })}</div>`;

    const canRep = swarms.some((x) => x.count >= REPLICATE_MIN);
    html += '<div class="ctx-sec">Orders</div><div class="ctx-row">';
    html += btn('replicate', 'Replicate', 'B', { off: !canRep, note: canRep ? '' : `needs ${REPLICATE_MIN}+` });
    html += btn('research', 'Research', 'T', { off: !swarms.length, note: `${team.points} pt${team.points === 1 ? '' : 's'}` });
    html += btn('split', 'Split', 'S', { off: !groups.some((x) => x.count >= 2), note: '' });
    if (groups.length > 1) html += btn('merge', 'Merge', 'G');
    html += btn('stop', 'Hold', 'H');
    html += '</div>';

    if (swarms.length) {
      html += '<div class="ctx-sec">Morph</div><div class="ctx-row roles">';
      ROLES.forEach((r, i) => {
        const current = swarms.every((x) => x.role === i);
        html += btn(`m${i}`, r.name, String(i + 1), { cls: current ? 'cur' : '', note: current ? 'current' : '' });
      });
      html += '</div>';

      html += '<div class="ctx-sec">Formation</div><div class="ctx-row">';
      FORMATIONS.forEach((f, i) => {
        const current = swarms.every((x) => x.formation === i);
        html += btn(`f${i}`, f.name, 'ZXCV'[i], { cls: current ? 'cur' : '' });
      });
      html += '</div>';
    }

    const ab = (kind: 'dash' | 'shield' | 'nova', key: string, def: { cost: number }) => {
      const st = g.abilityState(kind, groups.map((x) => x.id));
      const ready = st.ready >= 1 && st.energy;
      return btn(kind, kind[0].toUpperCase() + kind.slice(1), key, { off: !ready, note: ready ? `${def.cost} energy` : st.ready < 1 ? 'cooling down' : 'low energy' });
    };
    html += '<div class="ctx-sec">Abilities</div><div class="ctx-row">';
    html += ab('dash', 'Q', DASH) + ab('shield', 'E', SHIELD) + ab('nova', 'R', NOVA);
    html += '</div>';

    if (swarms.length) {
      const pool = swarms.reduce((n, x) => n + x.count, 0);
      const designs = [...team.designs, ...PRESETS.filter((p) => !team.designs.some((d) => d.name === p.name))]
        .filter((d) => d.cells.every((c) => team.unlocked.has(c.part)));
      html += '<div class="ctx-sec">Fabricate</div><div class="ctx-row">';
      if (designs.length) {
        designs.slice(0, 6).forEach((d, k) => {
          const need = designUnits(d);
          html += btn(`build:${k}`, d.name, '', { off: pool < need, note: `${need} units` });
        });
      } else html += '<span class="ctx-empty">Research construct parts to fabricate.</span>';
      html += btn('fab', 'Design new…', '', { note: 'describe it' });
      html += '</div>';
      this.el.dataset.designs = JSON.stringify(designs.slice(0, 6).map((d) => d.name));
    }

    html += `<div class="ctx-foot">${btn('tree', 'Research tree', 'Y', { note: `${team.points} pt${team.points === 1 ? '' : 's'} to spend` })}</div>`;
    // Keep it short: everyday orders and morphs up front, the rest folded under "More".
    let cut = html.indexOf('<div class="ctx-sec">Formation');
    if (cut < 0) cut = html.indexOf('<div class="ctx-sec">Abilities');
    if (cut >= 0) {
      html = html.slice(0, cut) + `<button type="button" class="ctx-toggle" data-a="more">${ContextMenu.more ? 'Less' : 'More: formation, abilities, build'}</button>` +
        `<div class="ctx-more"${ContextMenu.more ? '' : ' hidden'}>${html.slice(cut)}</div>`;
    }
    this.el.innerHTML = html;
    this.el.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (b.dataset.a === 'more') {
          ContextMenu.more = !ContextMenu.more;
          this.render();
          this.place();
          return;
        }
        this.run(b.dataset.a!);
      }));
  }

  private run(a: string): void {
    const g = this.game;
    const ids = this.ids.filter((id) => g.world.groups[id]?.alive);
    this.close();
    if (!ids.length) return;
    if (a === 'absorb') {
      g.selected.clear();
      for (const id of this.absorb) g.selected.add(id);
      g.joinGroup(ids[0]);
      return;
    }
    if (a === 'tree') { g.hud?.toggleResearch(true); return; }
    if (a === 'fab') {
      g.selected.clear();
      for (const id of ids) g.selected.add(id);
      g.hud?.dock.setMode('design');
      return;
    }
    if (a.startsWith('build:')) {
      const names = JSON.parse(this.el.dataset.designs ?? '[]') as string[];
      const name = names[Number(a.slice(6))];
      const swarms = ids.filter((id) => !g.world.groups[id].cells);
      if (!name || !swarms.length) return;
      swarms.sort((x, y) => g.world.groups[y].count - g.world.groups[x].count);
      g.selected.clear();
      for (const id of swarms) g.selected.add(id);
      g.issue({ op: 'build', ids: swarms, design: name });
      g.audio.ui('order');
      return;
    }
    if (a === 'split' || a === 'dash') {
      g.startTargeting(a, ids);
      return;
    }
    g.selected.clear();
    for (const id of ids) g.selected.add(id);
    g.action(a as Action);
  }
}

function esc(t: string): string {
  return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
