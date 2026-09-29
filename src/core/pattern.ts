import { TARGET_ACCURACY, cleanupRareColors, colorAccuracy, minLadder } from './cleanup';
import { linearRgbToLab } from './color';
import { EntrySet } from './entries';
import { KdTree } from './kdtree';
import { LabMatcher, PaletteMatcher, type ColorSet } from './match';
import { despeckle, farSimilarity, isolatedShare, threadsLinear } from './quality';
import { resizeToGrid, type GridColors, type RgbaImage } from './resize';
import { SYMBOLS } from './symbols';
import type { Palette } from '../palettes';

/**
 * Каким получился рисунок схемы:
 * flat — только одиночные нитки (в каждом крестике 2 нитки одного цвета);
 * blend — есть смеси: в крестике по одной нитке двух цветов.
 */
export type PatternStyle = 'flat' | 'blend';

export interface PatternOptions {
  cols: number;
  rows: number;
  /** Минимум крестиков на цвет (по умолчанию 10). */
  minStitches: number;
  /** Прозрачные пиксели = пустые клетки. */
  transparentEmpty: boolean;
  /** Минимальное сходство с фото, 0..1 (по умолчанию 0.85). */
  minSimilarity?: number;
  /** Разрешить смеси — по одной нитке двух цветов в крестике (по умолчанию да). */
  blends?: boolean;
}

export const DEFAULT_MIN_SIMILARITY = 0.85;

export interface ThreadRef {
  code: string;
  name: string;
  rgb: [number, number, number];
}

export interface PatternColor {
  /** Номер нитки или смеси: «310», «939+3799». */
  code: string;
  name: string;
  /** Цвет в схеме (у смеси — смешанный цвет двух ниток). */
  rgb: [number, number, number];
  count: number;
  symbol: string;
  /** Нитки варианта: одна (2 сложения) или две (по одной нитке). */
  parts: ThreadRef[];
}

export interface Pattern {
  cols: number;
  rows: number;
  /** Индекс в colors для каждой клетки (строка за строкой), -1 = пустая клетка. */
  cells: Int16Array;
  /** Цвета схемы, по убыванию количества крестиков. */
  colors: PatternColor[];
  brand: Palette['brand'];
  paletteTitle: string;
  style: PatternStyle;
  /** Сколько вариантов в схеме — смеси двух ниток. */
  blendColors: number;
  /** Точность передачи цвета после чистки редких цветов, 0..1. */
  accuracy: number;
  /** Сходство с исходником издалека: доля клеток с ΔE2000 ≤ 3 после лёгкого размытия, 0..1. */
  similarity: number;
  /** Требуемое сходство, 0..1. */
  minSimilarity: number;
  /** Доля одиночных крестиков (без соседа того же цвета), 0..1. */
  isolated: number;
  /** Итоговый минимум крестиков на цвет. */
  minStitches: number;
  /** Сколько вариантов было в эталоне (до чистки). */
  referenceColors: number;
  stitches: number;
}

export type ProgressFn = (fraction: number, stage: string) => void;

/**
 * Лестница: 0 — только одиночные нитки; дальше — разрешены смеси двух ниток, которые
 * отличаются друг от друга не больше чем на столько ΔE2000. Чем выше ступень, тем больше
 * промежуточных оттенков и тем сильнее различаются нитки в одном крестике.
 * Выбирается самая низкая ступень, дающая нужное сходство с фото.
 */
export const BLEND_LEVELS: readonly number[] = [0, 8, 12, 16, 20, 25, 30, 40];

/** Больше этого подбор ступени идёт на уменьшенной копии сетки, а полная проверяется только в конце. */
const SEARCH_CELLS = 160_000;

// Кэш подбора для смесей: цвет клетки округляется до 7 бит на канал в sRGB (шаг 2/255,
// меньше заметной разницы), и ответ для этого оттенка запоминается.
const Q_BITS = 7;
const Q_LEVELS = 1 << Q_BITS;
const LIN_STEPS = 4096;
const LIN_TO_Q = (() => {
  const t = new Uint8Array(LIN_STEPS);
  for (let i = 0; i < LIN_STEPS; i++) {
    const v = i / (LIN_STEPS - 1);
    const srgb = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    t[i] = Math.min(Q_LEVELS - 1, Math.round(srgb * (Q_LEVELS - 1)));
  }
  return t;
})();
const Q_TO_LIN = (() => {
  const t = new Float64Array(Q_LEVELS);
  for (let i = 0; i < Q_LEVELS; i++) {
    const c = i / (Q_LEVELS - 1);
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/** Ступень, посчитанная для конкретной сетки: палитра вариантов и эталон. */
interface Level {
  set: ColorSet;
  /** Линейный RGB вариантов: [r, g, b] × size. */
  pal: Float32Array;
  /** Для каждого варианта — индексы ниток палитры. */
  parts: (i: number) => number[];
  rgb: (i: number) => [number, number, number];
  /** Эталон: вариант для каждой клетки (после уборки одиночных крестиков). */
  ref: Int32Array;
}

interface Stage {
  reference: Int32Array;
  final: Int32Array;
  accuracy: number;
  usedMin: number;
  similarity: number;
}

/** Ближайший вариант для каждой клетки с кэшем по оттенку (7 бит на канал). */
function nearestCached(g: GridColors, nearest: (L: number, a: number, b: number) => number, cache: Int32Array): Int32Array {
  const m = g.cols * g.rows;
  const out = new Int32Array(m);
  const lab = new Float64Array(3);
  for (let i = 0; i < m; i++) {
    if (g.empty[i]) {
      out[i] = -1;
      continue;
    }
    const qr = LIN_TO_Q[Math.round(g.lin[i * 3] * (LIN_STEPS - 1))];
    const qg = LIN_TO_Q[Math.round(g.lin[i * 3 + 1] * (LIN_STEPS - 1))];
    const qb = LIN_TO_Q[Math.round(g.lin[i * 3 + 2] * (LIN_STEPS - 1))];
    const key = (qr << (2 * Q_BITS)) | (qg << Q_BITS) | qb;
    let t = cache[key];
    if (t < 0) {
      linearRgbToLab(Q_TO_LIN[qr], Q_TO_LIN[qg], Q_TO_LIN[qb], lab);
      t = nearest(lab[0], lab[1], lab[2]);
      cache[key] = t;
    }
    out[i] = t;
  }
  return out;
}

const newCache = () => new Int32Array(Q_LEVELS * Q_LEVELS * Q_LEVELS).fill(-1);

/**
 * Выбор не больше max вариантов, которые лучше всего покрывают цвета картинки: взвешенная
 * кластеризация k-средних в Lab по использованным вариантам (вес — число клеток), затем для
 * каждого кластера — вариант, ближайший к его центру. Так варианты распределяются по всем
 * цветам картинки, а не скапливаются в самых частых.
 */
function selectEntries(ds: EntrySet, counts: Map<number, number>, max: number): number[] {
  const used = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]);
  if (used.length <= max) return used.map(([e]) => e);
  const m = used.length;
  const px = new Float64Array(m * 3);
  const w = new Float64Array(m);
  used.forEach(([e, c], i) => {
    px.set(ds.lab.subarray(e * 3, e * 3 + 3), i * 3);
    w[i] = c;
  });
  // начальные центры: самые частые варианты, но не ближе 1 ΔE друг к другу
  const k = max;
  const cent = new Float64Array(k * 3);
  let nc = 0;
  for (let i = 0; i < m && nc < k; i++) {
    let far = true;
    for (let j = 0; j < nc && far; j++) {
      const dx = px[i * 3] - cent[j * 3];
      const dy = px[i * 3 + 1] - cent[j * 3 + 1];
      const dz = px[i * 3 + 2] - cent[j * 3 + 2];
      if (dx * dx + dy * dy + dz * dz < 1) far = false;
    }
    if (far) cent.set(px.subarray(i * 3, i * 3 + 3), nc++ * 3);
  }
  for (let i = 0; nc < k && i < m; i++) cent.set(px.subarray(i * 3, i * 3 + 3), nc++ * 3);
  const assign = new Int32Array(m);
  const sum = new Float64Array(k * 4);
  for (let iter = 0; iter < 8; iter++) {
    const tree = new KdTree(cent.subarray(0, nc * 3));
    const one = new Int32Array(1);
    sum.fill(0);
    for (let i = 0; i < m; i++) {
      tree.knn(px[i * 3], px[i * 3 + 1], px[i * 3 + 2], 1, one);
      const c = one[0];
      assign[i] = c;
      sum[c * 4] += px[i * 3] * w[i];
      sum[c * 4 + 1] += px[i * 3 + 1] * w[i];
      sum[c * 4 + 2] += px[i * 3 + 2] * w[i];
      sum[c * 4 + 3] += w[i];
    }
    for (let c = 0; c < nc; c++) {
      const ws = sum[c * 4 + 3];
      if (ws > 0) {
        cent[c * 3] = sum[c * 4] / ws;
        cent[c * 3 + 1] = sum[c * 4 + 1] / ws;
        cent[c * 3 + 2] = sum[c * 4 + 2] / ws;
      }
    }
  }
  // для каждого кластера — вариант, ближайший к центру (по CIEDE2000 среди соседей по Lab)
  const kept = new Set<number>();
  for (let c = 0; c < nc; c++) if (sum[c * 4 + 3] > 0) kept.add(ds.nearest(cent[c * 3], cent[c * 3 + 1], cent[c * 3 + 2]));
  return [...kept];
}

export function buildPattern(img: RgbaImage, opts: PatternOptions, palette: Palette, onProgress?: ProgressFn): Pattern {
  const progress = onProgress ?? (() => {});
  const { cols, rows } = opts;
  const n = cols * rows;
  const minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const threads = palette.threads;
  const threadRgbs = threads.map((t) => t.rgb);

  // 1. Ресайз усреднением по площади в линейном RGB → Lab
  progress(0, 'Уменьшаю картинку до сетки');
  const grid = resizeToGrid(img, cols, rows, opts.transparentEmpty, (f) => progress(0.1 * f, 'Уменьшаю картинку до сетки'));

  // Ступени лестницы. Для смесей: плотный набор «все нитки + смеси близких пар» нужен, чтобы
  // выбрать до 618 вариантов (столько у нас символов), лучше всего покрывающих цвета этой картинки;
  // дальше выбранные варианты работают как обычная палитра.
  const dense = new Map<number, { set: EntrySet; cache: Int32Array }>();
  const singles = new PaletteMatcher(threadRgbs);
  const singlesPal = threadsLinear(threadRgbs);

  const evaluate = (g: GridColors, k: number): Level => {
    const maxPair = BLEND_LEVELS[k];
    if (maxPair === 0) {
      // только одиночные нитки: точная ближайшая по CIEDE2000 для каждой клетки
      const m = g.cols * g.rows;
      const ref = new Int32Array(m);
      for (let i = 0; i < m; i++) ref[i] = g.empty[i] ? -1 : singles.nearest(g.lab[i * 3], g.lab[i * 3 + 1], g.lab[i * 3 + 2]);
      return {
        set: singles,
        pal: singlesPal,
        parts: (i) => [i],
        rgb: (i) => threads[i].rgb,
        ref: despeckle(ref, g, singlesPal),
      };
    }
    let d = dense.get(k);
    if (!d) {
      d = { set: new EntrySet(threadRgbs, maxPair), cache: newCache() };
      dense.set(k, d);
    }
    const ds = d.set;
    // 1) ближайший вариант из плотного набора; 2) самые употребительные — не больше, чем символов
    const denseRef = nearestCached(g, (L, a, b) => ds.nearest(L, a, b), d.cache);
    const counts = new Map<number, number>();
    for (const v of denseRef) if (v >= 0) counts.set(v, (counts.get(v) ?? 0) + 1);
    const kept = selectEntries(ds, counts, SYMBOLS.length);
    const lab = new Float64Array(kept.length * 3);
    const pal = new Float32Array(kept.length * 3);
    kept.forEach((e, i) => {
      lab.set(ds.lab.subarray(e * 3, e * 3 + 3), i * 3);
      pal.set(ds.lin.subarray(e * 3, e * 3 + 3), i * 3);
    });
    // 3) эталон: точная ближайшая по CIEDE2000 среди выбранных вариантов
    const set = new LabMatcher(lab);
    const ref = nearestCached(g, (L, a, b) => set.nearest(L, a, b), newCache());
    return {
      set,
      pal,
      parts: (i) => [...ds.parts[kept[i]]],
      rgb: (i) => ds.rgb(kept[i]),
      ref: despeckle(ref, g, pal),
    };
  };

  // 5–6. Чистка редких цветов; если точность < 99,9% — уменьшаем минимум (не ниже 2)
  const clean = (g: GridColors, lv: Level): Stage => {
    const ladder = minLadder(opts.minStitches);
    let final: Int32Array = lv.ref;
    let accuracy = 1;
    let usedMin = ladder[0];
    for (const min of ladder) {
      usedMin = min;
      final = cleanupRareColors(lv.ref, g.lab, lv.set, min, SYMBOLS.length);
      accuracy = colorAccuracy(final, lv.ref, lv.set);
      if (accuracy >= TARGET_ACCURACY) break;
    }
    return { reference: lv.ref, final, accuracy, usedMin, similarity: farSimilarity(final, g, lv.pal).share };
  };

  // Самая низкая ступень, у которой сходство с фото не ниже заданного (двоичный поиск).
  const last = opts.blends === false ? 0 : BLEND_LEVELS.length - 1;
  const searchGrid =
    n > SEARCH_CELLS
      ? resizeToGrid(
          img,
          Math.max(20, Math.round(cols * Math.sqrt(SEARCH_CELLS / n))),
          Math.max(1, Math.round(rows * Math.sqrt(SEARCH_CELLS / n))),
          opts.transparentEmpty,
        )
      : grid;
  let evals = 0;
  const simCache = new Map<number, number>();
  const simAt = (k: number) => {
    let sim = simCache.get(k);
    if (sim === undefined) {
      progress(0.1 + 0.12 * Math.min(evals, 5), `Подбираю нитки для сходства от ${Math.round(minSimilarity * 100)}% (${++evals})`);
      const lv = evaluate(searchGrid, k);
      sim = farSimilarity(lv.ref, searchGrid, lv.pal).share;
      simCache.set(k, sim);
    }
    return sim;
  };
  let lo = 0;
  let hi = minSimilarity <= 0 ? 0 : last;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (simAt(mid) >= minSimilarity) hi = mid;
    else lo = mid + 1;
  }
  let k = lo;

  progress(0.75, 'Строю схему');
  let lv = evaluate(grid, k);
  let result = clean(grid, lv);
  while (result.similarity < minSimilarity && k < last) {
    k++;
    progress(0.85, 'Уточняю: нужно больше сходства');
    lv = evaluate(grid, k);
    result = clean(grid, lv);
  }
  const { final, accuracy, usedMin, similarity } = result;
  progress(0.95, 'Считаю цвета');

  // 7. Цвета по убыванию частоты, самые частые получают самые простые символы
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) if (final[i] >= 0) counts.set(final[i], (counts.get(final[i]) ?? 0) + 1);
  const used = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const toLocal = new Map<number, number>();
  let blendColors = 0;
  const colors: PatternColor[] = used.map(([ei, count], i) => {
    toLocal.set(ei, i);
    const parts: ThreadRef[] = lv.parts(ei).map((ti) => ({ code: threads[ti].code, name: threads[ti].name, rgb: threads[ti].rgb }));
    if (parts.length > 1) blendColors++;
    return {
      code: parts.map((p) => p.code).join('+'),
      name: parts.length === 1 ? parts[0].name : parts.map((p) => p.name || `${palette.title} ${p.code}`).join(' + '),
      rgb: lv.rgb(ei),
      count,
      symbol: SYMBOLS[i],
      parts,
    };
  });
  const cells = new Int16Array(n);
  for (let i = 0; i < n; i++) cells[i] = final[i] < 0 ? -1 : toLocal.get(final[i])!;

  progress(1, 'Готово');
  return {
    cols,
    rows,
    cells,
    colors,
    brand: palette.brand,
    paletteTitle: palette.title,
    style: blendColors > 0 ? 'blend' : 'flat',
    blendColors,
    accuracy,
    similarity,
    minSimilarity,
    isolated: isolatedShare(cells, cols, rows),
    minStitches: usedMin,
    referenceColors: new Set(result.reference.filter((r) => r >= 0)).size,
    stitches: used.reduce((s, [, c]) => s + c, 0),
  };
}
