import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { applyTurn } from '../src/ai/protocol';
import { ARENA } from '../src/sim/config';

const run = (w: World, secs: number) => { for (let i = 0; i < secs * 60; i++) w.step(); };

describe('endless arena', () => {
  it('starts with bots and gives a joining player their own swarm', () => {
    const w = new World({ arena: true, seed: 3 });
    expect(w.size).toBe(ARENA.size);
    expect(w.teams.filter((t) => t.alive).length).toBe(ARENA.minSwarms - 1);
    applyTurn(w, 7, { op: 'join', name: 'Ada' });
    const t = w.teamOfPlayer(7);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(w.teams[t].name).toBe('Ada');
    expect(w.teams[t].ai).toBe(false);
    expect(w.teams[t].units).toBe(ARENA.startUnits);
    // Every role can be morphed into from the start; research only covers construct particles.
    expect(w.teams[t].unlocked.has('tank')).toBe(true);
    expect(w.teams[t].unlocked.has('plate')).toBe(false);
    // Orders from that player reach only their swarm.
    const g = w.groupsOf(t)[0];
    applyTurn(w, 7, { op: 'move', ids: [g.id], x: 100, y: 100 });
    expect(g.order.type).toBe('move');
    const bot = w.teams.find((x) => x.alive && x.owner < 0)!;
    const bg = w.groupsOf(bot.id)[0];
    applyTurn(w, 7, { op: 'move', ids: [bg.id], x: 1, y: 1 });
    expect(bg.order.x).not.toBe(1); // can't order someone else's swarm
  });

  it('a leaving player turns into a bot, a wiped-out player can redeploy', () => {
    const w = new World({ arena: true, seed: 4 });
    applyTurn(w, 1, { op: 'join', name: 'Bo' });
    const t = w.teamOfPlayer(1);
    for (let i = 0; i < w.hi; i++) if (w.ualive[i] && w.uteam[i] === t) w.uhp[i] = -1;
    run(w, 1);
    expect(w.teams[t].alive).toBe(false);
    applyTurn(w, 1, { op: 'respawn' });
    expect(w.teams[t].alive).toBe(false); // short cooldown first
    run(w, 2);
    applyTurn(w, 1, { op: 'respawn' });
    expect(w.teams[t].alive).toBe(true);
    expect(w.teams[t].units).toBe(ARENA.startUnits);
    applyTurn(w, 1, { op: 'leave' });
    expect(w.teamOfPlayer(1)).toBe(-1);
    expect(w.teams[t].ai).toBe(true);
    expect(w.teams[t].name).toContain('(AI)');
  });

  it('keeps going: bots refill, rocks regrow, and memory stays bounded', () => {
    const w = new World({ arena: true, seed: 5 });
    applyTurn(w, 1, { op: 'join', name: 'Cy' });
    const rocks0 = w.rockTarget;
    // Mine out a third of the field instantly.
    for (const r of w.rocks.slice(0, Math.floor(rocks0 / 3))) { r.alive = false; r.deadAt = w.time; }
    let groupsMax = 0, shipsMax = 0, rocksMax = 0;
    for (let m = 0; m < 6; m++) {
      run(w, 60);
      groupsMax = Math.max(groupsMax, w.groups.length);
      shipsMax = Math.max(shipsMax, w.ships.length);
      rocksMax = Math.max(rocksMax, w.rocks.length);
      expect(w.teams.filter((t) => t.alive).length).toBeGreaterThanOrEqual(ARENA.minSwarms - 2);
    }
    expect(w.winner).toBe(-1);
    expect(w.rocks.filter((r) => r.alive && !r.wreck).length).toBeGreaterThanOrEqual(rocks0 - 3);
    // Dead entries get recycled, so six minutes of play doesn't keep growing the arrays.
    expect(groupsMax).toBeLessThan(400);
    expect(shipsMax).toBeLessThan(150);
    expect(rocksMax).toBeLessThan(rocks0 + 80);
    for (let i = 0; i < w.hi; i++) if (w.ualive[i]) expect(Number.isFinite(w.ux[i])).toBe(true);
  }, 120_000);

  it('a late joiner loading a snapshot stays in lockstep with the host', () => {
    const host = new World({ arena: true, seed: 9 });
    applyTurn(host, 1, { op: 'join', name: 'Host' });
    run(host, 20);
    const snap = JSON.parse(JSON.stringify(host.serialize()));
    const late = new World({ arena: true, seed: 1 });
    late.restore(snap);
    expect(late.hash()).toBe(host.hash());
    for (const w of [host, late]) applyTurn(w, 2, { op: 'join', name: 'Late' });
    for (let i = 0; i < 1200; i++) { host.step(); late.step(); }
    expect(late.hash()).toBe(host.hash());
    expect(late.teamOfPlayer(2)).toBe(host.teamOfPlayer(2));
  }, 60_000);
});
