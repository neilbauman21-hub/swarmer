import type { World } from '../sim/world';

/**
 * Short position history per unit, sampled at a fixed rate, so units leave curved,
 * fading trails (a straight velocity streak can't show a swarm turning).
 */
export const TRAIL_LEN = 7;

export class Trails {
  private hx: Float32Array;
  private hy: Float32Array;
  private head: Uint8Array;
  private filled: Uint8Array;
  private seen: Uint8Array;
  private acc = 0;

  constructor(capacity: number) {
    this.hx = new Float32Array(capacity * TRAIL_LEN);
    this.hy = new Float32Array(capacity * TRAIL_LEN);
    this.head = new Uint8Array(capacity);
    this.filled = new Uint8Array(capacity);
    this.seen = new Uint8Array(capacity);
  }

  /** Record positions every ~1/40 s of real time. */
  sample(w: World, dt: number, alpha: number): void {
    this.acc += dt;
    if (this.acc < 1 / 40) return;
    this.acc = 0;
    const { ux, uy, upx, upy, ualive } = w;
    for (let i = 0; i < w.hi; i++) {
      if (!ualive[i]) {
        this.seen[i] = 0;
        continue;
      }
      const x = upx[i] + (ux[i] - upx[i]) * alpha, y = upy[i] + (uy[i] - upy[i]) * alpha;
      const o = i * TRAIL_LEN;
      if (!this.seen[i]) {
        // Newly spawned (or slot reused): start a fresh trail.
        this.seen[i] = 1;
        this.filled[i] = 0;
        this.head[i] = 0;
      } else {
        const last = o + this.head[i];
        const dx = x - this.hx[last], dy = y - this.hy[last];
        if (dx * dx + dy * dy > 120 * 120) this.filled[i] = 0; // teleport: don't streak across the map
      }
      const h = (this.head[i] + 1) % TRAIL_LEN;
      this.head[i] = h;
      this.hx[o + h] = x;
      this.hy[o + h] = y;
      if (this.filled[i] < TRAIL_LEN) this.filled[i]++;
    }
  }

  /** Visit trail points from newest to oldest. Returns the count written into out (x,y pairs). */
  points(i: number, out: Float32Array): number {
    const n = this.filled[i];
    const o = i * TRAIL_LEN;
    let h = this.head[i];
    for (let k = 0; k < n; k++) {
      out[k * 2] = this.hx[o + h];
      out[k * 2 + 1] = this.hy[o + h];
      h = (h + TRAIL_LEN - 1) % TRAIL_LEN;
    }
    return n;
  }
}
