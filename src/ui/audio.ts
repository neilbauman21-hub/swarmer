import type { GameEvent } from '../sim/world';

/** Procedural WebAudio sound effects. No assets, throttled so big fights stay pleasant. */
export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private budget = new Map<string, number>();
  private comp: DynamicsCompressorNode | null = null;
  muted = false;
  volume = 0.6;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.ratio.value = 6;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  /** Per-frame refill of rate limits. */
  tick(dt: number): void {
    for (const [k, v] of this.budget) this.budget.set(k, Math.min(v + dt * rate(k), cap(k)));
  }

  private take(kind: string): boolean {
    const v = this.budget.get(kind) ?? cap(kind);
    if (v < 1) return false;
    this.budget.set(kind, v - 1);
    return true;
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private hiss(f0: number, f1: number, dur: number, vol: number, q = 1, type: BiquadFilterType = 'lowpass'): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(this.master!);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  }

  /** Play sounds for a frame's events. `near(x,y)` returns 0..1 audibility from camera. */
  play(events: GameEvent[], near: (x: number, y: number) => number): void {
    if (!this.ctx || this.muted) return;
    for (const e of events) {
      const v = near(e.x, e.y);
      if (v <= 0.02 && e.t !== 'wave' && e.t !== 'research') continue;
      switch (e.t) {
        case 'tracer':
          if (this.take('pew')) this.tone('square', 1400 + Math.random() * 600, 300, 0.05, 0.025 * v);
          break;
        case 'melee':
          if (this.take('pew')) this.hiss(4000, 800, 0.05, 0.08 * v, 2, 'bandpass');
          break;
        case 'death':
          if (this.take('pop')) this.tone('triangle', 500 + Math.random() * 300, 90, 0.09, 0.05 * v);
          break;
        case 'spawn':
        case 'harvest':
          if (this.take('chime')) this.tone('sine', 900 + Math.random() * 500, 1500, 0.08, 0.03 * v);
          break;
        case 'explode':
          if (this.take('boom')) { this.hiss(1800, 80, 0.35, 0.22 * v); this.tone('sine', 120, 40, 0.3, 0.2 * v); }
          break;
        case 'shellFire':
          if (this.take('thump')) this.tone('sine', 200, 60, 0.12, 0.12 * v);
          break;
        case 'shipDeath':
          this.hiss(3000, 60, 1.1, 0.5 * v);
          this.tone('sawtooth', 160, 30, 0.8, 0.18 * v);
          break;
        case 'nova':
          this.hiss(6000, 40, 1.4, 0.7);
          this.tone('sine', 90, 25, 1.2, 0.5);
          this.tone('sawtooth', 600, 50, 0.6, 0.12);
          break;
        case 'novaCharge':
          this.tone('sawtooth', 80, 900, 0.8, 0.08 * v);
          break;
        case 'dash':
          this.hiss(500, 5000, 0.3, 0.25 * v, 3, 'bandpass');
          break;
        case 'shield':
          this.tone('sine', 300, 1200, 0.35, 0.12 * v);
          this.tone('sine', 450, 1800, 0.35, 0.06 * v, 0.04);
          break;
        case 'morph':
          this.tone('triangle', e.n ? 400 : 800, e.n ? 900 : 300, 0.3, 0.07 * v);
          break;
        case 'research':
          if (e.team === 0) { this.tone('sine', 660, 660, 0.15, 0.1); this.tone('sine', 990, 990, 0.25, 0.08, 0.12); }
          break;
        case 'bomb':
          if (this.take('boom')) this.tone('square', 900, 900, 0.06, 0.05 * v);
          break;
        case 'wave':
          this.tone('sawtooth', 110, 90, 1.2, 0.12);
          this.tone('sawtooth', 165, 130, 1.2, 0.08);
          break;
        case 'fail':
          if (e.team === 0) this.tone('square', 220, 160, 0.15, 0.06);
          break;
      }
    }
  }

  ui(kind: 'click' | 'select' | 'order' | 'error'): void {
    if (!this.ctx || this.muted) return;
    if (kind === 'click') this.tone('sine', 700, 900, 0.05, 0.05);
    else if (kind === 'select') this.tone('triangle', 520, 780, 0.07, 0.06);
    else if (kind === 'order') { this.tone('sine', 440, 660, 0.06, 0.06); this.tone('sine', 660, 880, 0.06, 0.04, 0.05); }
    else this.tone('square', 200, 150, 0.12, 0.05);
  }
}

function rate(k: string): number {
  return k === 'pew' ? 18 : k === 'pop' ? 14 : k === 'chime' ? 8 : k === 'boom' ? 6 : 5;
}
function cap(k: string): number {
  return k === 'pew' ? 6 : k === 'pop' ? 5 : k === 'boom' ? 4 : 3;
}
