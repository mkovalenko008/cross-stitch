import { TARGET_ACCURACY, cleanupRareColors, colorAccuracy, minLadder } from './cleanup';
import { DESPECKLE_PASSES, createNearestCache, despeckle, ditherAssign, farSimilarity, isolatedShare, threadsLinear } from './dither';
import { PaletteMatcher } from './match';
import { resizeToGrid, type GridColors, type RgbaImage } from './resize';
import { SYMBOLS } from './symbols';
import type { Palette } from '../palettes';

/**
 * Каким получился рисунок схемы:
 * flat — ровные пятна: каждая клетка — ближайшая нитка, цвета не смешиваются;
 * smooth — плавные переходы: оттенки между нитками собраны из соседних крестиков.
 */
export type PatternStyle = 'smooth' | 'flat';

export interface PatternOptions {
  cols: number;
  rows: number;
  /** Минимум крестиков на цвет (по умолчанию 10). */
  minStitches: number;
  /** Прозрачные пиксели = пустые клетки. */
  transparentEmpty: boolean;
  /** Минимальное сходство с фото, 0..1 (по умолчанию 0.85). 0 — всегда ровные пятна. */
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
  /** Требуемое сходство, 0..1. */
  minSimilarity: number;
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
 * Лестница вариантов — от самого аккуратного к самому точному.
 * Первая ступень — ровные пятна (ближайшая нитка для каждой клетки, без смешивания).
 * Дальше — плавные переходы: run — допуск продления отрезков в дизеринге (см. ditherAssign),
 * bias — сила уборки одиночных крестиков (undefined — без уборки). Подобраны на тестовых
 * картинках: вверх по лестнице растут и сходство с фото, и доля одиночных крестиков.
 */
export const LEVELS: ReadonlyArray<{ flat: true } | { flat?: false; run: number; bias?: number }> = [
  { flat: true },
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

/** Больше этого подбор ступени идёт на уменьшенной копии сетки, а полная проверяется только в конце. */
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
  const minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  // 1. Ресайз усреднением по площади в линейном RGB → Lab
  progress(0, 'Уменьшаю картинку до сетки');
  const grid = resizeToGrid(img, cols, rows, opts.transparentEmpty, (f) => progress(0.1 * f, 'Уменьшаю картинку до сетки'));
  const matcher = new PaletteMatcher(palette.threads.map((t) => t.rgb));
  const pal = threadsLinear(palette.threads.map((t) => t.rgb));
  const nearestCache = createNearestCache(); // для дизеринга; общий для всех ступеней и сеток

  // 2–4. Эталон для ступени k
  const reference = (g: GridColors, k: number, report?: (f: number) => void): Int16Array => {
    const lv = LEVELS[k];
    if (lv.flat) {
      // ровные пятна: точная ближайшая нитка по CIEDE2000 для каждой клетки
      const m = g.cols * g.rows;
      const ref = new Int16Array(m);
      for (let i = 0; i < m; i++) {
        ref[i] = g.empty[i] ? -1 : matcher.nearest(g.lab[i * 3], g.lab[i * 3 + 1], g.lab[i * 3 + 2]);
        if (report && (i & 4095) === 0) report(i / m);
      }
      return ref;
    }
    const ref = ditherAssign(g, matcher, pal, lv.run, report, nearestCache);
    return lv.bias === undefined ? ref : despeckle(ref, g, pal, DESPECKLE_PASSES, lv.bias);
  };

  // 5–6. Чистка редких цветов; если точность < 99,9% — уменьшаем минимум (не ниже 2)
  const clean = (g: GridColors, ref: Int16Array): Stage => {
    const ladder = minLadder(opts.minStitches);
    let final: Int16Array = ref;
    let accuracy = 1;
    let usedMin = ladder[0];
    for (const min of ladder) {
      usedMin = min;
      final = cleanupRareColors(ref, g.lab, matcher, min, SYMBOLS.length);
      accuracy = colorAccuracy(final, ref, matcher);
      if (accuracy >= TARGET_ACCURACY) break;
    }
    return { reference: ref, final, accuracy, usedMin, similarity: farSimilarity(final, g, pal).share };
  };

  // Самая аккуратная ступень, у которой сходство с фото не ниже заданного (двоичный поиск).
  // При подборе чистка редких цветов не делается: она меняет сходство на десятые доли процента.
  const last = LEVELS.length - 1;
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
      progress(0.1 + 0.12 * Math.min(evals, 5), `Подбираю вариант со сходством от ${Math.round(minSimilarity * 100)}% (${++evals})`);
      sim = farSimilarity(reference(searchGrid, k), searchGrid, pal).share;
      simCache.set(k, sim);
    }
    return sim;
  };
  let lo = 0;
  let hi = minSimilarity <= 0 ? 0 : last; // порог 0 — сразу ровные пятна
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (simAt(mid) >= minSimilarity) hi = mid;
    else lo = mid + 1;
  }
  let level = lo;

  progress(0.75, 'Строю схему');
  let result = clean(grid, reference(grid, level, (f) => progress(0.75 + 0.1 * f, 'Строю схему')));
  while (result.similarity < minSimilarity && level < last) {
    level++;
    progress(0.85, 'Уточняю: нужно больше сходства');
    result = clean(grid, reference(grid, level));
  }
  const { final, accuracy, usedMin, similarity } = result;
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
    style: LEVELS[level].flat ? 'flat' : 'smooth',
    accuracy,
    similarity,
    minSimilarity,
    isolated: isolatedShare(cells, cols, rows),
    minStitches: usedMin,
    referenceColors: new Set(result.reference.filter((r) => r >= 0)).size,
    stitches: used.reduce((s, [, c]) => s + c, 0),
  };
}
