import { DT, NOVA, ROLES, Role, SHIELD, SHIPS, SHIP_COLOR } from '../sim/config';
import type { World } from '../sim/world';
import { Bounds, Fx, teamColor } from './fx';
import { Shape, SpriteBatch } from './renderer';
import { TRAIL_LEN, Trails } from './trails';

export interface SceneState {
  selected: Set<number>;
  hoverGroup: number;
  hoverRock: number;
  hoverShip: number;
  alpha: number; // interpolation between sim ticks
  time: number;
  zoom: number; // device px per world unit
  trails: Trails | null;
}

const trailPts = new Float32Array(TRAIL_LEN * 2);

export function buildScene(w: World, fx: Fx, view: Bounds, s: SceneState, under: SpriteBatch, solid: SpriteBatch, glow: SpriteBatch): void {
  under.clear();
  solid.clear();
  glow.clear();
  const minW = 1.25 / s.zoom; // keep every unit at least ~1px wide when zoomed out
  const m = 60;
  const vis = (x: number, y: number, r: number) => x + r > view.x0 - m && x - r < view.x1 + m && y + r > view.y0 - m && y - r < view.y1 + m;
  const t = s.time;

  // ---- hazards and ground decals
  for (const p of w.pools) {
    if (!vis(p.x, p.y, p.r)) continue;
    const f = p.t / p.dur;
    const a = Math.min(1, p.t * 4) * (1 - f * f);
    under.push(p.x, p.y, p.r, 0, p.r, Shape.Pool, 0.9, 0.3, 0.9, a * 0.7, p.x * 0.01);
  }
  for (const b of w.bombs) {
    if (!vis(b.x, b.y, b.r)) continue;
    const f = b.t / b.fuse;
    const blink = 0.5 + 0.5 * Math.sin(t * (10 + f * 30));
    under.push(b.x, b.y, b.r, 0, b.r, Shape.Disk, 1, 0.15, 0.1, 0.12 + f * 0.25);
    under.push(b.x, b.y, b.r, 0, b.r, Shape.Ring, 1, 0.3, 0.2, 0.4 + blink * 0.5, 0.04);
    under.push(b.x, b.y, b.r * (1 - f), 0, b.r * (1 - f), Shape.Ring, 1, 0.5, 0.3, 0.6, 0.06);
    glow.push(b.x, b.y, 0, 0, 6, Shape.Glow, 1, 0.4 * blink, 0.2, 1);
  }

  // ---- group auras (under the units)
  for (const g of w.groups) {
    if (!g.alive || !vis(g.cx, g.cy, g.radius + 80)) continue;
    const c = teamColor(g.team);
    const R = g.radius + 14;
    if (g.order.type === 'replicate') {
      const pulse = 0.5 + 0.5 * Math.sin(t * 3 + g.id);
      // A soft breathing glow: the swarm is incubating.
      under.push(g.cx, g.cy, R * 1.2, 0, R * 1.2, Shape.Disk, c[0], c[1], c[2], 0.04 + pulse * 0.05);
    }
    if (g.shieldT > 0) {
      const f = Math.min(1, g.shieldT * 3, (SHIELD.duration - g.shieldT) * 6);
      glow.push(g.cx, g.cy, R + 6, 0, R + 6, Shape.Shield, 0.55, 0.85, 1, 0.8 * f);
    }
    if (g.novaT > 0) {
      const f = 1 - g.novaT / NOVA.charge;
      glow.push(g.cx, g.cy, 0, 0, R * (0.6 + f * 0.6), Shape.Disk, c[0], c[1], c[2], 0.3 + f * 0.6);
    }
  }

  // ---- construct bonds: faint struts between touching cells make each construct read as one body
  for (const g of w.groups) {
    if (!g.alive || !g.cells || !vis(g.cx, g.cy, g.radius + 40)) continue;
    const c = teamColor(g.team);
    const slots = g.slotUnit!;
    for (let k = 0; k < g.cells.length; k++) {
      const a = slots[k];
      if (a < 0) continue;
      for (const n of g.cells[k].neighbors) {
        if (n <= k) continue;
        const b = slots[n];
        if (b < 0) continue;
        const ax = w.ux[a], ay = w.uy[a], bx = w.ux[b], by = w.uy[b];
        under.push((ax + bx) / 2, (ay + by) / 2, (bx - ax) / 2, (by - ay) / 2, 1.1, Shape.Glow, c[0], c[1], c[2], 0.28);
      }
    }
  }

  // ---- rocks
  for (const r of w.rocks) {
    if (!r.alive || !vis(r.x, r.y, r.r * 1.2)) continue;
    let vein: [number, number, number] = r.wreck ? [1, 0.6, 0.25] : [0.45, 0.75, 1];
    let veinA = 0.35 + 0.65 * (r.mass / r.maxMass);
    for (const g of w.groups) {
      if (g.alive && g.harvesting && g.order.rock === r.id) {
        vein = teamColor(g.team);
        veinA = 1.2 + 0.4 * Math.sin(t * 6);
        break;
      }
    }
    const rr = r.r * 1.15;
    solid.push(r.x, r.y, rr, 0, rr, Shape.Rock, vein[0], vein[1], vein[2], veinA, r.seed, r.wreck ? 1 : 0);
    if (s.hoverRock === r.id) glow.push(r.x, r.y, rr + 10, 0, rr + 10, Shape.Ring, 1, 1, 1, 0.45, 0.04);
  }

  // ---- ships
  for (const sh of w.ships) {
    if (!sh.alive) continue;
    const st = SHIPS[sh.type];
    if (!vis(sh.x, sh.y, st.radius * 2)) continue;
    const L = st.radius * 1.15;
    const ca = Math.cos(sh.angle), sa = Math.sin(sh.angle);
    const x = sh.x + sh.vx * s.alpha * DT, y = sh.y + sh.vy * s.alpha * DT;
    solid.push(x, y, ca * L, sa * L, st.radius, Shape.Ship, SHIP_COLOR[0], SHIP_COLOR[1], SHIP_COLOR[2], 1, sh.type, sh.flash);
    // Engine plume.
    glow.push(x - ca * L * 0.95, y - sa * L * 0.95, -ca * st.radius * 0.6, -sa * st.radius * 0.6, st.radius * 0.28, Shape.Glow, 1, 0.55, 0.2, 0.8);
    if (s.hoverShip === sh.id) glow.push(x, y, st.radius * 1.6, 0, st.radius * 1.6, Shape.Ring, 1, 0.4, 0.3, 0.7, 0.05);
  }

  // ---- units
  const { ux, uy, uvx, uvy, ualive, ugroup, uflash, uteam } = w;
  const al = s.alpha;
  const { upx, upy } = w;
  const pulse = 0.5 + 0.5 * Math.sin(t * 20);
  let trailBudget = 36000;
  for (let i = 0; i < w.hi; i++) {
    if (!ualive[i]) continue;
    // Interpolate between the last two sim ticks: smooth at any frame rate.
    const x = upx[i] + (ux[i] - upx[i]) * al, y = upy[i] + (uy[i] - upy[i]) * al;
    if (x < view.x0 - m || x > view.x1 + m || y < view.y0 - m || y > view.y1 + m) continue;
    const g = w.groups[ugroup[i]];
    const role = ROLES[g.role];
    let [r, gg, b] = teamColor(uteam[i]);
    let size = 2.6 * role.size;
    let streak = 0.045;
    const slot = w.uslot[i];
    if (g.cells && slot >= 0) {
      // Construct cell: part tint, size and glyph; barely any motion streak since it's bonded.
      const part = g.cells[slot].part;
      r = r * 0.55 + part.tint[0] * 0.45; gg = gg * 0.55 + part.tint[1] * 0.45; b = b * 0.55 + part.tint[2] * 0.45;
      const f0 = uflash[i];
      if (f0 > 0) { r += (1 - r) * f0; gg += (1 - gg) * f0; b += (1 - b) * f0; }
      const wdt = Math.max(minW, 3.2 * part.size);
      const sx = part.id === 'spike' ? g.hx * 5 : uvx[i] * 0.015, sy = part.id === 'spike' ? g.hy * 5 : uvy[i] * 0.015;
      glow.push(x, y, sx, sy, wdt, Shape.Glow, r, gg, b, 0.95 + f0 * 0.5, wdt * s.zoom > 2.5 ? part.glyph : 0);
      continue;
    }
    streak = 0.02;
    if (g.role === Role.Striker) { streak = 0.05; size *= 0.75; }
    else if (g.role === Role.Artillery) { r = r * 0.6 + 0.4; gg = gg * 0.6 + 0.4; b = b * 0.6 + 0.4; }
    else if (g.role === Role.Harvester) { size *= 0.9; }
    if (g.morphT > 0) {
      const k = pulse * 0.6;
      r += (1 - r) * k; gg += (1 - gg) * k; b += (1 - b) * k;
    }
    const sel = s.selected.has(g.id);
    if (sel) { r += (1 - r) * 0.28; gg += (1 - gg) * 0.28; b += (1 - b) * 0.28; size *= 1.12; }
    const f = uflash[i];
    if (f > 0) { r += (1 - r) * f; gg += (1 - gg) * f; b += (1 - b) * f; }
    const wdt = Math.max(minW, size);
    // Curved, fading trail from recent positions.
    if (s.trails && trailBudget > 0 && wdt * s.zoom > 1.4) {
      const n = s.trails.points(i, trailPts);
      let px = x, py = y;
      for (let k = 0; k < n; k++) {
        const qx = trailPts[k * 2], qy = trailPts[k * 2 + 1];
        const dx = qx - px, dy = qy - py;
        if (dx * dx + dy * dy > 0.5) {
          const fade = 1 - (k + 1) / (TRAIL_LEN + 1);
          glow.push((px + qx) / 2, (py + qy) / 2, dx / 2, dy / 2, Math.max(minW * 0.6, wdt * (0.25 + 0.45 * fade)), Shape.Glow, r, gg, b, (sel ? 0.42 : 0.3) * fade * fade);
          trailBudget--;
        }
        px = qx; py = qy;
      }
    }
    glow.push(x, y, uvx[i] * streak, uvy[i] * streak, wdt, Shape.Glow, r, gg, b, 0.85 + f * 0.5, wdt * s.zoom > 3 ? g.role : 0);
  }

  // ---- shells
  for (const sh of w.shells) {
    const f = sh.t / sh.dur;
    const x = sh.x0 + (sh.x1 - sh.x0) * f, y = sh.y0 + (sh.y1 - sh.y0) * f;
    if (!vis(x, y, 20)) continue;
    const arc = Math.sin(f * Math.PI);
    const c = sh.big ? [1, 0.6, 0.25] : teamColor(sh.team);
    const dx = (sh.x1 - sh.x0) / sh.dur, dy = (sh.y1 - sh.y0) / sh.dur;
    const size = (sh.big ? 5 : 3) * (1 + arc * 0.8);
    // Shadow on the ground, shell lifted "up" toward the screen top.
    glow.push(x, y - arc * 40, dx * 0.03, dy * 0.03, size, Shape.Glow, c[0], c[1], c[2], 1);
    under.push(x, y, 0, 0, size * 1.2, Shape.Disk, 0.05, 0.05, 0.05, 0.3);
    if (f > 0.6) under.push(sh.x1, sh.y1, sh.splash, 0, sh.splash, Shape.Ring, c[0], c[1], c[2], (f - 0.6) * 0.8, 0.05);
  }

  fx.draw(glow, minW);
}
