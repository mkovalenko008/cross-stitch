import { SRGB_TO_LINEAR, ciede2000, linearRgbToLab } from './color';
import type { PaletteMatcher } from './match';
import type { GridColors } from './resize';

// Стиль «Как на фото»: цвета, которых нет среди ниток, передаются смесью соседних крестиков
// (рассеивание ошибки), а затем одиночные крестики убираются — так, чтобы средний цвет
// окрестности (то, что видно с расстояния) почти не менялся.

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

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Кэш ближайших ниток для дизеринга: цвет с учётом ошибки округляется до 7 бит на канал
// в sRGB (шаг 2/255 — меньше заметной разницы), и ответ для этого оттенка запоминается.
// Небольшая неточность выбора не накапливается: ошибка считается от настоящего цвета клетки
// и переносится на соседей.
const Q_BITS = 7;
const Q_LEVELS = 1 << Q_BITS;
const LIN_STEPS = 4096;
/** линейный 0..1 (шаг 1/4095) → уровень sRGB 0..127 */
const LIN_TO_Q = (() => {
  const t = new Uint8Array(LIN_STEPS);
  for (let i = 0; i < LIN_STEPS; i++) {
    const v = i / (LIN_STEPS - 1);
    const srgb = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    t[i] = Math.min(Q_LEVELS - 1, Math.round(srgb * (Q_LEVELS - 1)));
  }
  return t;
})();
/** уровень sRGB 0..127 → линейный */
const Q_TO_LIN = (() => {
  const t = new Float64Array(Q_LEVELS);
  for (let i = 0; i < Q_LEVELS; i++) {
    const c = i / (Q_LEVELS - 1);
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/**
 * Кэш «оттенок (7 бит на канал) → ближайшая нитка» для одной палитры. Не зависит от настроек
 * дизеринга, поэтому его можно передавать в несколько вызовов ditherAssign подряд.
 */
export function createNearestCache(): Int16Array {
  return new Int16Array(Q_LEVELS * Q_LEVELS * Q_LEVELS).fill(-1);
}

/**
 * Рассеивание ошибки Флойда–Стейнберга в линейном RGB, змейкой (чётные строки слева направо,
 * нечётные — справа налево), ближайшая нитка — по CIEDE2000. Пустые клетки пропускаются,
 * ошибка в них не переносится.
 *
 * runDelta > 0 — отрезки от двух крестиков: если в строке начинается новый цвет и сверху
 * нет такого же, следующая клетка берёт тот же цвет, когда он хуже лучшей нитки для неё
 * не больше чем на runDelta (ΔE2000). Ошибка при этом переносится на соседей как обычно,
 * поэтому средний цвет сохраняется, а одиночных крестиков становится намного меньше.
 * runDelta = Infinity — отрезок продлевается всегда, 0 — обычный дизеринг.
 */
export function ditherAssign(
  grid: GridColors,
  matcher: PaletteMatcher,
  pal: Float32Array,
  runDelta = 0,
  onProgress?: (fraction: number) => void,
  cache: Int16Array = createNearestCache(),
): Int16Array {
  const { cols, rows, lin, empty } = grid;
  const err = new Float32Array(lin);
  const out = new Int16Array(cols * rows).fill(-1);
  const lab = new Float64Array(3);
  const pl = matcher.lab;
  const W1 = 7 / 16;
  const W2 = 3 / 16;
  const W3 = 5 / 16;
  const W4 = 1 / 16;

  for (let y = 0; y < rows; y++) {
    const ltr = (y & 1) === 0;
    const dir = ltr ? 1 : -1;
    const hasNext = y + 1 < rows;
    let force = -1; // цвет, которым надо продлить начатый отрезок
    for (let s = 0; s < cols; s++) {
      const x = ltr ? s : cols - 1 - s;
      const i = y * cols + x;
      if (empty[i]) {
        force = -1;
        continue;
      }
      const r = clamp01(err[i * 3]);
      const g = clamp01(err[i * 3 + 1]);
      const b = clamp01(err[i * 3 + 2]);
      const qr = LIN_TO_Q[Math.round(r * (LIN_STEPS - 1))];
      const qg = LIN_TO_Q[Math.round(g * (LIN_STEPS - 1))];
      const qb = LIN_TO_Q[Math.round(b * (LIN_STEPS - 1))];
      const key = (qr << (2 * Q_BITS)) | (qg << Q_BITS) | qb;
      let t = cache[key];
      if (t < 0) {
        linearRgbToLab(Q_TO_LIN[qr], Q_TO_LIN[qg], Q_TO_LIN[qb], lab);
        t = matcher.nearest(lab[0], lab[1], lab[2]);
        cache[key] = t;
      }
      if (force >= 0) {
        if (force !== t) {
          linearRgbToLab(r, g, b, lab);
          const dBest = ciede2000(lab[0], lab[1], lab[2], pl[t * 3], pl[t * 3 + 1], pl[t * 3 + 2]);
          const dForce = ciede2000(lab[0], lab[1], lab[2], pl[force * 3], pl[force * 3 + 1], pl[force * 3 + 2]);
          if (dForce <= dBest + runDelta) t = force;
        }
        force = -1;
      } else if (runDelta > 0) {
        // начинается новый отрезок? (цвет не как у предыдущей клетки в строке и не как сверху)
        const xp = x - dir;
        const prev = xp >= 0 && xp < cols ? out[i - dir] : -1;
        const up = y > 0 ? out[i - cols] : -1;
        const xn = x + dir;
        if (t !== prev && t !== up && xn >= 0 && xn < cols && !empty[i + dir]) force = t;
      }
      out[i] = t;
      const er = r - pal[t * 3];
      const eg = g - pal[t * 3 + 1];
      const eb = b - pal[t * 3 + 2];
      // вправо по ходу строки
      const xa = x + dir;
      if (xa >= 0 && xa < cols) {
        const j = i + dir;
        if (!empty[j]) {
          err[j * 3] += er * W1;
          err[j * 3 + 1] += eg * W1;
          err[j * 3 + 2] += eb * W1;
        }
      }
      if (hasNext) {
        const below = i + cols;
        // назад-вниз, вниз, вперёд-вниз
        const xb = x - dir;
        if (xb >= 0 && xb < cols && !empty[below - dir]) {
          const j = below - dir;
          err[j * 3] += er * W2;
          err[j * 3 + 1] += eg * W2;
          err[j * 3 + 2] += eb * W2;
        }
        if (!empty[below]) {
          err[below * 3] += er * W3;
          err[below * 3 + 1] += eg * W3;
          err[below * 3 + 2] += eb * W3;
        }
        if (xa >= 0 && xa < cols && !empty[below + dir]) {
          const j = below + dir;
          err[j * 3] += er * W4;
          err[j * 3 + 1] += eg * W4;
          err[j * 3 + 2] += eb * W4;
        }
      }
    }
    if (onProgress && (y & 15) === 0) onProgress(y / rows);
  }
  onProgress?.(1);
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
export function despeckle(
  assign: Int16Array,
  grid: GridColors,
  pal: Float32Array,
  passes = DESPECKLE_PASSES,
  bias = DESPECKLE_BIAS,
): Int16Array {
  const { cols, rows, lin, empty } = grid;
  const n = cols * rows;
  const out = assign.slice();

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
export function isolatedShare(cells: Int16Array, cols: number, rows: number): number {
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
export function farSimilarity(assign: Int16Array, grid: GridColors, pal: Float32Array): { share: number; meanDeltaE: number } {
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
