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
<div class="controls">
  <div><kbd>LMB</kbd> drag / click</div><div>Select groups (<kbd>Shift</kbd> adds, double-click = all on screen)</div>
  <div><kbd>RMB</kbd></div><div>Move · attack enemy · harvest rock · join friendly group</div>
  <div><kbd>Wheel</kbd> · <kbd>MMB</kbd> drag · arrows</div><div>Zoom · pan</div>
  <div><kbd>S</kbd> <kbd>G</kbd> <kbd>H</kbd></div><div>Split toward cursor · merge · hold</div>
  <div><kbd>B</kbd> <kbd>T</kbd> <kbd>Y</kbd></div><div>Replicate · research · research panel</div>
  <div><kbd>Q</kbd> <kbd>E</kbd> <kbd>R</kbd></div><div>Dash · shield · nova</div>
  <div><kbd>Z</kbd> <kbd>X</kbd> <kbd>C</kbd> <kbd>V</kbd></div><div>Swarm · wedge · ring · line formation</div>
  <div><kbd>1</kbd>–<kbd>5</kbd></div><div>Morph: drone · striker · tank · harvester · artillery</div>
  <div><kbd>Tab</kbd> <kbd>Space</kbd> <kbd>\`</kbd></div><div>Cycle groups · center camera · select all</div>
</div>`;

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

function menu(): void {
  closeScreens();
  game?.destroy();
  game = null;
  startDemo();
  const opts = { ...lastOpts };
  const el = screen('menu', `
    <div class="menu-card">
      <h1>SWARMER</h1>
      <p class="tag">Command thousands. Harvest, split, morph, and overwhelm.</p>
      <div class="opt"><label>Difficulty</label><div class="seg" data-choice="diff"></div></div>
      <div class="opt"><label>Rival swarms</label><div class="seg" data-choice="rivals"></div></div>
      <div class="opt"><label>Map</label><div class="seg" data-choice="size"></div></div>
      <button class="play">Play</button>
      <p class="desktop-note">Swarmer is built for a mouse and keyboard. Open it on a desktop for the full game.</p>
      <details><summary>Controls</summary>${CONTROLS}</details>
    </div>`);
  choice(el, 'diff', [0, 1, 2], DIFFICULTY.map((d) => d.name), opts.difficulty, (v) => (opts.difficulty = v));
  choice(el, 'rivals', [1, 2, 3], ['1', '2', '3'], opts.rivals, (v) => (opts.rivals = v));
  choice(el, 'size', [4500, 6000, 8000], ['Small', 'Medium', 'Large'], opts.size, (v) => (opts.size = v));
  el.querySelector('.play')!.addEventListener('click', () => {
    audio.unlock();
    lastOpts = opts;
    try { localStorage.setItem('swarmer.opts', JSON.stringify(opts)); } catch { /* ignore */ }
    start(opts);
  });
}

function start(opts: GameOptions): void {
  closeScreens();
  stopDemo();
  game?.destroy();
  try {
    game = new Game(app, { ...opts, seed: (Math.random() * 1e9) | 0 }, audio);
  } catch (err) {
    screen('menu', `<div class="menu-card"><h1>Oops</h1><p class="tag">${(err as Error).message}</p><p>Swarmer needs a browser with WebGL2 (any recent Chrome, Edge, Firefox or Safari).</p></div>`);
    return;
  }
  game.onPause = (p) => (p ? pauseScreen() : closeScreens());
  game.onEnd = (won) => endScreen(won);
}

function pauseScreen(): void {
  closeScreens();
  const el = screen('pause', `
    <div class="menu-card">
      <h2>Paused</h2>
      <button class="play resume">Resume</button>
      <div class="row"><button class="ghost restart">Restart</button><button class="ghost quit">Main menu</button></div>
      ${CONTROLS}
    </div>`);
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
  const rivals = w.teams.slice(1).map((tm) => `${TEAM_NAMES[tm.id]}: ${tm.alive ? 'alive' : 'destroyed'}`).join(' · ');
  const el = screen(`end ${won ? 'won' : 'lost'}`, `
    <div class="menu-card">
      <h1>${won ? 'Victory' : 'Swarm lost'}</h1>
      <p class="tag">${won ? 'Every rival swarm has been consumed.' : 'Your swarm perished.'}</p>
      <div class="end-stats">
        <div><b>${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}</b><small>time</small></div>
        <div><b>${me.peak}</b><small>peak units</small></div>
        <div><b>${me.spawned}</b><small>units grown</small></div>
        <div><b>${me.kills}</b><small>kills</small></div>
        <div><b>${me.lost}</b><small>lost</small></div>
        <div><b>${me.pointsEarned}</b><small>research</small></div>
      </div>
      <p class="sub">${rivals} · survived ${w.waveNum} raids</p>
      <div class="row"><button class="play again">Play again</button><button class="ghost quit">Main menu</button></div>
    </div>`);
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
