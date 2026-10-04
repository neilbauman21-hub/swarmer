import {
  CRUISE_MAX, CRUISE_RAMP, DASH, DIFFICULTY, DT, Difficulty, ENERGY_MAX, ENERGY_REGEN, FORMATIONS, Formation,
  GRID_CELL, HARVEST_RATE, MASS_PER_UNIT, MAX_RESEARCH_LEVEL, MAX_UNITS, MORPH_TIME, NOVA, PLAYER_CAP,
  GROWTH_KNEE, ARTILLERY_HITS, ARTILLERY_MIN_RANGE, COUNTER, REPLICATE_MIN, REPLICATE_RATE, RESEARCH_POINT_BASE, RESEARCH_RATE, ROLES, Role, SHIELD, SHIP_TEAM, SHIPS,
  ResearchTrack, TEAM_COLORS, UNIT_SPACING,
} from './config';
import { Grid } from './grid';
import { CellStat, Design, MIN_CELLS, PART_BY_ID, ROLE_UNLOCKS, ROLE_UNLOCK_BY_ROLE, cellStats, constructSpeed, designUnits, largestComponent } from './parts';
import { Rng } from './rng';
import { updateShips, updateWaves } from './ships';
import { updateAI } from './ai';

export type OrderType = 'idle' | 'move' | 'attack' | 'harvest' | 'replicate' | 'research';

export interface Order {
  type: OrderType;
  x: number;
  y: number;
  group: number; // attack target group
  ship: number; // attack target ship
  rock: number; // harvest target rock
}

export interface Group {
  id: number;
  team: number;
  alive: boolean;
  ax: number; // anchor: where the formation is centred
  ay: number;
  hx: number; // heading
  hy: number;
  order: Order;
  formation: Formation;
  role: Role;
  morphTo: Role;
  morphT: number;
  energy: number;
  cdDash: number;
  cdShield: number;
  cdNova: number;
  dashT: number;
  dashX: number;
  dashY: number;
  shieldT: number;
  novaT: number;
  cruise: number;
  count: number;
  cx: number;
  cy: number;
  radius: number;
  spread: number;
  vx: number; // mean unit velocity, used for flock alignment
  vy: number;
  enemyNear: boolean;
  combatT: number; // seconds since last shot fired or damage taken (0 = now)
  progress: number; // replicate / harvest accumulator
  harvesting: boolean;
  born: number;
  recentLoss: number; // decaying counter of units lost, used by AI
  path: number[]; // queued waypoints (flat x,y pairs) after the current move target
  // Construct (soft body) data; null for ordinary swarms.
  design: Design | null;
  cells: CellStat[] | null;
  slotUnit: Int32Array | null; // cell index -> unit index (-1 = destroyed)
  cSpeed: number;
  integrityDirty: boolean;
  peak: number; // largest size this group reached
}

export interface Team {
  id: number;
  alive: boolean;
  ai: boolean;
  color: [number, number, number];
  units: number;
  cap: number;
  points: number;
  pointsEarned: number;
  progress: number;
  levels: Record<ResearchTrack, number>;
  unlocked: Set<string>; // researched particle parts
  designs: Design[]; // construct blueprints this team can build
  homeX: number;
  homeY: number;
  kills: number;
  lost: number;
  peak: number;
  spawned: number;
}

export interface Rock {
  id: number;
  x: number;
  y: number;
  mass: number;
  maxMass: number;
  r: number;
  seed: number;
  alive: boolean;
  wreck: boolean;
}

export interface Ship {
  id: number;
  type: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  hp: number;
  maxHp: number;
  cd: number;
  tx: number;
  ty: number;
  think: number;
  alive: boolean;
  flash: number;
  seed: number;
}

export interface Shell {
  x0: number; y0: number; x1: number; y1: number;
  t: number; dur: number; dmg: number; splash: number; team: number; big: boolean; hits: number; role: number;
}

export interface Bomb { x: number; y: number; t: number; fuse: number; r: number; dmg: number }
export interface Pool { x: number; y: number; r: number; t: number; dur: number; dps: number }

export interface GameEvent {
  t: 'tracer' | 'death' | 'spawn' | 'explode' | 'shipDeath' | 'nova' | 'novaCharge' | 'dash' | 'shield'
    | 'harvest' | 'research' | 'wave' | 'morph' | 'bomb' | 'melee' | 'hitShip' | 'fail' | 'shellFire'
    | 'groupLost' | 'teamOut';
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  team?: number;
  r?: number;
  n?: number;
  msg?: string;
}

export interface WorldOptions {
  seed?: number;
  size?: number;
  rivals?: number;
  difficulty?: Difficulty;
  startUnits?: number;
  waves?: boolean;
}

export class World {
  readonly size: number;
  readonly rng: Rng;
  readonly difficulty: Difficulty;
  time = 0;
  tick = 0;

  // Unit storage (structure of arrays).
  readonly ux = new Float32Array(MAX_UNITS);
  readonly uy = new Float32Array(MAX_UNITS);
  readonly uvx = new Float32Array(MAX_UNITS);
  readonly uvy = new Float32Array(MAX_UNITS);
  readonly uhp = new Float32Array(MAX_UNITS);
  readonly ucd = new Float32Array(MAX_UNITS);
  readonly uflash = new Float32Array(MAX_UNITS);
  readonly useed = new Float32Array(MAX_UNITS);
  readonly uteam = new Uint8Array(MAX_UNITS);
  readonly ualive = new Uint8Array(MAX_UNITS);
  readonly ugroup = new Int32Array(MAX_UNITS);
  readonly utgt = new Int32Array(MAX_UNITS).fill(-1);
  readonly uslot = new Int16Array(MAX_UNITS).fill(-1); // construct cell index, -1 = free swarm unit
  readonly upx = new Float32Array(MAX_UNITS); // positions at the previous tick, for smooth render interpolation
  readonly upy = new Float32Array(MAX_UNITS);
  private readonly sepX = new Float32Array(MAX_UNITS);
  private readonly sepY = new Float32Array(MAX_UNITS);
  hi = 0; // high-water mark of unit slots in use
  private free: number[] = [];
  private splashHits: number[] = [];

  groups: Group[] = [];
  teams: Team[] = [];
  rocks: Rock[] = [];
  ships: Ship[] = [];
  shells: Shell[] = [];
  bombs: Bomb[] = [];
  pools: Pool[] = [];
  events: GameEvent[] = [];
  readonly grid: Grid;

  waves: boolean;
  waveNum = 0;
  nextWave = 75;
  winner = -1; // team id once decided

  constructor(opts: WorldOptions = {}) {
    this.size = opts.size ?? 6000;
    this.rng = new Rng(opts.seed ?? (Math.random() * 1e9) | 0);
    this.difficulty = opts.difficulty ?? Difficulty.Normal;
    this.waves = opts.waves ?? true;
    this.grid = new Grid(this.size, this.size, GRID_CELL, MAX_UNITS);
    const rivals = Math.max(0, Math.min(3, opts.rivals ?? 2));
    this.setupMap(rivals, opts.startUnits ?? 60);
  }

  // ---------------------------------------------------------------- setup

  private setupMap(rivals: number, startUnits: number): void {
    const S = this.size;
    const m = 600;
    const corners = [
      [m, S - m], [S - m, m], [S - m, S - m], [m, m],
    ];
    const diff = DIFFICULTY[this.difficulty];
    for (let t = 0; t <= rivals; t++) {
      const [hx, hy] = corners[t];
      this.teams.push({
        id: t, alive: true, ai: t !== 0, color: TEAM_COLORS[t], units: 0,
        cap: t === 0 ? PLAYER_CAP : diff.aiCap, points: 0, pointsEarned: 0, progress: 0,
        levels: { speed: 0, damage: 0, hull: 0, replication: 0 },
        // Rivals know every swarm type; the player researches them.
        unlocked: new Set(t === 0 ? ['drone'] : ['drone', ...ROLE_UNLOCKS.map((r) => r.id)]), designs: [],
        homeX: hx, homeY: hy, kills: 0, lost: 0, peak: 0, spawned: 0,
      });
      const g = this.createGroup(t, hx, hy);
      for (let i = 0; i < startUnits; i++) {
        const a = this.rng.next() * Math.PI * 2;
        const r = Math.sqrt(this.rng.next()) * 60;
        this.spawnUnit(g, hx + Math.cos(a) * r, hy + Math.sin(a) * r, false);
      }
    }
    // Rocks: a guaranteed nearby rock for every team plus scattered field.
    for (const team of this.teams) {
      const a = Math.atan2(S / 2 - team.homeY, S / 2 - team.homeX) + this.rng.range(-0.5, 0.5);
      this.addRock(team.homeX + Math.cos(a) * 380, team.homeY + Math.sin(a) * 380, 260);
    }
    const count = Math.round((S * S) / 900000);
    let tries = 0;
    while (this.rocks.length < count + this.teams.length && tries++ < 2000) {
      const x = this.rng.range(200, S - 200);
      const y = this.rng.range(200, S - 200);
      if (this.rocks.some((r) => Math.hypot(r.x - x, r.y - y) < 320)) continue;
      if (this.teams.some((t) => Math.hypot(t.homeX - x, t.homeY - y) < 300)) continue;
      // Richer rocks toward the centre to pull swarms into conflict.
      const centre = 1 - Math.hypot(x - S / 2, y - S / 2) / (S * 0.7);
      this.addRock(x, y, this.rng.range(120, 300) + centre * 350);
    }
  }

  addRock(x: number, y: number, mass: number, wreck = false): Rock {
    const rock: Rock = {
      id: this.rocks.length, x, y, mass, maxMass: mass, r: rockRadius(mass), seed: this.rng.next() * 100,
      alive: true, wreck,
    };
    this.rocks.push(rock);
    return rock;
  }

  createGroup(team: number, x: number, y: number): Group {
    const g: Group = {
      id: this.groups.length, team, alive: true, ax: x, ay: y, hx: 1, hy: 0,
      order: { type: 'idle', x, y, group: -1, ship: -1, rock: -1 },
      formation: Formation.Swarm, role: Role.Drone, morphTo: Role.Drone, morphT: 0,
      energy: ENERGY_MAX * 0.5, cdDash: 0, cdShield: 0, cdNova: 0, dashT: 0, dashX: 0, dashY: 0,
      shieldT: 0, novaT: 0, cruise: 0, count: 0, cx: x, cy: y, radius: 10, spread: 0, vx: 0, vy: 0, enemyNear: false, combatT: 99,
      progress: 0, harvesting: false, born: this.time, recentLoss: 0, path: [], peak: 0, design: null, cells: null, slotUnit: null, cSpeed: 0, integrityDirty: false,
    };
    this.groups.push(g);
    return g;
  }

  spawnUnit(g: Group, x: number, y: number, announce = true): number {
    const team = this.teams[g.team];
    if (team.units >= team.cap) return -1;
    let i: number;
    if (this.free.length) i = this.free.pop()!;
    else if (this.hi < MAX_UNITS) i = this.hi++;
    else return -1;
    this.ux[i] = x;
    this.uy[i] = y;
    this.upx[i] = x;
    this.upy[i] = y;
    const a = this.rng.next() * Math.PI * 2;
    this.uvx[i] = Math.cos(a) * 60;
    this.uvy[i] = Math.sin(a) * 60;
    this.uteam[i] = g.team;
    this.ugroup[i] = g.id;
    this.ualive[i] = 1;
    this.uhp[i] = this.maxHp(g.team, g.role);
    this.ucd[i] = this.rng.next();
    this.uflash[i] = announce ? 1 : 0;
    this.useed[i] = this.rng.next();
    this.utgt[i] = -1;
    this.uslot[i] = -1;
    team.units++;
    team.spawned++;
    g.count++;
    if (team.units > team.peak) team.peak = team.units;
    if (announce) this.events.push({ t: 'spawn', x, y, team: g.team });
    return i;
  }

  private killUnit(i: number): void {
    this.ualive[i] = 0;
    this.free.push(i);
    const t = this.teams[this.uteam[i]];
    t.units--;
    t.lost++;
    const g = this.groups[this.ugroup[i]];
    g.count--;
    g.recentLoss += 1;
    if (g.cells) g.integrityDirty = true;
  }

  maxHp(team: number, role: Role): number {
    return ROLES[role].hp * (1 + 0.2 * this.teams[team].levels.hull);
  }

  // ---------------------------------------------------------------- queries

  unitsOf(g: Group): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.hi; i++) if (this.ualive[i] && this.ugroup[i] === g.id) out.push(i);
    return out;
  }

  groupsOf(team: number): Group[] {
    return this.groups.filter((g) => g.alive && g.team === team && g.count > 0);
  }

  speedOf(g: Group): number {
    const t = this.teams[g.team];
    if (g.cells) return g.cSpeed * (1 + 0.1 * t.levels.speed);
    return ROLES[g.role].speed * FORMATIONS[g.formation].speed * (1 + 0.1 * t.levels.speed);
  }

  rangeOf(g: Group): number {
    if (g.cells) {
      let r = 0;
      for (let k = 0; k < g.cells.length; k++) if (g.slotUnit![k] >= 0 && g.cells[k].range > r) r = g.cells[k].range;
      return r || 40;
    }
    return ROLES[g.role].range * FORMATIONS[g.formation].range;
  }

  canAct(g: Group): boolean {
    return g.alive && g.morphT <= 0 && g.novaT <= 0;
  }

  // ---------------------------------------------------------------- commands

  private setOrder(g: Group, type: OrderType, x = g.ax, y = g.ay, target = -1): void {
    const o = g.order;
    o.type = type;
    o.x = x;
    o.y = y;
    o.group = type === 'attack' && target >= 0 ? target : -1;
    o.ship = -1;
    o.rock = type === 'harvest' ? target : -1;
    g.harvesting = false;
    g.path.length = 0;
  }

  /** Follow a drawn route: points are flat x,y pairs in world space. */
  cmdPath(ids: number[], pts: number[]): void {
    if (pts.length < 2) return;
    for (const id of ids) {
      const g = this.groups[id];
      if (!g?.alive) continue;
      this.setOrder(g, 'move', this.clampX(pts[0]), this.clampX(pts[1]));
      for (let k = 2; k < pts.length; k++) g.path.push(this.clampX(pts[k]));
    }
  }

  /** Append a waypoint after whatever the group is currently moving to. */
  cmdQueue(ids: number[], x: number, y: number): void {
    for (const id of ids) {
      const g = this.groups[id];
      if (!g?.alive) continue;
      if (g.order.type === 'move') g.path.push(this.clampX(x), this.clampX(y));
      else this.setOrder(g, 'move', this.clampX(x), this.clampX(y));
    }
  }

  cmdMove(ids: number[], x: number, y: number): void {
    const gs = ids.map((id) => this.groups[id]).filter((g) => g?.alive);
    if (!gs.length) return;
    // Keep relative spacing for multi-group moves, compressed so they arrive together.
    let mx = 0, my = 0;
    for (const g of gs) { mx += g.cx; my += g.cy; }
    mx /= gs.length; my /= gs.length;
    for (const g of gs) {
      const ox = gs.length > 1 ? (g.cx - mx) * 0.35 : 0;
      const oy = gs.length > 1 ? (g.cy - my) * 0.35 : 0;
      this.setOrder(g, 'move', this.clampX(x + ox), this.clampX(y + oy));
    }
  }

  cmdAttackGroup(ids: number[], target: number): void {
    for (const id of ids) {
      const g = this.groups[id];
      if (g?.alive) this.setOrder(g, 'attack', g.ax, g.ay, target);
    }
  }

  cmdAttackShip(ids: number[], ship: number): void {
    for (const id of ids) {
      const g = this.groups[id];
      if (!g?.alive) continue;
      this.setOrder(g, 'attack');
      g.order.ship = ship;
    }
  }

  cmdHarvest(ids: number[], rock: number): void {
    for (const id of ids) {
      const g = this.groups[id];
      if (g?.alive && !g.cells && this.rocks[rock]?.alive) this.setOrder(g, 'harvest', g.ax, g.ay, rock);
    }
  }

  cmdReplicate(ids: number[]): boolean {
    let ok = false;
    for (const id of ids) {
      const g = this.groups[id];
      if (!g?.alive || g.cells) continue;
      if (g.count < REPLICATE_MIN) {
        this.events.push({ t: 'fail', x: g.cx, y: g.cy, team: g.team, msg: `Needs ${REPLICATE_MIN}+ units to replicate` });
        continue;
      }
      this.setOrder(g, 'replicate', g.cx, g.cy);
      g.ax = g.cx;
      g.ay = g.cy;
      ok = true;
    }
    return ok;
  }

  cmdResearch(ids: number[]): void {
    for (const id of ids) {
      const g = this.groups[id];
      if (!g?.alive || g.cells) continue;
      this.setOrder(g, 'research', g.cx, g.cy);
      g.ax = g.cx;
      g.ay = g.cy;
    }
  }

  cmdStop(ids: number[]): void {
    for (const id of ids) {
      const g = this.groups[id];
      if (!g?.alive) continue;
      this.setOrder(g, 'idle', g.cx, g.cy);
      g.ax = g.cx;
      g.ay = g.cy;
    }
  }

  /** Split a group in two along the direction (dx, dy). Returns the new group's id (the half facing dx,dy). */
  cmdSplit(id: number, dx: number, dy: number): number {
    const g = this.groups[id];
    if (!g?.alive || g.cells || g.count < 2) return -1;
    const units = this.unitsOf(g);
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len, ny = dy / len;
    units.sort((a, b) => (this.ux[a] - g.cx) * nx + (this.uy[a] - g.cy) * ny - ((this.ux[b] - g.cx) * nx + (this.uy[b] - g.cy) * ny));
    const half = units.slice(Math.floor(units.length / 2));
    let sx = 0, sy = 0;
    for (const i of half) { sx += this.ux[i]; sy += this.uy[i]; }
    sx /= half.length; sy /= half.length;
    const ng = this.createGroup(g.team, sx, sy);
    ng.formation = g.formation;
    ng.role = g.role;
    ng.morphTo = g.morphTo;
    ng.morphT = g.morphT;
    ng.energy = g.energy;
    ng.hx = g.hx; ng.hy = g.hy;
    for (const i of half) this.ugroup[i] = ng.id;
    ng.count = half.length;
    g.count -= half.length;
    // Nudge the halves apart so the split reads clearly.
    const push = 30 + Math.sqrt(units.length) * 3;
    ng.ax = sx + nx * push; ng.ay = sy + ny * push;
    let rx = 0, ry = 0;
    for (const i of units.slice(0, units.length - half.length)) { rx += this.ux[i]; ry += this.uy[i]; }
    const rest = units.length - half.length;
    // The remaining half keeps working (harvest, replicate, attack...); the new half awaits orders.
    const keepsOrder = g.order.type !== 'idle' && g.order.type !== 'move';
    g.ax = rx / rest - (keepsOrder ? 0 : nx * push);
    g.ay = ry / rest - (keepsOrder ? 0 : ny * push);
    if (!keepsOrder) this.setOrder(g, 'idle', g.ax, g.ay);
    else if (g.order.type === 'replicate' && g.count < REPLICATE_MIN) this.setOrder(g, 'idle', g.ax, g.ay);
    this.setOrder(ng, 'idle', ng.ax, ng.ay);
    return ng.id;
  }

  /** Merge groups into the largest one. Returns surviving id. */
  cmdMerge(ids: number[]): number {
    const gs = ids.map((id) => this.groups[id]).filter((g) => g?.alive && g.count > 0);
    if (gs.length < 2) return gs[0]?.id ?? -1;
    const construct = gs.find((g) => g.cells);
    if (construct) {
      for (const g of gs) if (g !== construct && !g.cells && g.team === construct.team) this.repair(construct, g);
      return construct.id;
    }
    const team = gs[0].team;
    const same = gs.filter((g) => g.team === team);
    same.sort((a, b) => b.count - a.count);
    const keep = same[0];
    const ids2 = new Set(same.slice(1).map((g) => g.id));
    let sx = keep.cx * keep.count, sy = keep.cy * keep.count, n = keep.count;
    for (const g of same.slice(1)) { sx += g.cx * g.count; sy += g.cy * g.count; n += g.count; }
    for (let i = 0; i < this.hi; i++) {
      if (this.ualive[i] && ids2.has(this.ugroup[i])) {
        // Units of a different role adopt the survivor's role, keeping health ratio.
        const old = this.groups[this.ugroup[i]];
        if (old.role !== keep.role) this.uhp[i] *= this.maxHp(team, keep.role) / this.maxHp(team, old.role);
        this.ugroup[i] = keep.id;
      }
    }
    for (const g of same.slice(1)) { g.alive = false; g.count = 0; }
    keep.count = n;
    this.setOrder(keep, 'move', sx / n, sy / n);
    return keep.id;
  }

  /** Research a particle part. */
  buyPart(team: number, partId: string): boolean {
    const t = this.teams[team];
    const roleUnlock = ROLE_UNLOCKS.find((r) => r.id === partId);
    if (roleUnlock) {
      if (t.unlocked.has(partId) || t.points < roleUnlock.cost) return false;
      t.points -= roleUnlock.cost;
      t.unlocked.add(partId);
      this.events.push({ t: 'research', x: t.homeX, y: t.homeY, team, msg: `${roleUnlock.name} unlocked` });
      return true;
    }
    const part = PART_BY_ID.get(partId);
    if (!part || t.unlocked.has(partId) || t.points < part.cost) return false;
    if (!part.requires.every((r) => t.unlocked.has(r))) return false;
    t.points -= part.cost;
    t.unlocked.add(partId);
    this.events.push({ t: 'research', x: t.homeX, y: t.homeY, team, msg: `${part.name} unlocked` });
    return true;
  }

  /**
   * Assemble a construct from a swarm group. Each cell consumes `part.units` swarm units:
   * one becomes the cell's particle, the rest are absorbed into it.
   * Returns the new construct's group id, or -1.
   */
  cmdBuild(id: number, design: Design): number {
    const g = this.groups[id];
    if (!g?.alive || g.cells) return -1;
    const t = this.teams[g.team];
    const need = designUnits(design);
    if (design.cells.some((c) => !t.unlocked.has(c.part))) {
      this.events.push({ t: 'fail', x: g.cx, y: g.cy, team: g.team, msg: 'Research the parts in this design first' });
      return -1;
    }
    if (g.count < need) {
      this.events.push({ t: 'fail', x: g.cx, y: g.cy, team: g.team, msg: `${design.name} needs ${need} units (group has ${g.count})` });
      return -1;
    }
    const units = this.unitsOf(g).sort((a, b) =>
      Math.hypot(this.ux[a] - g.cx, this.uy[a] - g.cy) - Math.hypot(this.ux[b] - g.cx, this.uy[b] - g.cy));
    const cg = this.createGroup(g.team, g.cx, g.cy);
    cg.role = Role.Tank; // constructs count as heavy targets in the counter table
    cg.hx = g.hx; cg.hy = g.hy;
    this.initConstruct(cg, design);
    let u = 0;
    for (let k = 0; k < design.cells.length; k++) {
      const part = PART_BY_ID.get(design.cells[k].part)!;
      const i = units[u++];
      this.ugroup[i] = cg.id;
      this.uslot[i] = k;
      this.uhp[i] = cg.cells![k].hp;
      cg.slotUnit![k] = i;
      for (let extra = 1; extra < part.units; extra++) this.absorb(units[u++], cg);
    }
    cg.count = design.cells.length;
    g.count -= need;
    this.setOrder(cg, 'idle', g.cx, g.cy);
    this.events.push({ t: 'morph', x: g.cx, y: g.cy, team: g.team, r: 60, n: 1 });
    return cg.id;
  }

  private initConstruct(cg: Group, design: Design): void {
    const t = this.teams[cg.team];
    cg.design = design;
    cg.cells = cellStats(design, t.levels.hull, t.levels.damage);
    cg.slotUnit = new Int32Array(design.cells.length).fill(-1);
    cg.cSpeed = constructSpeed(design);
  }

  /** Remove a unit that was fused into a construct (not a combat loss). */
  private absorb(i: number, into: Group): void {
    if (i === undefined || !this.ualive[i]) return;
    this.ualive[i] = 0;
    this.free.push(i);
    this.teams[this.uteam[i]].units--;
    this.events.push({ t: 'spawn', x: this.ux[i], y: this.uy[i], team: into.team });
  }

  /** Feed swarm units into a construct's destroyed cells. */
  private repair(cg: Group, donor: Group): void {
    const pool = this.unitsOf(donor);
    let used = 0;
    for (let k = 0; k < cg.cells!.length && pool.length; k++) {
      if (cg.slotUnit![k] >= 0) continue;
      const cell = cg.cells![k];
      if (pool.length < cell.part.units) break;
      const i = pool.pop()!;
      this.ugroup[i] = cg.id;
      this.uslot[i] = k;
      this.uhp[i] = cell.hp * 0.6;
      cg.slotUnit![k] = i;
      for (let extra = 1; extra < cell.part.units; extra++) this.absorb(pool.pop()!, cg);
      used += cell.part.units;
    }
    if (used) {
      donor.count -= used;
      this.events.push({ t: 'morph', x: cg.cx, y: cg.cy, team: cg.team, r: cg.radius, n: 1 });
    }
  }

  cmdFormation(ids: number[], f: Formation): void {
    for (const id of ids) {
      const g = this.groups[id];
      if (g?.alive && !g.cells) g.formation = f;
    }
  }

  cmdMorph(ids: number[], role: Role): void {
    for (const id of ids) {
      const g = this.groups[id];
      if (!g?.alive || g.cells || (g.role === role && g.morphT <= 0) || (g.morphTo === role && g.morphT > 0)) continue;
      const gate = ROLE_UNLOCK_BY_ROLE.get(role);
      if (gate && !this.teams[g.team].unlocked.has(gate.id)) {
        this.events.push({ t: 'fail', x: g.cx, y: g.cy, team: g.team, msg: `Research ${gate.name} first (Y)` });
        continue;
      }
      g.morphTo = role;
      g.morphT = MORPH_TIME;
      this.events.push({ t: 'morph', x: g.cx, y: g.cy, team: g.team, r: g.radius });
    }
  }

  cmdDash(ids: number[], tx: number, ty: number): boolean {
    let any = false;
    for (const id of ids) {
      const g = this.groups[id];
      if (!g || !this.canAct(g) || g.cdDash > 0 || g.energy < DASH.cost) continue;
      let dx = tx - g.cx, dy = ty - g.cy;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
      g.energy -= DASH.cost;
      g.cdDash = DASH.cooldown;
      g.dashT = DASH.duration;
      g.dashX = dx; g.dashY = dy;
      const dist = Math.min(d, DASH.distance + g.radius);
      g.ax = this.clampX(g.cx + dx * dist);
      g.ay = this.clampX(g.cy + dy * dist);
      g.hx = dx; g.hy = dy;
      if (g.order.type === 'replicate' || g.order.type === 'research' || g.order.type === 'idle' || g.order.type === 'move') {
        this.setOrder(g, 'move', g.ax, g.ay);
      }
      this.events.push({ t: 'dash', x: g.cx, y: g.cy, x2: dx, y2: dy, team: g.team, r: g.radius });
      any = true;
    }
    return any;
  }

  cmdShield(ids: number[]): boolean {
    let any = false;
    for (const id of ids) {
      const g = this.groups[id];
      if (!g || !this.canAct(g) || g.cdShield > 0 || g.energy < SHIELD.cost) continue;
      g.energy -= SHIELD.cost;
      g.cdShield = SHIELD.cooldown;
      g.shieldT = SHIELD.duration;
      this.events.push({ t: 'shield', x: g.cx, y: g.cy, team: g.team, r: g.radius });
      any = true;
    }
    return any;
  }

  cmdNova(ids: number[]): boolean {
    let any = false;
    for (const id of ids) {
      const g = this.groups[id];
      if (!g || !this.canAct(g) || g.cdNova > 0 || g.energy < NOVA.cost) continue;
      if (g.cells) continue;
      if (g.count < NOVA.minUnits) {
        this.events.push({ t: 'fail', x: g.cx, y: g.cy, team: g.team, msg: `Nova needs ${NOVA.minUnits}+ units` });
        continue;
      }
      g.energy -= NOVA.cost;
      g.cdNova = NOVA.cooldown;
      g.novaT = NOVA.charge;
      this.events.push({ t: 'novaCharge', x: g.cx, y: g.cy, team: g.team, r: g.radius });
      any = true;
    }
    return any;
  }

  buyResearch(team: number, track: ResearchTrack): boolean {
    const t = this.teams[team];
    if (t.points < 1 || t.levels[track] >= MAX_RESEARCH_LEVEL) return false;
    t.points--;
    const before = t.levels.hull;
    t.levels[track]++;
    if (track === 'hull' || track === 'damage') {
      for (const g of this.groups) if (g.alive && g.team === team && g.design) g.cells = cellStats(g.design, t.levels.hull, t.levels.damage);
    }
    if (track === 'hull') {
      const k = (1 + 0.2 * t.levels.hull) / (1 + 0.2 * before);
      for (let i = 0; i < this.hi; i++) if (this.ualive[i] && this.uteam[i] === team) this.uhp[i] *= k;
    }
    return true;
  }

  researchCost(team: number): number {
    return RESEARCH_POINT_BASE * (1 + 0.2 * this.teams[team].pointsEarned);
  }

  // ---------------------------------------------------------------- simulation

  step(): void {
    this.time += DT;
    this.tick++;
    this.computeGroupStats();
    if (this.tick % 6 === 0) this.computeProximity();
    for (const g of this.groups) if (g.alive) this.updateGroup(g);
    this.grid.build(this.ux, this.uy, this.ualive, this.hi);
    this.updateUnits();
    updateShips(this);
    this.updateProjectiles();
    this.reap();
    updateAI(this);
    if (this.waves) updateWaves(this);
    this.checkEnd();
  }

  private computeGroupStats(): void {
    const gs = this.groups;
    for (const g of gs) {
      if (!g.alive) continue;
      g.count = 0;
      g.cx = 0;
      g.cy = 0;
      g.vx = 0;
      g.vy = 0;
      g.slotUnit?.fill(-1);
    }
    for (const t of this.teams) t.units = 0;
    for (let i = 0; i < this.hi; i++) {
      if (!this.ualive[i]) continue;
      const g = gs[this.ugroup[i]];
      g.count++;
      if (g.slotUnit && this.uslot[i] >= 0) g.slotUnit[this.uslot[i]] = i;
      g.cx += this.ux[i];
      g.cy += this.uy[i];
      g.vx += this.uvx[i];
      g.vy += this.uvy[i];
      this.teams[this.uteam[i]].units++;
    }
    for (const g of gs) {
      if (!g.alive) continue;
      if (g.count === 0) {
        g.alive = false;
        continue;
      }
      g.cx /= g.count;
      g.cy /= g.count;
      g.vx /= g.count;
      g.vy /= g.count;
      g.spread = 0;
    }
    // Measured spread (RMS distance from centroid) so rings and hit-tests hug the real swarm.
    for (let i = 0; i < this.hi; i++) {
      if (!this.ualive[i]) continue;
      const g = gs[this.ugroup[i]];
      const dx = this.ux[i] - g.cx, dy = this.uy[i] - g.cy;
      g.spread += dx * dx + dy * dy;
    }
    for (const g of gs) {
      if (!g.alive) continue;
      const measured = Math.sqrt(g.spread / g.count) * 1.35 + 6;
      g.radius = Math.min(measured, formationRadius(g.count, g.formation) * 1.6);
      if (g.count > g.peak) g.peak = g.count;
    }
  }

  private computeProximity(): void {
    const gs = this.groups.filter((g) => g.alive);
    for (const g of gs) {
      const reach = g.radius + this.rangeOf(g) + 160;
      let near = false;
      for (const o of gs) {
        if (o.team === g.team) continue;
        const d = Math.hypot(o.cx - g.cx, o.cy - g.cy);
        if (d < reach + o.radius + this.rangeOf(o)) { near = true; break; }
      }
      if (!near) {
        for (const s of this.ships) {
          if (!s.alive) continue;
          const st = SHIPS[s.type];
          if (Math.hypot(s.x - g.cx, s.y - g.cy) < reach + st.range + st.radius) { near = true; break; }
        }
      }
      g.enemyNear = near;
    }
  }

  private updateGroup(g: Group): void {
    const team = this.teams[g.team];
    let regen = ENERGY_REGEN;
    if (g.cells) regen += this.constructUpkeep(g);
    g.energy = Math.min(ENERGY_MAX, g.energy + regen * DT);
    g.cdDash = Math.max(0, g.cdDash - DT);
    g.cdShield = Math.max(0, g.cdShield - DT);
    g.cdNova = Math.max(0, g.cdNova - DT);
    g.dashT = Math.max(0, g.dashT - DT);
    g.shieldT = Math.max(0, g.shieldT - DT);
    g.combatT += DT;
    g.recentLoss *= 1 - DT * 0.5;

    if (g.morphT > 0) {
      g.morphT -= DT;
      if (g.morphT <= 0) {
        const ratio = this.maxHp(g.team, g.morphTo) / this.maxHp(g.team, g.role);
        g.role = g.morphTo;
        for (let i = 0; i < this.hi; i++) if (this.ualive[i] && this.ugroup[i] === g.id) this.uhp[i] *= ratio;
        this.events.push({ t: 'morph', x: g.cx, y: g.cy, team: g.team, r: g.radius, n: 1 });
      }
    }
    if (g.novaT > 0) {
      g.novaT -= DT;
      if (g.novaT <= 0) this.detonateNova(g);
    }

    const o = g.order;
    // Idle constructs defend themselves: engage the nearest enemy swarm in reach (and so keep their guns at range).
    if (g.cells && o.type === 'idle' && g.enemyNear && (this.tick + g.id) % 20 === 0) {
      const reach = this.rangeOf(g) + 150;
      let best: Group | null = null, bd = reach;
      for (const e of this.groups) {
        if (!e.alive || e.team === g.team || e.count <= 0) continue;
        const d = Math.hypot(e.cx - g.cx, e.cy - g.cy) - e.radius;
        if (d < bd) { bd = d; best = e; }
      }
      if (best) this.setOrder(g, 'attack', g.ax, g.ay, best.id);
    }
    let gx = g.ax, gy = g.ay;
    let stopDist = 3;
    g.harvesting = false;
    switch (o.type) {
      case 'move':
        gx = o.x; gy = o.y;
        if (g.path.length && Math.hypot(g.ax - o.x, g.ay - o.y) < 30 + g.radius * 0.3) {
          // Flow through waypoints without stopping.
          o.x = g.path.shift()!;
          o.y = g.path.shift()!;
        } else if (Math.hypot(g.ax - o.x, g.ay - o.y) < 4) o.type = 'idle';
        break;
      case 'attack': {
        let tx = 0, ty = 0, tr = 0, valid = false;
        if (o.group >= 0) {
          const t = this.groups[o.group];
          if (t?.alive && t.count > 0) { tx = t.cx; ty = t.cy; tr = t.radius; valid = true; }
        } else if (o.ship >= 0) {
          const s = this.ships[o.ship];
          if (s?.alive) { tx = s.x; ty = s.y; tr = SHIPS[s.type].radius; valid = true; }
        }
        if (!valid) {
          this.setOrder(g, 'idle', g.cx, g.cy);
          break;
        }
        gx = tx; gy = ty;
        // Melee roles dive in; ranged ones hold at range.
        stopDist = g.role === Role.Striker ? 0 : tr * 0.55 + this.rangeOf(g) * 0.6 + 10;
        break;
      }
      case 'harvest': {
        const r = this.rocks[o.rock];
        if (!r?.alive) { this.setOrder(g, 'idle', g.cx, g.cy); break; }
        gx = r.x; gy = r.y;
        stopDist = 0;
        const d = Math.hypot(g.cx - r.x, g.cy - r.y);
        if (d < r.r + g.radius + 50) {
          g.harvesting = true;
          const rate = HARVEST_RATE * ROLES[g.role].harvest * (1 + 0.25 * team.levels.replication) * this.growthMult(g.team);
          // A rock only has so much surface: extra units beyond its crew limit help a little.
          const crew = 25 + r.r * 0.9;
          const effN = g.count <= crew ? g.count : crew + (g.count - crew) * 0.15;
          const take = Math.min(r.mass, effN * rate * DT * (g.morphT > 0 ? 0 : 1));
          r.mass -= take;
          r.r = rockRadius(r.mass);
          g.progress += take;
          while (g.progress >= MASS_PER_UNIT) {
            g.progress -= MASS_PER_UNIT;
            const a = this.rng.next() * Math.PI * 2;
            const u = this.spawnUnit(g, r.x + Math.cos(a) * r.r, r.y + Math.sin(a) * r.r);
            if (u < 0) { g.progress = 0; break; }
            this.events.push({ t: 'harvest', x: r.x + Math.cos(a) * r.r, y: r.y + Math.sin(a) * r.r, team: g.team });
          }
          if (r.mass <= 0.5) {
            r.alive = false;
            this.events.push({ t: 'explode', x: r.x, y: r.y, r: 60, team: -1 });
            this.setOrder(g, 'idle', g.cx, g.cy);
          }
        }
        break;
      }
      case 'replicate': {
        if (g.count < REPLICATE_MIN) { this.setOrder(g, 'idle', g.cx, g.cy); break; }
        if (g.morphT > 0) break;
        const n = g.count;
        g.progress += Math.sqrt(n) * REPLICATE_RATE * ROLES[g.role].replicate * (1 + 0.25 * team.levels.replication) * this.growthMult(g.team) * DT;
        while (g.progress >= 1) {
          g.progress -= 1;
          const a = this.rng.next() * Math.PI * 2;
          const rr = g.radius * Math.sqrt(this.rng.next());
          if (this.spawnUnit(g, g.cx + Math.cos(a) * rr, g.cy + Math.sin(a) * rr) < 0) { g.progress = 0; break; }
        }
        break;
      }
      case 'research': {
        if (g.morphT > 0) break;
        team.progress += g.count * RESEARCH_RATE * DT;
        const cost = this.researchCost(g.team);
        if (team.progress >= cost) {
          team.progress -= cost;
          team.points++;
          team.pointsEarned++;
          this.events.push({ t: 'research', x: g.cx, y: g.cy, team: g.team });
        }
        break;
      }
      case 'idle':
        break;
    }

    // Move the anchor. It waits for stragglers so the swarm stays cohesive.
    let dx = gx - g.ax, dy = gy - g.ay;
    const dist = Math.hypot(dx, dy);
    const lag = Math.hypot(g.cx - g.ax, g.cy - g.ay);
    const moving = dist > stopDist + 2;
    if (moving && g.combatT > 1.5 && g.dashT <= 0) g.cruise = Math.min(CRUISE_RAMP, g.cruise + DT);
    else g.cruise = Math.max(0, g.cruise - DT * 4);
    const c = g.cruise / CRUISE_RAMP;
    const cruiseMult = 1 + (CRUISE_MAX - 1) * c * c * (3 - 2 * c);
    if (moving) {
      dx /= dist; dy /= dist;
      let sp = this.speedOf(g) * 0.9 * cruiseMult;
      if (g.dashT > 0) sp *= DASH.speedMult;
      const slack = g.radius + 40 + sp * 0.35;
      if (lag > slack && g.dashT <= 0) sp *= Math.max(0.15, 1 - (lag - slack) / 120);
      const stepLen = Math.min(dist - stopDist, sp * DT);
      g.ax += dx * stepLen;
      g.ay += dy * stepLen;
      // Smoothly turn heading toward travel direction.
      const turn = g.cells ? 1.4 : 4; // constructs have rotational inertia
      g.hx += (dx - g.hx) * Math.min(1, DT * turn);
      g.hy += (dy - g.hy) * Math.min(1, DT * turn);
    } else if (o.type === 'attack') {
      // Face the target when holding position.
      const fx = gx - g.cx, fy = gy - g.cy, fd = Math.hypot(fx, fy) || 1;
      g.hx += (fx / fd - g.hx) * Math.min(1, DT * 4);
      g.hy += (fy / fd - g.hy) * Math.min(1, DT * 4);
      if (dist < stopDist - 40) {
        // Too close for a ranged group: back off. Artillery kites hard to keep its guns usable.
        const kite = g.role === Role.Artillery ? 0.9 : 0.4;
        g.ax -= (dx / (dist || 1)) * this.speedOf(g) * kite * DT;
        g.ay -= (dy / (dist || 1)) * this.speedOf(g) * kite * DT;
      }
    }
    const hl = Math.hypot(g.hx, g.hy) || 1;
    g.hx /= hl; g.hy /= hl;
    g.ax = this.clampX(g.ax);
    g.ay = this.clampX(g.ay);
  }

  /** Menders heal, reactors add energy, and pieces cut off from the main body break away. Returns bonus energy regen. */
  private constructUpkeep(g: Group): number {
    const cells = g.cells!, slots = g.slotUnit!;
    let energy = 0;
    const healTick = (this.tick + g.id) % 15 === 0;
    for (let k = 0; k < cells.length; k++) {
      if (slots[k] < 0) continue;
      const part = cells[k].part;
      energy += part.energy;
      if (healTick && part.heal > 0) {
        for (const n of cells[k].neighbors) {
          const u = slots[n];
          if (u >= 0) this.uhp[u] = Math.min(cells[n].hp, this.uhp[u] + part.heal * 0.25);
        }
      }
    }
    if (g.integrityDirty && (this.tick + g.id) % 6 === 0) {
      g.integrityDirty = false;
      this.checkIntegrity(g);
    }
    return Math.min(energy, ENERGY_REGEN * 2);
  }

  /** Cells no longer connected to the largest surviving chunk lose their bonds and become loose swarm units. */
  private checkIntegrity(g: Group): void {
    const cells = g.cells!, slots = g.slotUnit!, design = g.design!;
    const alive: number[] = [];
    for (let k = 0; k < cells.length; k++) if (slots[k] >= 0 && this.ualive[slots[k]]) alive.push(k);
    const keep = alive.length >= MIN_CELLS
      ? new Set(largestComponent(alive.map((k) => [design.cells[k].x, design.cells[k].y])).map((j) => alive[j]))
      : new Set<number>();
    const loose = alive.filter((k) => !keep.has(k));
    if (!loose.length) return;
    let lx = 0, ly = 0;
    for (const k of loose) { lx += this.ux[slots[k]]; ly += this.uy[slots[k]]; }
    const debris = this.createGroup(g.team, lx / loose.length, ly / loose.length);
    const droneHp = this.maxHp(g.team, Role.Drone);
    for (const k of loose) {
      const i = slots[k];
      this.ugroup[i] = debris.id;
      this.uslot[i] = -1;
      this.uhp[i] = Math.min(this.uhp[i], droneHp);
      slots[k] = -1;
      // Fling the broken piece outward.
      const dx = this.ux[i] - g.cx, dy = this.uy[i] - g.cy, d = Math.hypot(dx, dy) || 1;
      this.uvx[i] += (dx / d) * 120;
      this.uvy[i] += (dy / d) * 120;
    }
    debris.count = loose.length;
    g.count -= loose.length;
    this.events.push({ t: 'explode', x: debris.ax, y: debris.ay, r: 30, team: g.team });
  }

  /** Growth slows as a team gets bigger (logistic), so splitting into many small groups is no exploit. */
  growthMult(team: number): number {
    const t = this.teams[team];
    return (t.ai ? DIFFICULTY[this.difficulty].aiGrowth : 1) * (GROWTH_KNEE / (GROWTH_KNEE + t.units));
  }

  private detonateNova(g: Group): void {
    const units = this.unitsOf(g);
    if (!units.length) return;
    // Sacrifice the units closest to the centre: they collapse into the blast.
    units.sort((a, b) => Math.hypot(this.ux[a] - g.cx, this.uy[a] - g.cy) - Math.hypot(this.ux[b] - g.cx, this.uy[b] - g.cy));
    const n = Math.max(1, Math.floor(units.length * NOVA.sacrifice));
    for (let k = 0; k < n; k++) {
      const i = units[k];
      this.uhp[i] = 0;
      this.ualive[i] = 0;
      this.free.push(i);
      this.teams[g.team].units--;
      g.count--;
    }
    const dmg = NOVA.damage * (1 + 0.2 * this.teams[g.team].levels.damage) * Math.min(2.5, 0.6 + units.length / 120);
    const r = NOVA.radius + g.radius * 0.6;
    this.splash(g.cx, g.cy, r, dmg, g.team, 0.4);
    this.events.push({ t: 'nova', x: g.cx, y: g.cy, r, team: g.team, n });
  }

  /** Area damage with linear falloff to `edge` fraction at the rim, hitting at most `maxHits` units (nearest first). */
  splash(x: number, y: number, r: number, dmg: number, team: number, edge = 0.5, maxHits = Infinity, role = -1): void {
    const r2 = r * r;
    const hits = this.splashHits;
    hits.length = 0;
    this.grid.query(x, y, r, (i) => {
      if (!this.ualive[i] || this.uteam[i] === team) return;
      const dx = this.ux[i] - x, dy = this.uy[i] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) hits.push(i, d2);
    });
    let n = hits.length / 2;
    let order: number[] | null = null;
    if (n > maxHits) {
      order = Array.from({ length: n }, (_, k) => k).sort((a, b) => hits[a * 2 + 1] - hits[b * 2 + 1]);
      n = maxHits;
    }
    for (let k = 0; k < n; k++) {
      const h = order ? order[k] : k;
      const i = hits[h * 2];
      const d = Math.sqrt(hits[h * 2 + 1]);
      const f = 1 - (1 - edge) * d / r;
      const counter = role >= 0 ? COUNTER[role][this.roleOf(i)] : 1;
      this.damageUnit(i, dmg * f * counter, team);
      // Knockback sells the impact.
      const dx = this.ux[i] - x, dy = this.uy[i] - y;
      const dl = d || 1;
      this.uvx[i] += (dx / dl) * 220 * f;
      this.uvy[i] += (dy / dl) * 220 * f;
    }
    if (team !== SHIP_TEAM) {
      for (const s of this.ships) {
        if (!s.alive) continue;
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < r + SHIPS[s.type].radius) this.damageShip(s, dmg * (1 - (1 - edge) * Math.min(1, d / r)) * 1.5, team);
      }
    }
  }

  /** Counter-table role of a unit: construct cells use their part's role. */
  roleOf(i: number): Role {
    const g = this.groups[this.ugroup[i]];
    return g.cells && this.uslot[i] >= 0 ? g.cells[this.uslot[i]].part.counter : g.role;
  }

  damageUnit(i: number, dmg: number, attacker: number): void {
    const g = this.groups[this.ugroup[i]];
    let def = ROLES[g.role].defense + FORMATIONS[g.formation].defense;
    if (g.cells && this.uslot[i] >= 0) {
      // Construct cell: its own armor plus the best touching shield node.
      const c = g.cells[this.uslot[i]];
      let shield = 0;
      for (const n of c.neighbors) if (g.slotUnit![n] >= 0 && g.cells[n].part.shield > shield) shield = g.cells[n].part.shield;
      def = c.part.armor + (1 - c.part.armor) * shield;
    }
    if (g.shieldT > 0) def = Math.max(def, 0) + (1 - Math.max(def, 0)) * SHIELD.reduction;
    if (def > 0.92) def = 0.92;
    this.uhp[i] -= dmg * (1 - def);
    this.uflash[i] = 1;
    g.combatT = 0;
    if (this.uhp[i] <= 0 && attacker !== SHIP_TEAM && attacker >= 0 && this.teams[attacker]) {
      // Credit kill once: mark hp very negative so it is not double counted.
      if (this.uhp[i] > -1e6) {
        this.teams[attacker].kills++;
        this.uhp[i] = -1e7;
      }
    }
  }

  damageShip(s: Ship, dmg: number, attacker: number): void {
    if (!s.alive) return;
    s.hp -= dmg;
    s.flash = 1;
    if (s.hp <= 0) {
      s.alive = false;
      const st = SHIPS[s.type];
      if (attacker >= 0 && this.teams[attacker]) this.teams[attacker].kills += 5;
      this.events.push({ t: 'shipDeath', x: s.x, y: s.y, r: st.radius, n: s.type });
      this.addRock(s.x, s.y, st.wreck, true);
    }
  }

  private updateUnits(): void {
    const { ux, uy, uvx, uvy, ualive, ugroup, uteam, utgt, ucd, uflash, useed } = this;
    const grid = this.grid;
    const cell = grid.cell, cols = grid.cols, rows = grid.rows;
    const cs = grid.cellStart, items = grid.items;
    const groups = this.groups;
    const ships = this.ships;
    const time = this.time;
    const sep = UNIT_SPACING;
    const sep2 = sep * sep;
    const sepX = this.sepX, sepY = this.sepY;
    this.upx.set(ux.subarray(0, this.hi));
    this.upy.set(uy.subarray(0, this.hi));

    for (let i = 0; i < this.hi; i++) {
      if (!ualive[i]) continue;
      const g = groups[ugroup[i]];
      const role = ROLES[g.role];
      const team = this.teams[g.team];
      const x = ux[i], y = uy[i];
      const seed = useed[i];
      uflash[i] = Math.max(0, uflash[i] - DT * 4);
      const slot = this.uslot[i];
      const cellS = slot >= 0 && g.cells ? g.cells[slot] : null;

      // ---- desired position from the formation shape field (or the construct's rotated grid slot)
      let px: number, py: number;
      const ox = x - g.ax, oy = y - g.ay;
      if (cellS) {
        px = g.ax + cellS.ox * g.hx - cellS.oy * g.hy;
        py = g.ay + cellS.ox * g.hy + cellS.oy * g.hx;
      } else if (g.harvesting) {
        const r = this.rocks[g.order.rock];
        const rx = x - r.x, ry = y - r.y;
        const rd = Math.sqrt(rx * rx + ry * ry) || 1;
        const band = r.r + 10 + seed * Math.min(70, 6 + Math.sqrt(g.count) * 3);
        // Orbit the rock: target slightly ahead along the tangent.
        const tang = 18 + seed * 14;
        px = r.x + (rx / rd) * band - (ry / rd) * tang;
        py = r.y + (ry / rd) * band + (rx / rd) * tang;
      } else {
        const p = shapeProject(ox, oy, g.hx, g.hy, g.count, g.formation, seed);
        px = g.ax + p[0];
        py = g.ay + p[1];
      }
      if (!cellS && !g.harvesting) {
        // Each particle loops on its own little orbit around its formation spot, so the swarm never sits in a lattice.
        const ph = time * (0.7 + seed * 1.3) + seed * 50;
        const orb = 4 + seed * 13;
        px += Math.cos(ph) * orb;
        py += Math.sin(ph * 1.17) * orb;
      }
      if (g.novaT > 0) {
        // Charging nova: the swarm implodes toward its centre.
        const k = 1 - g.novaT / NOVA.charge;
        px += (g.cx - px) * k * 0.8;
        py += (g.cy - py) * k * 0.8;
      }

      let maxSp = cellS ? g.cSpeed * 2 * (1 + 0.1 * team.levels.speed) : role.speed * FORMATIONS[g.formation].speed * (1 + 0.1 * team.levels.speed);
      maxSp *= 1 + (CRUISE_MAX - 1) * Math.min(1, g.cruise / CRUISE_RAMP);
      if (g.dashT > 0) maxSp *= DASH.speedMult;
      const spring = cellS ? 7 : 3.2;
      let dvx = (px - x) * spring, dvy = (py - y) * spring;

      // ---- targeting & firing
      ucd[i] -= DT;
      let t = utgt[i];
      if (g.enemyNear && !(cellS && cellS.damage <= 0)) {
        const range = cellS ? cellS.range : role.range * FORMATIONS[g.formation].range;
        if (t !== -1 && !this.targetValid(i, t, range * 1.7 + 40)) t = utgt[i] = -1;
        if (t === -1 && (this.tick + i) % 10 === 0) t = utgt[i] = this.acquire(i, range + 60 + (g.order.type === 'attack' ? 80 : 0));
        if (t !== -1) {
          let tx: number, ty: number, tr = 0;
          if (t >= 0) { tx = ux[t]; ty = uy[t]; }
          else { const s = ships[-t - 2]; tx = s.x; ty = s.y; tr = SHIPS[s.type].radius; }
          const ddx = tx - x, ddy = ty - y;
          const d = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
          if (!cellS && g.role === Role.Striker && g.morphT <= 0) {
            // Lancers peel off and lunge, then swing back into formation.
            const lunge = Math.sin(time * 6 + seed * 20) * 0.5 + 0.5;
            if (d < range + tr + 140) {
              dvx = dvx * 0.2 + (ddx / d) * maxSp * (0.8 + lunge * 0.6);
              dvy = dvy * 0.2 + (ddy / d) * maxSp * (0.8 + lunge * 0.6);
            }
          }
          const tooClose = cellS ? cellS.part.splash > 0 && d < 22 : g.role === Role.Artillery && d < ARTILLERY_MIN_RANGE;
          if (tooClose && (this.tick + i) % 10 === 5) utgt[i] = -1; // look for something farther away
          if (d <= range + tr && !tooClose && ucd[i] <= 0 && g.morphT <= 0 && g.novaT <= 0) {
            this.fire(i, g, t, tx, ty);
          }
        }
      } else if (t !== -1) {
        utgt[i] = -1;
      }

      // ---- dash ramming
      if (g.dashT > 0 && g.enemyNear && (this.tick + i) % 3 === 0) {
        const ram = (g.role === Role.Striker ? DASH.strikerRam : DASH.ramDamage) * (1 + 0.2 * team.levels.damage);
        grid.query(x, y, 10, (j) => {
          if (ualive[j] && uteam[j] !== g.team) {
            this.damageUnit(j, ram * COUNTER[this.roleOf(i)][this.roleOf(j)], g.team);
            uvx[j] += uvx[i] * 0.4;
            uvy[j] += uvy[i] * 0.4;
            this.events.push({ t: 'melee', x: ux[j], y: uy[j], team: g.team });
            return true;
          }
        });
      }

      // ---- separation (inline grid walk; each unit refreshes every other tick). Bonded cells skip it.
      let sx = cellS ? 0 : sepX[i], sy = cellS ? 0 : sepY[i];
      if (!cellS && ((i + this.tick) & 1) === 0) {
      sx = 0; sy = 0;
      let cx0 = ((x - sep) / cell) | 0, cx1 = ((x + sep) / cell) | 0;
      let cy0 = ((y - sep) / cell) | 0, cy1 = ((y + sep) / cell) | 0;
      if (cx0 < 0) cx0 = 0;
      if (cy0 < 0) cy0 = 0;
      if (cx1 >= cols) cx1 = cols - 1;
      if (cy1 >= rows) cy1 = rows - 1;
      let seen = 0;
      for (let cy = cy0; cy <= cy1 && seen < 14; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = cy * cols + cx;
          for (let k = cs[c], e = cs[c + 1]; k < e; k++) {
            const j = items[k];
            if (j === i) continue;
            const ddx = x - ux[j], ddy = y - uy[j];
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < sep2 && d2 > 1e-4) {
              const d = Math.sqrt(d2);
              const f = (sep - d) / sep;
              // Enemies shove harder than friends.
              const w = uteam[j] === uteam[i] ? 1 : 2.2;
              sx += (ddx / d) * f * w;
              sy += (ddy / d) * f * w;
              seen++;
            }
          }
        }
      }
      sepX[i] = sx; sepY[i] = sy;
      }
      dvx += sx * 160;
      dvy += sy * 160;

      // Ships are solid.
      if (g.enemyNear) {
        for (let k = 0; k < ships.length; k++) {
          const s = ships[k];
          if (!s.alive) continue;
          const rr = SHIPS[s.type].radius + 4;
          const ddx = x - s.x, ddy = y - s.y;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 < rr * rr && d2 > 1e-4) {
            const d = Math.sqrt(d2);
            dvx += (ddx / d) * (rr - d) * 30;
            dvy += (ddy / d) * (rr - d) * 30;
          }
        }
      }

      if (cellS) {
        // Bonded cells: tight spring, a hint of tremor.
        const w = time * (1.3 + seed) + seed * 40;
        dvx += Math.cos(w) * 2;
        dvy += Math.sin(w * 1.3) * 2;
      } else {
        // ---- murmuration: a drifting flow field, an idle swirl and alignment with the flock.
        const calm = g.order.type === 'idle' || g.order.type === 'replicate' || g.order.type === 'research';
        const fa = Math.sin(x * 0.011 + time * 0.35 + g.id) + Math.cos(y * 0.013 - time * 0.29) + Math.sin((x - y) * 0.006 + time * 0.17 + seed * 2);
        const flow = (calm ? 52 : 26) * (0.6 + seed * 0.7);
        dvx += Math.cos(fa * 2.1) * flow;
        dvy += Math.sin(fa * 2.1) * flow;
        if (calm && !g.enemyNear && !g.harvesting && g.formation === Formation.Swarm) {
          // Slow rotation around the swarm's heart; alternate direction per swarm.
          const rx = x - g.cx, ry = y - g.cy;
          const rd = Math.sqrt(rx * rx + ry * ry) || 1;
          const spin = (g.id & 1 ? 1 : -1) * (14 + 22 * seed) * Math.min(1, rd / (g.radius * 0.5 + 1));
          dvx += (-ry / rd) * spin;
          dvy += (rx / rd) * spin;
        }
        dvx += (g.vx - uvx[i]) * 0.25;
        dvy += (g.vy - uvy[i]) * 0.25;
      }

      // Clamp desired speed, then steer with a limited turn/acceleration budget so paths curve.
      const dl = Math.sqrt(dvx * dvx + dvy * dvy);
      const lim = maxSp * 1.15;
      if (dl > lim) { dvx *= lim / dl; dvy *= lim / dl; }
      if (cellS) {
        const acc = g.dashT > 0 ? 10 : 9;
        uvx[i] += (dvx - uvx[i]) * Math.min(1, acc * DT);
        uvy[i] += (dvy - uvy[i]) * Math.min(1, acc * DT);
      } else {
        let sx2 = dvx - uvx[i], sy2 = dvy - uvy[i];
        const sl = Math.sqrt(sx2 * sx2 + sy2 * sy2);
        const maxAcc = (g.dashT > 0 ? 3200 : 700 + maxSp * 3.2) * DT;
        if (sl > maxAcc) { sx2 *= maxAcc / sl; sy2 *= maxAcc / sl; }
        uvx[i] += sx2;
        uvy[i] += sy2;
      }
      let nx = x + uvx[i] * DT, ny = y + uvy[i] * DT;
      if (nx < 5) { nx = 5; uvx[i] = Math.abs(uvx[i]); }
      if (ny < 5) { ny = 5; uvy[i] = Math.abs(uvy[i]); }
      if (nx > this.size - 5) { nx = this.size - 5; uvx[i] = -Math.abs(uvx[i]); }
      if (ny > this.size - 5) { ny = this.size - 5; uvy[i] = -Math.abs(uvy[i]); }
      ux[i] = nx;
      uy[i] = ny;
    }
  }

  private targetValid(i: number, t: number, maxRange: number): boolean {
    let tx: number, ty: number;
    if (t >= 0) {
      if (!this.ualive[t] || this.uteam[t] === this.uteam[i]) return false;
      tx = this.ux[t]; ty = this.uy[t];
    } else {
      const s = this.ships[-t - 2];
      if (!s?.alive) return false;
      tx = s.x; ty = s.y;
      maxRange += SHIPS[s.type].radius;
    }
    const dx = tx - this.ux[i], dy = ty - this.uy[i];
    return dx * dx + dy * dy < maxRange * maxRange;
  }

  /** Nearest enemy unit or ship within r. Returns -1, a unit index, or -(ship+2). */
  private acquire(i: number, r: number): number {
    const x = this.ux[i], y = this.uy[i], team = this.uteam[i];
    let best = -1, bestD = r * r;
    const grid = this.grid;
    const cell = grid.cell, cols = grid.cols, rows = grid.rows;
    const cs = grid.cellStart, items = grid.items;
    // Walk rings outward from the unit's cell so we can stop early.
    const ccx = (x / cell) | 0, ccy = (y / cell) | 0;
    const maxRing = Math.ceil(r / cell);
    for (let ring = 0; ring <= maxRing; ring++) {
      const ringMin = (ring - 1) * cell;
      if (best !== -1 && ringMin > 0 && ringMin * ringMin > bestD) break;
      for (let cy = ccy - ring; cy <= ccy + ring; cy++) {
        if (cy < 0 || cy >= rows) continue;
        const edgeRow = cy === ccy - ring || cy === ccy + ring;
        for (let cx = ccx - ring; cx <= ccx + ring; cx += edgeRow ? 1 : 2 * ring || 1) {
          if (cx < 0 || cx >= cols) continue;
          const c = cy * cols + cx;
          for (let k = cs[c], e = cs[c + 1]; k < e; k++) {
            const j = items[k];
            if (this.uteam[j] === team || !this.ualive[j]) continue;
            const dx = this.ux[j] - x, dy = this.uy[j] - y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD) { bestD = d2; best = j; }
          }
        }
      }
    }
    for (let k = 0; k < this.ships.length; k++) {
      const s = this.ships[k];
      if (!s.alive) continue;
      const rr = SHIPS[s.type].radius;
      const dx = s.x - x, dy = s.y - y;
      const d = Math.max(0, Math.hypot(dx, dy) - rr);
      if (d * d < bestD) { bestD = d * d; best = -k - 2; }
    }
    return best;
  }

  private fire(i: number, g: Group, t: number, tx: number, ty: number): void {
    if (g.cells && this.uslot[i] >= 0) return this.fireCell(i, g, g.cells[this.uslot[i]], t, tx, ty);
    const role = ROLES[g.role];
    const team = this.teams[g.team];
    this.ucd[i] = role.cooldown * (0.85 + this.rng.next() * 0.3);
    const dmg = role.damage * FORMATIONS[g.formation].damage * (1 + 0.2 * team.levels.damage);
    g.combatT = 0;
    if (g.role === Role.Artillery) {
      const d = Math.hypot(tx - this.ux[i], ty - this.uy[i]);
      this.shells.push({
        x0: this.ux[i], y0: this.uy[i], x1: tx + this.rng.range(-8, 8), y1: ty + this.rng.range(-8, 8),
        t: 0, dur: 0.35 + d / 420, dmg, splash: role.splash, team: g.team, big: false, hits: ARTILLERY_HITS, role: g.role,
      });
      this.events.push({ t: 'shellFire', x: this.ux[i], y: this.uy[i], team: g.team });
      // Recoil.
      this.uvx[i] -= ((tx - this.ux[i]) / (d || 1)) * 60;
      this.uvy[i] -= ((ty - this.uy[i]) / (d || 1)) * 60;
      return;
    }
    if (t >= 0) this.damageUnit(t, dmg * COUNTER[g.role][this.roleOf(t)], g.team);
    else {
      const s = this.ships[-t - 2];
      this.damageShip(s, dmg, g.team);
      if (this.rng.next() < 0.3) this.events.push({ t: 'hitShip', x: tx, y: ty, team: g.team });
    }
    if (g.role === Role.Striker) this.events.push({ t: 'melee', x: tx, y: ty, team: g.team });
    else this.events.push({ t: 'tracer', x: this.ux[i], y: this.uy[i], x2: tx, y2: ty, team: g.team });
  }

  private fireCell(i: number, g: Group, c: CellStat, t: number, tx: number, ty: number): void {
    this.ucd[i] = c.cooldown * (0.85 + this.rng.next() * 0.3);
    g.combatT = 0;
    const counter = c.part.counter;
    if (c.part.splash > 0) {
      const d = Math.hypot(tx - this.ux[i], ty - this.uy[i]);
      this.shells.push({
        x0: this.ux[i], y0: this.uy[i], x1: tx + this.rng.range(-6, 6), y1: ty + this.rng.range(-6, 6),
        t: 0, dur: 0.35 + d / 420, dmg: c.damage, splash: c.part.splash, team: g.team, big: false, hits: ARTILLERY_HITS + 1, role: counter,
      });
      this.events.push({ t: 'shellFire', x: this.ux[i], y: this.uy[i], team: g.team });
      this.uvx[i] -= ((tx - this.ux[i]) / (d || 1)) * 40;
      this.uvy[i] -= ((ty - this.uy[i]) / (d || 1)) * 40;
      return;
    }
    if (t >= 0) this.damageUnit(t, c.damage * COUNTER[counter][this.roleOf(t)], g.team);
    else {
      this.damageShip(this.ships[-t - 2], c.damage, g.team);
      if (this.rng.next() < 0.3) this.events.push({ t: 'hitShip', x: tx, y: ty, team: g.team });
    }
    if (c.part.range < 40) this.events.push({ t: 'melee', x: tx, y: ty, team: g.team });
    else this.events.push({ t: 'tracer', x: this.ux[i], y: this.uy[i], x2: tx, y2: ty, team: g.team, r: c.part.id === 'lance' ? 2 : undefined });
  }

  private updateProjectiles(): void {
    for (const s of this.shells) {
      s.t += DT;
      if (s.t >= s.dur) {
        this.splash(s.x1, s.y1, s.splash, s.dmg, s.team, 0.5, s.hits, s.role);
        this.events.push({ t: 'explode', x: s.x1, y: s.y1, r: s.splash, team: s.team });
      }
    }
    this.shells = this.shells.filter((s) => s.t < s.dur);
    for (const b of this.bombs) {
      b.t += DT;
      if (b.t >= b.fuse) {
        this.splash(b.x, b.y, b.r, b.dmg, SHIP_TEAM, 0.6);
        this.events.push({ t: 'explode', x: b.x, y: b.y, r: b.r, team: SHIP_TEAM, n: 1 });
        this.pools.push({ x: b.x, y: b.y, r: b.r * 0.85, t: 0, dur: 5, dps: 7 });
      }
    }
    this.bombs = this.bombs.filter((b) => b.t < b.fuse);
    for (const p of this.pools) {
      p.t += DT;
      if (this.tick % 15 === 0) this.splash(p.x, p.y, p.r * (1 - p.t / p.dur * 0.3), p.dps * 0.25, SHIP_TEAM, 1);
    }
    this.pools = this.pools.filter((p) => p.t < p.dur);
  }

  private reap(): void {
    for (let i = 0; i < this.hi; i++) {
      if (this.ualive[i] && this.uhp[i] <= 0) {
        this.events.push({ t: 'death', x: this.ux[i], y: this.uy[i], x2: this.uvx[i], y2: this.uvy[i], team: this.uteam[i] });
        this.killUnit(i);
      }
    }
    while (this.hi > 0 && !this.ualive[this.hi - 1]) {
      this.hi--;
      const k = this.free.indexOf(this.hi);
      if (k >= 0) this.free.splice(k, 1);
    }
    for (const g of this.groups) {
      if (g.alive && g.count <= 0) {
        g.alive = false;
        if (g.peak >= 25) this.events.push({ t: 'groupLost', x: g.cx, y: g.cy, team: g.team, n: g.peak });
      }
    }
    if (this.tick % 120 === 0) {
      this.rocks = this.rocks.filter((r) => r.alive || this.groups.some((g) => g.alive && g.order.rock === r.id));
      this.reindexRocks();
      this.ships = this.ships.filter((s) => s.alive || this.groups.some((g) => g.alive && g.order.ship === s.id));
      this.reindexShips();
    }
  }

  private reindexRocks(): void {
    const map = new Map<number, number>();
    this.rocks.forEach((r, i) => { map.set(r.id, i); r.id = i; });
    for (const g of this.groups) {
      if (g.alive && g.order.rock >= 0) g.order.rock = map.get(g.order.rock) ?? -1;
      if (g.alive && g.order.type === 'harvest' && g.order.rock < 0) g.order.type = 'idle';
    }
  }

  private reindexShips(): void {
    const map = new Map<number, number>();
    this.ships.forEach((s, i) => { map.set(s.id, i); s.id = i; });
    for (const g of this.groups) {
      if (g.alive && g.order.ship >= 0) g.order.ship = map.get(g.order.ship) ?? -1;
      if (g.alive && g.order.type === 'attack' && g.order.ship < 0 && g.order.group < 0) g.order.type = 'idle';
    }
    // Unit targets referencing ships are re-acquired.
    for (let i = 0; i < this.hi; i++) if (this.utgt[i] < -1) this.utgt[i] = -1;
  }

  addShip(type: number, x: number, y: number): Ship {
    const st = SHIPS[type];
    const s: Ship = {
      id: this.ships.length, type, x, y, vx: 0, vy: 0, angle: Math.atan2(this.size / 2 - y, this.size / 2 - x),
      hp: st.hp, maxHp: st.hp, cd: 1 + this.rng.next(), tx: this.size / 2, ty: this.size / 2, think: 0,
      alive: true, flash: 0, seed: this.rng.next(),
    };
    this.ships.push(s);
    return s;
  }

  private checkEnd(): void {
    for (const t of this.teams) {
      if (t.alive && t.units <= 0 && this.tick > 2) {
        t.alive = false;
        this.events.push({ t: 'teamOut', x: t.homeX, y: t.homeY, team: t.id });
      }
    }
    if (this.winner >= 0) return;
    const player = this.teams[0];
    if (!player.alive) { this.winner = this.teams.find((t) => t.alive)?.id ?? 99; return; }
    if (this.teams.length > 1 && this.teams.every((t) => t.id === 0 || !t.alive)) this.winner = 0;
  }

  clampX(v: number): number {
    return Math.max(20, Math.min(this.size - 20, v));
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
}

export function rockRadius(mass: number): number {
  return 8 + Math.sqrt(Math.max(0, mass)) * 2.4;
}

/** Approximate outer radius of a formation of n units. */
export function formationRadius(n: number, f: Formation): number {
  const base = Math.sqrt(n) * UNIT_SPACING * 0.62 + 6;
  if (f === Formation.Ring) return base * 1.45 + 10;
  if (f === Formation.Line) return Math.max(base, Math.sqrt(n) * UNIT_SPACING * 1.4);
  if (f === Formation.Wedge) return base * 1.3;
  return base;
}

const out: [number, number] = [0, 0];

/**
 * Shape field: projects a unit's offset from the anchor onto the formation's
 * region. Units steer to the projected point and separation fills the shape,
 * so there are no slot assignments to reshuffle when units die or formations
 * change - transitions animate themselves.
 */
export function shapeProject(ox: number, oy: number, hx: number, hy: number, n: number, f: Formation, seed: number): [number, number] {
  // Local frame: u = forward along heading, v = lateral.
  let u = ox * hx + oy * hy;
  let v = -ox * hy + oy * hx;
  const area = n * UNIT_SPACING * UNIT_SPACING * 0.9;
  switch (f) {
    case Formation.Swarm: {
      const R = Math.sqrt(area / Math.PI) * (0.55 + seed * 0.5);
      const d = Math.hypot(u, v);
      if (d > R) { u *= R / d; v *= R / d; }
      // Mild pull inward keeps the cloud dense.
      u *= 0.9; v *= 0.9;
      break;
    }
    case Formation.Ring: {
      // Annulus with inner radius ~0.65 of outer, sized for the unit area.
      const ro = Math.sqrt(area / (Math.PI * (1 - 0.42))) + 12;
      const ri = ro * 0.65;
      const d = Math.hypot(u, v) || 0.001;
      const target = Math.max(ri, Math.min(ro, d));
      const want = d < ri ? ri + (ro - ri) * seed : target;
      u = (u / d) * want; v = (v / d) * want;
      break;
    }
    case Formation.Line: {
      const depth = Math.max(UNIT_SPACING * 1.5, Math.sqrt(n) * UNIT_SPACING * 0.28);
      const half = area / depth / 2;
      u = Math.max(-depth / 2, Math.min(depth / 2, u));
      v = Math.max(-half, Math.min(half, v));
      break;
    }
    case Formation.Wedge: {
      // Chevron: u ≈ tip - slope*|v|, with thickness.
      const span = Math.sqrt(area) * 1.1;
      const slope = 0.75;
      const thick = Math.max(UNIT_SPACING * 2, area / (span * 2.4));
      const tip = span * 0.45;
      v = Math.max(-span, Math.min(span, v));
      const front = tip - slope * Math.abs(v);
      u = Math.max(front - thick, Math.min(front, u));
      break;
    }
  }
  out[0] = u * hx - v * hy;
  out[1] = u * hy + v * hx;
  return out;
}
