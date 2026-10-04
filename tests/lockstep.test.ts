import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { applyCommands } from '../src/ai/protocol';

const opts = { seed: 42, size: 4500, teams: 3, humans: [0, 1] };

function script(w: World, t: number): void {
  // Same orders for both humans at fixed ticks, like turns from the room.
  if (t === 30) {
    for (const team of [0, 1]) {
      const g = w.groupsOf(team)[0];
      const rock = w.rocks.find((r) => r.alive && Math.hypot(r.x - g.cx, r.y - g.cy) < 700)!;
      applyCommands(w, team, [{ op: 'harvest', ids: [g.id], rock: rock.id }]);
    }
  }
  if (t === 900) applyCommands(w, 0, [{ op: 'split', id: w.groupsOf(0)[0].id, dx: 1, dy: 0 }]);
  if (t === 1200) applyCommands(w, 1, [{ op: 'attack', ids: w.groupsOf(1).map((g) => g.id), target: w.groupsOf(0)[0].id }]);
}

describe('lockstep', () => {
  it('two clients fed the same turns stay identical', () => {
    const a = new World(opts), b = new World(opts);
    for (let t = 0; t < 1800; t++) {
      script(a, t); script(b, t);
      a.step(); b.step();
      if (t % 300 === 0) expect(a.hash()).toBe(b.hash());
    }
    expect(a.hash()).toBe(b.hash());
    expect(a.teams[0].units).toBe(b.teams[0].units);
  });

  it('a snapshot restores into an identical, still-deterministic world', () => {
    const a = new World(opts);
    for (let t = 0; t < 1000; t++) { script(a, t); a.step(); }
    const snap = JSON.parse(JSON.stringify(a.serialize()));
    const b = new World({ ...opts, seed: 999 }); // different start, overwritten by the snapshot
    b.restore(snap);
    expect(b.hash()).toBe(a.hash());
    for (let t = 1000; t < 1600; t++) { script(a, t); script(b, t); a.step(); b.step(); }
    expect(b.hash()).toBe(a.hash());
  });

  it('a player leaving hands their swarm to the AI and the match can still end', () => {
    const w = new World({ ...opts, teams: 2, humans: [0, 1] });
    w.handOver(1);
    expect(w.teams[1].ai).toBe(true);
    expect(w.teams[1].unlocked.has('striker')).toBe(true);
    for (const g of w.groupsOf(0)) for (let i = 0; i < w.hi; i++) if (w.ugroup[i] === g.id) w.damageUnit(i, 1e9, 1);
    for (let t = 0; t < 30; t++) w.step();
    expect(w.winner).toBe(1);
  });

  it('rock ids stay stable after rocks are mined out', () => {
    const w = new World(opts);
    const ids = w.rocks.map((r) => r.id);
    w.rocks[0].mass = 0.1;
    w.rocks[0].alive = false;
    for (let t = 0; t < 300; t++) w.step();
    expect(w.rocks.map((r) => r.id).slice(0, ids.length)).toEqual(ids);
    expect(w.rocks.every((r, i) => r.id === i)).toBe(true);
  });
});
