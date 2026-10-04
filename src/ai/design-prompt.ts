// Prompt for turning a description into a construct blueprint. Shared by the browser and the Pages Function.

import { GRID_LIMIT, MAX_CELLS, PARTS, PRESETS } from '../sim/parts';

export function designSystemPrompt(unlocked: string[]): string {
  const parts = PARTS.filter((p) => unlocked.includes(p.id))
    .map((p) => `- ${p.id}: ${p.blurb} HP ${p.hp}${p.damage ? `, damage ${p.damage}, range ${p.range}, fires every ${p.cooldown}s` : ''}${p.armor ? `, armor ${Math.round(p.armor * 100)}%` : ''}. Costs ${p.units} swarm unit${p.units > 1 ? 's' : ''}.`)
    .join('\n');
  return `You design constructs for the swarm strategy game Swarmer. A construct is a soft body of particles on a square grid.
Answer with ONE JSON object and nothing else:
{"name": "short name", "cells": [{"x": 0, "y": 0, "part": "plate", "tune": {"hp": 1.5, "damage": 0.67}}, ...]}

GRID RULES
- Integer x and y in [-${GRID_LIMIT}, ${GRID_LIMIT}]. +x is the FRONT (direction of travel), -x is the back. y is left/right.
- 3 to ${MAX_CELLS} cells, one part per cell, every cell touching another (diagonals count). Loose cells are dropped.
- Cells touching a mender get healed; cells touching a shield node take half damage.

PARTS YOU MAY USE (the player has researched only these)
${parts}

TUNING (optional, per cell): multipliers for hp, damage, range, rate (fire rate), each between 0.5 and 2.
The product of a cell's multipliers must be 1 or less: to double one stat, halve another (e.g. hp 2 with damage 0.5).

DESIGN ADVICE
Armor in front, weapons protected behind it, thrusters at the back, menders in the middle. More thrusters per cell = faster.
Strikers counter cannon-heavy designs, artillery counters plate-heavy ones, and tanks counter spike-heavy ones.
Respect what the player asks for (shape, role, size). If they ask for a part they don't have, use the closest part they do have.

EXAMPLE
${JSON.stringify(PRESETS[1])}`;
}

/** Find the first JSON object in a model reply. */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
  const src = fence ? fence[1] : text;
  const start = src.indexOf('{');
  const end = src.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(src.slice(start, end + 1));
  } catch {
    return null;
  }
}
