import { DIFFICULTY, Formation, REPLICATE_MIN, Role, SHIPS } from './config';
import type { Group, Team, World } from './world';

interface AIState {
  next: number;
  researchIdx: number;
  personality: number; // 0..1: low = turtle/economic, high = aggressive
}

const states = new WeakMap<World, Map<number, AIState>>();

interface Threat {
  x: number;
  y: number;
  strength: number;
  group: number;
  ship: number;
  dist: number;
}

export function updateAI(w: World): void {
  let map = states.get(w);
  if (!map) {
    map = new Map();
    states.set(w, map);
  }
  const diff = DIFFICULTY[w.difficulty];
  for (const team of w.teams) {
    if (!team.ai || !team.alive) continue;
    let st = map.get(team.id);
    if (!st) {
      st = { next: 1 + team.id * 0.17, researchIdx: team.id, personality: w.rng.next() };
      map.set(team.id, st);
    }
    if (w.time < st.next) continue;
    st.next = w.time + (0.45 + w.rng.next() * 0.3) * diff.aiThink;
    think(w, team, st);
  }
}

function think(w: World, team: Team, st: AIState): void {
  const mine = w.groupsOf(team.id);
  if (!mine.length) return;
  const researching = mine.filter((g) => g.order.type === 'research').length;
  const armyThreshold = 260 - st.personality * 120;

  // The biggest group becomes the army once the economy is rolling.
  const sorted = [...mine].sort((a, b) => b.count - a.count);
  const army = w.time > DIFFICULTY[w.difficulty].aiArmyAt * (1.2 - st.personality * 0.4) && team.units > armyThreshold && sorted[0].count > armyThreshold * 0.55 ? sorted[0] : null;

  for (const g of mine) {
    if (!w.canAct(g)) continue;
    const threat = assessThreat(w, g);
    if (threat) {
      handleCombat(w, g, threat, mine);
      continue;
    }
    if (g === army) {
      handleArmy(w, g, team);
      continue;
    }
    const o = g.order;
    if (o.type === 'attack' && g.count > 30) continue;
    if (o.type === 'move' && Math.hypot(o.x - g.ax, o.y - g.ay) > 10) {
      tryMerge(w, g, mine);
      continue;
    }
    if (o.type === 'harvest' && w.rocks[o.rock]?.alive) {
      if (g.count > 90 && mine.length < 7) splitAndHarvest(w, g, mine);
      continue;
    }
    if (o.type === 'research' && researching <= 1 && g.count < 160) continue;
    if (o.type === 'replicate' && g.count < 140) continue;
    if (o.type === 'replicate' && g.count >= 140) {
      if (!splitAndHarvest(w, g, mine)) w.cmdMove([g.id], g.cx + (team.homeX - g.cx) * 0.2 + 1, g.cy);
      continue;
    }

    // Idle decision tree.
    if (g.count >= 40 && mine.length < 2 + Math.floor(team.units / 120) && splitAndHarvest(w, g, mine)) continue;
    const rock = freeRock(w, g, 1600);
    if (rock >= 0 && (g.count < 60 || w.rng.next() < 0.4)) {
      if (g.count < 40 && g.role !== Role.Harvester && w.rng.next() < 0.5) w.cmdMorph([g.id], Role.Harvester);
      w.cmdHarvest([g.id], rock);
      continue;
    }
    if (g.count >= REPLICATE_MIN) {
      if (researching === 0 && team.units > 140) w.cmdResearch([g.id]);
      else w.cmdReplicate([g.id]);
      continue;
    }
    tryMerge(w, g, mine);
  }
}

function assessThreat(w: World, g: Group): Threat | null {
  const sense = 420 + g.radius;
  let nearest: Threat | null = null;
  let strength = 0;
  for (const o of w.groups) {
    if (!o.alive || o.team === g.team || o.count <= 0) continue;
    const d = Math.hypot(o.cx - g.cx, o.cy - g.cy) - o.radius;
    if (d > sense) continue;
    strength += o.count * (o.role === Role.Tank ? 1.6 : 1);
    if (!nearest || d < nearest.dist) nearest = { x: o.cx, y: o.cy, strength: 0, group: o.id, ship: -1, dist: d };
  }
  for (const s of w.ships) {
    if (!s.alive) continue;
    const d = Math.hypot(s.x - g.cx, s.y - g.cy) - SHIPS[s.type].radius;
    if (d > sense) continue;
    strength += s.hp / 9;
    if (!nearest || d < nearest.dist) nearest = { x: s.x, y: s.y, strength: 0, group: -1, ship: s.id, dist: d };
  }
  if (nearest) nearest.strength = strength;
  return nearest;
}

function handleCombat(w: World, g: Group, t: Threat, mine: Group[]): void {
  const power = g.count * (g.role === Role.Tank ? 1.6 : 1) * (g.shieldT > 0 ? 2 : 1);
  if (power >= t.strength * 0.7 || g.count >= 120) {
    if (t.group >= 0 && (g.order.type !== 'attack' || g.order.group !== t.group)) w.cmdAttackGroup([g.id], t.group);
    else if (t.ship >= 0 && (g.order.type !== 'attack' || g.order.ship !== t.ship)) w.cmdAttackShip([g.id], t.ship);
    if (g.formation !== Formation.Wedge && g.count > 30 && g.role !== Role.Artillery) w.cmdFormation([g.id], Formation.Wedge);
    // Abilities.
    if (g.recentLoss > Math.max(3, g.count * 0.06)) w.cmdShield([g.id]);
    if (t.dist > 120 && t.dist < 380 && w.rng.next() < 0.35) w.cmdDash([g.id], t.x, t.y);
    if (g.count >= 40 && t.dist < 90 && t.strength > 20 && w.rng.next() < 0.25) w.cmdNova([g.id]);
    return;
  }
  // Retreat toward the strongest friendly group, or home.
  let refuge: Group | null = null;
  for (const o of mine) {
    if (o === g) continue;
    if (!refuge || o.count > refuge.count) refuge = o;
  }
  const team = w.teams[g.team];
  const rx = refuge ? refuge.cx : team.homeX;
  const ry = refuge ? refuge.cy : team.homeY;
  if (g.formation !== Formation.Ring) w.cmdFormation([g.id], Formation.Ring);
  if (g.recentLoss > 2) w.cmdShield([g.id]);
  if (refuge && Math.hypot(refuge.cx - g.cx, refuge.cy - g.cy) < refuge.radius + g.radius + 40) {
    w.cmdMerge([refuge.id, g.id]);
    return;
  }
  // Dash away when caught.
  if (t.dist < 60 && w.rng.next() < 0.4) w.cmdDash([g.id], g.cx * 2 - t.x, g.cy * 2 - t.y);
  else w.cmdMove([g.id], rx, ry);
}

function handleArmy(w: World, g: Group, team: Team): void {
  if (g.order.type === 'attack') return;
  // Pick the weakest-looking enemy group within striking distance, preferring big juicy targets we can beat.
  let best: Group | null = null;
  let bestScore = -Infinity;
  for (const o of w.groups) {
    if (!o.alive || o.team === g.team || o.count <= 0) continue;
    if (o.count > g.count * 1.25) continue;
    const d = Math.hypot(o.cx - g.cx, o.cy - g.cy);
    const score = o.count * 1.5 - d * 0.05 + (o.order.type === 'replicate' || o.order.type === 'harvest' ? 40 : 0);
    if (score > bestScore) { bestScore = score; best = o; }
  }
  if (!best) {
    if (g.order.type !== 'replicate') w.cmdReplicate([g.id]);
    return;
  }
  if (g.role === Role.Drone || g.role === Role.Harvester) {
    const roll = w.rng.next();
    w.cmdMorph([g.id], roll < 0.45 ? Role.Striker : roll < 0.7 ? Role.Artillery : roll < 0.85 ? Role.Tank : Role.Drone);
    return;
  }
  w.cmdFormation([g.id], g.role === Role.Artillery ? Formation.Line : Formation.Wedge);
  w.cmdAttackGroup([g.id], best.id);
  void team;
}

function splitAndHarvest(w: World, g: Group, mine: Group[]): boolean {
  const rock = freeRock(w, g, 2400);
  if (rock < 0 || g.count < 30) return false;
  const r = w.rocks[rock];
  const id = w.cmdSplit(g.id, r.x - g.cx, r.y - g.cy);
  if (id < 0) return false;
  w.cmdHarvest([id], rock);
  if (w.rng.next() < 0.5) w.cmdMorph([id], Role.Harvester);
  mine.push(w.groups[id]);
  return true;
}

/** Nearest rock nobody on our team is harvesting and no enemy is camping. */
function freeRock(w: World, g: Group, maxDist: number): number {
  let best = -1, bestD = maxDist;
  for (const r of w.rocks) {
    if (!r.alive || r.mass < 20) continue;
    const d = Math.hypot(r.x - g.cx, r.y - g.cy);
    if (d >= bestD) continue;
    let taken = false;
    for (const o of w.groups) {
      if (!o.alive) continue;
      if (o.team === g.team && o.order.type === 'harvest' && o.order.rock === r.id) { taken = true; break; }
      if (o.team !== g.team && o.count > g.count * 0.5 && Math.hypot(o.cx - r.x, o.cy - r.y) < r.r + o.radius + 200) { taken = true; break; }
    }
    if (!taken) { bestD = d; best = r.id; }
  }
  return best;
}

function tryMerge(w: World, g: Group, mine: Group[]): void {
  let best: Group | null = null, bestD = 1e9;
  for (const o of mine) {
    if (o === g || !o.alive) continue;
    const d = Math.hypot(o.cx - g.cx, o.cy - g.cy);
    if (d < bestD) { bestD = d; best = o; }
  }
  if (!best) return;
  if (bestD < best.radius + g.radius + 30) w.cmdMerge([best.id, g.id]);
  else if (g.count < REPLICATE_MIN) w.cmdMove([g.id], best.cx, best.cy);
}
