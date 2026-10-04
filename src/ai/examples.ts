// Ready-made programs. They run without the LLM and double as examples of what it writes.

export interface Example {
  prompt: string;
  code: string;
}

export const EXAMPLES: Example[] = [
  {
    prompt: 'Spread out and harvest every nearby rock',
    code: `function tick(state, api, memory) {
  memory.claimed = memory.claimed || {};
  const free = state.rocks.filter((r) => !Object.values(memory.claimed).includes(r.id) && r.mass > 20);
  for (const g of state.groups) {
    const mine = memory.claimed[g.id];
    if (mine !== undefined && state.rocks.some((r) => r.id === mine)) continue;
    if (g.count >= 40 && state.groups.length < 8) { api.split(g, 1, 0); continue; }
    const rock = nearest(g, free);
    if (rock) { api.harvest(g, rock); memory.claimed[g.id] = rock.id; free.splice(free.indexOf(rock), 1); }
  }
  if (state.time > (memory.start ??= state.time) + 60) { api.log('Harvest sweep finished'); api.done(); }
}`,
  },
  {
    prompt: 'Turtle up: ring formation, replicate, research, retreat if outnumbered',
    code: `function tick(state, api, memory) {
  const all = state.groups;
  if (!memory.setup) {
    api.formation(all, 'ring');
    const [big, ...rest] = [...all].sort((a, b) => b.count - a.count);
    if (big) api.research(big);
    for (const g of rest) if (g.count >= 20) api.replicate(g);
    memory.setup = true;
  }
  while (state.points > 0) { api.upgrade('hull'); state.points--; }
  for (const g of all) {
    const threat = state.enemies.filter((e) => dist(e, g) < 500).reduce((s, e) => s + e.count, 0);
    if (threat > g.count * 1.2 && g.order !== 'move') {
      if (g.ready.shield) api.shield(g);
      api.move(g, state.home.x, state.home.y);
      api.log('Group ' + g.id + ' retreating from ' + threat + ' enemies');
    } else if (g.order === 'idle' && g.count >= 20) api.replicate(g);
  }
}`,
  },
  {
    prompt: 'Hunt raider ships with strikers in wedge formation',
    code: `function tick(state, api, memory) {
  const hunters = state.groups.filter((g) => g.count >= 25);
  if (!memory.morphed) { api.morph(hunters, 'striker'); api.formation(hunters, 'wedge'); memory.morphed = true; }
  if (!state.ships.length) { if (!memory.said) { api.log('No raiders on the map right now'); memory.said = true; } return; }
  for (const g of hunters) {
    const ship = nearest(g, state.ships);
    if (memory[g.id] !== ship.id) { api.attackShip(g, ship); memory[g.id] = ship.id; }
    if (g.ready.dash && dist(g, ship) > 200 && dist(g, ship) < 450) api.dash(g, ship.x, ship.y);
  }
}`,
  },
  {
    prompt: 'All-in on the weakest rival',
    code: `function tick(state, api, memory) {
  const teams = {};
  for (const e of state.enemies) teams[e.team] = (teams[e.team] || 0) + e.count;
  const weakest = Object.keys(teams).sort((a, b) => teams[a] - teams[b])[0];
  if (!weakest) { api.log('No rivals left'); return api.done(); }
  const targets = state.enemies.filter((e) => e.team === weakest);
  if (!memory.go) { api.merge(state.groups); api.formation(state.groups, 'wedge'); memory.go = true; api.log('Attacking ' + weakest); return; }
  for (const g of state.groups) {
    const t = nearest(g, targets);
    if (memory[g.id] !== t.id) { api.attack(g, t); memory[g.id] = t.id; }
    if (g.ready.shield && g.inCombat) api.shield(g);
    if (g.ready.nova && g.count > 80 && dist(g, t) < 120) api.nova(g);
  }
}`,
  },
];

export const PLACEHOLDERS = [
  'Split into 3 groups and harvest the closest rocks',
  'Strikers flank Ember from the north while the rest holds',
  'Kite the raiders with artillery in line formation',
  'Replicate at home until 500 units, then attack Verdant',
  'If any group drops below 20 units, merge it into the biggest one',
];
