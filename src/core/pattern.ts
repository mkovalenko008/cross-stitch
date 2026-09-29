import { TARGET_ACCURACY, cleanupRareColors, colorAccuracy, minLadder } from './cleanup';
import { ciede2000, linearToSrgb8 } from './color';
import { EntrySet } from './entries';
import { KdTree } from './kdtree';
import { LabMatcher, PaletteMatcher } from './match';
import { despeckle, farSimilarity, isolatedShare } from './quality';
import { resizeToGrid, type GridColors, type RgbaImage } from './resize';
import { SYMBOLS } from './symbols';
import type { Palette } from '../palettes';

/**
 * Каким получился рисунок схемы:
 * flat — только обычные нитки (в каждом крестике 2 нитки одного цвета);
 * blend — есть смеси: в крестике по одной нитке двух цветов.
 */
export type PatternStyle = 'flat' | 'blend';

/**
 * Смеси (по одной нитке двух цветов в крестике):
 * none — не использовать;
 * rare — только в исключительных случаях: где ни одна нитка не подходит, и немного;
 * needed — столько, сколько нужно для заданного сходства с фото.
 * Во всех режимах основа — обычные нитки: смесь ставится, только если обычная нитка
 * заметно отличается от нужного цвета, а смесь даёт явно лучше.
 */
export type BlendMode = 'none' | 'rare' | 'needed';

export interface PatternOptions {
  cols: number;
  rows: number;
  /** Минимум крестиков на цвет (по умолчанию 10). */
  minStitches: number;
  /** Прозрачные пиксели = пустые клетки. */
  transparentEmpty: boolean;
  /** Минимальное сходство с фото, 0..1 (по умолчанию 0.85). */
  minSimilarity?: number;
  /** Смеси ниток (по умолчанию — только в исключительных случаях). */
  blendMode?: BlendMode;
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
  blendMode: BlendMode;
  /** Сколько цветов схемы — смеси двух ниток. */
  blendColors: number;
  /** Доля крестиков, вышитых смесями, 0..1. */
  blendShare: number;
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
 * Правила для смесей. tau — смесь рассматривается, только если ближайшая обычная нитка
 * отличается от цвета клетки больше чем на столько ΔE2000; gain — насколько смесь должна
 * быть ближе; budgets — сколько разных смесей пробовать (по порядку, пока сходство не станет
 * не ниже заданного).
 */
export const BLEND_RULES: Record<Exclude<BlendMode, 'none'>, { tau: number; gain: number; budgets: number[] }> = {
  rare: { tau: 6, gain: 3, budgets: [0, 5, 10, 20] },
  needed: { tau: 3, gain: 1.5, budgets: [0, 10, 20, 40, 80, 150, 300] },
};

/** Смеси собираются из пар ниток, отличающихся не больше чем на столько ΔE2000. */
export const MAX_BLEND_PAIR_DE = 30;

/** Больше этого подбор числа смесей идёт на уменьшенной копии сетки, а полная считается в конце. */
const SEARCH_CELLS = 160_000;

interface Plan {
  /** Индексы выбранных смесей в плотном наборе. */
  blends: number[];
  /** Вариант для каждой клетки: 0…T−1 — нитки, T… — выбранные смеси; после уборки одиночных. */
  ref: Int32Array;
  lab: Float64Array;
  pal: Float32Array;
  similarity: number;
}

export function buildPattern(img: RgbaImage, opts: PatternOptions, palette: Palette, onProgress?: ProgressFn): Pattern {
  const progress = onProgress ?? (() => {});
  const { cols, rows } = opts;
  const n = cols * rows;
  const minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const blendMode: BlendMode = opts.blendMode ?? 'rare';
  const threads = palette.threads;
  const T = threads.length;
  const threadRgbs = threads.map((t) => t.rgb);

  // 1. Ресайз усреднением по площади в линейном RGB → Lab
  progress(0, 'Уменьшаю картинку до сетки');
  const grid = resizeToGrid(img, cols, rows, opts.transparentEmpty, (f) => progress(0.1 * f, 'Уменьшаю картинку до сетки'));
  const singles = new PaletteMatcher(threadRgbs);
  // плотный набор «все нитки + смеси пар» нужен только чтобы находить смеси для редких оттенков
  let dense: EntrySet | null = null;
  const denseSet = () => (dense ??= new EntrySet(threadRgbs, MAX_BLEND_PAIR_DE));

  // 2–3. Для каждой клетки — ближайшая обычная нитка по CIEDE2000 (точный поиск) и её ошибка.
  // На очень больших сетках (больше SEARCH_CELLS) ответ запоминается для оттенка клетки,
  // округлённого до 8 бит на канал в sRGB, — разница с точным поиском возможна только
  // на самой границе между двумя нитками.
  const cache8 = new Map<number, number>();
  const nearestSingles = (g: GridColors) => {
    const m = g.cols * g.rows;
    const idx = new Int32Array(m);
    const err = new Float32Array(m);
    const useCache = m > SEARCH_CELLS;
    for (let i = 0; i < m; i++) {
      if (g.empty[i]) {
        idx[i] = -1;
        continue;
      }
      const L = g.lab[i * 3];
      const a = g.lab[i * 3 + 1];
      const b = g.lab[i * 3 + 2];
      let s: number;
      if (useCache) {
        const key = (linearToSrgb8(g.lin[i * 3]) << 16) | (linearToSrgb8(g.lin[i * 3 + 1]) << 8) | linearToSrgb8(g.lin[i * 3 + 2]);
        const hit = cache8.get(key);
        if (hit === undefined) {
          s = singles.nearest(L, a, b);
          cache8.set(key, s);
        } else s = hit;
      } else s = singles.nearest(L, a, b);
      idx[i] = s;
      err[i] = ciede2000(L, a, b, singles.lab[s * 3], singles.lab[s * 3 + 1], singles.lab[s * 3 + 2]);
    }
    return { idx, err };
  };

  // Вариант схемы с не больше чем budget разными смесями
  const plan = (g: GridColors, s: { idx: Int32Array; err: Float32Array }, budget: number, tau: number, gain: number): Plan => {
    const m = g.cols * g.rows;
    const blends: number[] = [];
    // клетки, для которых обычная нитка явно не подходит
    const bad: number[] = [];
    if (budget > 0) for (let i = 0; i < m; i++) if (s.idx[i] >= 0 && s.err[i] > tau) bad.push(i);
    if (bad.length) {
      const ds = denseSet();
      // их цвета — в budget групп (k-средних), для центра каждой группы — ближайшая смесь,
      // если она заметно лучше ближайшей обычной нитки
      const centers = kMeans(g.lab, bad, Math.min(budget, bad.length));
      for (let c = 0; c < centers.length / 3; c++) {
        const L = centers[c * 3];
        const a = centers[c * 3 + 1];
        const b = centers[c * 3 + 2];
        const e = ds.nearest(L, a, b);
        if (e < T || blends.includes(e)) continue;
        const sNear = singles.nearest(L, a, b);
        const dSingle = ciede2000(L, a, b, singles.lab[sNear * 3], singles.lab[sNear * 3 + 1], singles.lab[sNear * 3 + 2]);
        const dBlend = ciede2000(L, a, b, ds.lab[e * 3], ds.lab[e * 3 + 1], ds.lab[e * 3 + 2]);
        if (dBlend <= dSingle - gain) blends.push(e);
      }
    }
    // палитра варианта: все нитки + выбранные смеси
    const size = T + blends.length;
    const lab = new Float64Array(size * 3);
    const pal = new Float32Array(size * 3);
    lab.set(singles.lab);
    const ds = dense;
    for (let i = 0; i < T; i++) {
      const c = threadRgbs[i];
      pal.set([srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])], i * 3);
    }
    blends.forEach((e, k) => {
      lab.set(ds!.lab.subarray(e * 3, e * 3 + 3), (T + k) * 3);
      pal.set(ds!.lin.subarray(e * 3, e * 3 + 3), (T + k) * 3);
    });
    // клетка берёт смесь, только если обычная нитка хуже tau, а смесь лучше хотя бы на gain
    const ref = Int32Array.from(s.idx);
    if (blends.length) {
      for (const i of bad) {
        const L = g.lab[i * 3];
        const a = g.lab[i * 3 + 1];
        const b = g.lab[i * 3 + 2];
        let best = -1;
        let bestD = s.err[i] - gain;
        for (let k = 0; k < blends.length; k++) {
          const o = (T + k) * 3;
          const d = ciede2000(L, a, b, lab[o], lab[o + 1], lab[o + 2]);
          if (d < bestD) {
            bestD = d;
            best = T + k;
          }
        }
        if (best >= 0) ref[i] = best;
      }
    }
    const cleaned = despeckle(ref, g, pal);
    return { blends, ref: cleaned, lab, pal, similarity: farSimilarity(cleaned, g, pal).share };
  };

  // Сколько смесей нужно: наименьшее число из списка, при котором сходство не ниже заданного
  let budget = 0;
  if (blendMode !== 'none' && minSimilarity > 0) {
    const rules = BLEND_RULES[blendMode];
    const searchGrid =
      n > SEARCH_CELLS
        ? resizeToGrid(
            img,
            Math.max(20, Math.round(cols * Math.sqrt(SEARCH_CELLS / n))),
            Math.max(1, Math.round(rows * Math.sqrt(SEARCH_CELLS / n))),
            opts.transparentEmpty,
          )
        : grid;
    progress(0.12, 'Подбираю нитки');
    const s = nearestSingles(searchGrid);
    for (let k = 0; k < rules.budgets.length; k++) {
      budget = rules.budgets[k];
      progress(0.15 + (0.55 * k) / rules.budgets.length, budget ? `Проверяю смеси: до ${budget}` : 'Проверяю обычные нитки');
      if (plan(searchGrid, s, budget, rules.tau, rules.gain).similarity >= minSimilarity) break;
    }
  }

  // Итоговая схема на полной сетке
  progress(0.72, 'Строю схему');
  const full = nearestSingles(grid);
  const rules = blendMode === 'none' ? { tau: Infinity, gain: 0 } : BLEND_RULES[blendMode];
  const chosen = plan(grid, full, budget, rules.tau, rules.gain);

  // 5–6. Чистка редких цветов; если точность < 99,9% — уменьшаем минимум (не ниже 2)
  progress(0.88, 'Убираю редкие цвета');
  const set = new LabMatcher(chosen.lab);
  const ladder = minLadder(opts.minStitches);
  let final: Int32Array = chosen.ref;
  let accuracy = 1;
  let usedMin = ladder[0];
  for (const min of ladder) {
    usedMin = min;
    final = cleanupRareColors(chosen.ref, grid.lab, set, min, SYMBOLS.length);
    accuracy = colorAccuracy(final, chosen.ref, set);
    if (accuracy >= TARGET_ACCURACY) break;
  }
  const similarity = farSimilarity(final, grid, chosen.pal).share;
  progress(0.95, 'Считаю цвета');

  // 7. Цвета по убыванию частоты, самые частые получают самые простые символы
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) if (final[i] >= 0) counts.set(final[i], (counts.get(final[i]) ?? 0) + 1);
  const used = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const toLocal = new Map<number, number>();
  let blendColors = 0;
  let blendStitches = 0;
  const colors: PatternColor[] = used.map(([v, count], i) => {
    toLocal.set(v, i);
    const threadIdx = v < T ? [v] : [...dense!.parts[chosen.blends[v - T]]];
    const parts: ThreadRef[] = threadIdx.map((ti) => ({ code: threads[ti].code, name: threads[ti].name, rgb: threads[ti].rgb }));
    if (parts.length > 1) {
      blendColors++;
      blendStitches += count;
    }
    return {
      code: parts.map((p) => p.code).join('+'),
      name: parts.length === 1 ? parts[0].name : parts.map((p) => p.name || `${palette.title} ${p.code}`).join(' + '),
      rgb: v < T ? threads[v].rgb : dense!.rgb(chosen.blends[v - T]),
      count,
      symbol: SYMBOLS[i],
      parts,
    };
  });
  const cells = new Int16Array(n);
  for (let i = 0; i < n; i++) cells[i] = final[i] < 0 ? -1 : toLocal.get(final[i])!;
  const stitches = used.reduce((s2, [, c]) => s2 + c, 0);

  progress(1, 'Готово');
  return {
    cols,
    rows,
    cells,
    colors,
    brand: palette.brand,
    paletteTitle: palette.title,
    style: blendColors > 0 ? 'blend' : 'flat',
    blendMode,
    blendColors,
    blendShare: stitches ? blendStitches / stitches : 0,
    accuracy,
    similarity,
    minSimilarity,
    isolated: isolatedShare(cells, cols, rows),
    minStitches: usedMin,
    referenceColors: new Set(chosen.ref.filter((r) => r >= 0)).size,
    stitches,
  };
}

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Для группировки цветов хватает выборки: больше стольких клеток не берём. */
const KMEANS_SAMPLE = 40_000;

/** Центры k групп цветов клеток (k-средних в Lab); начальные центры — равномерно по светлоте. */
function kMeans(lab: Float32Array, allCells: number[], k: number): Float64Array {
  // равномерная выборка (детерминированная), чтобы большие схемы считались быстро
  const step = Math.max(1, Math.floor(allCells.length / KMEANS_SAMPLE));
  const cells = step === 1 ? allCells : allCells.filter((_, i) => i % step === 0);
  const cent = new Float64Array(k * 3);
  // начальные центры: клетки, отсортированные по светлоте, берутся через равные промежутки
  const sorted = [...cells].sort((a, b) => lab[a * 3] - lab[b * 3]);
  for (let c = 0; c < k; c++) {
    const i = sorted[Math.floor(((c + 0.5) / k) * sorted.length)];
    cent[c * 3] = lab[i * 3];
    cent[c * 3 + 1] = lab[i * 3 + 1];
    cent[c * 3 + 2] = lab[i * 3 + 2];
  }
  const sum = new Float64Array(k * 4);
  const one = new Int32Array(1);
  for (let iter = 0; iter < 10; iter++) {
    const tree = new KdTree(cent);
    sum.fill(0);
    for (const i of cells) {
      tree.knn(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2], 1, one);
      const c = one[0];
      sum[c * 4] += lab[i * 3];
      sum[c * 4 + 1] += lab[i * 3 + 1];
      sum[c * 4 + 2] += lab[i * 3 + 2];
      sum[c * 4 + 3]++;
    }
    for (let c = 0; c < k; c++) {
      const w = sum[c * 4 + 3];
      if (w > 0) {
        cent[c * 3] = sum[c * 4] / w;
        cent[c * 3 + 1] = sum[c * 4 + 1] / w;
        cent[c * 3 + 2] = sum[c * 4 + 2] / w;
      }
    }
  }
  return cent;
}
