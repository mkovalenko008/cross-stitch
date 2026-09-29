import { SRGB_TO_LINEAR, ciede2000, linearRgbToLab } from './color';
import type { GridColors } from './resize';

// Качество схемы: уборка одиночных крестиков, их доля и сходство с фото издалека.

/** Линейный RGB ниток: [r, g, b] × n. */
export function threadsLinear(rgbs: ReadonlyArray<readonly number[]>): Float32Array {
  const out = new Float32Array(rgbs.length * 3);
  rgbs.forEach((c, i) => {
    out[i * 3] = SRGB_TO_LINEAR[c[0]];
    out[i * 3 + 1] = SRGB_TO_LINEAR[c[1]];
    out[i * 3 + 2] = SRGB_TO_LINEAR[c[2]];
  });
  return out;
}

const N4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Сила уборки одиночных крестиков (в единицах ΔE2000) и число проходов — подобраны на тестовых картинках. */
export const DESPECKLE_BIAS = 2;
export const DESPECKLE_PASSES = 8;

/**
 * Уборка одиночных крестиков: клетка, у которой нет соседа того же цвета (по 4 сторонам),
 * перекрашивается в цвет одного из соседей, если это не портит средний цвет окрестности 3×3
 * по сравнению с исходником больше чем на bias (ΔE2000). Новых цветов не появляется.
 */
export function despeckle<T extends Int16Array | Int32Array>(
  assign: T,
  grid: GridColors,
  pal: Float32Array,
  passes = DESPECKLE_PASSES,
  bias = DESPECKLE_BIAS,
): T {
  const { cols, rows, lin, empty } = grid;
  const n = cols * rows;
  const out = assign.slice() as T;

  // целевой цвет окрестности 3×3 по исходнику, в Lab
  const target = new Float32Array(n * 3);
  const lab = new Float64Array(3);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (empty[i]) continue;
      let r = 0;
      let g = 0;
      let b = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= rows) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= cols) continue;
          const j = yy * cols + xx;
          if (empty[j]) continue;
          r += lin[j * 3];
          g += lin[j * 3 + 1];
          b += lin[j * 3 + 2];
          c++;
        }
      }
      linearRgbToLab(r / c, g / c, b / c, lab);
      target[i * 3] = lab[0];
      target[i * 3 + 1] = lab[1];
      target[i * 3 + 2] = lab[2];
    }
  }

  const neigh: number[] = [];
  // Первый проход — по всем клеткам; дальше — только по соседям изменившихся клеток:
  // их окрестность 3×3 поменялась, остальные клетки решение не изменят.
  let list: Int32Array = Int32Array.from({ length: n }, (_, i) => i);
  const stamp = new Int32Array(n);
  for (let p = 1; p <= passes && list.length > 0; p++) {
    const next: number[] = [];
    let changed = 0;
    for (let li = 0; li < list.length; li++) {
      const i = list[li];
      const v = out[i];
      if (v < 0) continue;
      const x = i % cols;
      const y = (i - x) / cols;
      neigh.length = 0;
      let same = false;
      for (const [dx, dy] of N4) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
        const u = out[yy * cols + xx];
        if (u < 0) continue;
        if (u === v) {
          same = true;
          break;
        }
        if (!neigh.includes(u)) neigh.push(u);
      }
      if (same || neigh.length === 0) continue;

      // сумма цветов схемы в окрестности 3×3 без центральной клетки
      let r = 0;
      let g = 0;
      let b = 0;
      let c = 1;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= rows) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= cols || (dx === 0 && dy === 0)) continue;
          const u = out[yy * cols + xx];
          if (u < 0) continue;
          r += pal[u * 3];
          g += pal[u * 3 + 1];
          b += pal[u * 3 + 2];
          c++;
        }
      }
      const tL = target[i * 3];
      const tA = target[i * 3 + 1];
      const tB = target[i * 3 + 2];
      let best = v;
      let bestD = Infinity;
      for (let k = -1; k < neigh.length; k++) {
        const cand = k < 0 ? v : neigh[k];
        linearRgbToLab((r + pal[cand * 3]) / c, (g + pal[cand * 3 + 1]) / c, (b + pal[cand * 3 + 2]) / c, lab);
        const d = ciede2000(tL, tA, tB, lab[0], lab[1], lab[2]) + (cand === v ? bias : 0);
        if (d < bestD) {
          bestD = d;
          best = cand;
        }
      }
      if (best !== v) {
        out[i] = best;
        changed++;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= rows) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= cols) continue;
            const j = yy * cols + xx;
            if (stamp[j] !== p) {
              stamp[j] = p;
              next.push(j);
            }
          }
        }
      }
    }
    if (!changed) break;
    list = Int32Array.from(next);
  }
  return out;
}

/** Доля непустых клеток без соседа того же цвета (по 4 сторонам) — «одиночные крестики». */
export function isolatedShare(cells: Int16Array | Int32Array, cols: number, rows: number): number {
  let total = 0;
  let isolated = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = cells[y * cols + x];
      if (v < 0) continue;
      total++;
      let same = false;
      for (const [dx, dy] of N4) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < cols && yy < rows && cells[yy * cols + xx] === v) {
          same = true;
          break;
        }
      }
      if (!same) isolated++;
    }
  }
  return total === 0 ? 0 : isolated / total;
}

/** Порог ΔE2000 для «сходства с фото»: разница, которую с расстояния почти не видно. */
export const SIMILARITY_DELTA_E = 3;

/**
 * Сходство с фото издалека: картинка и схема слегка размываются (гаусс 3×3 — так вышивку
 * видит глаз с обычного расстояния), и считается доля клеток, где разница ΔE2000 ≤ 3.
 */
export function farSimilarity(assign: Int16Array | Int32Array, grid: GridColors, pal: Float32Array): { share: number; meanDeltaE: number } {
  const { cols, rows, lin, empty } = grid;
  const W = [1, 2, 1];
  const a = new Float64Array(3);
  const b = new Float64Array(3);
  let total = 0;
  let ok = 0;
  let sum = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (empty[i]) continue;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let w = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= rows) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= cols) continue;
          const j = yy * cols + xx;
          const t = assign[j];
          if (empty[j] || t < 0) continue;
          const k = W[dx + 1] * W[dy + 1];
          sr += lin[j * 3] * k;
          sg += lin[j * 3 + 1] * k;
          sb += lin[j * 3 + 2] * k;
          pr += pal[t * 3] * k;
          pg += pal[t * 3 + 1] * k;
          pb += pal[t * 3 + 2] * k;
          w += k;
        }
      }
      linearRgbToLab(sr / w, sg / w, sb / w, a);
      linearRgbToLab(pr / w, pg / w, pb / w, b);
      const d = ciede2000(a[0], a[1], a[2], b[0], b[1], b[2]);
      total++;
      sum += d;
      if (d <= SIMILARITY_DELTA_E) ok++;
    }
  }
  return total === 0 ? { share: 1, meanDeltaE: 0 } : { share: ok / total, meanDeltaE: sum / total };
}
