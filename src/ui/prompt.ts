import { applyCommands, describe, snapshot } from '../ai/protocol';
import { EXAMPLES, PLACEHOLDERS } from '../ai/examples';
import { SwarmSandbox } from '../ai/sandbox';
import { PART_BY_ID, PRESETS, designUnits, summarize, validateDesign, type Design } from '../sim/parts';
import { TEAM_COLORS } from '../sim/config';
import type { Game } from '../game';

type Status = 'idle' | 'thinking' | 'running' | 'error' | 'done' | 'designed';
type Mode = 'command' | 'design';

const DESIGN_PLACEHOLDERS = [
  'A tank: armored front, two cannons behind it, a mender in the middle, thrusters at the back',
  'A fast hedgehog covered in spikes',
  'A long-range lance platform protected by shield nodes',
  'A tiny cheap scout: three thrusters and a spike',
];

/** The "tell your swarm what to do" box: prompt -> LLM-written program -> sandboxed execution. */
export class PromptDock {
  readonly el: HTMLDivElement;
  private input: HTMLInputElement;
  private statusEl: HTMLDivElement;
  private codeEl: HTMLPreElement;
  private logEl: HTMLDivElement;
  private sandbox: SwarmSandbox;
  private status: Status = 'idle';
  private label = '';
  private history: string[] = [];
  private histIdx = -1;
  private placeholderIdx = 0;
  private placeholderTimer = 0;
  private request: AbortController | null = null;
  private applied = 0;

  constructor(host: HTMLElement, private game: Game) {
    this.el = document.createElement('div');
    this.el.className = 'dock';
    this.el.innerHTML = `
      <div class="dock-tabs" role="tablist">
        <button type="button" role="tab" data-mode="command" class="on">Orders</button>
        <button type="button" role="tab" data-mode="design">Fabrication</button>
      </div>
      <div class="dock-status" data-s="idle"></div>
      <form class="dock-form" autocomplete="off">
        <span class="dock-pr">ORDER&gt;</span>
        <input id="swarm-prompt" maxlength="500" spellcheck="false" aria-label="Order for your swarm">
        <button type="submit" class="dock-go">Transmit <kbd>Enter</kbd></button>
      </form>
      <div class="dock-examples"></div>
      <div class="dock-designs" hidden></div>
      <pre class="dock-code" hidden></pre>
      <div class="dock-log"></div>`;
    host.append(this.el);
    this.input = this.el.querySelector('input')!;
    this.statusEl = this.el.querySelector('.dock-status')!;
    this.codeEl = this.el.querySelector('.dock-code')!;
    this.logEl = this.el.querySelector('.dock-log')!;
    this.designsEl = this.el.querySelector('.dock-designs')!;
    this.examplesEl = this.el.querySelector('.dock-examples')!;
    this.input.placeholder = this.placeholder();
    this.el.querySelectorAll<HTMLButtonElement>('.dock-tabs button').forEach((b) =>
      b.addEventListener('click', () => this.setMode(b.dataset.mode as Mode)));

    const ex = this.el.querySelector('.dock-examples')!;
    for (const e of EXAMPLES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = e.prompt;
      b.title = 'Runs a ready-made program (no AI call)';
      b.addEventListener('click', () => this.run(e.code, e.prompt, 'example'));
      ex.append(b);
    }

    this.el.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.input.blur();
        e.stopPropagation();
      } else if (e.key === 'ArrowUp' && this.history.length) {
        this.histIdx = Math.min(this.history.length - 1, this.histIdx + 1);
        this.input.value = this.history[this.history.length - 1 - this.histIdx];
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        this.histIdx = Math.max(-1, this.histIdx - 1);
        this.input.value = this.histIdx >= 0 ? this.history[this.history.length - 1 - this.histIdx] : '';
        e.preventDefault();
      }
    });
    this.input.addEventListener('focus', () => this.el.classList.add('focus'));
    this.input.addEventListener('blur', () => this.el.classList.remove('focus'));

    this.sandbox = new SwarmSandbox({
      onCommands: (cmds) => {
        const n = applyCommands(this.game.world, 0, cmds);
        this.applied += n;
        if (n) this.renderStatus();
      },
      onLog: (lines) => this.log(lines),
      onError: (msg) => this.onProgramError(msg),
      onDone: () => this.setStatus('done'),
    });
    this.renderStatus();
  }

  private mode: Mode = 'command';
  private designsEl: HTMLDivElement;
  private examplesEl: HTMLDivElement;

  setMode(m: Mode): void {
    this.mode = m;
    this.el.querySelectorAll<HTMLButtonElement>('.dock-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    this.examplesEl.hidden = m !== 'command';
    this.designsEl.hidden = m !== 'design';
    this.placeholderIdx = 0;
    this.input.placeholder = this.placeholder();
    this.el.querySelector('.dock-go')!.innerHTML = `${m === 'command' ? 'Transmit' : 'Fabricate'} <kbd>Enter</kbd>`;
    this.el.querySelector('.dock-pr')!.textContent = m === 'command' ? 'ORDER>' : 'BUILD>';
    if (m === 'design') this.refreshDesigns();
    if (this.status === 'idle') this.renderStatus();
    this.input.focus();
  }

  private placeholder(): string {
    return this.mode === 'command'
      ? PLACEHOLDERS[this.placeholderIdx % PLACEHOLDERS.length].toLowerCase()
      : DESIGN_PLACEHOLDERS[this.placeholderIdx % DESIGN_PLACEHOLDERS.length].toLowerCase();
  }

  private get designs(): Design[] {
    return this.game.world.teams[0].designs;
  }

  /** Re-render the blueprint cards (presets you can build plus everything designed this match). */
  refreshDesigns(): void {
    const team = this.game.world.teams[0];
    const all = [...this.designs, ...PRESETS.filter((p) => !this.designs.some((d) => d.name === p.name))];
    this.designsEl.innerHTML = '';
    if (!all.length) return;
    const tc = TEAM_COLORS[0];
    for (const d of all) {
      const sum = summarize(d);
      const missing = [...new Set(d.cells.map((c) => c.part))].filter((p) => !team.unlocked.has(p)).map((p) => PART_BY_ID.get(p)!.name);
      const card = document.createElement('div');
      card.className = 'bp';
      const cv = document.createElement('canvas');
      cv.width = cv.height = 84;
      drawBlueprint(cv, d, tc);
      const info = document.createElement('div');
      info.className = 'bp-info';
      const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
      info.innerHTML = `<b>${esc(d.name)}</b><span>${sum.cells} cells · costs ${sum.units} units</span>
        <span>${sum.hp} HP · ${sum.dps} dmg/s · range ${sum.maxRange} · speed ${sum.speed}</span>
        ${missing.length ? `<span class="bp-missing">Research first: ${missing.join(', ')}</span>` : ''}`;
      const build = document.createElement('button');
      build.type = 'button';
      build.className = 'bp-build';
      build.textContent = 'Build';
      build.disabled = missing.length > 0;
      build.addEventListener('click', () => this.build(d));
      card.append(cv, info, build);
      this.designsEl.append(card);
    }
  }

  private build(d: Design): void {
    const w = this.game.world;
    const ids = this.game.selectedIds().filter((id) => !w.groups[id].cells);
    if (!ids.length) {
      this.setStatus('error', 'Select a swarm to build from first (drag a box around it).');
      return;
    }
    // Build from the biggest selected swarm, pooling the others into it if needed.
    const need = designUnits(d);
    ids.sort((a, b) => w.groups[b].count - w.groups[a].count);
    let src = ids[0];
    if (w.groups[src].count < need && ids.length > 1) src = w.cmdMerge(ids);
    const id = w.cmdBuild(src, d);
    if (id < 0) {
      this.setStatus('error', `${d.name} needs ${need} units; the selected swarm has ${w.groups[src].count}.`);
      return;
    }
    this.game.selected.clear();
    this.game.selected.add(id);
    this.label = d.name;
    this.setStatus('designed', `Assembling ${d.name}. Right-click a friendly swarm to repair it later.`);
    this.game.audio.ui('order');
  }

  focus(): void {
    this.input.focus();
  }

  get focused(): boolean {
    return document.activeElement === this.input;
  }

  /** Called 4x per second of game time. */
  tick(): void {
    if (!this.sandbox.running) return;
    this.ranFor++;
    if (this.ranFor === 24 && this.applied === 0 && this.aiProgram) this.renderStatus(); // show the "fix it" link
    this.sandbox.tick(snapshot(this.game.world, 0, this.game.selected));
  }

  private thinkingSince = 0;
  private thinkingShown = -1;

  update(dt: number): void {
    if (this.status === 'thinking') {
      const secs = Math.floor((performance.now() - this.thinkingSince) / 1000);
      if (secs !== this.thinkingShown) { this.thinkingShown = secs; this.renderStatus(); }
    }
    if (this.focused || this.input.value) return;
    this.placeholderTimer += dt;
    if (this.placeholderTimer > 6) {
      this.placeholderTimer = 0;
      this.placeholderIdx = (this.placeholderIdx + 1) % PLACEHOLDERS.length;
      this.input.placeholder = this.placeholder();
    }
  }

  stop(): void {
    this.request?.abort();
    this.sandbox.stop();
    this.setStatus('idle');
  }

  dispose(): void {
    this.request?.abort();
    this.sandbox.dispose();
  }

  private async submit(): Promise<void> {
    const prompt = this.input.value.trim();
    if (!prompt) return;
    this.history.push(prompt);
    this.histIdx = -1;
    this.input.value = '';
    this.input.blur();
    this.request?.abort();
    this.request = new AbortController();
    this.label = prompt;
    this.setStatus('thinking');
    if (this.mode === 'design') return this.design(prompt);
    this.attempt = 0;
    this.fixNote = '';
    return this.ask(prompt);
  }

  // ---- self-repair: a program that crashes is sent back to the model with the error
  private attempt = 0;
  private aiProgram = false;
  private ranFor = 0; // ticks since the current program started

  private onProgramError(msg: string): void {
    if (this.aiProgram && this.attempt < 2) {
      this.attempt++;
      this.fixNote = `Fixing the program (attempt ${this.attempt}/2): ${msg}`;
      void this.ask(this.label, { code: this.sandbox.source, error: msg });
      return;
    }
    this.setStatus('error', msg);
  }

  private fixNote = '';

  private async ask(prompt: string, fix?: { code: string; error: string }): Promise<void> {
    this.request?.abort();
    this.request = new AbortController();
    this.setStatus('thinking');
    try {
      const context = describe(snapshot(this.game.world, 0, this.game.selected));
      const res = await fetch('api/swarm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, context, fix }),
        signal: this.request.signal,
      });
      const data = (await res.json().catch(() => null)) as { code?: string; error?: string; model?: string } | null;
      if (!res.ok || !data?.code) {
        const offline = res.status === 404 || res.status === 405 || !data;
        throw new Error(offline ? 'The AI server isn’t reachable from this copy of the game. Try one of the ready-made programs below.' : data?.error ?? `Server error ${res.status}`);
      }
      this.run(data.code, prompt, data.model ?? 'AI');
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const msg = err instanceof TypeError ? 'The AI server isn’t reachable. Try one of the ready-made programs below.' : (err as Error).message;
      this.setStatus('error', msg);
    }
  }

  private async design(prompt: string): Promise<void> {
    const team = this.game.world.teams[0];
    try {
      const res = await fetch('api/design', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, unlocked: [...team.unlocked] }),
        signal: this.request!.signal,
      });
      const data = (await res.json().catch(() => null)) as { design?: unknown; error?: string; model?: string } | null;
      if (!res.ok || !data?.design) {
        const offline = res.status === 404 || res.status === 405 || !data;
        throw new Error(offline ? 'The AI designer isn’t reachable from this copy of the game. The ready-made blueprints below still work.' : data?.error ?? `Server error ${res.status}`);
      }
      const v = validateDesign(data.design, team.unlocked);
      if (!v.ok) throw new Error(v.error ?? 'That design did not work.');
      const d = v.design!;
      // Keep names unique so programs can build by name.
      let name = d.name, n = 2;
      while (this.designs.some((x) => x.name === name) || PRESETS.some((x) => x.name === name)) name = `${d.name} ${n++}`;
      d.name = name;
      this.designs.unshift(d);
      this.codeEl.textContent = `// Blueprint from ${data.model ?? 'AI'}\n${JSON.stringify(d, null, 1)}`;
      this.refreshDesigns();
      this.label = name;
      this.setStatus('designed', `Designed ${name}: ${d.cells.length} cells, costs ${designUnits(d)} units.${v.warnings.length ? ' ' + v.warnings.join('. ') + '.' : ''} Select a swarm and press Build.`);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const msg = err instanceof TypeError ? 'The AI designer isn’t reachable. The ready-made blueprints below still work.' : (err as Error).message;
      this.setStatus('error', msg);
    }
  }

  private run(code: string, label: string, source: string): void {
    this.label = label;
    this.applied = 0;
    this.ranFor = 0;
    this.aiProgram = source !== 'example';
    if (source === 'example') this.fixNote = '';
    this.logEl.innerHTML = '';
    this.codeEl.textContent = `// ${source === 'example' ? 'Ready-made program' : `Written by ${source}`}\n${code}`;
    this.sandbox.load(code);
    this.setStatus('running');
    this.game.audio.ui('order');
  }

  private log(lines: string[]): void {
    for (const l of lines) {
      const d = document.createElement('div');
      d.textContent = l;
      this.logEl.append(d);
      setTimeout(() => d.remove(), 7000);
    }
    while (this.logEl.children.length > 4) this.logEl.firstChild!.remove();
  }

  private errorMsg = '';
  private setStatus(s: Status, msg = ''): void {
    this.status = s;
    this.errorMsg = msg;
    if (s === 'thinking') { this.thinkingSince = performance.now(); this.thinkingShown = 0; }
    if (s === 'error') this.game.audio.ui('error');
    this.renderStatus();
  }

  private renderStatus(): void {
    const s = this.status;
    const el = this.statusEl;
    el.dataset.s = s;
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    let html = '';
    if (s === 'idle') html = this.mode === 'command'
      ? '<span class="dot"></span>Standing by. Type an order; the swarm writes its own program and runs it.'
      : '<span class="dot"></span>Describe a construct. It is laid out from the parts you have researched (Y).';
    else if (s === 'thinking' && this.fixNote && this.attempt > 0) html = `<span class="dot"></span>${esc(this.fixNote)} <span class="secs">${Math.max(0, this.thinkingShown)}s</span>`;
    else if (s === 'thinking') html = (this.mode === 'command' ? `<span class="dot"></span>Writing a program for “${esc(this.label)}”…` : `<span class="dot"></span>Designing “${esc(this.label)}”…`) + ` <span class="secs">${Math.max(0, this.thinkingShown)}s</span>`;
    else if (s === 'designed') html = `<span class="dot"></span>${esc(this.errorMsg)}`;
    else if (s === 'running') {
      html = `<span class="dot"></span>Running “${esc(this.label)}” · ${this.applied} orders issued`;
      if (this.attempt > 0) html += ` · repaired ${this.attempt}x`;
      if (this.aiProgram && this.applied === 0 && this.ranFor >= 24) html += ' · no orders yet <button type="button" class="link fix">Ask AI to fix it</button>';
    }
    else if (s === 'done') html = `<span class="dot"></span>Finished “${esc(this.label)}” · ${this.applied} orders issued`;
    else html = `<span class="dot"></span>${esc(this.errorMsg)}`;
    if (this.sandbox?.source && s !== 'thinking') html += ` <button type="button" class="link code-toggle">${this.codeEl.hidden ? 'Show code' : 'Hide code'}</button>`;
    if (s === 'running' || s === 'thinking') html += ' <button type="button" class="link stop">Stop</button>';
    el.innerHTML = html;
    el.querySelector('.code-toggle')?.addEventListener('click', () => {
      this.codeEl.hidden = !this.codeEl.hidden;
      this.renderStatus();
    });
    el.querySelector('.stop')?.addEventListener('click', () => this.stop());
    el.querySelector('.fix')?.addEventListener('click', () => {
      this.attempt++;
      this.fixNote = 'Fixing the program: it issued no orders';
      void this.ask(this.label, { code: this.sandbox.source, error: 'It ran for 6 seconds without issuing a single order. Make sure every group gets the order right away.' });
    });
  }
}

/** Small top-down preview of a blueprint: front (+x) points right. */
function drawBlueprint(cv: HTMLCanvasElement, d: Design, team: [number, number, number]): void {
  const ctx = cv.getContext('2d')!;
  const xs = d.cells.map((c) => c.x), ys = d.cells.map((c) => c.y);
  const span = Math.max(3, Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1);
  const cell = Math.min(14, (cv.width - 10) / span);
  const cx = cv.width / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * cell;
  const cy = cv.height / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * cell;
  ctx.fillStyle = 'rgba(4,8,18,0.9)';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.strokeStyle = `rgba(${team.map((v) => Math.round(v * 255)).join(',')},0.35)`;
  ctx.lineWidth = 1;
  for (let i = 0; i < d.cells.length; i++) for (let j = i + 1; j < d.cells.length; j++) {
    const a = d.cells[i], b = d.cells[j];
    if (Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1) {
      ctx.beginPath();
      ctx.moveTo(cx + a.x * cell, cy + a.y * cell);
      ctx.lineTo(cx + b.x * cell, cy + b.y * cell);
      ctx.stroke();
    }
  }
  for (const c of d.cells) {
    const p = PART_BY_ID.get(c.part)!;
    const col = p.tint.map((v, k) => Math.round((v * 0.5 + team[k] * 0.5) * 255)).join(',');
    ctx.fillStyle = `rgb(${col})`;
    ctx.shadowColor = `rgb(${col})`;
    ctx.shadowBlur = 6;
    const r = cell * 0.22 * p.size + 1.5;
    ctx.beginPath();
    if (p.glyph === 4) { ctx.moveTo(cx + c.x * cell + r, cy + c.y * cell); ctx.lineTo(cx + c.x * cell, cy + c.y * cell + r); ctx.lineTo(cx + c.x * cell - r, cy + c.y * cell); ctx.lineTo(cx + c.x * cell, cy + c.y * cell - r); }
    else ctx.arc(cx + c.x * cell, cy + c.y * cell, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(160,200,255,0.5)';
  ctx.font = '9px Inter, sans-serif';
  ctx.fillText('front →', cv.width - 38, cv.height - 4);
}
