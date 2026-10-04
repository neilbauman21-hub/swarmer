import { applyCommands, describe, snapshot } from '../ai/protocol';
import { EXAMPLES, PLACEHOLDERS } from '../ai/examples';
import { SwarmSandbox } from '../ai/sandbox';
import type { Game } from '../game';

type Status = 'idle' | 'thinking' | 'running' | 'error' | 'done';

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
      <div class="dock-status" data-s="idle"></div>
      <form class="dock-form" autocomplete="off">
        <svg class="dock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="2.5"/></svg>
        <input id="swarm-prompt" maxlength="500" spellcheck="false" aria-label="Order for your swarm">
        <button type="submit" class="dock-go">Command <kbd>Enter</kbd></button>
      </form>
      <div class="dock-examples"></div>
      <pre class="dock-code" hidden></pre>
      <div class="dock-log"></div>`;
    host.append(this.el);
    this.input = this.el.querySelector('input')!;
    this.statusEl = this.el.querySelector('.dock-status')!;
    this.codeEl = this.el.querySelector('.dock-code')!;
    this.logEl = this.el.querySelector('.dock-log')!;
    this.input.placeholder = `Tell your swarm what to do… e.g. "${PLACEHOLDERS[0]}"`;

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
      onError: (msg) => this.setStatus('error', msg),
      onDone: () => this.setStatus('done'),
    });
    this.renderStatus();
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
    this.sandbox.tick(snapshot(this.game.world, 0, this.game.selected));
  }

  update(dt: number): void {
    if (this.focused || this.input.value) return;
    this.placeholderTimer += dt;
    if (this.placeholderTimer > 6) {
      this.placeholderTimer = 0;
      this.placeholderIdx = (this.placeholderIdx + 1) % PLACEHOLDERS.length;
      this.input.placeholder = `Tell your swarm what to do… e.g. "${PLACEHOLDERS[this.placeholderIdx]}"`;
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
    try {
      const context = describe(snapshot(this.game.world, 0, this.game.selected));
      const res = await fetch('api/swarm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, context }),
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

  private run(code: string, label: string, source: string): void {
    this.label = label;
    this.applied = 0;
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
    if (s === 'error') this.game.audio.ui('error');
    this.renderStatus();
  }

  private renderStatus(): void {
    const s = this.status;
    const el = this.statusEl;
    el.dataset.s = s;
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    let html = '';
    if (s === 'idle') html = '<span class="dot"></span>Type an order in plain English. The swarm writes its own program and runs it.';
    else if (s === 'thinking') html = `<span class="dot"></span>Writing a program for “${esc(this.label)}”…`;
    else if (s === 'running') html = `<span class="dot"></span>Running “${esc(this.label)}” · ${this.applied} orders issued`;
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
  }
}
