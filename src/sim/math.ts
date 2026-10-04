// Math.hypot is not specified bit-exactly and differs between JS engines; sqrt is (IEEE 754),
// so the lockstep simulation uses this everywhere to stay identical across browsers.
export const hyp = (x: number, y: number): number => Math.sqrt(x * x + y * y);

/**
 * Where a harvesting unit is in its mining cycle (0..1): it dives to the rock during [0, BITE),
 * bites off ore at BITE, then climbs back out carrying it. Shared by the sim and the renderer.
 */
export const BITE = 0.3;
export const harvestPhase = (time: number, seed: number): number => {
  const p = time * (0.42 + seed * 0.3) + seed * 7.31;
  return p - Math.floor(p);
};
/** 1 = out in the orbit band, 0 = touching the rock surface. */
export const harvestLift = (ph: number): number => {
  if (ph < BITE) { const k = ph / BITE; return 1 - k * k; } // accelerate into the dive
  const k = (ph - BITE) / (1 - BITE);
  return 1 - (1 - k) * (1 - k) * (1 - k); // ease back out
};
