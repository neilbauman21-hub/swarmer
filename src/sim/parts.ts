// Particle parts and constructs. A construct is a soft body made of particles
// laid out on a small grid; each cell is one part with optionally tuned stats.

import { Role } from './config';

export interface PartDef {
  id: string;
  name: string;
  hp: number;
  damage: number; // 0 = no weapon
  range: number;
  cooldown: number;
  armor: number; // fraction of damage ignored
  splash: number; // >0 fires shells with this radius
  heal: number; // hp/s restored to neighbouring cells
  shield: number; // damage reduction granted to neighbouring cells
  thrust: number; // adds construct speed
  energy: number; // extra energy regen for the construct
  units: number; // swarm units consumed to build one cell
  counter: Role; // which role this part counts as in the counter table
  cost: number; // research points to unlock (0 = always available)
  requires: string[];
  tint: [number, number, number];
  glyph: number; // shader glyph id
  size: number;
  blurb: string;
}

export const PARTS: PartDef[] = [
  { id: 'drone', name: 'Drone', hp: 28, damage: 2.2, range: 80, cooldown: 0.6, armor: 0, splash: 0, heal: 0, shield: 0, thrust: 0, energy: 0, units: 1, counter: Role.Drone, cost: 0, requires: [], tint: [1, 1, 1], glyph: 0, size: 1, blurb: 'Basic particle with a light beam.' },
  { id: 'plate', name: 'Armor Plate', hp: 95, damage: 0, range: 0, cooldown: 1, armor: 0.4, splash: 0, heal: 0, shield: 0, thrust: 0, energy: 0, units: 2, counter: Role.Tank, cost: 1, requires: [], tint: [0.75, 0.8, 0.9], glyph: 2, size: 1.6, blurb: 'Heavy, unarmed, 40% armor. Builds hulls.' },
  { id: 'spike', name: 'Spike', hp: 48, damage: 6, range: 32, cooldown: 0.4, armor: 0.2, splash: 0, heal: 0, shield: 0, thrust: 0, energy: 0, units: 2, counter: Role.Striker, cost: 1, requires: [], tint: [1, 0.6, 0.6], glyph: 1, size: 1.1, blurb: 'Short-range shredder. Put it on the front.' },
  { id: 'thruster', name: 'Thruster', hp: 26, damage: 0, range: 0, cooldown: 1, armor: 0, splash: 0, heal: 0, shield: 0, thrust: 1, energy: 0, units: 1, counter: Role.Drone, cost: 1, requires: [], tint: [1, 0.65, 0.25], glyph: 3, size: 1.1, blurb: 'Makes the construct faster. More thrusters, more speed.' },
  { id: 'mender', name: 'Mender', hp: 30, damage: 0, range: 0, cooldown: 1, armor: 0, splash: 0, heal: 6, shield: 0, thrust: 0, energy: 0, units: 2, counter: Role.Harvester, cost: 2, requires: ['plate'], tint: [0.45, 1, 0.55], glyph: 3, size: 1.2, blurb: 'Repairs touching cells for 6 HP per second.' },
  { id: 'cannon', name: 'Cannon', hp: 34, damage: 15, range: 260, cooldown: 2.1, armor: 0, splash: 32, heal: 0, shield: 0, thrust: 0, energy: 0, units: 3, counter: Role.Artillery, cost: 2, requires: ['plate'], tint: [1, 0.9, 0.55], glyph: 4, size: 1.4, blurb: 'Lobs splash shells at range 260.' },
  { id: 'lance', name: 'Lance', hp: 24, damage: 7, range: 340, cooldown: 1.4, armor: 0, splash: 0, heal: 0, shield: 0, thrust: 0, energy: 0, units: 3, counter: Role.Artillery, cost: 3, requires: ['cannon'], tint: [0.7, 0.85, 1], glyph: 4, size: 1, blurb: 'Long-range precision beam.' },
  { id: 'shield', name: 'Shield Node', hp: 45, damage: 0, range: 0, cooldown: 1, armor: 0.1, splash: 0, heal: 0, shield: 0.5, thrust: 0, energy: 0, units: 3, counter: Role.Tank, cost: 3, requires: ['mender'], tint: [0.5, 0.9, 1], glyph: 2, size: 1.5, blurb: 'Touching cells take 50% less damage.' },
  { id: 'reactor', name: 'Reactor', hp: 60, damage: 0, range: 0, cooldown: 1, armor: 0.2, splash: 0, heal: 0, shield: 0, thrust: 0.5, energy: 7, units: 4, counter: Role.Tank, cost: 3, requires: ['thruster', 'cannon'], tint: [1, 1, 1], glyph: 5, size: 1.8, blurb: 'Doubles ability energy regen and adds a little thrust.' },
];

export const PART_BY_ID = new Map(PARTS.map((p) => [p.id, p]));
export const CELL_SPACING = 11; // world units between grid cells
export const GRID_LIMIT = 7; // cells live in [-7, 7] on both axes
export const MAX_CELLS = 32;
export const MIN_CELLS = 3;

export type TuneKey = 'hp' | 'damage' | 'range' | 'rate';
export const TUNE_KEYS: TuneKey[] = ['hp', 'damage', 'range', 'rate'];

export interface DesignCell {
  x: number;
  y: number;
  part: string;
  tune?: Partial<Record<TuneKey, number>>;
}

export interface Design {
  name: string;
  cells: DesignCell[];
}

export interface CellStat {
  part: PartDef;
  ox: number; // local offset (world units), x = forward
  oy: number;
  hp: number;
  damage: number;
  range: number;
  cooldown: number;
  neighbors: number[]; // touching cell indices (8-neighbourhood)
}

/**
 * Tuning is a trade: each stat multiplier is in [0.5, 2] and the product of all
 * multipliers on a cell may not exceed 1. Doubling HP means halving something else.
 */
export function normalizeTune(t: DesignCell['tune']): Record<TuneKey, number> {
  const out = { hp: 1, damage: 1, range: 1, rate: 1 };
  if (!t || typeof t !== 'object') return out;
  for (const k of TUNE_KEYS) {
    const v = Number((t as Record<string, unknown>)[k]);
    if (Number.isFinite(v) && v > 0) out[k] = Math.max(0.5, Math.min(2, v));
  }
  let logSum = TUNE_KEYS.reduce((s, k) => s + Math.log2(out[k]), 0);
  if (logSum > 1e-6) {
    // Over budget: shrink the boosts proportionally until the trade balances.
    const boosts = TUNE_KEYS.filter((k) => out[k] > 1);
    const boostSum = boosts.reduce((s, k) => s + Math.log2(out[k]), 0);
    const keep = Math.max(0, (boostSum - logSum) / boostSum);
    for (const k of boosts) out[k] = 2 ** (Math.log2(out[k]) * keep);
    logSum = 0;
  }
  return out;
}

export interface ValidResult {
  ok: boolean;
  design?: Design;
  error?: string;
  warnings: string[];
}

/** Clean up an untrusted design (from the LLM or a share code) against what the team has unlocked. */
export function validateDesign(raw: unknown, unlocked: Set<string>): ValidResult {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'That design is empty.', warnings };
  const r = raw as { name?: unknown; cells?: unknown };
  const name = (typeof r.name === 'string' && r.name.trim() ? r.name.trim() : 'Construct').slice(0, 32);
  if (!Array.isArray(r.cells)) return { ok: false, error: 'The design has no cells.', warnings };
  const seen = new Set<string>();
  let cells: DesignCell[] = [];
  const locked = new Set<string>();
  for (const c of r.cells.slice(0, 200)) {
    if (!c || typeof c !== 'object') continue;
    const cc = c as Record<string, unknown>;
    const x = Math.round(Number(cc.x)), y = Math.round(Number(cc.y));
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > GRID_LIMIT || Math.abs(y) > GRID_LIMIT) continue;
    let part = String(cc.part ?? 'drone').toLowerCase();
    if (!PART_BY_ID.has(part)) part = 'drone';
    if (!unlocked.has(part)) {
      locked.add(PART_BY_ID.get(part)!.name);
      part = 'drone';
    }
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tune = normalizeTune(cc.tune as DesignCell['tune']);
    const cell: DesignCell = { x, y, part };
    if (TUNE_KEYS.some((k) => Math.abs(tune[k] - 1) > 0.01)) cell.tune = tune;
    cells.push(cell);
  }
  if (locked.size) warnings.push(`Not researched yet, used Drones instead: ${[...locked].join(', ')}`);
  if (cells.length > MAX_CELLS) {
    warnings.push(`Trimmed to ${MAX_CELLS} cells`);
    cells.sort((a, b) => a.x * a.x + a.y * a.y - (b.x * b.x + b.y * b.y));
    cells = cells.slice(0, MAX_CELLS);
  }
  // Keep the largest connected piece: loose cells can't hold together.
  const comp = largestComponent(cells.map((c) => [c.x, c.y]));
  if (comp.length < cells.length) warnings.push(`Dropped ${cells.length - comp.length} disconnected cells`);
  cells = comp.map((i) => cells[i]);
  if (cells.length < MIN_CELLS) return { ok: false, error: `A construct needs at least ${MIN_CELLS} connected cells.`, warnings };
  // Centre on the origin so the construct pivots around its middle.
  const mx = Math.round(cells.reduce((s, c) => s + c.x, 0) / cells.length);
  const my = Math.round(cells.reduce((s, c) => s + c.y, 0) / cells.length);
  for (const c of cells) { c.x -= mx; c.y -= my; }
  return { ok: true, design: { name, cells }, warnings };
}

/** Indices of the largest 8-connected component. */
export function largestComponent(pts: number[][]): number[] {
  const index = new Map(pts.map((p, i) => [`${p[0]},${p[1]}`, i]));
  const seen = new Set<number>();
  let best: number[] = [];
  for (let s = 0; s < pts.length; s++) {
    if (seen.has(s)) continue;
    const comp: number[] = [];
    const stack = [s];
    seen.add(s);
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const j = index.get(`${pts[i][0] + dx},${pts[i][1] + dy}`);
        if (j !== undefined && !seen.has(j)) { seen.add(j); stack.push(j); }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  return best;
}

export function designUnits(d: Design): number {
  return d.cells.reduce((s, c) => s + (PART_BY_ID.get(c.part)?.units ?? 1), 0);
}

export function cellStats(d: Design, hullLevel: number, damageLevel: number): CellStat[] {
  const out: CellStat[] = d.cells.map((c) => {
    const part = PART_BY_ID.get(c.part) ?? PARTS[0];
    const t = normalizeTune(c.tune);
    return {
      part,
      ox: c.x * CELL_SPACING,
      oy: c.y * CELL_SPACING,
      hp: part.hp * t.hp * (1 + 0.2 * hullLevel),
      damage: part.damage * t.damage * (1 + 0.2 * damageLevel),
      range: part.range * t.range,
      cooldown: part.cooldown / t.rate,
      neighbors: [],
    };
  });
  for (let i = 0; i < d.cells.length; i++) {
    for (let j = 0; j < d.cells.length; j++) {
      if (i !== j && Math.abs(d.cells[i].x - d.cells[j].x) <= 1 && Math.abs(d.cells[i].y - d.cells[j].y) <= 1) out[i].neighbors.push(j);
    }
  }
  return out;
}

export interface DesignSummary {
  cells: number;
  units: number;
  hp: number;
  dps: number;
  maxRange: number;
  speed: number;
}

export function constructSpeed(d: Design): number {
  let thrust = 0, mass = 0;
  for (const c of d.cells) {
    const p = PART_BY_ID.get(c.part) ?? PARTS[0];
    thrust += p.thrust;
    mass += p.units;
  }
  return Math.max(35, Math.min(190, 55 + (420 * thrust) / Math.max(1, mass)));
}

export function summarize(d: Design): DesignSummary {
  const stats = cellStats(d, 0, 0);
  return {
    cells: d.cells.length,
    units: designUnits(d),
    hp: Math.round(stats.reduce((s, c) => s + c.hp / (1 - c.part.armor), 0)),
    dps: Math.round(stats.reduce((s, c) => s + (c.damage ? (c.damage * (c.part.splash ? 2.5 : 1)) / c.cooldown : 0), 0)),
    maxRange: Math.round(Math.max(0, ...stats.map((c) => c.range))),
    speed: Math.round(constructSpeed(d)),
  };
}

/** Ready-made designs, also used as examples in the LLM prompt. */
export const PRESETS: Design[] = [
  {
    name: 'Hedgehog',
    cells: [
      { x: 0, y: 0, part: 'plate' }, { x: 1, y: 0, part: 'spike' }, { x: -1, y: 0, part: 'plate' },
      { x: 0, y: 1, part: 'spike' }, { x: 0, y: -1, part: 'spike' }, { x: 1, y: 1, part: 'spike' },
      { x: 1, y: -1, part: 'spike' }, { x: -1, y: 1, part: 'thruster' }, { x: -1, y: -1, part: 'thruster' },
    ],
  },
  {
    name: 'Siege Tank',
    cells: [
      // Armored shell (front = +x) around two cannons, a mender and rear thrusters.
      { x: 2, y: -1, part: 'plate', tune: { hp: 1.6, rate: 0.625 } }, { x: 2, y: 0, part: 'plate', tune: { hp: 1.6, rate: 0.625 } }, { x: 2, y: 1, part: 'plate', tune: { hp: 1.6, rate: 0.625 } },
      { x: 1, y: -2, part: 'plate' }, { x: 1, y: 2, part: 'plate' }, { x: 0, y: -2, part: 'plate' }, { x: 0, y: 2, part: 'plate' },
      { x: 1, y: 0, part: 'cannon', tune: { range: 1.3, hp: 0.77 } }, { x: 0, y: 0, part: 'mender' }, { x: 0, y: -1, part: 'cannon' }, { x: 0, y: 1, part: 'cannon' },
      { x: 1, y: -1, part: 'plate' }, { x: 1, y: 1, part: 'plate' },
      { x: -1, y: -1, part: 'thruster' }, { x: -1, y: 0, part: 'thruster' }, { x: -1, y: 1, part: 'thruster' },
    ],
  },
];
