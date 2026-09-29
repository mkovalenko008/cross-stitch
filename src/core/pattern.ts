import { TARGET_ACCURACY, cleanupRareColors, colorAccuracy, minLadder } from './cleanup';
import { ciede2000, labToDin99o, linearToSrgb8 } from './color';
import { EntrySet } from './entries';
import { KdTree } from './kdtree';
import { LabMatcher, PaletteMatcher } from './match';
import { despeckle, farSimilarity, isolatedShare } from './quality';
import { resizeToGrid, type GridColors, type RgbaImage } from './resize';
import { SYMBOLS } from './symbols';
import type { Palette, Thread } from '../palettes';

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
  /**
   * Экономия ниток к покупке: насколько можно уступить в сходстве с фото (доля, 0.01 = 1%),
   * чтобы купить меньше ниток. 0 — не экономить. По умолчанию 0.01.
   */
  threadEconomy?: number;
  /** Жёсткий предел числа ниток к покупке (если задан, экономия идёт до него). */
  maxThreads?: number;
}

export const DEFAULT_MIN_SIMILARITY = 0.85;
export const DEFAULT_THREAD_ECONOMY = 0.01;

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
  /** Сколько ниток к покупке было бы без экономии (если экономия включена). */
  threadsBeforeEconomy?: number;
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
/** Сетка для подбора набора ниток (экономии) — не больше стольких клеток: пересчётов много. */
const ECONOMY_CELLS = 40_000;
/** Меньше стольких ниток экономия не опускается. */
const MIN_THREADS = 8;

interface Plan {
  /** Индексы выбранных смесей в плотном наборе движка. */
  blends: number[];
  /** Вариант для каждой клетки: 0…T−1 — нитки движка, T… — выбранные смеси; после уборки одиночных. */
  ref: Int32Array;
  lab: Float64Array;
  pal: Float32Array;
  similarity: number;
}

interface Singles {
  idx: Int32Array;
  err: Float32Array;
}

/** Подбор для заданного набора ниток: ближайшие нитки, смеси, варианты схемы. */
class Engine {
  readonly T: number;
  readonly singles: PaletteMatcher;
  private readonly rgbs: [number, number, number][];
  private dense: EntrySet | null = null;
  private readonly cache8 = new Map<number, number>();

  constructor(readonly threads: Thread[]) {
    this.T = threads.length;
    this.rgbs = threads.map((t) => t.rgb);
    this.singles = new PaletteMatcher(this.rgbs);
  }

  /** «Все нитки + смеси пар» — только чтобы находить смеси для оттенков, которых нет среди ниток. */
  denseSet(): EntrySet {
    return (this.dense ??= new EntrySet(this.rgbs, MAX_BLEND_PAIR_DE));
  }

  /**
   * Для каждой клетки — ближайшая обычная нитка по CIEDE2000 (точный поиск) и её ошибка.
   * На очень больших сетках ответ запоминается для оттенка клетки, округлённого до 8 бит
   * на канал в sRGB, — разница с точным поиском возможна только на границе между нитками.
   */
  nearestSingles(g: GridColors): Singles {
    const m = g.cols * g.rows;
    const idx = new Int32Array(m);
    const err = new Float32Array(m);
    const useCache = m > SEARCH_CELLS;
    const { singles } = this;
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
        const hit = this.cache8.get(key);
        if (hit === undefined) {
          s = singles.nearest(L, a, b);
          this.cache8.set(key, s);
        } else s = hit;
      } else s = singles.nearest(L, a, b);
      idx[i] = s;
      err[i] = ciede2000(L, a, b, singles.lab[s * 3], singles.lab[s * 3 + 1], singles.lab[s * 3 + 2]);
    }
    return { idx, err };
  }

  /** Вариант схемы с не больше чем budget разными смесями. */
  plan(g: GridColors, s: Singles, budget: number, tau: number, gain: number): Plan {
    const { T, singles } = this;
    const m = g.cols * g.rows;
    const blends: number[] = [];
    // клетки, для которых обычная нитка явно не подходит
    const bad: number[] = [];
    if (budget > 0) for (let i = 0; i < m; i++) if (s.idx[i] >= 0 && s.err[i] > tau) bad.push(i);
    const ds = bad.length ? this.denseSet() : null;
    if (ds) {
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
    for (let i = 0; i < T; i++) {
      const c = this.rgbs[i];
      pal[i * 3] = srgbToLinear(c[0]);
      pal[i * 3 + 1] = srgbToLinear(c[1]);
      pal[i * 3 + 2] = srgbToLinear(c[2]);
    }
    blends.forEach((e, k) => {
      lab.set(ds!.lab.subarray(e * 3, e * 3 + 3), (T + k) * 3);
      pal.set(ds!.lin.subarray(e * 3, e * 3 + 3), (T + k) * 3);
    });
    // клетка берёт смесь, только если обычная нитка хуже tau, а смесь лучше хотя бы на gain;
    // кандидаты — ближайшие смеси в DIN99o (k-d дерево), затем сравнение по CIEDE2000
    const ref = Int32Array.from(s.idx);
    if (blends.length) {
      const din = new Float64Array(blends.length * 3);
      for (let k = 0; k < blends.length; k++) {
        const o = (T + k) * 3;
        labToDin99o(lab[o], lab[o + 1], lab[o + 2], din, k * 3);
      }
      const tree = new KdTree(din);
      const K = Math.min(8, blends.length);
      const cand = new Int32Array(K);
      const q = new Float64Array(3);
      for (const i of bad) {
        const L = g.lab[i * 3];
        const a = g.lab[i * 3 + 1];
        const b = g.lab[i * 3 + 2];
        labToDin99o(L, a, b, q);
        const cnt = tree.knn(q[0], q[1], q[2], K, cand);
        let best = -1;
        let bestD = s.err[i] - gain;
        for (let c = 0; c < cnt; c++) {
          const o = (T + cand[c]) * 3;
          const d = ciede2000(L, a, b, lab[o], lab[o + 1], lab[o + 2]);
          if (d < bestD) {
            bestD = d;
            best = T + cand[c];
          }
        }
        if (best >= 0) ref[i] = best;
      }
    }
    const cleaned = despeckle(ref, g, pal);
    return { blends, ref: cleaned, lab, pal, similarity: farSimilarity(cleaned, g, pal).share };
  }

  /** Индексы ниток движка, из которых состоит вариант v плана. */
  partsOf(p: Plan, v: number): number[] {
    return v < this.T ? [v] : [...this.denseSet().parts[p.blends[v - this.T]]];
  }

  /** Расход каждой нитки движка в плане (крестик смеси — по ½ на нитку). */
  usage(p: Plan): Float64Array {
    const u = new Float64Array(this.T);
    const counts = new Map<number, number>();
    for (const v of p.ref) if (v >= 0) counts.set(v, (counts.get(v) ?? 0) + 1);
    for (const [v, c] of counts) {
      const parts = this.partsOf(p, v);
      for (const t of parts) u[t] += c / parts.length;
    }
    return u;
  }
}

/** Уменьшенная копия сетки не больше чем на cells клеток (или сама сетка, если она меньше). */
function smallerGrid(img: RgbaImage, grid: GridColors, cells: number, transparentEmpty: boolean): GridColors {
  const n = grid.cols * grid.rows;
  if (n <= cells) return grid;
  const k = Math.sqrt(cells / n);
  return resizeToGrid(img, Math.max(20, Math.round(grid.cols * k)), Math.max(1, Math.round(grid.rows * k)), transparentEmpty);
}

export function buildPattern(img: RgbaImage, opts: PatternOptions, palette: Palette, onProgress?: ProgressFn): Pattern {
  const progress = onProgress ?? (() => {});
  const { cols, rows } = opts;
  const n = cols * rows;
  const minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const blendMode: BlendMode = opts.blendMode ?? 'rare';
  const rules = blendMode === 'none' ? { tau: Infinity, gain: 0, budgets: [0] } : BLEND_RULES[blendMode];

  // 1. Ресайз усреднением по площади в линейном RGB → Lab
  progress(0, 'Уменьшаю картинку до сетки');
  const grid = resizeToGrid(img, cols, rows, opts.transparentEmpty, (f) => progress(0.1 * f, 'Уменьшаю картинку до сетки'));
  const searchGrid = smallerGrid(img, grid, SEARCH_CELLS, opts.transparentEmpty);

  // 2–4. Сколько смесей нужно: наименьшее число из списка, при котором сходство не ниже заданного
  const allEngine = new Engine(palette.threads);
  let budget = 0;
  if (blendMode !== 'none' && minSimilarity > 0) {
    progress(0.12, 'Подбираю нитки');
    const s = allEngine.nearestSingles(searchGrid);
    for (let k = 0; k < rules.budgets.length; k++) {
      budget = rules.budgets[k];
      progress(0.15 + (0.35 * k) / rules.budgets.length, budget ? `Проверяю смеси: до ${budget}` : 'Проверяю обычные нитки');
      if (allEngine.plan(searchGrid, s, budget, rules.tau, rules.gain).similarity >= minSimilarity) break;
    }
  }

  // 5–6. Чистка редких цветов; если точность < 99,9% — уменьшаем минимум (не ниже 2)
  const cleanRare = (p: Plan) => {
    const set = new LabMatcher(p.lab);
    const ladder = minLadder(opts.minStitches);
    let final: Int32Array = p.ref;
    let accuracy = 1;
    let usedMin = ladder[0];
    for (const min of ladder) {
      usedMin = min;
      final = cleanupRareColors(p.ref, grid.lab, set, min, SYMBOLS.length);
      accuracy = colorAccuracy(final, p.ref, set);
      if (accuracy >= TARGET_ACCURACY) break;
    }
    return { final, accuracy, usedMin };
  };

  // Итоговая схема на полной сетке — сначала из всей палитры
  progress(0.5, 'Строю схему');
  let engine = allEngine;
  let chosen = allEngine.plan(grid, allEngine.nearestSingles(grid), budget, rules.tau, rules.gain);

  // Экономия ниток к покупке: самые редкие нитки убираются порциями (пересчёт на уменьшенной
  // копии), пока сходство падает не больше чем на threadEconomy — или пока ниток не станет
  // не больше maxThreads. Затем схема строится заново из оставшихся ниток.
  const economy = opts.threadEconomy ?? DEFAULT_THREAD_ECONOMY;
  let threadsBeforeEconomy: number | undefined;
  if (economy > 0 || opts.maxThreads) {
    const fullUsage = allEngine.usage(chosen);
    // сколько ниток было бы без экономии — после той же чистки редких цветов, что и в итоге
    threadsBeforeEconomy = allEngine.usage({ ...chosen, ref: cleanRare(chosen).final }).filter((u) => u > 0).length;
    progress(0.55, 'Экономлю нитки');
    const eg = smallerGrid(img, grid, ECONOMY_CELLS, opts.transparentEmpty);
    const evaluate = (idx: number[]) => {
      const e = new Engine(idx.map((i) => palette.threads[i]));
      const p = e.plan(eg, e.nearestSingles(eg), budget, rules.tau, rules.gain);
      const u = e.usage(p);
      return { idx, sim: p.similarity, usage: new Map(idx.map((ti, k) => [ti, u[k]])) };
    };
    // старт — нитки, которые есть в полной схеме
    let cur = evaluate(palette.threads.map((_, i) => i).filter((i) => fullUsage[i] > 0));
    const base = cur.sim;
    let step = 0.15;
    let rounds = 0;
    while (rounds++ < 40) {
      if (opts.maxThreads && cur.idx.length <= opts.maxThreads) break;
      let drop = Math.max(1, Math.round(cur.idx.length * step));
      if (opts.maxThreads) drop = Math.min(drop, cur.idx.length - opts.maxThreads);
      if (cur.idx.length - drop < MIN_THREADS) break;
      const keep = [...cur.idx].sort((a, b) => cur.usage.get(a)! - cur.usage.get(b)! || a - b).slice(drop);
      progress(0.55 + Math.min(0.25, rounds * 0.015), `Экономлю нитки: пробую ${keep.length}`);
      const next = evaluate(keep.sort((a, b) => a - b));
      if (opts.maxThreads || next.sim >= base - economy) cur = next;
      else if (drop === 1) break;
      else step /= 2;
    }
    if (cur.idx.length < fullUsage.filter((u) => u > 0).length) {
      progress(0.82, 'Строю схему из оставшихся ниток');
      engine = new Engine(cur.idx.map((i) => palette.threads[i]));
      chosen = engine.plan(grid, engine.nearestSingles(grid), budget, rules.tau, rules.gain);
    }
  }

  progress(0.88, 'Убираю редкие цвета');
  const { final, accuracy, usedMin } = cleanRare(chosen);
  const similarity = farSimilarity(final, grid, chosen.pal).share;
  progress(0.95, 'Считаю цвета');

  // 7. Цвета по убыванию частоты, самые частые получают самые простые символы
  const threads = engine.threads;
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) if (final[i] >= 0) counts.set(final[i], (counts.get(final[i]) ?? 0) + 1);
  const used = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const toLocal = new Map<number, number>();
  let blendColors = 0;
  let blendStitches = 0;
  const colors: PatternColor[] = used.map(([v, count], i) => {
    toLocal.set(v, i);
    const parts: ThreadRef[] = engine.partsOf(chosen, v).map((ti) => ({ code: threads[ti].code, name: threads[ti].name, rgb: threads[ti].rgb }));
    if (parts.length > 1) {
      blendColors++;
      blendStitches += count;
    }
    return {
      code: parts.map((p) => p.code).join('+'),
      name: parts.length === 1 ? parts[0].name : parts.map((p) => p.name || `${palette.title} ${p.code}`).join(' + '),
      rgb: v < engine.T ? threads[v].rgb : engine.denseSet().rgb(chosen.blends[v - engine.T]),
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
    ...(threadsBeforeEconomy !== undefined ? { threadsBeforeEconomy } : {}),
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
