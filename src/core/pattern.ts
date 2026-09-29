import { TARGET_ACCURACY, cleanupRareColors, colorAccuracy, minLadder } from './cleanup';
import { DESPECKLE_PASSES, createNearestCache, despeckle, ditherAssign, farSimilarity, isolatedShare, threadsLinear } from './dither';
import { PaletteMatcher } from './match';
import { resizeToGrid, type GridColors, type RgbaImage } from './resize';
import { SYMBOLS } from './symbols';
import type { Palette } from '../palettes';

/**
 * smooth — «Как на фото»: плавные переходы смесью соседних крестиков, одиночные крестики убраны;
 * flat — «Ровные пятна»: каждая клетка — ближайшая нитка, без дизеринга.
 */
export type PatternStyle = 'smooth' | 'flat';

export interface PatternOptions {
  cols: number;
  rows: number;
  /** Минимум крестиков на цвет (по умолчанию 10). */
  minStitches: number;
  /** Прозрачные пиксели = пустые клетки. */
  transparentEmpty: boolean;
  style: PatternStyle;
  /** Для «Как на фото»: минимальное сходство с фото, 0..1 (по умолчанию 0.85). */
  minSimilarity?: number;
}

export const DEFAULT_MIN_SIMILARITY = 0.85;

export interface PatternColor {
  code: string;
  name: string;
  rgb: [number, number, number];
  count: number;
  symbol: string;
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
  /** Точность передачи цвета после чистки редких цветов, 0..1. */
  accuracy: number;
  /** Сходство с исходником издалека: доля клеток с ΔE2000 ≤ 3 после лёгкого размытия, 0..1. */
  similarity: number;
  /** Требуемое сходство (только «Как на фото»), 0..1. */
  minSimilarity?: number;
  /** Доля одиночных крестиков (без соседа того же цвета), 0..1. */
  isolated: number;
  /** Итоговый минимум крестиков на цвет. */
  minStitches: number;
  /** Сколько цветов было в эталоне (до чистки). */
  referenceColors: number;
  stitches: number;
}

export type ProgressFn = (fraction: number, stage: string) => void;

/**
 * Уровни для «Как на фото» — от самого чистого (меньше всего одиночных крестиков) к самому
 * точному. run — допуск продления отрезков в дизеринге (см. ditherAssign), bias — сила
 * уборки одиночных крестиков (undefined — без уборки). Подобраны на тестовых картинках:
 * по ним сходство растёт, а доля одиночных крестиков — тоже.
 */
export const SMOOTH_LEVELS: ReadonlyArray<{ run: number; bias?: number }> = [
  { run: Infinity, bias: 2 },
  { run: 24, bias: 1 },
  { run: 16, bias: 1 },
  { run: 12, bias: 1 },
  { run: 12, bias: 0.35 },
  { run: 8, bias: 0.7 },
  { run: 8, bias: 0.35 },
  { run: 4, bias: 0 },
  { run: 0 },
];

/** Больше этого поиск уровня идёт на уменьшенной копии сетки, а полная проверяется только в конце. */
const SEARCH_CELLS = 160_000;

interface Stage {
  reference: Int16Array;
  final: Int16Array;
  accuracy: number;
  usedMin: number;
  similarity: number;
}

export function buildPattern(img: RgbaImage, opts: PatternOptions, palette: Palette, onProgress?: ProgressFn): Pattern {
  const progress = onProgress ?? (() => {});
  const { cols, rows } = opts;
  const n = cols * rows;

  // 1. Ресайз усреднением по площади в линейном RGB → Lab
  progress(0, 'Уменьшаю картинку до сетки');
  const grid = resizeToGrid(img, cols, rows, opts.transparentEmpty, (f) => progress(0.1 * f, 'Уменьшаю картинку до сетки'));
  const matcher = new PaletteMatcher(palette.threads.map((t) => t.rgb));
  const pal = threadsLinear(palette.threads.map((t) => t.rgb));

  // 5–6. Чистка редких цветов; если точность < 99,9% — уменьшаем минимум (не ниже 2)
  const clean = (g: GridColors, reference: Int16Array): Stage => {
    const ladder = minLadder(opts.minStitches);
    let final: Int16Array = reference;
    let accuracy = 1;
    let usedMin = ladder[0];
    for (const min of ladder) {
      usedMin = min;
      final = cleanupRareColors(reference, g.lab, matcher, min, SYMBOLS.length);
      accuracy = colorAccuracy(final, reference, matcher);
      if (accuracy >= TARGET_ACCURACY) break;
    }
    return { reference, final, accuracy, usedMin, similarity: farSimilarity(final, g, pal).share };
  };

  let result: Stage;
  let level: number | undefined;
  const minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  if (opts.style === 'smooth') {
    // 2–4. Дизеринг с отрезками и уборкой одиночных крестиков. Берём самый чистый уровень,
    // при котором сходство с фото не ниже заданного; если не дотягивает даже самый точный — его.
    // При подборе чистка редких цветов не делается (она меняет сходство на десятые доли процента),
    // итог с чисткой проверяется в конце.
    const nearestCache = createNearestCache(); // общий для всех уровней и сеток: зависит только от палитры
    const reference = (g: GridColors, k: number): Int16Array => {
      const lv = SMOOTH_LEVELS[k];
      const ref = ditherAssign(g, matcher, pal, lv.run, undefined, nearestCache);
      return lv.bias === undefined ? ref : despeckle(ref, g, pal, DESPECKLE_PASSES, lv.bias);
    };
    const last = SMOOTH_LEVELS.length - 1;
    let evals = 0;
    const search = (g: GridColors): number => {
      const cache = new Map<number, number>();
      const at = (k: number) => {
        let sim = cache.get(k);
        if (sim === undefined) {
          progress(0.1 + 0.12 * evals, `Подбираю баланс сходства и одиночных крестиков (${++evals})`);
          sim = farSimilarity(reference(g, k), g, pal).share;
          cache.set(k, sim);
        }
        return sim;
      };
      let lo = 0;
      let hi = last;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (at(mid) >= minSimilarity) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    // большие сетки: подбор на уменьшенной копии, итог — на полной
    const searchGrid =
      n > SEARCH_CELLS
        ? resizeToGrid(img, Math.max(20, Math.round(cols * Math.sqrt(SEARCH_CELLS / n))), Math.max(1, Math.round(rows * Math.sqrt(SEARCH_CELLS / n))), opts.transparentEmpty)
        : grid;
    level = search(searchGrid);
    progress(0.75, 'Строю схему');
    result = clean(grid, reference(grid, level));
    while (result.similarity < minSimilarity && level < last) {
      level++;
      progress(0.85, 'Уточняю: нужно больше сходства');
      result = clean(grid, reference(grid, level));
    }
  } else {
    // «Ровные пятна»: эталон — ближайшая нитка по CIEDE2000 для каждой клетки
    const reference = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      reference[i] = grid.empty[i] ? -1 : matcher.nearest(grid.lab[i * 3], grid.lab[i * 3 + 1], grid.lab[i * 3 + 2]);
      if ((i & 1023) === 0) progress(0.1 + (0.7 * i) / n, 'Подбираю нитки');
    }
    result = clean(grid, reference);
  }
  const { reference, final, accuracy, usedMin, similarity } = result!;
  progress(0.95, 'Считаю цвета');

  // 7. Цвета по убыванию частоты, самые частые получают самые простые символы
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) if (final[i] >= 0) counts.set(final[i], (counts.get(final[i]) ?? 0) + 1);
  const used = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const toLocal = new Map<number, number>();
  const colors: PatternColor[] = used.map(([pi, count], i) => {
    toLocal.set(pi, i);
    const t = palette.threads[pi];
    return { code: t.code, name: t.name, rgb: t.rgb, count, symbol: SYMBOLS[i] };
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
    style: opts.style,
    accuracy,
    similarity,
    ...(opts.style === 'smooth' ? { minSimilarity } : {}),
    isolated: isolatedShare(cells, cols, rows),
    minStitches: usedMin,
    referenceColors: new Set(reference.filter((r) => r >= 0)).size,
    stitches: used.reduce((s, [, c]) => s + c, 0),
  };
}
