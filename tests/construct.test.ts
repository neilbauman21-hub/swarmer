import { describe, expect, it } from 'vitest';
import { TICK_HZ } from '../src/sim/config';
import { PRESETS, designUnits, normalizeTune, validateDesign } from '../src/sim/parts';
import { World } from '../src/sim/world';

const run = (w: World, s: number) => { for (let i = 0; i < s * TICK_HZ; i++) w.step(); };
const tank = PRESETS.find((p) => p.name === 'Siege Tank')!;

function setup(units = 200) {
  const w = new World({ seed: 31, rivals: 1, waves: false, startUnits: 0 });
  for (const t of w.teams) { t.ai = false; t.cap = 9999; }
  const g = w.createGroup(0, 3000, 3000);
  for (let i = 0; i < units; i++) w.spawnUnit(g, 3000 + Math.random() * 80, 3000 + Math.random() * 80, false);
  w.step();
  return { w, g };
}

describe('constructs', () => {
  it('tuning is a trade: boosts are paid for with cuts', () => {
    const t = normalizeTune({ hp: 2, damage: 2 });
    expect(Math.log2(t.hp) + Math.log2(t.damage)).toBeLessThanOrEqual(1e-6);
    const fair = normalizeTune({ hp: 2, damage: 0.5 });
    expect(fair.hp).toBeCloseTo(2);
    expect(fair.damage).toBeCloseTo(0.5);
  });

  it('validation swaps locked parts, drops loose cells and keeps coordinates on the grid', () => {
    const v = validateDesign({ name: 'X', cells: [{ x: 0, y: 0, part: 'plate' }, { x: 1, y: 0, part: 'cannon' }, { x: 2, y: 0, part: 'drone' }, { x: 6, y: 6, part: 'drone' }, { x: 99, y: 0, part: 'drone' }] }, new Set(['drone', 'plate']));
    expect(v.ok).toBe(true);
    expect(v.design!.cells.length).toBe(3);
    expect(v.design!.cells.some((c) => c.part === 'cannon')).toBe(false);
    expect(v.warnings.join(' ')).toMatch(/Cannon/);
  });

  it('builds only with researched parts and enough units, consuming the right number', () => {
    const { w, g } = setup(200);
    expect(w.cmdBuild(g.id, tank)).toBe(-1); // nothing researched
    w.teams[0].points = 10;
    for (const p of ['plate', 'thruster', 'mender', 'cannon']) expect(w.buyPart(0, p)).toBe(true);
    const before = w.teams[0].units;
    const id = w.cmdBuild(g.id, tank);
    expect(id).toBeGreaterThanOrEqual(0);
    w.step();
    const c = w.groups[id];
    expect(c.count).toBe(tank.cells.length);
    expect(before - w.teams[0].units).toBe(designUnits(tank) - tank.cells.length);
    expect(w.teams[0].lost).toBe(0);
  });

  it('holds its shape while moving and rotates toward travel', () => {
    const { w, g } = setup(200);
    w.teams[0].points = 10;
    for (const p of ['plate', 'thruster', 'mender', 'cannon']) w.buyPart(0, p);
    const c = w.groups[w.cmdBuild(g.id, tank)];
    run(w, 3);
    w.cmdMove([c.id], 3000, 2200);
    run(w, 14);
    expect(Math.hypot(c.cx - 3000, c.cy - 2200)).toBeLessThan(60);
    expect(c.hy).toBeLessThan(-0.8); // facing north
    expect(c.radius).toBeLessThan(60); // still compact
  });

  it('crumbles: cut-off cells break away, and swarm units repair it', () => {
    const { w, g } = setup(200);
    w.teams[0].points = 10;
    for (const p of ['plate', 'thruster', 'mender', 'cannon']) w.buyPart(0, p);
    const c = w.groups[w.cmdBuild(g.id, tank)];
    run(w, 2);
    // Destroy the middle column (x = 0 and 1 except corners) to split the hull.
    const design = c.design!;
    design.cells.forEach((cell, k) => { if (cell.x === 0 || cell.x === 1) w.uhp[c.slotUnit![k]] = -1; });
    run(w, 1);
    const groupsAfter = w.groupsOf(0).length;
    expect(groupsAfter).toBeGreaterThan(2); // debris broke off
    const repairable = w.groupsOf(0).find((x) => !x.cells && x.id !== c.id && x.count > 20);
    if (c.alive && repairable) {
      const before = c.count;
      w.cmdMerge([c.id, repairable.id]);
      w.step();
      expect(c.count).toBeGreaterThan(before);
    }
  });

  it('a siege tank beats an equal-cost drone swarm', () => {
    const { w, g } = setup(designUnits(tank) * 2);
    w.teams[0].points = 10;
    for (const p of ['plate', 'thruster', 'mender', 'cannon']) w.buyPart(0, p);
    const c = w.groups[w.cmdBuild(g.id, tank)];
    const leftover = w.groups[g.id];
    const foe = w.createGroup(1, 3000, 2500);
    for (let i = 0; i < designUnits(tank); i++) w.spawnUnit(foe, 3000 + Math.random() * 60, 2500 + Math.random() * 60, false);
    if (leftover.alive) w.cmdMove([leftover.id], 2000, 3500);
    w.cmdAttackGroup([foe.id], c.id);
    run(w, 60);
    const tankCells = c.alive ? c.count : 0;
    console.log(`tank cells left ${tankCells}/${tank.cells.length}, drones left ${foe.alive ? foe.count : 0}/${designUnits(tank)}`);
    expect(foe.alive ? foe.count : 0).toBeLessThan(designUnits(tank) * 0.3);
  });
});
