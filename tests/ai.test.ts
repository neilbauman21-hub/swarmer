import { describe, expect, it } from 'vitest';
import { applyCommands, snapshot } from '../src/ai/protocol';
import { EXAMPLES } from '../src/ai/examples';
import { extractCode } from '../src/ai/prompt';
import { onRequestPost, replyText } from '../functions/api/swarm';
import { TICK_HZ } from '../src/sim/config';
import { World } from '../src/sim/world';

/** Minimal re-implementation of the worker's harness so programs can run in Node. */
function runProgram(code: string, w: World, seconds: number): { logs: string[]; applied: number } {
  const dist = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y);
  const nearest = (from: any, list: any[]) => [...list].sort((a, b) => dist(from, a) - dist(from, b))[0] ?? null;
  const byDistance = (from: any, list: any[]) => [...list].sort((a, b) => dist(from, a) - dist(from, b));
  const centroid = () => null;
  const tick = new Function('dist', 'nearest', 'byDistance', 'centroid', `${code}\nreturn tick;`)(dist, nearest, byDistance, centroid);
  const memory = {};
  const logs: string[] = [];
  let applied = 0;
  let done = false;
  const id = (g: any) => (g && typeof g === 'object' ? g.id : g);
  const ids = (x: any) => (Array.isArray(x) ? x.map(id) : id(x));
  for (let t = 0; t < seconds * TICK_HZ && !done; t++) {
    w.step();
    if (t % 15) continue;
    const cmds: any[] = [];
    const api: any = {
      move: (g: any, x: number, y: number) => cmds.push({ op: 'move', ids: ids(g), x, y }),
      path: (g: any, points: any) => cmds.push({ op: 'path', ids: ids(g), points }),
      attack: (g: any, target: any) => cmds.push({ op: 'attack', ids: ids(g), target: id(target) }),
      attackShip: (g: any, target: any) => cmds.push({ op: 'attackShip', ids: ids(g), target: id(target) }),
      harvest: (g: any, rock: any) => cmds.push({ op: 'harvest', ids: ids(g), rock: id(rock) }),
      split: (g: any, dx = 1, dy = 0) => cmds.push({ op: 'split', id: id(g), dx, dy }),
      merge: (g: any) => cmds.push({ op: 'merge', ids: ids(g) }),
      replicate: (g: any) => cmds.push({ op: 'replicate', ids: ids(g) }),
      research: (g: any) => cmds.push({ op: 'research', ids: ids(g) }),
      hold: (g: any) => cmds.push({ op: 'hold', ids: ids(g) }),
      formation: (g: any, name: string) => cmds.push({ op: 'formation', ids: ids(g), name }),
      morph: (g: any, role: string) => cmds.push({ op: 'morph', ids: ids(g), role }),
      dash: (g: any, x: number, y: number) => cmds.push({ op: 'dash', ids: ids(g), x, y }),
      shield: (g: any) => cmds.push({ op: 'shield', ids: ids(g) }),
      nova: (g: any) => cmds.push({ op: 'nova', ids: ids(g) }),
      unlock: (type: string) => cmds.push({ op: 'unlock', type }),
      build: (g: any, design: string) => cmds.push({ op: 'build', id: id(g), design }),
      log: (m: string) => logs.push(m),
      done: () => { done = true; },
    };
    tick(snapshot(w, 0, []), api, memory);
    applied += applyCommands(w, 0, cmds);
  }
  return { logs, applied };
}

describe('swarm programs', () => {
  for (const ex of EXAMPLES) {
    it(`example runs: ${ex.prompt}`, () => {
      const w = new World({ seed: 21, rivals: 2 });
      w.addShip(0, 900, 4900);
      const { applied } = runProgram(ex.code, w, 20);
      expect(applied).toBeGreaterThan(0);
    });
  }

  it('harvest example spreads the swarm over several rocks and grows it', () => {
    const w = new World({ seed: 22, rivals: 1, waves: false });
    runProgram(EXAMPLES[0].code, w, 40);
    const harvesting = w.groupsOf(0).filter((g) => g.order.type === 'harvest' || g.harvesting);
    expect(w.groupsOf(0).length).toBeGreaterThan(1);
    expect(harvesting.length).toBeGreaterThan(0);
    expect(w.teams[0].units).toBeGreaterThan(60);
  });

  it('a program can build a researched construct by name', () => {
    const w = new World({ seed: 24, rivals: 1, waves: false, startUnits: 80 });
    w.teams[0].points = 10;
    for (const p of ['plate', 'spike', 'thruster']) w.buyPart(0, p);
    const code = "function tick(state, api, memory) { if (memory.done) return; memory.done = true; const d = state.designs.find((x) => x.buildable); api.build(state.groups[0], d.name); }";
    runProgram(code, w, 2);
    expect(w.groupsOf(0).some((g) => g.cells)).toBe(true);
  });

  it('rejects commands for enemy groups, bad ids and non-finite coordinates', () => {
    const w = new World({ seed: 23, rivals: 1, waves: false });
    w.step();
    const mine = w.groupsOf(0)[0], theirs = w.groupsOf(1)[0];
    const n = applyCommands(w, 0, [
      { op: 'move', ids: theirs.id, x: 100, y: 100 },
      { op: 'move', ids: [999], x: 1, y: 1 },
      { op: 'move', ids: mine.id, x: NaN, y: 3 },
      { op: 'eval', code: 'alert(1)' },
      null,
      { op: 'attack', ids: mine.id, target: mine.id },
    ]);
    expect(n).toBe(0);
    expect(theirs.order.type).toBe('idle');
    expect(applyCommands(w, 0, [{ op: 'move', ids: [mine.id], x: 100, y: 100 }])).toBe(1);
  });
});

describe('Pages Function /api/swarm', () => {
  const call = (body: unknown, AI?: any) =>
    onRequestPost({ request: new Request('https://x/api/swarm', { method: 'POST', body: JSON.stringify(body), headers: { 'cf-connecting-ip': String(Math.random()) } }), env: { AI } });

  it('returns code from the first model that answers with a tick function', async () => {
    const seen: string[] = [];
    const AI = {
      run: async (model: string) => {
        seen.push(model);
        if (seen.length === 1) throw new Error('capacity');
        return { response: 'Here you go:\n```js\nfunction tick(state, api) { api.done(); }\n```' };
      },
    };
    const res = await call({ prompt: 'do it', context: 'ctx' }, AI);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.code).toContain('function tick');
    expect(seen.length).toBe(2);
  });

  it('explains missing binding and empty prompts', async () => {
    expect((await call({ prompt: 'x' })).status).toBe(503);
    expect((await call({ prompt: '  ' }, { run: async () => '' })).status).toBe(400);
  });

  it('parses the reply shapes different models use', () => {
    expect(replyText({ response: 'a' })).toBe('a');
    expect(replyText({ choices: [{ message: { content: 'b' } }] })).toBe('b');
    expect(replyText({ output: [{ type: 'reasoning', content: [{ text: 'x' }] }, { type: 'message', content: [{ text: 'c' }] }] })).toBe('c');
    expect(extractCode('blah\nfunction tick(){}')).toBe('function tick(){}');
  });
});

describe('Pages Function /api/design', () => {
  it('returns the design JSON a model writes, even wrapped in prose', async () => {
    const { onRequestPost: design } = await import('../functions/api/design');
    const AI = { run: async () => ({ response: 'Sure!\n```json\n{"name":"Brick","cells":[{"x":0,"y":0,"part":"plate"},{"x":1,"y":0,"part":"spike"},{"x":-1,"y":0,"part":"thruster"}]}\n```' }) };
    const res = await design({ request: new Request('https://x/api/design', { method: 'POST', body: JSON.stringify({ prompt: 'a brick', unlocked: ['plate', 'spike', 'thruster', 'bogus'] }) }), env: { AI } });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.design.cells).toHaveLength(3);
  });
});
