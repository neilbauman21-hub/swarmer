// Tunable gameplay constants. Everything balance-related lives here.

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;

export const MAX_UNITS = 14000;
export const UNIT_SPACING = 9; // preferred distance between neighbours
export const GRID_CELL = 16;

export enum Role {
  Drone = 0,
  Striker = 1,
  Tank = 2,
  Harvester = 3,
  Artillery = 4,
}

export enum Formation {
  Swarm = 0,
  Wedge = 1,
  Ring = 2,
  Line = 3,
}

export interface RoleStats {
  name: string;
  hp: number;
  damage: number;
  range: number;
  cooldown: number;
  speed: number;
  defense: number; // fraction of damage ignored
  harvest: number; // multiplier
  replicate: number; // multiplier
  size: number; // render size
  splash: number; // 0 = single target
  blurb: string;
}

export const ROLES: RoleStats[] = [
  {
    name: 'Drone', hp: 10, damage: 2, range: 75, cooldown: 0.6, speed: 150, defense: 0,
    harvest: 1, replicate: 1, size: 1, splash: 0,
    blurb: 'Balanced all-rounder. Fires light beams.',
  },
  {
    name: 'Striker', hp: 9, damage: 3.4, range: 24, cooldown: 0.32, speed: 215, defense: 0,
    harvest: 0.5, replicate: 0.6, size: 0.9, splash: 0,
    blurb: 'Fast melee lancers. Lunge into targets, huge dash damage.',
  },
  {
    name: 'Tank', hp: 30, damage: 1.6, range: 48, cooldown: 0.8, speed: 105, defense: 0.35,
    harvest: 0.5, replicate: 0.5, size: 1.5, splash: 0,
    blurb: 'Armored and slow. Soaks damage for the swarm.',
  },
  {
    name: 'Harvester', hp: 8, damage: 1, range: 55, cooldown: 0.9, speed: 160, defense: 0,
    harvest: 2.6, replicate: 1.6, size: 0.85, splash: 0,
    blurb: 'Weak fighters, but harvest and replicate far faster.',
  },
  {
    name: 'Artillery', hp: 7, damage: 7, range: 230, cooldown: 2.0, speed: 115, defense: 0,
    harvest: 0.4, replicate: 0.5, size: 1.1, splash: 34,
    blurb: 'Lobs explosive shells from long range. Fragile up close.',
  },
];

export interface FormationStats {
  name: string;
  damage: number;
  defense: number;
  speed: number;
  range: number;
  blurb: string;
}

export const FORMATIONS: FormationStats[] = [
  { name: 'Swarm', damage: 1, defense: 0, speed: 1, range: 1, blurb: 'Loose cloud. No modifiers.' },
  { name: 'Wedge', damage: 1.25, defense: -0.1, speed: 1.15, range: 1, blurb: '+25% damage, +15% speed, -10% armor.' },
  { name: 'Ring', damage: 0.9, defense: 0.4, speed: 0.8, range: 1, blurb: '+40% armor, -20% speed.' },
  { name: 'Line', damage: 1, defense: 0, speed: 0.9, range: 1.3, blurb: '+30% range, -10% speed.' },
];

export const MORPH_TIME = 2.2;

// Abilities
export const ENERGY_MAX = 100;
export const ENERGY_REGEN = 7;
export const DASH = { cost: 30, cooldown: 6, duration: 0.55, speedMult: 4.2, ramDamage: 4, strikerRam: 11, distance: 260 };
export const SHIELD = { cost: 40, cooldown: 13, duration: 3.2, reduction: 0.75 };
export const NOVA = { cost: 60, cooldown: 20, charge: 0.8, sacrifice: 0.15, radius: 170, damage: 45, minUnits: 12 };

// Economy
export const REPLICATE_MIN = 20;
export const REPLICATE_RATE = 0.1; // units per second scales with sqrt(group size): growth is steady, not exponential
export const HARVEST_RATE = 0.05; // mass per second per unit, up to the rock's crew limit
export const MASS_PER_UNIT = 3;
export const GROWTH_KNEE = 220; // team size at which growth runs at half speed
export const RESEARCH_RATE = 1; // progress per second per unit
export const RESEARCH_POINT_BASE = 1400;
export const MAX_RESEARCH_LEVEL = 5;

export const CRUISE_MAX = 2.4; // long journeys build speed up to this multiplier
export const CRUISE_RAMP = 3.5; // seconds to reach max

export type ResearchTrack = 'speed' | 'damage' | 'hull' | 'replication';
export const RESEARCH_TRACKS: { id: ResearchTrack; name: string; per: string }[] = [
  { id: 'speed', name: 'Thrusters', per: '+10% speed' },
  { id: 'damage', name: 'Weapons', per: '+20% damage' },
  { id: 'hull', name: 'Hull', per: '+20% health' },
  { id: 'replication', name: 'Replication', per: '+25% growth & harvest' },
];

export const TEAM_COLORS: [number, number, number][] = [
  [0.35, 0.85, 1.0], // player - cyan
  [1.0, 0.42, 0.32], // coral
  [0.72, 1.0, 0.36], // lime
  [0.85, 0.45, 1.0], // violet
];
export const SHIP_COLOR: [number, number, number] = [1.0, 0.78, 0.3];
export const TEAM_NAMES = ['You', 'Ember', 'Verdant', 'Umbra'];
export const SHIP_TEAM = 255;

export enum ShipType {
  Scout = 0,
  Bomber = 1,
  Bulwark = 2,
  Siege = 3,
}

export interface ShipStats {
  name: string;
  hp: number;
  speed: number;
  range: number;
  damage: number;
  cooldown: number;
  splash: number;
  radius: number;
  wreck: number; // harvestable mass left behind
}

export const SHIPS: ShipStats[] = [
  { name: 'Scout', hp: 70, speed: 170, range: 130, damage: 3, cooldown: 0.25, splash: 0, radius: 14, wreck: 60 },
  { name: 'Bomber', hp: 150, speed: 95, range: 60, damage: 18, cooldown: 2.4, splash: 90, radius: 20, wreck: 120 },
  { name: 'Bulwark', hp: 650, speed: 55, range: 90, damage: 5, cooldown: 0.5, splash: 40, radius: 34, wreck: 320 },
  { name: 'Siege', hp: 320, speed: 50, range: 380, damage: 14, cooldown: 3.2, splash: 55, radius: 26, wreck: 220 },
];

export enum Difficulty {
  Easy = 0,
  Normal = 1,
  Hard = 2,
}

export const DIFFICULTY = [
  { name: 'Easy', aiGrowth: 0.75, aiThink: 1.6, waveScale: 0.6, aiCap: 1600, aiArmyAt: 420 },
  { name: 'Normal', aiGrowth: 1.0, aiThink: 1.0, waveScale: 1.0, aiCap: 2600, aiArmyAt: 300 },
  { name: 'Hard', aiGrowth: 1.3, aiThink: 0.6, waveScale: 1.4, aiCap: 3600, aiArmyAt: 220 },
];

export const PLAYER_CAP = 4000;
