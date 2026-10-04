import { FORMATIONS, Formation, ROLES, Role, SHIPS, TEAM_NAMES } from '../sim/config';
import type { World } from '../sim/world';
import { PRESETS, designUnits, validateDesign } from '../sim/parts';

/** What a swarm program sees each tick. Plain JSON so it can cross into the sandbox worker. */
export interface SwarmState {
  time: number;
  units: number;
  cap: number;
  points: number;
  unlocked: string[];
  mapSize: number;
  home: { x: number; y: number };
  selected: number[];
  groups: {
    id: number; count: number; x: number; y: number; radius: number; role: string; formation: string;
    order: string; energy: number; inCombat: boolean; harvesting: boolean;
    ready: { dash: boolean; shield: boolean; nova: boolean };
  }[];
  enemies: { id: number; team: string; color: string; count: number; x: number; y: number; radius: number; role: string; order: string }[];
  ships: { id: number; type: string; x: number; y: number; hp: number; maxHp: number }[];
  rocks: { id: number; x: number; y: number; mass: number; radius: number; wreck: boolean }[];
  designs: { name: string; units: number; buildable: boolean }[];
}

export type Ids = number | number[];
export type Command =
  | { op: 'move'; ids: Ids; x: number; y: number }
  | { op: 'path'; ids: Ids; points: number[][] }
  | { op: 'attack'; ids: Ids; target: number }
  | { op: 'attackShip'; ids: Ids; target: number }
  | { op: 'harvest'; ids: Ids; rock: number }
  | { op: 'split'; id: number; dx: number; dy: number }
  | { op: 'merge'; ids: Ids }
  | { op: 'replicate'; ids: Ids }
  | { op: 'research'; ids: Ids }
  | { op: 'hold'; ids: Ids }
  | { op: 'formation'; ids: Ids; name: string }
  | { op: 'morph'; ids: Ids; role: string }
  | { op: 'dash'; ids: Ids; x: number; y: number }
  | { op: 'shield'; ids: Ids }
  | { op: 'nova'; ids: Ids }
  | { op: 'unlock'; type: string }
  | { op: 'build'; id?: number; ids?: Ids; design: string }
  | { op: 'queue'; ids: Ids; x: number; y: number }
  | { op: 'design'; design: unknown };

/** Called for commands that create or replace a group, so the issuing player's UI can select the result. */
export type ResultFn = (cmd: Record<string, unknown>, id: number) => void;

const ROLE_NAMES = ROLES.map((r) => r.name.toLowerCase());
const FORMATION_NAMES = FORMATIONS.map((f) => f.name.toLowerCase());
const SHIP_NAMES = SHIPS.map((s) => s.name.toLowerCase());
const round = (v: number) => Math.round(v);

const COLOR_NAMES = ['blue', 'red', 'green', 'purple'];

export function snapshot(w: World, team: number, selected: Iterable<number>): SwarmState {
  const t = w.teams[team];
  const groups: SwarmState['groups'] = [];
  const enemies: SwarmState['enemies'] = [];
  for (const g of w.groups) {
    if (!g.alive || g.count <= 0) continue;
    if (g.team === team) {
      groups.push({
        id: g.id, count: g.count, x: round(g.cx), y: round(g.cy), radius: round(g.radius),
        role: ROLE_NAMES[g.morphT > 0 ? g.morphTo : g.role], formation: FORMATION_NAMES[g.formation], order: g.cells ? 'construct:' + g.order.type : g.order.type,
        energy: round(g.energy), inCombat: g.combatT < 1, harvesting: g.harvesting,
        ready: { dash: g.cdDash <= 0 && g.energy >= 30, shield: g.cdShield <= 0 && g.energy >= 40, nova: g.cdNova <= 0 && g.energy >= 60 },
      });
    } else {
      enemies.push({
        id: g.id, team: (w.teams[g.team]?.name ?? TEAM_NAMES[g.team] ?? 'raiders').toLowerCase(), color: COLOR_NAMES[g.team] ?? 'white', count: g.count, x: round(g.cx), y: round(g.cy),
        radius: round(g.radius), role: ROLE_NAMES[g.role], order: g.order.type,
      });
    }
  }
  return {
    time: Math.round(w.time * 10) / 10, units: t.units, cap: t.cap, points: t.points, unlocked: [...t.unlocked],
    mapSize: w.size, home: { x: t.homeX, y: t.homeY },
    selected: [...selected].filter((id) => w.groups[id]?.alive && w.groups[id].team === team),
    groups, enemies,
    ships: w.ships.filter((s) => s.alive).map((s) => ({ id: s.id, type: SHIP_NAMES[s.type], x: round(s.x), y: round(s.y), hp: round(s.hp), maxHp: s.maxHp })),
    rocks: w.rocks.filter((r) => r.alive).map((r) => ({ id: r.id, x: round(r.x), y: round(r.y), mass: round(r.mass), radius: round(r.r), wreck: r.wreck })),
    designs: allDesigns(w, team).map((d) => ({ name: d.name, units: designUnits(d), buildable: d.cells.every((c) => t.unlocked.has(c.part)) })),
  };
}

function allDesigns(w: World, team: number) {
  const own = w.teams[team].designs;
  return [...own, ...PRESETS.filter((p) => !own.some((d) => d.name === p.name))];
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Apply commands from untrusted generated code. Everything is validated:
 * only the player's own living groups can be ordered, coordinates must be finite.
 * Returns the number of commands that took effect.
 */
export function applyCommands(w: World, team: number, cmds: unknown[], limit = 80, onResult?: ResultFn): number {
  let applied = 0;
  const own = (ids: unknown): number[] => {
    const list = Array.isArray(ids) ? ids : [ids];
    return list.filter((id): id is number => Number.isInteger(id) && w.groups[id as number]?.alive === true && w.groups[id as number].team === team);
  };
  for (const raw of cmds.slice(0, limit)) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const ids = own(c.ids);
    switch (c.op) {
      case 'move':
        if (ids.length && num(c.x) && num(c.y)) { w.cmdMove(ids, c.x, c.y); applied++; }
        break;
      case 'queue':
        if (ids.length && num(c.x) && num(c.y)) { w.cmdQueue(ids, c.x, c.y); applied++; }
        break;
      case 'path': {
        if (!ids.length || !Array.isArray(c.points)) break;
        const flat: number[] = [];
        for (const p of c.points.slice(0, 40)) {
          const [x, y] = Array.isArray(p) ? p : [(p as { x?: unknown })?.x, (p as { y?: unknown })?.y];
          if (num(x) && num(y)) flat.push(x, y);
        }
        if (flat.length >= 2) { w.cmdPath(ids, flat); applied++; }
        break;
      }
      case 'attack': {
        const tg = w.groups[c.target as number];
        if (ids.length && Number.isInteger(c.target) && tg?.alive && tg.team !== team) { w.cmdAttackGroup(ids, tg.id); applied++; }
        break;
      }
      case 'attackShip': {
        const s = w.ships.find((x) => x.id === c.target && x.alive);
        if (ids.length && s) { w.cmdAttackShip(ids, s.id); applied++; }
        break;
      }
      case 'harvest':
        if (ids.length && Number.isInteger(c.rock) && w.rocks[c.rock as number]?.alive) { w.cmdHarvest(ids, c.rock as number); applied++; }
        break;
      case 'split': {
        const [id] = own(c.id);
        const nid = id !== undefined && num(c.dx) && num(c.dy) ? w.cmdSplit(id, c.dx || 1, c.dy) : -1;
        if (nid >= 0) { applied++; onResult?.(c, nid); }
        break;
      }
      case 'merge':
        if (ids.length > 1) { const keep = w.cmdMerge(ids); applied++; if (keep >= 0) onResult?.(c, keep); }
        break;
      case 'replicate':
        if (ids.length && w.cmdReplicate(ids)) applied++;
        break;
      case 'research':
        if (ids.length) { w.cmdResearch(ids); applied++; }
        break;
      case 'hold':
        if (ids.length) { w.cmdStop(ids); applied++; }
        break;
      case 'formation': {
        const f = FORMATION_NAMES.indexOf(String(c.name).toLowerCase());
        if (ids.length && f >= 0) { w.cmdFormation(ids, f as Formation); applied++; }
        break;
      }
      case 'morph': {
        const r = ROLE_NAMES.indexOf(String(c.role).toLowerCase());
        if (ids.length && r >= 0) { w.cmdMorph(ids, r as Role); applied++; }
        break;
      }
      case 'dash':
        if (ids.length && num(c.x) && num(c.y) && w.cmdDash(ids, c.x, c.y)) applied++;
        break;
      case 'shield':
        if (ids.length && w.cmdShield(ids)) applied++;
        break;
      case 'nova':
        if (ids.length && w.cmdNova(ids)) applied++;
        break;
      case 'build': {
        // With several ids, the swarms are pooled into the biggest one first.
        let id: number | undefined = own(c.id)[0];
        if (id === undefined && ids.length) id = ids.length > 1 ? w.cmdMerge(ids) : ids[0];
        if (id !== undefined && id < 0) id = undefined;
        const d = allDesigns(w, team).find((x) => x.name.toLowerCase() === String(c.design).toLowerCase());
        const bid = id !== undefined && d ? w.cmdBuild(id, d) : -1;
        if (bid >= 0) { applied++; onResult?.(c, bid); }
        break;
      }
      case 'design': {
        // A blueprint from the AI designer joins the team's library (names stay unique so builds by name work).
        const t = w.teams[team];
        const v = validateDesign(c.design, t.unlocked);
        if (!v.ok || !v.design || t.designs.length >= 40) break;
        const d = v.design;
        const base = d.name.slice(0, 40);
        let name = base, n = 2;
        while (t.designs.some((x) => x.name === name) || PRESETS.some((x) => x.name === name)) name = `${base} ${n++}`;
        d.name = name;
        t.designs.unshift(d);
        applied++;
        onResult?.(c, 0);
        break;
      }
      case 'unlock':
        if (w.buyPart(team, String(c.type).toLowerCase())) applied++;
        break;
    }
  }
  return applied;
}

/** Short text summary sent to the LLM along with the prompt, so it can resolve names like "Ember" or "the big rock". */
export function describe(s: SwarmState): string {
  const mine = s.groups.map((g) => `#${g.id} ${g.count} ${g.role} at (${g.x},${g.y}) ${g.order}`).join('; ');
  const foes = s.enemies.slice(0, 12).map((g) => `#${g.id} ${g.team} (${g.color}) ${g.count} ${g.role} at (${g.x},${g.y})`).join('; ');
  return `t=${s.time}s, map ${s.mapSize}x${s.mapSize}, home (${s.home.x},${s.home.y}), ${s.units} units, ${s.points} research points. ` +
    `Selected: [${s.selected.join(',')}]. My groups: ${mine || 'none'}. Enemies: ${foes || 'none visible'}. ` +
    `${s.ships.length} raider ships, ${s.rocks.length} rocks.`;
}

/**
 * Apply one order from a lockstep turn. Orders are tagged with the player id that sent them; the world
 * decides which swarm (if any) that player drives. join/leave come from the arena server only.
 */
export function applyTurn(w: World, pid: number, cmd: unknown, onResult?: ResultFn): void {
  if (!cmd || typeof cmd !== 'object') return;
  const c = cmd as Record<string, unknown>;
  if (c.op === 'join') { w.joinPlayer(pid, String(c.name ?? '').slice(0, 16)); return; }
  if (c.op === 'leave') { w.leavePlayer(pid); return; }
  if (c.op === 'respawn') { w.respawnPlayer(pid); return; }
  const team = w.teamOfPlayer(pid);
  if (team >= 0 && w.teams[team].alive) applyCommands(w, team, [c], 1, onResult);
}
