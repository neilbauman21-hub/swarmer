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
  <dt>Drag</dt><dd>Pan</dd>
  <dt>Click</dt><dd>Move · click a rock to harvest it · click an enemy to attack</dd>
  <dt>Right-click your swarm</dt><dd>Split, replicate, morph, research, build…</dd>
  <dt>Enter</dt><dd>Command your swarm in plain words</dd>
  <dt>Scroll</dt><dd>Zoom</dd>
  <dt>Shift + drag</dt><dd>Select several swarms</dd>
</dl>
<p class="keys">Shortcuts: S split · G merge · B replicate · T research · Y research tree · 1–5 morph · Q E R abilities · Esc menu</p>`;


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

function menu(notice = ''): void {
  closeScreens();
  game?.destroy();
  game = null;
  conn?.close();
  conn = null;
  startDemo();
  const el = screen('menu', `
    <div class="shell">
      <div class="brand">Swarmer</div>
      <nav class="menu-list" aria-label="Game modes">
        <button class="mi" data-act="play">Arena<small class="online">Free-for-all, never ends</small></button>
        <button class="mi" data-act="controls">How to play<small>Six controls, that's it</small></button>
      </nav>
      <label class="callsign"><span>Name</span><input id="cs" maxlength="16" spellcheck="false" placeholder="Pilot" value="${esc(callsign)}"></label>
      ${notice ? `<p class="notice">${esc(notice)}</p>` : ''}
      <p class="desktop-note">Made for mouse and keyboard.</p>
    </div>
    <aside class="side" data-panel="controls" hidden>
      <p class="lead">Grow your swarm by harvesting rocks, then swallow everyone else. Everybody plays on the same map, and it never resets.</p>
      ${CONTROLS}
    </aside>
    <button type="button" class="corner snd" aria-label="Toggle sound"></button>`);
  const cs = el.querySelector<HTMLInputElement>('#cs')!;
  cs.addEventListener('input', () => {
    callsign = cs.value.trim();
    try { localStorage.setItem('swarmer.name', callsign); } catch { /* ignore */ }
  });
  cs.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
  const snd = el.querySelector<HTMLButtonElement>('.snd')!;
  const showSound = () => (snd.textContent = audio.muted ? 'Sound off' : 'Sound on');
  showSound();
  snd.addEventListener('click', () => { audio.unlock(); audio.setMuted(!audio.muted); showSound(); });
  void arenaStatus().then((st) => {
    if (!st || !el.isConnected) return;
    el.querySelector('.online')!.textContent = `${st.players} player${st.players === 1 ? '' : 's'}`;
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
      else show(el.querySelector<HTMLElement>(`[data-panel="${act}"]`)!.hidden ? act : '');
    }));
}

/** Connect to the arena; the game starts as soon as the world (fresh, saved, or another pilot's) arrives. */
function enter(): void {
  audio.unlock();
  conn?.close();
  const c = (conn = new Connection(callsign));
  closeScreens();
  screen('menu connecting', `
    <div class="shell">
      <div class="brand">Swarmer</div>
      <p class="verdict">Joining the arena…</p>
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
    screen('menu', `<div class="shell"><div class="brand">Swarmer</div>
      <p class="notice">${esc((err as Error).message)}. Swarmer needs WebGL2: any recent Chrome, Edge, Firefox or Safari.</p></div>`);
    return;
  }
  game.onPause = (p) => (p ? pauseScreen() : closeScreens());
}

function pauseScreen(): void {
  closeScreens();
  const el = screen('pause', `
    <div class="shell">
      <div class="brand">Swarmer</div>
      <nav class="menu-list">
        <button class="mi resume">Resume<small>The arena keeps running</small></button>
        <button class="mi quit">Leave<small>Your swarm fights on without you</small></button>
      </nav>
    </div>
    <aside class="side">${CONTROLS}</aside>`);
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
