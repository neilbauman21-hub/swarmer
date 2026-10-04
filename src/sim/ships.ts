import { hyp } from './math';
import { ARENA, DIFFICULTY, DT, SHIP_TEAM, SHIPS, ShipType } from './config';
import type { Ship, World } from './world';

/** Hostile raider ships: they hunt every swarm, including the AI rivals. */
export function updateShips(w: World): void {
  const ships = w.ships;
  for (const s of ships) {
    if (!s.alive) continue;
    const st = SHIPS[s.type];
    s.flash = Math.max(0, s.flash - DT * 5);
    s.cd -= DT;
    s.think -= DT;
    if (s.think <= 0) {
      s.think = 0.7 + s.seed * 0.4;
      pickTarget(w, s);
    }
    // Where to be relative to the target.
    const dx = s.tx - s.x, dy = s.ty - s.y;
    const d = hyp(dx, dy) || 1;
    let keep = 0;
    if (s.type === ShipType.Siege) keep = st.range * 0.85;
    else if (s.type === ShipType.Scout) keep = st.range * 0.6;
    else if (s.type === ShipType.Bulwark) keep = st.range * 0.4;
    let wx = 0, wy = 0;
    if (d > keep + 20) { wx = dx / d; wy = dy / d; }
    else if (d < keep * 0.7) { wx = -dx / d; wy = -dy / d; }
    if (s.type === ShipType.Scout || s.type === ShipType.Bomber) {
      // Strafing runs: orbit the target.
      const dir = s.seed > 0.5 ? 1 : -1;
      wx += (-dy / d) * 0.8 * dir;
      wy += (dx / d) * 0.8 * dir;
    }
    // Spread out from other ships.
    for (const o of ships) {
      if (o === s || !o.alive) continue;
      const ox = s.x - o.x, oy = s.y - o.y;
      const od = hyp(ox, oy);
      const min = st.radius + SHIPS[o.type].radius + 20;
      if (od < min && od > 0.01) { wx += (ox / od) * 1.5; wy += (oy / od) * 1.5; }
    }
    const wl = hyp(wx, wy);
    if (wl > 1) { wx /= wl; wy /= wl; }
    const k = Math.min(1, DT * 2);
    s.vx += (wx * st.speed - s.vx) * k;
    s.vy += (wy * st.speed - s.vy) * k;
    s.x = Math.max(30, Math.min(w.size - 30, s.x + s.vx * DT));
    s.y = Math.max(30, Math.min(w.size - 30, s.y + s.vy * DT));
    const sp = hyp(s.vx, s.vy);
    const face = s.type === ShipType.Siege && sp < st.speed * 0.4 ? Math.atan2(dy, dx) : Math.atan2(s.vy, s.vx);
    let da = face - s.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    s.angle += da * Math.min(1, DT * 3);

    if (s.cd > 0) continue;
    if (s.type === ShipType.Bomber) {
      if (d < 80 && hasEnemyNear(w, s.tx, s.ty, 90)) {
        s.cd = st.cooldown;
        w.bombs.push({ x: s.x, y: s.y, t: 0, fuse: 1.1, r: st.splash, dmg: st.damage });
        w.events.push({ t: 'bomb', x: s.x, y: s.y, r: st.splash });
      }
      continue;
    }
    const target = nearestUnit(w, s.x, s.y, st.range + 10);
    if (target < 0) continue;
    s.cd = st.cooldown * (0.85 + w.rng.next() * 0.3);
    const tx = w.ux[target], ty = w.uy[target];
    if (s.type === ShipType.Siege) {
      const dist = hyp(tx - s.x, ty - s.y);
      w.shells.push({ x0: s.x, y0: s.y, x1: tx, y1: ty, t: 0, dur: 0.6 + dist / 380, dmg: st.damage, splash: st.splash, team: SHIP_TEAM, big: true, hits: 14, role: -1 });
      w.events.push({ t: 'shellFire', x: s.x, y: s.y, team: SHIP_TEAM, r: 1 });
    } else if (s.type === ShipType.Bulwark) {
      w.splash(tx, ty, st.splash, st.damage, SHIP_TEAM, 0.7, 8);
      w.events.push({ t: 'tracer', x: s.x, y: s.y, x2: tx, y2: ty, team: SHIP_TEAM, r: 2 });
      w.events.push({ t: 'explode', x: tx, y: ty, r: st.splash * 0.7, team: SHIP_TEAM });
    } else {
      w.damageUnit(target, st.damage, SHIP_TEAM);
      w.events.push({ t: 'tracer', x: s.x, y: s.y, x2: tx, y2: ty, team: SHIP_TEAM });
    }
  }
}

function pickTarget(w: World, s: Ship): void {
  // Nearest swarm within sensor range, otherwise hunt the biggest swarm on the map.
  let best: { x: number; y: number } | null = null;
  let bestScore = Infinity;
  let biggest: { x: number; y: number; n: number } | null = null;
  for (const g of w.groups) {
    if (!g.alive || g.count <= 0) continue;
    const d = hyp(g.cx - s.x, g.cy - s.y);
    if (d < 1300 && d < bestScore) { bestScore = d; best = { x: g.cx, y: g.cy }; }
    if (!biggest || g.count > biggest.n) biggest = { x: g.cx, y: g.cy, n: g.count };
  }
  const t = best ?? biggest;
  if (t) { s.tx = t.x; s.ty = t.y; }
}

function hasEnemyNear(w: World, x: number, y: number, r: number): boolean {
  let found = false;
  w.grid.query(x, y, r, (i) => {
    if (w.ualive[i]) { found = true; return true; }
  });
  return found;
}

function nearestUnit(w: World, x: number, y: number, r: number): number {
  let best = -1, bestD = r * r;
  w.grid.query(x, y, r, (i) => {
    if (!w.ualive[i]) return;
    const dx = w.ux[i] - x, dy = w.uy[i] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD) { bestD = d2; best = i; }
  });
  return best;
}

const COST = [1, 2, 4, 3];
const UNLOCK = [0, 1, 3, 2];

export function updateWaves(w: World): void {
  if (w.time < w.nextWave) return;
  const scale = DIFFICULTY[w.difficulty].waveScale;
  // In the endless arena raids stop escalating, otherwise they would eventually wipe everything.
  const lvl = w.arena ? Math.min(w.waveNum, ARENA.waveCap) : w.waveNum;
  let budget = Math.round((2 + lvl * 1.7) * scale);
  w.nextWave = w.time + Math.max(38, 62 - lvl * 1.5);
  const side = w.rng.int(0, 3);
  const along = w.rng.range(0.2, 0.8) * w.size;
  const m = 60;
  const sx = side === 0 ? along : side === 1 ? w.size - m : side === 2 ? along : m;
  const sy = side === 0 ? m : side === 1 ? along : side === 2 ? w.size - m : along;
  let n = 0;
  const available = [0, 1, 2, 3].filter((t) => UNLOCK[t] <= lvl);
  while (budget > 0 && n < 24) {
    const affordable = available.filter((t) => COST[t] <= budget);
    if (!affordable.length) break;
    // Prefer heavier ships as waves grow.
    const type = w.rng.next() < 0.45 ? affordable[affordable.length - 1] : w.rng.pick(affordable);
    budget -= COST[type];
    w.addShip(type, sx + w.rng.range(-140, 140), sy + w.rng.range(-140, 140));
    n++;
  }
  w.waveNum++;
  w.events.push({ t: 'wave', x: sx, y: sy, n });
}
