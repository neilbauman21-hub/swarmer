import './style.css';
import { DIFFICULTY, Difficulty, TEAM_COLORS } from './sim/config';
import { Game, type EndKind, type GameOptions } from './game';
import { Audio } from './ui/audio';
import { Connection, LocalLink, newRoomCode, quickCode, type LobbyInfo, type StartInfo } from './net/link';

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
const rgb = (t: number) => `rgb(${(TEAM_COLORS[t] ?? [1, 1, 1]).map((v) => Math.round(v * 255)).join(',')})`;

const CONTROLS = `
<dl class="controls">
  <dt><kbd>Enter</kbd></dt><dd>Give an order in plain language</dd>
  <dt><kbd>LMB</kbd></dt><dd>Click to move, attack or harvest · click your swarm to select it · drag a box · double-click selects all on screen</dd>
  <dt><kbd>RMB</kbd></dt><dd>On your swarm: every order (replicate, research, split, morph, formation, abilities, fabricate) · elsewhere: same as a click · drag to draw a route · <kbd>Shift</kbd> queues waypoints</dd>
  <dt><kbd>Wheel</kbd> <kbd>MMB</kbd></dt><dd>Zoom · pan (arrow keys and screen edges pan too)</dd>
  <dt><kbd>S</kbd> <kbd>G</kbd> <kbd>H</kbd></dt><dd>Split toward cursor · merge · hold</dd>
  <dt><kbd>B</kbd> <kbd>T</kbd> <kbd>Y</kbd></dt><dd>Replicate · research · research tree</dd>
  <dt><kbd>Q</kbd> <kbd>E</kbd> <kbd>R</kbd></dt><dd>Dash · shield · nova</dd>
  <dt><kbd>Z</kbd> <kbd>X</kbd> <kbd>C</kbd> <kbd>V</kbd></dt><dd>Swarm · wedge · ring · line formation</dd>
  <dt><kbd>1</kbd>–<kbd>5</kbd></dt><dd>Morph: drone · striker · tank · harvester · artillery (research them first)</dd>
  <dt><kbd>Tab</kbd> <kbd>Space</kbd></dt><dd>Cycle groups · center camera</dd>
  <dt><kbd>Esc</kbd></dt><dd>Menu (the match keeps running)</dd>
</dl>`;

const BUILD = 'BUILD 0.8 · MULTIPLAYER';

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

function choice<T>(el: HTMLElement, name: string, values: T[], labels: string[], current: T, set: (v: T) => void, enabled = true): void {
  const row = el.querySelector(`[data-choice="${name}"]`)!;
  row.innerHTML = '';
  values.forEach((v, i) => {
    const b = document.createElement('button');
    b.textContent = labels[i];
    b.className = v === current ? 'on' : '';
    b.disabled = !enabled;
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

function leaveRoom(): void {
  if (conn && !conn.link) conn.close();
  conn = null;
}

function menu(notice = ''): void {
  closeScreens();
  game?.destroy();
  game = null;
  leaveRoom();
  startDemo();
  history.replaceState(null, '', location.pathname);
  const el = screen('menu', `
    <div class="shell">
      <header class="brand">
        <div class="kicker">Multiplayer swarm command</div>
        <h1 class="logo">SWARMER</h1>
        <div class="rule"><i></i></div>
      </header>
      <section class="panel setup callsign" aria-label="Callsign">
        <div class="opt"><label for="cs">Callsign</label><input id="cs" maxlength="16" spellcheck="false" placeholder="Pilot name" value="${esc(callsign)}"></div>
      </section>
      <nav class="menu-list" aria-label="Main menu">
        <button class="mi mi-primary" data-act="quick">Quick match<small>Join the next open sector · bots fill empty slots</small></button>
        <button class="mi" data-act="create">Create room<small>Private sector · share the code with friends</small></button>
        <div class="mi join"><span>Join room<small>Enter a 5-letter code</small></span><form class="join-form" autocomplete="off"><input class="code" maxlength="5" spellcheck="false" placeholder="CODE" aria-label="Room code"><button type="submit">Join</button></form></div>
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
      <p class="ic-note">Type orders in plain language. Your swarm writes its own program and runs it, live, against other players.</p>
    </aside>
    <aside class="panel side" data-panel="briefing" hidden>
      <div class="panel-h">Briefing</div>
      <ol class="brief">
        <li><b>Move.</b> Your swarm starts selected: click anywhere to send it, click an asteroid to mine it into new units.</li>
        <li><b>Right-click your swarm</b> for every order: replicate, research, split, morph, formation, abilities and fabrication.</li>
        <li><b>Talk.</b> Press <kbd>Enter</kbd> and give an order in plain language. The swarm writes a program for it; <em>Show code</em> reveals what it wrote.</li>
        <li><b>Research</b> unlocks new particle types: strikers, tanks, artillery, armor plates, cannons, menders and more.</li>
        <li><b>Fabricate.</b> Describe a construct like a tank. It is built from your own units and crumbles as it takes hits.</li>
        <li><b>Win.</b> Up to four swarms per sector, players and bots. Raider fleets hunt everyone. Last swarm standing takes it.</li>
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
  const snd = el.querySelector('.snd')!;
  const showSound = () => (snd.textContent = audio.muted ? 'Off' : 'On');
  showSound();
  const show = (name: string) => {
    el.querySelectorAll<HTMLElement>('.side').forEach((p) => (p.hidden = p.dataset.panel !== name));
    el.querySelectorAll<HTMLElement>('.mi').forEach((b) => b.classList.toggle('on', b.dataset.act === name));
  };
  el.querySelectorAll<HTMLButtonElement>('button.mi').forEach((b) =>
    b.addEventListener('click', async () => {
      audio.unlock();
      audio.ui('click');
      const act = b.dataset.act!;
      if (act === 'quick') {
        b.disabled = true;
        try { join(await quickCode(), true); } catch (err) { menu((err as Error).message); }
      } else if (act === 'create') {
        b.disabled = true;
        try { join(await newRoomCode(), false); } catch (err) { menu((err as Error).message); }
      } else if (act === 'sound') {
        audio.setMuted(!audio.muted);
        showSound();
      } else show(el.querySelector<HTMLElement>(`[data-panel="${act}"]`)!.hidden ? act : 'intercept');
    }));
  const codeIn = el.querySelector<HTMLInputElement>('.code')!;
  codeIn.addEventListener('input', () => (codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  el.querySelector('.join-form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    audio.unlock();
    if (codeIn.value.length === 5) join(codeIn.value, false);
    else codeIn.focus();
  });
  runIntercepts(el.querySelector('[data-panel="intercept"]')!);
}

/** Connect to a room and show its lobby until the match starts. */
function join(code: string, isPublic: boolean, retries = 2): void {
  clearTimeout(interceptTimer);
  leaveRoom();
  const c = (conn = new Connection(code, callsign, isPublic));
  history.replaceState(null, '', `?room=${code}`);
  closeScreens();
  const el = screen('menu lobby', `
    <div class="shell">
      <header class="brand">
        <div class="kicker">${isPublic ? 'Quick match' : 'Private sector'}</div>
        <h1 class="logo">LOBBY</h1>
        <div class="rule"><i></i></div>
      </header>
      <section class="panel setup">
        <div class="panel-h">Room <b class="room-code">${code}</b> <button type="button" class="link copy">Copy invite link</button></div>
        <ul class="roster"><li class="wait">Connecting…</li></ul>
        <p class="lobby-status"></p>
      </section>
      <section class="panel setup host-only" hidden>
        <div class="panel-h">Sector setup</div>
        <div class="opt"><label>Bots</label><div class="seg" data-choice="bots"></div></div>
        <div class="opt"><label>Bot skill</label><div class="seg" data-choice="diff"></div></div>
        <div class="opt"><label>Sector size</label><div class="seg" data-choice="size"></div></div>
      </section>
      <nav class="menu-list">
        <button class="mi mi-primary start" hidden>Launch<small>Start the match for everyone</small></button>
        <button class="mi leave">Leave<small>Back to the main menu</small></button>
      </nav>
    </div>
    <aside class="panel side"><div class="panel-h">Controls</div>${CONTROLS}</aside>`);
  el.querySelector('.leave')!.addEventListener('click', () => menu());
  el.querySelector('.copy')!.addEventListener('click', (e) => {
    const url = `${location.origin}${location.pathname}?room=${code}`;
    void navigator.clipboard?.writeText(url).then(() => ((e.target as HTMLElement).textContent = 'Copied'));
  });
  const startBtn = el.querySelector<HTMLButtonElement>('.start')!;
  startBtn.addEventListener('click', () => { c.send({ t: 'start' }); startBtn.disabled = true; });
  let countdown = 0;
  let deadline = 0;
  const status = el.querySelector('.lobby-status')!;
  const tickCountdown = () => {
    const left = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    status.textContent = `Launching in ${left}s · more players can still join`;
  };
  c.onLobby = (l: LobbyInfo) => {
    const host = l.you === l.host;
    el.querySelector('.roster')!.innerHTML = l.players.map((p, i) =>
      `<li style="--c:${rgb(i)}"><i></i>${esc(p.name)}${p.id === l.you ? ' <em>you</em>' : ''}${p.id === l.host && !l.public ? ' <em>host</em>' : ''}</li>`).join('') +
      Array.from({ length: Math.max(0, Math.min(4 - l.players.length, l.public ? 4 : l.settings.bots)) }, (_, k) =>
        `<li class="bot" style="--c:${rgb(l.players.length + k)}"><i></i>Bot</li>`).join('');
    el.querySelector<HTMLElement>('.host-only')!.hidden = l.public || !host;
    startBtn.hidden = l.public || !host;
    clearInterval(countdown);
    if (l.public && l.startsIn !== null) {
      deadline = performance.now() + l.startsIn;
      tickCountdown();
      countdown = window.setInterval(tickCountdown, 250);
    } else status.textContent = host ? 'Share the code, then launch when everyone is in.' : 'Waiting for the host to launch.';
    if (host && !l.public) {
      const set = (patch: Partial<LobbyInfo['settings']>) => c.send({ t: 'settings', ...l.settings, ...patch });
      choice(el, 'bots', [0, 1, 2, 3], ['0', '1', '2', '3'], l.settings.bots, (v) => set({ bots: v }));
      choice(el, 'diff', [0, 1, 2], DIFFICULTY.map((d) => d.name), l.settings.difficulty, (v) => set({ difficulty: v }));
      choice(el, 'size', [4500, 6000, 8000], ['Small', 'Medium', 'Large'], l.settings.size, (v) => set({ size: v }));
    }
  };
  c.onStart = (s: StartInfo, link) => {
    clearInterval(countdown);
    start(s, link);
  };
  c.onError = (msg, retry) => {
    clearInterval(countdown);
    if (retry && isPublic && retries > 0) {
      // The quick-match room filled up or launched while we were connecting: grab the next one.
      void quickCode().then((next) => join(next, true, retries - 1)).catch(() => menu(msg));
      return;
    }
    menu(msg);
  };
  c.onClose = () => {
    clearInterval(countdown);
    if (game) {
      game.hud?.banner('Connection to the room lost', '#ff6b5a');
      setTimeout(() => game && endScreen('over', 'Connection lost.'), 1500);
    } else if (conn === c) menu('Could not reach the room. Check your connection and try again.');
  };
}

function start(s: StartInfo, link: import('./net/link').NetLink): void {
  clearTimeout(interceptTimer);
  closeScreens();
  stopDemo();
  game?.destroy();
  const opts: GameOptions = { difficulty: s.difficulty as Difficulty, teams: s.teams, humans: s.humans, size: s.size, seed: s.seed, names: s.names };
  try {
    game = new Game(app, opts, audio, link);
  } catch (err) {
    link.close();
    screen('menu', `<div class="shell"><header class="brand"><div class="kicker">Display error</div><h1 class="logo">NO SIGNAL</h1><div class="rule"><i></i></div></header>
      <section class="panel setup"><p>${esc((err as Error).message)}</p><p>Swarmer needs WebGL2: any recent Chrome, Edge, Firefox or Safari.</p></section></div>`);
    return;
  }
  if (conn) conn.onNotice = (text) => game?.hud?.banner(text, '#9fe0ff');
  game.onPause = (p) => (p ? pauseScreen() : closeScreens());
  game.onEnd = (kind) => endScreen(kind);
}

function pauseScreen(): void {
  closeScreens();
  const el = screen('pause', `
    <div class="shell">
      <header class="brand"><div class="kicker">Sector ${game ? Math.floor(game.world.time / 60) + ':' + String(Math.floor(game.world.time) % 60).padStart(2, '0') : ''} · the match is still running</div><h1 class="logo">MENU</h1><div class="rule"><i></i></div></header>
      <nav class="menu-list">
        <button class="mi mi-primary resume">Resume<small>Back to the sector</small></button>
        <button class="mi quit">Leave match<small>An AI takes over your swarm</small></button>
      </nav>
    </div>
    <aside class="panel side"><div class="panel-h">Controls</div>${CONTROLS}</aside>`);
  el.querySelector('.resume')!.addEventListener('click', () => game?.setPaused(false));
  el.querySelector('.quit')!.addEventListener('click', () => menu());
}

function endScreen(kind: EndKind, why = ''): void {
  if (!game) return;
  closeScreens();
  const g = game;
  const w = g.world;
  const me = w.teams[g.me] ?? w.teams[0];
  const t = Math.floor(w.time);
  const winner = w.winner >= 0 && w.winner < w.teams.length ? g.teamName(w.winner) : '';
  const rows = w.teams.map((tm) => `<tr><td style="color:${rgb(tm.id)}">${esc(g.teamName(tm.id))}${tm.id === g.me ? ' (you)' : ''}</td><td class="${tm.alive ? 'alive' : 'dead'}">${tm.alive ? 'Active' : 'Destroyed'}</td><td>${tm.kills}</td><td>${tm.peak}</td></tr>`).join('');
  const title = kind === 'won' ? 'SECURED' : kind === 'lost' ? 'SWARM LOST' : 'MATCH OVER';
  const verdict = why || (kind === 'won' ? 'Every rival swarm has been consumed. The sector is yours.'
    : kind === 'lost' ? (w.winner >= 0 ? `Your last unit went dark. ${winner} took the sector.` : 'Your last unit went dark. The others fight on.')
    : winner ? `${winner} took the sector.` : 'The match has ended.');
  const watching = kind === 'lost' && w.winner < 0;
  const el = screen(`end ${kind === 'won' ? 'won' : 'lost'}`, `
    <div class="shell">
      <header class="brand"><div class="kicker">After-action report</div><h1 class="logo">${title}</h1><div class="rule"><i></i></div></header>
      <p class="verdict">${esc(verdict)}</p>
      <dl class="stats-grid">
        <div><dt>Time</dt><dd>${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}</dd></div>
        <div><dt>Peak units</dt><dd>${me.peak}</dd></div>
        <div><dt>Units grown</dt><dd>${me.spawned}</dd></div>
        <div><dt>Kills</dt><dd>${me.kills}</dd></div>
        <div><dt>Lost</dt><dd>${me.lost}</dd></div>
        <div><dt>Raids survived</dt><dd>${w.waveNum}</dd></div>
      </dl>
      <nav class="menu-list">
        ${watching ? '<button class="mi mi-primary spectate">Keep watching<small>Follow the rest of the match</small></button>' : ''}
        <button class="mi ${watching ? '' : 'mi-primary'} again">Find a new match<small>Quick match</small></button>
        <button class="mi quit">Main menu</button>
      </nav>
    </div>
    <aside class="panel side"><div class="panel-h">Swarms</div><table class="rivals"><thead><tr><th>Swarm</th><th>Status</th><th>Kills</th><th>Peak</th></tr></thead><tbody>${rows}</tbody></table></aside>`);
  el.querySelector('.spectate')?.addEventListener('click', closeScreens);
  el.querySelector('.again')!.addEventListener('click', async () => {
    menu();
    try { join(await quickCode(), true); } catch (err) { menu((err as Error).message); }
  });
  el.querySelector('.quit')!.addEventListener('click', () => menu());
}

// Persist mute toggle.
const origSetMuted = audio.setMuted.bind(audio);
audio.setMuted = (m: boolean) => {
  origSetMuted(m);
  try { localStorage.setItem('swarmer.muted', m ? '1' : '0'); } catch { /* ignore */ }
};

/** Offline sandbox for automated tests only (not reachable from the UI). */
function startLocal(seed = 1): Game {
  closeScreens();
  stopDemo();
  game?.destroy();
  game = new Game(app, { difficulty: Difficulty.Normal, teams: 3, humans: [0], size: 6000, seed }, audio, new LocalLink(0));
  game.onEnd = (kind) => endScreen(kind);
  return game;
}

// Debug/automation hook.
(window as unknown as { swarmer: unknown }).swarmer = { get game() { return game; }, get conn() { return conn; }, menu, join, startLocal };

const invite = new URLSearchParams(location.search).get('room');
if (invite && /^[A-Za-z0-9]{5}$/.test(invite)) {
  menu();
  join(invite.toUpperCase(), false);
} else menu();
