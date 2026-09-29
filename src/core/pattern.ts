import { TARGET_ACCURACY, cleanupRareColors, colorAccuracy, minLadder } from './cleanup';
import { PaletteMatcher } from './match';
import { resizeToGrid, type RgbaImage } from './resize';
import { SYMBOLS } from './symbols';
import type { Palette } from '../palettes';

export interface PatternOptions {
  cols: number;
  rows: number;
  /** Минимум крестиков на цвет (по умолчанию 10). */
  minStitches: number;
  /** Прозрачные пиксели = пустые клетки. */
  transparentEmpty: boolean;
}

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
  /** Точность передачи цвета, 0..1. */
  accuracy: number;
  /** Итоговый минимум крестиков на цвет. */
  minStitches: number;
  /** Сколько цветов было в эталоне (до чистки). */
  referenceColors: number;
  stitches: number;
}

export type ProgressFn = (fraction: number, stage: string) => void;

export function buildPattern(img: RgbaImage, opts: PatternOptions, palette: Palette, onProgress?: ProgressFn): Pattern {
  const progress = onProgress ?? (() => {});
  const { cols, rows } = opts;

  // 1. Ресайз усреднением по площади в линейном RGB → Lab
  progress(0, 'Уменьшаю картинку до сетки');
  const grid = resizeToGrid(img, cols, rows, opts.transparentEmpty, (f) => progress(0.3 * f, 'Уменьшаю картинку до сетки'));

  // 2–3. Эталон: ближайшая нитка по CIEDE2000 для каждой клетки
  const matcher = new PaletteMatcher(palette.threads.map((t) => t.rgb));
  const n = cols * rows;
  const reference = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    reference[i] = grid.empty[i] ? -1 : matcher.nearest(grid.lab[i * 3], grid.lab[i * 3 + 1], grid.lab[i * 3 + 2]);
    if ((i & 1023) === 0) progress(0.3 + (0.6 * i) / n, 'Подбираю нитки');
  }

  // 5–6. Чистка редких цветов; если точность < 99% — уменьшаем минимум
  const ladder = minLadder(opts.minStitches);
  let final: Int16Array = reference;
  let accuracy = 1;
  let usedMin = ladder[0];
  for (let k = 0; k < ladder.length; k++) {
    progress(0.9 + (0.1 * k) / ladder.length, 'Убираю редкие цвета');
    usedMin = ladder[k];
    final = cleanupRareColors(reference, grid.lab, matcher, usedMin, SYMBOLS.length);
    accuracy = colorAccuracy(final, reference, matcher);
    if (accuracy >= TARGET_ACCURACY) break;
  }

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
    accuracy,
    minStitches: usedMin,
    referenceColors: new Set(reference.filter((r) => r >= 0)).size,
    stitches: used.reduce((s, [, c]) => s + c, 0),
  };
}
