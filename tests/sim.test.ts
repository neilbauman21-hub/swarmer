import { describe, expect, it } from 'vitest';
import { Formation, Role, TICK_HZ } from '../src/sim/config';
import { World, shapeProject } from '../src/sim/world';

function run(w: World, seconds: number) {
  for (let i = 0; i < seconds * TICK_HZ; i++) w.step();
}

describe('world', () => {
  it('starts every team with a swarm', () => {
    const w = new World({ seed: 1, rivals: 3 });
    w.step();
    expect(w.teams).toHaveLength(4);
    for (const t of w.teams) expect(t.units).toBe(60);
  });

  it('moves a group toward its order', () => {
    const w = new World({ seed: 2, rivals: 1, waves: false });
    const g = w.groupsOf(0)[0];
    const sx = g.cx, sy = g.cy;
    w.cmdMove([g.id], sx + 500, sy - 500);
    run(w, 6);
    expect(Math.hypot(g.cx - (sx + 500), g.cy - (sy - 500))).toBeLessThan(60);
  });

  it('replicates and harvests into new units', () => {
    const w = new World({ seed: 3, rivals: 1, waves: false });
    const g = w.groupsOf(0)[0];
    w.cmdReplicate([g.id]);
    run(w, 20);
    expect(w.teams[0].units).toBeGreaterThan(65);
    const rock = w.rocks.reduce((a, r) => (Math.hypot(r.x - g.cx, r.y - g.cy) < Math.hypot(a.x - g.cx, a.y - g.cy) ? r : a));
    const before = w.teams[0].units;
    w.cmdHarvest([g.id], rock.id);
    run(w, 15);
    expect(w.teams[0].units).toBeGreaterThan(before);
  });

  it('follows a drawn path through every waypoint', () => {
    const w = new World({ seed: 8, rivals: 1, waves: false });
    w.step();
    const g = w.groupsOf(0)[0];
    const pts = [g.cx + 400, g.cy, g.cx + 400, g.cy - 400, g.cx, g.cy - 400];
    w.cmdPath([g.id], pts);
    expect(g.path.length).toBe(4);
    let visitedCorner = false;
    for (let i = 0; i < 60 * 14; i++) {
      w.step();
      if (Math.hypot(g.cx - pts[2], g.cy - pts[3]) < 90) visitedCorner = true;
    }
    expect(visitedCorner).toBe(true);
    expect(Math.hypot(g.cx - pts[4], g.cy - pts[5])).toBeLessThan(60);
    w.cmdQueue([g.id], g.cx + 100, g.cy);
    expect(g.order.type).toBe('move');
  });

  it('splits and merges groups', () => {
    const w = new World({ seed: 4, rivals: 1, waves: false });
    w.step();
    const g = w.groupsOf(0)[0];
    const id = w.cmdSplit(g.id, 1, 0);
    w.step();
    expect(w.groups[id].count + g.count).toBe(60);
    expect(Math.abs(w.groups[id].count - g.count)).toBeLessThanOrEqual(1);
    const keep = w.cmdMerge([g.id, id]);
    w.step();
    expect(w.groups[keep].count).toBe(60);
  });

  it('fights: two swarms that meet lose units, and nothing goes NaN', () => {
    const w = new World({ seed: 5, rivals: 1, waves: false });
    w.step();
    const a = w.groupsOf(0)[0], b = w.groupsOf(1)[0];
    w.cmdAttackGroup([a.id], b.id);
    w.cmdAttackGroup([b.id], a.id);
    run(w, 40);
    expect(w.teams[0].lost + w.teams[1].lost).toBeGreaterThan(20);
    for (let i = 0; i < w.hi; i++) if (w.ualive[i]) expect(Number.isFinite(w.ux[i] + w.uy[i])).toBe(true);
  });

  it('abilities spend energy and morphing changes role', () => {
    const w = new World({ seed: 6, rivals: 1, waves: false });
    w.step();
    const g = w.groupsOf(0)[0];
    g.energy = 100;
    expect(w.cmdShield([g.id])).toBe(true);
    expect(g.energy).toBeLessThan(100);
    expect(w.cmdShield([g.id])).toBe(false); // cooldown
    expect(w.buyPart(0, 'tank')).toBe(false); // morphs aren't research: they're always available
    w.cmdMorph([g.id], Role.Tank);
    run(w, 3);
    expect(g.role).toBe(Role.Tank);
    w.cmdFormation([g.id], Formation.Ring);
    run(w, 1);
    expect(g.formation).toBe(Formation.Ring);
  });

  it('shape projection keeps units within the formation region', () => {
    for (const f of [Formation.Swarm, Formation.Wedge, Formation.Ring, Formation.Line]) {
      const [x, y] = shapeProject(5000, 5000, 1, 0, 100, f, 0.5);
      expect(Math.hypot(x, y)).toBeLessThan(400);
    }
  });

  it('runs a full AI game for 4 minutes with waves without crashing', () => {
    const w = new World({ seed: 7, rivals: 3 });
    const t0 = performance.now();
    run(w, 240);
    const ms = performance.now() - t0;
    const total = w.teams.reduce((s, t) => s + t.units, 0);
    console.log(`4min sim: ${ms.toFixed(0)}ms, units=${total}, ships=${w.ships.filter((s) => s.alive).length}, wave=${w.waveNum}`,
      w.teams.map((t) => `${t.id}:${t.units}/${t.kills}k/${t.levels.damage}d`).join(' '));
    expect(total).toBeGreaterThan(0);
  }, 120000);
});
