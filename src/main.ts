import './style.css';
import { Difficulty } from './sim/config';
import { Game } from './game';
import { Audio } from './ui/audio';
import { Connection, LocalLink, arenaStatus, type NetLink, type Welcome } from './net/link';

const app = document.getElementById('app')!;
const audio = new Audio();
let game: Game | null = null;
let conn: Connection | null = null;
let callsign = '';

try {
  callsign = localStorage.getItem('swarmer.name') ?? '';
  audio.setMuted(localStorage.getItem('swarmer.muted') === '1');
} catch {
  /* storage unavailable */
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const CONTROLS = `
<dl class="controls">
  <dt><kbd>Enter</kbd></dt><dd>Give an order in plain language</dd>
  <dt><kbd>LMB</kbd></dt><dd>Click to move, attack or harvest · click your swarm to select it · drag a box · double-click selects all on screen</dd>
  <dt><kbd>RMB</kbd></dt><dd>On your swarm: every order (replicate, research, split, morph, formation, abilities, fabricate) · elsewhere: same as a click · drag to draw a route · <kbd>Shift</kbd> queues waypoints</dd>
  <dt><kbd>Wheel</kbd> <kbd>MMB</kbd></dt><dd>Zoom · pan (arrow keys and screen edges pan too)</dd>
  <dt><kbd>S</kbd> <kbd>G</kbd> <kbd>H</kbd></dt><dd>Split toward cursor · merge · hold</dd>
  <dt><kbd>B</kbd> <kbd>T</kbd> <kbd>Y</kbd></dt><dd>Replicate · research (earns points) · research tree (construct particles)</dd>
  <dt><kbd>Q</kbd> <kbd>E</kbd> <kbd>R</kbd></dt><dd>Dash · shield · nova</dd>
  <dt><kbd>Z</kbd> <kbd>X</kbd> <kbd>C</kbd> <kbd>V</kbd></dt><dd>Swarm · wedge · ring · line formation</dd>
  <dt><kbd>1</kbd>–<kbd>5</kbd></dt><dd>Morph: drone · striker · tank · harvester · artillery</dd>
  <dt><kbd>Tab</kbd> <kbd>Space</kbd></dt><dd>Cycle groups · center camera (redeploy when wiped out)</dd>
  <dt><kbd>Esc</kbd></dt><dd>Menu (the match keeps running)</dd>
</dl>`;

const BUILD = 'BUILD 0.9 · ENDLESS ARENA';

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

let demo: Game | null = null;
const demoRoot = document.createElement('div');
demoRoot.className = 'menu-demo';

function startDemo(): void {
  if (demo) return;
  document.body.prepend(demoRoot);
  try {
    demo = new Game(demoRoot, { difficulty: Difficulty.Hard, teams: 4, humans: [], size: 4500, demo: true, seed: (Math.random() * 1e9) | 0 }, audio, new LocalLink(-1));
    // Skip the slow opening so the menu shows a living swarm.
    demo.skipTicks = 60 * 70;
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

function menu(notice = ''): void {
  closeScreens();
  game?.destroy();
  game = null;
  conn?.close();
  conn = null;
  startDemo();
  const el = screen('menu', `
    <div class="shell">
      <header class="brand">
        <div class="kicker">One endless arena</div>
        <h1 class="logo">SWARMER</h1>
        <div class="rule"><i></i></div>
      </header>
      <section class="panel setup callsign" aria-label="Callsign">
        <div class="opt"><label for="cs">Callsign</label><input id="cs" maxlength="16" spellcheck="false" placeholder="Pilot name" value="${esc(callsign)}"></div>
      </section>
      <nav class="menu-list" aria-label="Main menu">
        <button class="mi mi-primary" data-act="play">Enter the arena<small class="online">Drop in, fight, leave whenever</small></button>
        <button class="mi" data-act="briefing">Briefing<small>How the swarm thinks</small></button>
        <button class="mi" data-act="controls">Controls<small>Mouse and hotkeys</small></button>
        <button class="mi" data-act="sound">Sound<small class="snd"></small></button>
      </nav>
      ${notice ? `<p class="notice">${esc(notice)}</p>` : ''}
      <p class="desktop-note">Built for mouse and keyboard. Open it on a desktop for the full game.</p>
    </div>
    <aside class="panel side" data-panel="intercept">
      <div class="panel-h">Comms <span class="live">Live</span></div>
      <div class="ic-line"><span class="ic-pr">ORDER&gt;</span> <span class="ic-order"></span><span class="caret"></span></div>
      <div class="ic-code"></div>
      <p class="ic-note">Type orders in plain language. Your swarm writes its own program and runs it, live, against everyone else in the arena.</p>
    </aside>
    <aside class="panel side" data-panel="briefing" hidden>
      <div class="panel-h">Briefing</div>
      <ol class="brief">
        <li><b>One arena.</b> Everyone plays on the same endless map. It never resets: drop in, fight, leave whenever. Bots keep it busy when it's quiet.</li>
        <li><b>Move.</b> Click anywhere to send your swarm, click an asteroid to mine it into new units. Asteroids grow back.</li>
        <li><b>Right-click your swarm</b> for every order: replicate, research, split, morph, formation, abilities and fabrication.</li>
        <li><b>Talk.</b> Press <kbd>Enter</kbd> and give an order in plain language. The swarm writes a program for it; <em>Show code</em> reveals what it wrote.</li>
        <li><b>Research</b> unlocks particle types for constructs: armor plates, spikes, thrusters, cannons, menders and more. Morphing into strikers, tanks, harvesters or artillery is always available.</li>
        <li><b>Fabricate.</b> Describe a construct like a tank. It is built from your own units and crumbles as it takes hits.</li>
        <li><b>Wiped out?</b> Redeploy with a fresh swarm somewhere quiet. Climb the leaderboard by staying big.</li>
      </ol>
    </aside>
    <aside class="panel side" data-panel="controls" hidden>
      <div class="panel-h">Controls</div>
      ${CONTROLS}
    </aside>
    <footer class="foot"><span>${BUILD}</span><span>AI by Cloudflare Workers AI</span></footer>`);
  const cs = el.querySelector<HTMLInputElement>('#cs')!;
  cs.addEventListener('input', () => {
    callsign = cs.value.trim();
    try { localStorage.setItem('swarmer.name', callsign); } catch { /* ignore */ }
  });
  cs.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
  const snd = el.querySelector('.snd')!;
  const showSound = () => (snd.textContent = audio.muted ? 'Off' : 'On');
  showSound();
  void arenaStatus().then((st) => {
    if (!st || !el.isConnected) return;
    el.querySelector('.online')!.textContent = st.players
      ? `${st.players} pilot${st.players === 1 ? '' : 's'} in now: ${st.names.slice(0, 4).map(esc).join(', ')}${st.players > 4 ? '…' : ''}`
      : 'Nobody in right now: the bots are waiting';
  });
  const show = (name: string) => {
    el.querySelectorAll<HTMLElement>('.side').forEach((p) => (p.hidden = p.dataset.panel !== name));
    el.querySelectorAll<HTMLElement>('.mi').forEach((b) => b.classList.toggle('on', b.dataset.act === name));
  };
  el.querySelectorAll<HTMLButtonElement>('button.mi').forEach((b) =>
    b.addEventListener('click', () => {
      audio.unlock();
      audio.ui('click');
      const act = b.dataset.act!;
      if (act === 'play') enter();
      else if (act === 'sound') {
        audio.setMuted(!audio.muted);
        showSound();
      } else show(el.querySelector<HTMLElement>(`[data-panel="${act}"]`)!.hidden ? act : 'intercept');
    }));
  runIntercepts(el.querySelector('[data-panel="intercept"]')!);
}

/** Connect to the arena; the game starts as soon as the world (fresh, saved, or another pilot's) arrives. */
function enter(): void {
  audio.unlock();
  clearTimeout(interceptTimer);
  conn?.close();
  const c = (conn = new Connection(callsign));
  closeScreens();
  screen('menu connecting', `
    <div class="shell">
      <header class="brand"><div class="kicker">Arena</div><h1 class="logo">LINKING</h1><div class="rule"><i></i></div></header>
      <p class="verdict">Syncing with the arena…</p>
      <nav class="menu-list"><button class="mi cancel">Cancel</button></nav>
    </div>`).querySelector('.cancel')!.addEventListener('click', () => menu());
  c.onWelcome = (w: Welcome, link: NetLink) => start(w, link);
  c.onError = (msg, reload) => {
    if (reload) {
      menu(msg);
      setTimeout(() => location.reload(), 1200);
    } else menu(msg);
  };
  c.onClose = () => {
    if (conn !== c) return;
    menu(game ? 'Lost the connection to the arena.' : 'Could not reach the arena. Check your connection and try again.');
  };
  c.onNotice = (text) => game?.hud?.banner(text, '#9fe0ff');
}

function start(wel: Welcome, link: NetLink): void {
  closeScreens();
  stopDemo();
  game?.destroy();
  try {
    game = new Game(app, {
      arena: true, seed: wel.seed ?? 1,
      init: (w) => {
        if (wel.snapshot) w.restore(wel.snapshot);
        w.tick = wel.tick;
        // A saved arena nobody is in: every swarm in it is a bot now.
        if (wel.stored) w.orphanAll();
      },
    }, audio, link);
  } catch (err) {
    link.close();
    screen('menu', `<div class="shell"><header class="brand"><div class="kicker">Display error</div><h1 class="logo">NO SIGNAL</h1><div class="rule"><i></i></div></header>
      <section class="panel setup"><p>${esc((err as Error).message)}</p><p>Swarmer needs WebGL2: any recent Chrome, Edge, Firefox or Safari.</p></section></div>`);
    return;
  }
  game.onPause = (p) => (p ? pauseScreen() : closeScreens());
}

function pauseScreen(): void {
  closeScreens();
  const el = screen('pause', `
    <div class="shell">
      <header class="brand"><div class="kicker">The arena keeps running</div><h1 class="logo">MENU</h1><div class="rule"><i></i></div></header>
      <nav class="menu-list">
        <button class="mi mi-primary resume">Resume<small>Back to the arena</small></button>
        <button class="mi quit">Leave arena<small>Your swarm fights on as a bot</small></button>
      </nav>
    </div>
    <aside class="panel side"><div class="panel-h">Controls</div>${CONTROLS}</aside>`);
  el.querySelector('.resume')!.addEventListener('click', () => game?.setPaused(false));
  el.querySelector('.quit')!.addEventListener('click', () => menu());
}

// Persist mute toggle.
const origSetMuted = audio.setMuted.bind(audio);
audio.setMuted = (m: boolean) => {
  origSetMuted(m);
  try { localStorage.setItem('swarmer.muted', m ? '1' : '0'); } catch { /* ignore */ }
};

/** Offline arena for automated tests only (not reachable from the UI). */
function startLocal(seed = 1): Game {
  closeScreens();
  stopDemo();
  game?.destroy();
  game = new Game(app, { arena: true, seed }, audio, new LocalLink(1, callsign || 'Tester'));
  return game;
}

// Debug/automation hook.
(window as unknown as { swarmer: unknown }).swarmer = { get game() { return game; }, get conn() { return conn; }, menu, enter, startLocal };

if (location.search.includes('room=')) history.replaceState(null, '', location.pathname);
menu();
