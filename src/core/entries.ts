import { SRGB_TO_LINEAR, ciede2000, labToDin99o, linearRgbToLab, linearToSrgb8 } from './color';
import { KdTree } from './kdtree';
import type { ColorSet } from './match';

/**
 * Варианты ниток для схемы: обычные нитки палитры (все нити в игле одного цвета) и смеси —
 * нити двух цветов в одной игле. При 2 нитях в игле смесь одна: 1 + 1; при 3 — две: 2 + 1 и 1 + 2.
 * Цвет смеси — среднее цветов ниток в линейном RGB с весами по числу нитей (так смешивается
 * отражённый свет ниток, лежащих рядом).
 *
 * Индексы 0 … threads−1 — обычные нитки (совпадают с индексами палитры), дальше — смеси.
 */
export class EntrySet implements ColorSet {
  readonly size: number;
  readonly lab: Float64Array;
  readonly lin: Float32Array;
  /** Для каждого варианта — индексы ниток палитры (одна или две). */
  readonly parts: Array<[number] | [number, number]>;
  /** Сколько нитей каждого цвета в игле (в том же порядке, что parts). */
  readonly strands: Array<[number] | [number, number]>;
  private readonly tree: KdTree;
  private readonly buf = new Int32Array(64);
  private readonly q = new Float64Array(3);

  constructor(threadRgbs: ReadonlyArray<readonly number[]>, maxPairDeltaE: number, strandsInNeedle = 3) {
    const n = threadRgbs.length;
    const tLin = threadRgbs.map((c) => [SRGB_TO_LINEAR[c[0]], SRGB_TO_LINEAR[c[1]], SRGB_TO_LINEAR[c[2]]]);
    const tLab = tLin.map((l) => {
      const out = [0, 0, 0];
      linearRgbToLab(l[0], l[1], l[2], out);
      return out;
    });
    const parts: Array<[number] | [number, number]> = [];
    const strands: Array<[number] | [number, number]> = [];
    const lins: number[][] = [];
    for (let i = 0; i < n; i++) {
      parts.push([i]);
      strands.push([strandsInNeedle]);
      lins.push(tLin[i]);
    }
    // как можно разделить нити в игле между двумя цветами: 1+1 (2 нити) или 2+1 и 1+2 (3 нити)
    const splits: Array<[number, number]> = [];
    for (let a = 1; a < strandsInNeedle; a++) splits.push([a, strandsInNeedle - a]);
    if (maxPairDeltaE > 0) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = tLab[i];
          const b = tLab[j];
          if (ciede2000(a[0], a[1], a[2], b[0], b[1], b[2]) > maxPairDeltaE) continue;
          for (const [si, sj] of splits) {
            const wi = si / strandsInNeedle;
            const wj = sj / strandsInNeedle;
            parts.push([i, j]);
            strands.push([si, sj]);
            lins.push([0, 1, 2].map((k) => wi * tLin[i][k] + wj * tLin[j][k]));
          }
        }
      }
    }
    this.size = parts.length;
    this.parts = parts;
    this.strands = strands;
    this.lin = new Float32Array(this.size * 3);
    this.lab = new Float64Array(this.size * 3);
    const lab = [0, 0, 0];
    lins.forEach((l, i) => {
      this.lin.set(l, i * 3);
      linearRgbToLab(l[0], l[1], l[2], lab);
      this.lab.set(lab, i * 3);
    });
    // дерево строится в DIN99o: там евклидово расстояние близко к CIEDE2000
    const din = new Float64Array(this.size * 3);
    for (let i = 0; i < this.size; i++) labToDin99o(this.lab[i * 3], this.lab[i * 3 + 1], this.lab[i * 3 + 2], din, i * 3);
    this.tree = new KdTree(din);
  }

  /** Число смесей среди вариантов. */
  get blendCount(): number {
    return this.size - this.parts.filter((p) => p.length === 1).length;
  }

  /** Цвет варианта в sRGB (0..255). */
  rgb(i: number): [number, number, number] {
    return [linearToSrgb8(this.lin[i * 3]), linearToSrgb8(this.lin[i * 3 + 1]), linearToSrgb8(this.lin[i * 3 + 2])];
  }

  /** Индексы до k ближайших вариантов (по евклидову расстоянию в DIN99o). */
  candidates(L: number, a: number, b: number, k = 16): Int32Array {
    labToDin99o(L, a, b, this.q);
    const c = this.tree.knn(this.q[0], this.q[1], this.q[2], Math.min(k, this.buf.length), this.buf);
    return this.buf.subarray(0, c);
  }

  /**
   * Ближайший вариант по CIEDE2000 среди 16 ближайших в DIN99o. Для цветов реальных
   * картинок совпадает с полным перебором (проверяется в тестах); для ядовитых цветов,
   * которых нет ни в одной нитке, разница с полным перебором мала. Поиск в сотни раз быстрее.
   */
  nearest(L: number, a: number, b: number): number {
    const cand = this.candidates(L, a, b, 16);
    let best = -1;
    let bestD = Infinity;
    const { lab } = this;
    for (let k = 0; k < cand.length; k++) {
      const i = cand[k];
      const d = ciede2000(L, a, b, lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]);
      if (d < bestD || (d === bestD && i < best)) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  distance(i: number, j: number): number {
    const { lab } = this;
    return ciede2000(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2], lab[j * 3], lab[j * 3 + 1], lab[j * 3 + 2]);
  }
}
