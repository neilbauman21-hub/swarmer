// Uniform spatial hash rebuilt every tick with a counting sort.
// Items are unit indices; cellStart[c]..cellStart[c+1] indexes into items.
export class Grid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly cellStart: Int32Array;
  private cellCount: Int32Array;
  items: Int32Array;
  private itemCell: Int32Array;

  constructor(width: number, height: number, cell: number, capacity: number) {
    this.cell = cell;
    this.cols = Math.ceil(width / cell) + 1;
    this.rows = Math.ceil(height / cell) + 1;
    const n = this.cols * this.rows;
    this.cellStart = new Int32Array(n + 1);
    this.cellCount = new Int32Array(n);
    this.items = new Int32Array(capacity);
    this.itemCell = new Int32Array(capacity);
  }

  cellOf(x: number, y: number): number {
    let cx = (x / this.cell) | 0;
    let cy = (y / this.cell) | 0;
    if (cx < 0) cx = 0;
    else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0;
    else if (cy >= this.rows) cy = this.rows - 1;
    return cy * this.cols + cx;
  }

  /** Rebuild from positions of all alive items (alive[i] !== 0) in [0, count). */
  build(xs: Float32Array, ys: Float32Array, alive: Uint8Array, count: number): void {
    const cc = this.cellCount;
    cc.fill(0);
    for (let i = 0; i < count; i++) {
      if (!alive[i]) {
        this.itemCell[i] = -1;
        continue;
      }
      const c = this.cellOf(xs[i], ys[i]);
      this.itemCell[i] = c;
      cc[c]++;
    }
    const cs = this.cellStart;
    let acc = 0;
    for (let c = 0; c < cc.length; c++) {
      cs[c] = acc;
      acc += cc[c];
      cc[c] = 0;
    }
    cs[cc.length] = acc;
    for (let i = 0; i < count; i++) {
      const c = this.itemCell[i];
      if (c < 0) continue;
      this.items[cs[c] + cc[c]++] = i;
    }
  }

  /** Visit all items in cells overlapping the circle. Return true from fn to stop early. */
  query(x: number, y: number, r: number, fn: (i: number) => boolean | void): void {
    const cell = this.cell;
    let x0 = ((x - r) / cell) | 0, x1 = ((x + r) / cell) | 0;
    let y0 = ((y - r) / cell) | 0, y1 = ((y + r) / cell) | 0;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 >= this.cols) x1 = this.cols - 1;
    if (y1 >= this.rows) y1 = this.rows - 1;
    const cs = this.cellStart, items = this.items;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cy * this.cols + cx;
        for (let k = cs[c], e = cs[c + 1]; k < e; k++) {
          if (fn(items[k])) return;
        }
      }
    }
  }
}
