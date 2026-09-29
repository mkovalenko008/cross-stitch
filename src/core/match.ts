import { ciede2000, lightnessLowerBound, rgb8ToLab } from './color';

/** Набор цветов, с которым работают чистка и метрика точности (палитра ниток или варианты со смесями). */
export interface ColorSet {
  readonly size: number;
  /** Lab всех цветов: [L, a, b] × size. */
  readonly lab: Float64Array;
  /** ΔE2000 между цветами i и j. */
  distance(i: number, j: number): number;
  /** Необязательно: несколько ближайших кандидатов к цвету (для ускорения чистки больших наборов). */
  candidates?(L: number, a: number, b: number, k?: number): ArrayLike<number>;
}

/**
 * Точный поиск ближайшего цвета палитры по CIEDE2000.
 * Палитра отсортирована по L*, поиск идёт от светлоты образца в обе стороны и
 * останавливается, когда нижняя граница |ΔL|/SL превышает лучший найденный ΔE00.
 * Результат совпадает с полным перебором (проверяется в тестах).
 */
export class LabMatcher implements ColorSet {
  /** Lab цветов в исходном порядке: [L, a, b] × n. */
  readonly lab: Float64Array;
  readonly size: number;
  private readonly order: Int32Array; // индексы, отсортированные по L
  private readonly sortedL: Float64Array;

  constructor(lab: Float64Array) {
    this.lab = lab;
    this.size = lab.length / 3;
    const idx = Array.from({ length: this.size }, (_, i) => i);
    idx.sort((a, b) => this.lab[a * 3] - this.lab[b * 3] || a - b);
    this.order = Int32Array.from(idx);
    this.sortedL = Float64Array.from(idx, (i) => this.lab[i * 3]);
  }

  /** Индекс ближайшего цвета палитры. При равенстве ΔE выбирается меньший индекс. */
  nearest(L: number, a: number, b: number): number {
    const { lab, order, sortedL } = this;
    const n = this.size;
    // бинарный поиск первой позиции с L >= L образца
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedL[mid] < L) lo = mid + 1;
      else hi = mid;
    }
    let best = Infinity;
    let bestIdx = -1;
    let up = lo;
    let down = lo - 1;
    let upOpen = up < n;
    let downOpen = down >= 0;
    while (upOpen || downOpen) {
      if (upOpen) {
        const Lp = sortedL[up];
        if (lightnessLowerBound(L, Lp) > best) upOpen = false;
        else {
          const i = order[up];
          const d = ciede2000(L, a, b, Lp, lab[i * 3 + 1], lab[i * 3 + 2]);
          if (d < best || (d === best && i < bestIdx)) {
            best = d;
            bestIdx = i;
          }
          up++;
          upOpen = up < n;
        }
      }
      if (downOpen) {
        const Lp = sortedL[down];
        if (lightnessLowerBound(L, Lp) > best) downOpen = false;
        else {
          const i = order[down];
          const d = ciede2000(L, a, b, Lp, lab[i * 3 + 1], lab[i * 3 + 2]);
          if (d < best || (d === best && i < bestIdx)) {
            best = d;
            bestIdx = i;
          }
          down--;
          downOpen = down >= 0;
        }
      }
    }
    return bestIdx;
  }

  /** Полный перебор — эталон для тестов. */
  nearestBruteForce(L: number, a: number, b: number): number {
    let best = Infinity;
    let bestIdx = -1;
    for (let i = 0; i < this.size; i++) {
      const d = ciede2000(L, a, b, this.lab[i * 3], this.lab[i * 3 + 1], this.lab[i * 3 + 2]);
      if (d < best) {
        best = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  /** ΔE00 между двумя цветами палитры. */
  distance(i: number, j: number): number {
    const { lab } = this;
    return ciede2000(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2], lab[j * 3], lab[j * 3 + 1], lab[j * 3 + 2]);
  }
}

/** Точный поиск по палитре ниток, заданной цветами sRGB. */
export class PaletteMatcher extends LabMatcher {
  constructor(rgbs: ReadonlyArray<readonly [number, number, number]>) {
    const lab = new Float64Array(rgbs.length * 3);
    rgbs.forEach((rgb, i) => lab.set(rgb8ToLab(rgb), i * 3));
    super(lab);
  }
}
