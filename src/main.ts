import './style.css';
import { DIFFICULTY, Difficulty, TEAM_NAMES } from './sim/config';
import { Game, type GameOptions } from './game';
import { Audio } from './ui/audio';

const app = document.getElementById('app')!;
const audio = new Audio();
let game: Game | null = null;
let lastOpts: GameOptions = { difficulty: Difficulty.Normal, rivals: 2, size: 6000 };

try {
  const saved = JSON.parse(localStorage.getItem('swarmer.opts') ?? 'null');
  if (saved && typeof saved.difficulty === 'number') lastOpts = { ...lastOpts, ...saved };
  audio.setMuted(localStorage.getItem('swarmer.muted') === '1');
} catch {
  /* storage unavailable */
}

const CONTROLS = `
<dl class="controls">
  <dt><kbd>Enter</kbd></dt><dd>Give an order in plain language</dd>
  <dt><kbd>LMB</kbd></dt><dd>Select · drag a box · <kbd>Shift</kbd> adds · double-click selects all on screen</dd>
  <dt><kbd>RMB</kbd></dt><dd>Move · attack · harvest · join a friendly swarm · drag to draw a route</dd>
  <dt><kbd>Wheel</kbd> <kbd>MMB</kbd></dt><dd>Zoom · pan (arrow keys and screen edges pan too)</dd>
  <dt><kbd>S</kbd> <kbd>G</kbd> <kbd>H</kbd></dt><dd>Split toward cursor · merge · hold</dd>
  <dt><kbd>B</kbd> <kbd>T</kbd> <kbd>Y</kbd></dt><dd>Replicate · research · research tree</dd>
  <dt><kbd>Q</kbd> <kbd>E</kbd> <kbd>R</kbd></dt><dd>Dash · shield · nova</dd>
  <dt><kbd>Z</kbd> <kbd>X</kbd> <kbd>C</kbd> <kbd>V</kbd></dt><dd>Swarm · wedge · ring · line formation</dd>
  <dt><kbd>1</kbd>–<kbd>5</kbd></dt><dd>Morph: drone · striker · tank · harvester · artillery</dd>
  <dt><kbd>Tab</kbd> <kbd>Space</kbd></dt><dd>Cycle groups · center camera</dd>
  <dt><kbd>P</kbd> <kbd>Esc</kbd></dt><dd>Pause</dd>
</dl>`;

const BUILD = 'BUILD 0.6';

const INTERCEPTS = [
  { order: 'split into three and harvest the closest rocks', code: ['for (const g of state.groups)', '  api.split(g, rock.x - g.x, rock.y - g.y);', '  api.harvest(half, nearest(half, state.rocks));'] },
  { order: 'strikers flank ember from the north, rest hold the line', code: ["api.morph(flank, 'striker');", 'api.path(flank, [[x, y - 600], [ember.x, ember.y]]);', "api.formation(rest, 'line');"] },
  { order: 'build a siege tank and push verdant', code: ["api.build(biggest, 'Siege Tank');", 'api.attack(tank, nearest(tank, verdant));', 'if (tank.ready.shield) api.shield(tank);'] },
];

function screen(cls: string, html: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `screen ${cls}`;
  el.innerHTML = html;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  return el;
}

function closeScreens(): void {
  document.querySelectorAll('.screen').forEach((s) => s.remove());
}

function choice<T>(el: HTMLElement, name: string, values: T[], labels: string[], current: T, set: (v: T) => void): void {
  const row = el.querySelector(`[data-choice="${name}"]`)!;
  values.forEach((v, i) => {
    const b = document.createElement('button');
    b.textContent = labels[i];
    b.className = v === current ? 'on' : '';
    b.addEventListener('click', () => {
      set(v);
      row.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    });
    row.append(b);
  });
}

let demo: Game | null = null;
const demoRoot = document.createElement('div');
demoRoot.className = 'menu-demo';

function startDemo(): void {
  if (demo) return;
  document.body.prepend(demoRoot);
  try {
    demo = new Game(demoRoot, { difficulty: Difficulty.Hard, rivals: 3, size: 4500, demo: true, seed: (Math.random() * 1e9) | 0 }, audio);
    // Skip the slow opening so the menu shows a living swarm.
    for (let i = 0; i < 60 * 70; i++) demo.world.step();
    demo.world.drainEvents();
  } catch {
    demo = null;
  }
}

function stopDemo(): void {
  demo?.destroy();
  demo = null;
  demoRoot.remove();
}

let interceptTimer = 0;

/** Types example orders and the code they turn into, so the menu shows what the prompt does. */
function runIntercepts(host: HTMLElement): void {
  const orderEl = host.querySelector('.ic-order')!;
  const codeEl = host.querySelector('.ic-code')!;
  let i = 0;
  const play = () => {
    const ic = INTERCEPTS[i++ % INTERCEPTS.length];
    orderEl.textContent = '';
    codeEl.innerHTML = '';
    let c = 0;
    const type = () => {
      if (!host.isConnected) return;
      if (c <= ic.order.length) {
        orderEl.textContent = ic.order.slice(0, c++);
        interceptTimer = window.setTimeout(type, 28 + Math.random() * 40);
        return;
      }
      ic.code.forEach((line, k) => {
        interceptTimer = window.setTimeout(() => {
          const d = document.createElement('div');
          d.textContent = line;
          codeEl.append(d);
        }, 350 + k * 260);
      });
      interceptTimer = window.setTimeout(play, 4200);
    };
    type();
  };
  play();
}

function menu(): void {
  closeScreens();
  game?.destroy();
  game = null;
  startDemo();
  const opts = { ...lastOpts };
  const el = screen('menu', `
    <div class="shell">
      <header class="brand">
        <div class="kicker">Tactical swarm command</div>
        <h1 class="logo">SWARMER</h1>
        <div class="rule"><i></i></div>
      </header>
      <nav class="menu-list" aria-label="Main menu">
        <button class="mi mi-primary" data-act="deploy">Deploy<small>Launch the sector below</small></button>
        <button class="mi" data-act="briefing">Briefing<small>How the swarm thinks</small></button>
        <button class="mi" data-act="controls">Controls<small>Mouse and hotkeys</small></button>
        <button class="mi" data-act="sound">Sound<small class="snd"></small></button>
      </nav>
      <section class="panel setup" aria-label="Sector setup">
        <div class="panel-h">Sector setup</div>
        <div class="opt"><label>Difficulty</label><div class="seg" data-choice="diff"></div></div>
        <div class="opt"><label>Rival swarms</label><div class="seg" data-choice="rivals"></div></div>
        <div class="opt"><label>Sector size</label><div class="seg" data-choice="size"></div></div>
      </section>
      <p class="desktop-note">Built for mouse and keyboard. Open it on a desktop for the full game.</p>
    </div>
    <aside class="panel side" data-panel="intercept">
      <div class="panel-h">Comms <span class="live">Live</span></div>
      <div class="ic-line"><span class="ic-pr">ORDER&gt;</span> <span class="ic-order"></span><span class="caret"></span></div>
      <div class="ic-code"></div>
      <p class="ic-note">Type orders in plain language. Your swarm writes its own program and runs it, live.</p>
    </aside>
    <aside class="panel side" data-panel="briefing" hidden>
      <div class="panel-h">Briefing</div>
      <ol class="brief">
        <li><b>Grow.</b> Right-click asteroids to harvest them into new units. Press <kbd>B</kbd> to replicate in place.</li>
        <li><b>Talk.</b> Press <kbd>Enter</kbd> and give an order in plain language. The swarm writes a program for it; <em>Show code</em> reveals what it wrote.</li>
        <li><b>Research.</b> <kbd>T</kbd> earns points; <kbd>Y</kbd> opens the tree. Unlock armor, cannons, menders and more.</li>
        <li><b>Fabricate.</b> In the Fabrication tab, describe a construct like a tank. It is built from your own units and crumbles as it takes hits.</li>
        <li><b>Survive.</b> Raider fleets hunt every swarm. Wipe out the rival swarms to secure the sector.</li>
      </ol>
    </aside>
    <aside class="panel side" data-panel="controls" hidden>
      <div class="panel-h">Controls</div>
      ${CONTROLS}
    </aside>
    <footer class="foot"><span>${BUILD}</span><span>AI by Cloudflare Workers AI</span></footer>`);
  choice(el, 'diff', [0, 1, 2], DIFFICULTY.map((d) => d.name), opts.difficulty, (v) => (opts.difficulty = v));
  choice(el, 'rivals', [1, 2, 3], ['1', '2', '3'], opts.rivals, (v) => (opts.rivals = v));
  choice(el, 'size', [4500, 6000, 8000], ['Small', 'Medium', 'Large'], opts.size, (v) => (opts.size = v));
  const snd = el.querySelector('.snd')!;
  const showSound = () => (snd.textContent = audio.muted ? 'Off' : 'On');
  showSound();
  const show = (name: string) => {
    el.querySelectorAll<HTMLElement>('.side').forEach((p) => (p.hidden = p.dataset.panel !== name));
    el.querySelectorAll<HTMLElement>('.mi').forEach((b) => b.classList.toggle('on', b.dataset.act === name));
  };
  el.querySelectorAll<HTMLButtonElement>('.mi').forEach((b) =>
    b.addEventListener('click', () => {
      audio.unlock();
      audio.ui('click');
      const act = b.dataset.act!;
      if (act === 'deploy') {
        lastOpts = opts;
        try { localStorage.setItem('swarmer.opts', JSON.stringify(opts)); } catch { /* ignore */ }
        start(opts);
      } else if (act === 'sound') {
        audio.setMuted(!audio.muted);
        showSound();
      } else show(el.querySelector<HTMLElement>(`[data-panel="${act}"]`)!.hidden ? act : 'intercept');
    }));
  runIntercepts(el.querySelector('[data-panel="intercept"]')!);
}

function start(opts: GameOptions): void {
  clearTimeout(interceptTimer);
  closeScreens();
  stopDemo();
  game?.destroy();
  try {
    game = new Game(app, { ...opts, seed: (Math.random() * 1e9) | 0 }, audio);
  } catch (err) {
    screen('menu', `<div class="shell"><header class="brand"><div class="kicker">Display error</div><h1 class="logo">NO SIGNAL</h1><div class="rule"><i></i></div></header>
      <section class="panel setup"><p>${(err as Error).message}</p><p>Swarmer needs WebGL2: any recent Chrome, Edge, Firefox or Safari.</p></section></div>`);
    return;
  }
  game.onPause = (p) => (p ? pauseScreen() : closeScreens());
  game.onEnd = (won) => endScreen(won);
}

function pauseScreen(): void {
  closeScreens();
  const el = screen('pause', `
    <div class="shell">
      <header class="brand"><div class="kicker">Sector ${game ? Math.floor(game.world.time / 60) + ':' + String(Math.floor(game.world.time) % 60).padStart(2, '0') : ''}</div><h1 class="logo">PAUSED</h1><div class="rule"><i></i></div></header>
      <nav class="menu-list">
        <button class="mi mi-primary resume">Resume<small>Back to the sector</small></button>
        <button class="mi restart">Restart<small>Same settings, new sector</small></button>
        <button class="mi quit">Abandon<small>Return to the main menu</small></button>
      </nav>
    </div>
    <aside class="panel side"><div class="panel-h">Controls</div>${CONTROLS}</aside>`);
  el.querySelector('.resume')!.addEventListener('click', () => game?.setPaused(false));
  el.querySelector('.restart')!.addEventListener('click', () => start(lastOpts));
  el.querySelector('.quit')!.addEventListener('click', menu);
}

function endScreen(won: boolean): void {
  if (!game) return;
  closeScreens();
  const w = game.world;
  const me = w.teams[0];
  const t = Math.floor(w.time);
  const rows = w.teams.slice(1).map((tm) => `<tr><td>${TEAM_NAMES[tm.id]}</td><td class="${tm.alive ? 'alive' : 'dead'}">${tm.alive ? 'Active' : 'Destroyed'}</td><td>${tm.kills}</td></tr>`).join('');
  const el = screen(`end ${won ? 'won' : 'lost'}`, `
    <div class="shell">
      <header class="brand"><div class="kicker">After-action report</div><h1 class="logo">${won ? 'SECURED' : 'SWARM LOST'}</h1><div class="rule"><i></i></div></header>
      <p class="verdict">${won ? 'Every rival swarm has been consumed. The sector is yours.' : 'Your last unit went dark.'}</p>
      <dl class="stats-grid">
        <div><dt>Time</dt><dd>${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}</dd></div>
        <div><dt>Peak units</dt><dd>${me.peak}</dd></div>
        <div><dt>Units grown</dt><dd>${me.spawned}</dd></div>
        <div><dt>Kills</dt><dd>${me.kills}</dd></div>
        <div><dt>Lost</dt><dd>${me.lost}</dd></div>
        <div><dt>Raids survived</dt><dd>${w.waveNum}</dd></div>
      </dl>
      <nav class="menu-list">
        <button class="mi mi-primary again">Redeploy<small>New sector, same settings</small></button>
        <button class="mi quit">Main menu</button>
      </nav>
    </div>
    <aside class="panel side"><div class="panel-h">Rivals</div><table class="rivals"><thead><tr><th>Swarm</th><th>Status</th><th>Kills</th></tr></thead><tbody>${rows}</tbody></table></aside>`);
  el.querySelector('.again')!.addEventListener('click', () => start(lastOpts));
  el.querySelector('.quit')!.addEventListener('click', menu);
}

// Persist mute toggle.
const origSetMuted = audio.setMuted.bind(audio);
audio.setMuted = (m: boolean) => {
  origSetMuted(m);
  try { localStorage.setItem('swarmer.muted', m ? '1' : '0'); } catch { /* ignore */ }
};

// Debug/automation hook.
(window as unknown as { swarmer: unknown }).swarmer = { get game() { return game; }, start, menu };

menu();
