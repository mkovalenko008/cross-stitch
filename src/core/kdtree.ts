/**
 * k-d дерево для поиска k ближайших точек в трёхмерном пространстве (здесь — Lab, евклидово
 * расстояние). Используется как быстрый предварительный отбор кандидатов, которые потом
 * сравниваются по CIEDE2000.
 */
export class KdTree {
  private readonly idx: Int32Array;
  private readonly axis: Uint8Array;
  private readonly pts: Float64Array;
  // рабочие буферы запроса
  private bestD = new Float64Array(0);
  private bestI = new Int32Array(0);
  private count = 0;
  private k = 0;
  private qx = 0;
  private qy = 0;
  private qz = 0;

  constructor(points: Float64Array) {
    this.pts = points;
    const n = points.length / 3;
    this.idx = Int32Array.from({ length: n }, (_, i) => i);
    this.axis = new Uint8Array(n);
    this.build(0, n);
  }

  private build(s: number, e: number): void {
    // итеративно через стек, чтобы не упереться в глубину рекурсии
    const stack: number[] = [s, e];
    while (stack.length) {
      const end = stack.pop()!;
      const start = stack.pop()!;
      if (end - start <= 1) continue;
      // ось с наибольшим разбросом
      const { idx, pts } = this;
      let best = 0;
      let bestSpread = -1;
      for (let a = 0; a < 3; a++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = start; i < end; i++) {
          const v = pts[idx[i] * 3 + a];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > bestSpread) {
          bestSpread = hi - lo;
          best = a;
        }
      }
      const mid = (start + end) >> 1;
      this.select(start, end - 1, mid, best);
      this.axis[mid] = best;
      stack.push(start, mid, mid + 1, end);
    }
  }

  /** Быстрый выбор: после вызова idx[k] — k-я по координате a точка на отрезке [lo, hi]. */
  private select(lo: number, hi: number, k: number, a: number): void {
    const { idx, pts } = this;
    while (hi > lo) {
      const pivot = pts[idx[(lo + hi) >> 1] * 3 + a];
      let i = lo;
      let j = hi;
      while (i <= j) {
        while (pts[idx[i] * 3 + a] < pivot) i++;
        while (pts[idx[j] * 3 + a] > pivot) j--;
        if (i <= j) {
          const t = idx[i];
          idx[i] = idx[j];
          idx[j] = t;
          i++;
          j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }

  /** k ближайших точек к (x, y, z); индексы пишутся в out, возвращается их число. */
  knn(x: number, y: number, z: number, k: number, out: Int32Array): number {
    if (this.bestD.length < k) {
      this.bestD = new Float64Array(k);
      this.bestI = new Int32Array(k);
    }
    this.k = k;
    this.count = 0;
    this.qx = x;
    this.qy = y;
    this.qz = z;
    this.visit(0, this.idx.length);
    for (let i = 0; i < this.count; i++) out[i] = this.bestI[i];
    return this.count;
  }

  private visit(s: number, e: number): void {
    if (s >= e) return;
    const mid = (s + e) >> 1;
    const p = this.idx[mid];
    const { pts } = this;
    const dx = this.qx - pts[p * 3];
    const dy = this.qy - pts[p * 3 + 1];
    const dz = this.qz - pts[p * 3 + 2];
    this.offer(p, dx * dx + dy * dy + dz * dz);
    if (e - s === 1) return;
    const a = this.axis[mid];
    const diff = a === 0 ? dx : a === 1 ? dy : dz;
    // diff = запрос − точка: при diff < 0 запрос левее точки разбиения
    if (diff < 0) {
      this.visit(s, mid);
      if (this.count < this.k || diff * diff < this.bestD[this.count - 1]) this.visit(mid + 1, e);
    } else {
      this.visit(mid + 1, e);
      if (this.count < this.k || diff * diff < this.bestD[this.count - 1]) this.visit(s, mid);
    }
  }

  private offer(i: number, d: number): void {
    const { bestD, bestI } = this;
    if (this.count === this.k && d >= bestD[this.count - 1]) return;
    let pos = this.count < this.k ? this.count++ : this.count - 1;
    while (pos > 0 && bestD[pos - 1] > d) {
      bestD[pos] = bestD[pos - 1];
      bestI[pos] = bestI[pos - 1];
      pos--;
    }
    bestD[pos] = d;
    bestI[pos] = i;
  }
}
