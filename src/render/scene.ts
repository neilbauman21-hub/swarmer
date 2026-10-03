import { DT, NOVA, ROLES, Role, SHIELD, SHIPS, SHIP_COLOR } from '../sim/config';
import type { World } from '../sim/world';
import { Bounds, Fx, teamColor } from './fx';
import { Shape, SpriteBatch } from './renderer';

export interface SceneState {
  selected: Set<number>;
  hoverGroup: number;
  hoverRock: number;
  hoverShip: number;
  alpha: number; // interpolation between sim ticks
  time: number;
  zoom: number; // device px per world unit
}

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
      under.push(g.cx, g.cy, R * 1.3, 0, R * 1.3, Shape.Disk, c[0], c[1], c[2], 0.06 + pulse * 0.06);
      under.push(g.cx, g.cy, R * (1 + pulse * 0.25), 0, R * (1 + pulse * 0.25), Shape.Ring, c[0], c[1], c[2], 0.25 * (1 - pulse), 0.04);
    } else if (g.order.type === 'research') {
      const a = t * 1.5 + g.id;
      for (let k = 0; k < 3; k++) {
        const aa = a + (k * Math.PI * 2) / 3;
        glow.push(g.cx + Math.cos(aa) * R, g.cy + Math.sin(aa) * R, -Math.sin(aa) * 10, Math.cos(aa) * 10, 3, Shape.Glow, 0.7, 0.9, 1, 0.9);
      }
      under.push(g.cx, g.cy, R, 0, R, Shape.Ring, 0.6, 0.85, 1, 0.25, 0.03);
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
  const al = s.alpha * DT;
  const pulse = 0.5 + 0.5 * Math.sin(t * 20);
  for (let i = 0; i < w.hi; i++) {
    if (!ualive[i]) continue;
    const x = ux[i] + uvx[i] * al, y = uy[i] + uvy[i] * al;
    if (x < view.x0 - m || x > view.x1 + m || y < view.y0 - m || y > view.y1 + m) continue;
    const g = w.groups[ugroup[i]];
    const role = ROLES[g.role];
    let [r, gg, b] = teamColor(uteam[i]);
    let size = 2.6 * role.size;
    let streak = 0.045;
    if (g.role === Role.Striker) { streak = 0.1; size *= 0.75; }
    else if (g.role === Role.Artillery) { r = r * 0.6 + 0.4; gg = gg * 0.6 + 0.4; b = b * 0.6 + 0.4; }
    else if (g.role === Role.Harvester) { size *= 0.9; }
    if (g.morphT > 0) {
      const k = pulse * 0.6;
      r += (1 - r) * k; gg += (1 - gg) * k; b += (1 - b) * k;
    }
    const f = uflash[i];
    if (f > 0) { r += (1 - r) * f; gg += (1 - gg) * f; b += (1 - b) * f; }
    const wdt = Math.max(minW, size);
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

  // ---- selection & hover
  for (const id of s.selected) {
    const g = w.groups[id];
    if (!g?.alive) continue;
    const c = teamColor(g.team);
    const R = g.radius + 16;
    glow.push(g.cx, g.cy, R, 0, R, Shape.Ring, c[0], c[1], c[2], 0.55, 0.035);
    const o = g.order;
    if (o.type === 'move') {
      const p = 0.5 + 0.5 * Math.sin(t * 6);
      glow.push(o.x, o.y, 10 + p * 4, 0, 10 + p * 4, Shape.Ring, c[0], c[1], c[2], 0.7, 0.2);
    }
  }
  if (s.hoverGroup >= 0) {
    const g = w.groups[s.hoverGroup];
    if (g?.alive) {
      const c = teamColor(g.team);
      const R = g.radius + 20;
      glow.push(g.cx, g.cy, R, 0, R, Shape.Ring, c[0], c[1], c[2], 0.3, 0.025);
    }
  }

  fx.draw(glow, minW);
}
