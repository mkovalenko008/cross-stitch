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
 * flat — только обычные нитки (все нити в игле одного цвета);
 * blend — есть смеси: в игле нити двух цветов (2 + 1 и 1 + 2 при 3 нитях, 1 + 1 при 2).
 */
export type PatternStyle = 'flat' | 'blend';

/**
 * Смеси (нити двух цветов в одной игле):
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
  /** Нитей в игле: 3 (по умолчанию: плотнее, смеси 2 + 1 и 1 + 2) или 2 (тоньше, смеси 1 + 1). */
  strands?: 2 | 3;
}

export const DEFAULT_MIN_SIMILARITY = 0.85;
export const DEFAULT_THREAD_ECONOMY = 0.01;
export const DEFAULT_STRANDS = 3;

export interface ThreadRef {
  code: string;
  name: string;
  rgb: [number, number, number];
}

export interface PatternPart extends ThreadRef {
  /** Сколько нитей этого цвета в игле. */
  strands: number;
}

export interface PatternColor {
  /** Номер нитки или смеси: «310», «939+3799». */
  code: string;
  name: string;
  /** Цвет в схеме (у смеси — смешанный цвет двух ниток). */
  rgb: [number, number, number];
  count: number;
  symbol: string;
  /** Нитки варианта: одна (все нити одного цвета) или две (смесь, например 1 + 1 или 2 + 1). */
  parts: PatternPart[];
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
  /** Нитей в игле. */
  strands: 2 | 3;
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
  needed: { tau: 3, gain: 1.5, budgets: [0, 10, 20, 30, 40, 60, 80, 110, 150, 200, 300] },
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
  private readonly options = new WeakMap<Singles, BlendOptions>();

  constructor(
    readonly threads: Thread[],
    readonly strandsInNeedle: number,
  ) {
    this.T = threads.length;
    this.rgbs = threads.map((t) => t.rgb);
    this.singles = new PaletteMatcher(this.rgbs);
  }

  /** «Все нитки + смеси пар» — только чтобы находить смеси для оттенков, которых нет среди ниток. */
  denseSet(): EntrySet {
    return (this.dense ??= new EntrySet(this.rgbs, MAX_BLEND_PAIR_DE, this.strandsInNeedle));
  }

  /**
   * Для каждой клетки — ближайшая обычная нитка по CIEDE2000 (точный поиск) и её ошибка.
   * На очень больших сетках ответ запоминается для оттенка клетки, округлённого до 8 бит
   * на канал в sRGB, — разница с точным поиском возможна только на границе между нитками.
   *
   * from — готовый ответ на той же сетке для большего набора ниток (local — номер его нитки
   * в этом движке или −1): если ближайшая там нитка есть и здесь, она ближайшая и здесь,
   * так что заново ищутся только клетки убранных ниток.
   */
  nearestSingles(g: GridColors, from?: { base: Singles; local: Int32Array }): Singles {
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
      if (from) {
        const k = from.local[from.base.idx[i]];
        if (k >= 0) {
          idx[i] = k;
          err[i] = from.base.err[i];
          continue;
        }
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

  /**
   * Какие смеси подходят «плохим» клеткам (выборка не больше PICK_SAMPLE): для каждой клетки —
   * смеси среди PICK_NEIGHBORS ближайших вариантов, которые ближе её обычной нитки хотя бы на gain.
   * Не зависит от числа смесей, поэтому запоминается для сетки.
   */
  private blendOptions(g: GridColors, s: Singles, bad: number[], tau: number, gain: number): BlendOptions {
    const hit = this.options.get(s);
    if (hit && hit.tau === tau && hit.gain === gain) return hit;
    const ds = this.denseSet();
    const step = Math.max(1, Math.floor(bad.length / PICK_SAMPLE));
    const cells = step === 1 ? bad : bad.filter((_, i) => i % step === 0);
    const err0 = new Float32Array(cells.length);
    const slots = new Map<number, number[]>();
    const dists = new Map<number, number[]>();
    const dlab = ds.lab;
    cells.forEach((i, k) => {
      err0[k] = Math.min(s.err[i], PICK_CAP);
      const L = g.lab[i * 3];
      const a = g.lab[i * 3 + 1];
      const b = g.lab[i * 3 + 2];
      const cand = ds.candidates(L, a, b, PICK_NEIGHBORS);
      for (let c = 0; c < cand.length; c++) {
        const e = cand[c];
        if (e < this.T) continue;
        const d = ciede2000(L, a, b, dlab[e * 3], dlab[e * 3 + 1], dlab[e * 3 + 2]);
        if (d > s.err[i] - gain) continue;
        let sl = slots.get(e);
        if (!sl) {
          sl = [];
          slots.set(e, sl);
          dists.set(e, []);
        }
        sl.push(k);
        dists.get(e)!.push(Math.min(d, PICK_CAP));
      }
    });
    const opts: BlendOptions = { tau, gain, err0, slots, dists };
    this.options.set(s, opts);
    return opts;
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
    if (ds) blends.push(...pickBlends(this.blendOptions(g, s, bad, tau, gain), budget));
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

  /** Сколько нитей каждой нитки варианта v в игле. */
  strandsOf(p: Plan, v: number): number[] {
    return v < this.T ? [this.strandsInNeedle] : [...this.denseSet().strands[p.blends[v - this.T]]];
  }

  /** Расход каждой нитки движка в плане — в долях крестика (смесь 1 + 1 — по ½, 2 + 1 — ⅔ и ⅓). */
  usage(p: Plan): Float64Array {
    const u = new Float64Array(this.T);
    const counts = new Map<number, number>();
    for (const v of p.ref) if (v >= 0) counts.set(v, (counts.get(v) ?? 0) + 1);
    for (const [v, c] of counts) {
      const parts = this.partsOf(p, v);
      const strands = this.strandsOf(p, v);
      parts.forEach((t, k) => (u[t] += (c * strands[k]) / this.strandsInNeedle));
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
  const strands = opts.strands ?? DEFAULT_STRANDS;
  const rules = blendMode === 'none' ? { tau: Infinity, gain: 0, budgets: [0] } : BLEND_RULES[blendMode];

  // 1. Ресайз усреднением по площади в линейном RGB → Lab
  progress(0, 'Уменьшаю картинку до сетки');
  const grid = resizeToGrid(img, cols, rows, opts.transparentEmpty, (f) => progress(0.1 * f, 'Уменьшаю картинку до сетки'));
  const searchGrid = smallerGrid(img, grid, SEARCH_CELLS, opts.transparentEmpty);

  // 2–4. Сколько смесей нужно: наименьшее число из списка, при котором сходство не ниже заданного.
  // В режиме «сколько нужно» с экономией ниток — с запасом на её допуск: потом редкие нитки
  // убираются, и сходство опускается, но не ниже заданного.
  const economy = opts.threadEconomy ?? DEFAULT_THREAD_ECONOMY;
  const target = blendMode === 'needed' && economy > 0 && !opts.maxThreads ? Math.min(minSimilarity + economy, 1) : minSimilarity;
  const allEngine = new Engine(palette.threads, strands);
  let budget = 0;
  let searchSingles: Singles | null = null;
  if (blendMode !== 'none' && minSimilarity > 0) {
    progress(0.12, 'Подбираю нитки');
    const s = (searchSingles = allEngine.nearestSingles(searchGrid));
    for (let k = 0; k < rules.budgets.length; k++) {
      budget = rules.budgets[k];
      progress(0.15 + (0.35 * k) / rules.budgets.length, budget ? `Проверяю смеси: до ${budget}` : 'Проверяю обычные нитки');
      if (allEngine.plan(searchGrid, s, budget, rules.tau, rules.gain).similarity >= target) break;
    }
  }

  // 5–6. Чистка редких цветов; если точность < 99,9% — уменьшаем минимум (не ниже 2).
  // Сходство готовой схемы считается после чистки: на маленьких схемах чистка заметно его меняет,
  // поэтому все проверки сходства на полной сетке идут по готовой схеме.
  const finished = new WeakMap<Plan, { final: Int32Array; accuracy: number; usedMin: number; similarity: number }>();
  const finish = (p: Plan) => {
    let f = finished.get(p);
    if (!f) {
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
      f = { final, accuracy, usedMin, similarity: farSimilarity(final, grid, p.pal).share };
      finished.set(p, f);
    }
    return f;
  };

  // Итоговая схема на полной сетке — сначала из всей палитры. Число смесей подбиралось
  // на уменьшенной копии и до чистки редких цветов; если готовая схема не дотянула
  // до нужного сходства, смесей добавляется больше.
  progress(0.5, 'Строю схему');
  let engine = allEngine;
  const fullSingles = searchGrid === grid && searchSingles ? searchSingles : allEngine.nearestSingles(grid);
  let chosen = allEngine.plan(grid, fullSingles, budget, rules.tau, rules.gain);
  if (blendMode !== 'none') {
    for (let k = rules.budgets.indexOf(budget) + 1; k < rules.budgets.length && finish(chosen).similarity < target; k++) {
      budget = rules.budgets[k];
      progress(0.52, `Уточняю: смеси до ${budget}`);
      chosen = allEngine.plan(grid, fullSingles, budget, rules.tau, rules.gain);
    }
  }

  // Экономия ниток к покупке: самые редкие нитки убираются порциями (пересчёт на уменьшенной
  // копии), пока сходство падает не больше чем на threadEconomy — или пока ниток не станет
  // не больше maxThreads. Ниже заданного сходство не опускается, если без экономии оно было
  // не ниже. Затем схема строится заново из оставшихся ниток.
  let threadsBeforeEconomy: number | undefined;
  if (economy > 0 || opts.maxThreads) {
    const fullUsage = allEngine.usage(chosen);
    // сколько ниток было бы без экономии — после той же чистки редких цветов, что и в итоге
    threadsBeforeEconomy = allEngine.usage({ ...chosen, ref: finish(chosen).final }).filter((u) => u > 0).length;
    progress(0.55, 'Экономлю нитки');
    const floorOf = (base: number) => (base >= minSimilarity ? Math.max(base - economy, minSimilarity) : base - economy);
    const eg = smallerGrid(img, grid, ECONOMY_CELLS, opts.transparentEmpty);
    const egSingles = eg === grid ? fullSingles : allEngine.nearestSingles(eg);
    /** Вариант схемы из ниток idx (номера в палитре) на сетке g; base — ближайшие нитки всей палитры на ней. */
    const planWith = (idx: number[], g: GridColors, base: Singles) => {
      const e = new Engine(
        idx.map((i) => palette.threads[i]),
        strands,
      );
      const local = new Int32Array(palette.threads.length).fill(-1);
      idx.forEach((ti, k) => (local[ti] = k));
      return { e, p: e.plan(g, e.nearestSingles(g, { base, local }), budget, rules.tau, rules.gain) };
    };
    const evaluate = (idx: number[]) => {
      const { e, p } = planWith(idx, eg, egSingles);
      const u = e.usage(p);
      return { idx, sim: p.similarity, usage: new Map(idx.map((ti, k) => [ti, u[k]])), e, p };
    };
    // старт — нитки, которые есть в полной схеме; каждый принятый шаг — набор поменьше
    let cur = evaluate(palette.threads.map((_, i) => i).filter((i) => fullUsage[i] > 0));
    const steps = [cur];
    const floor = floorOf(cur.sim);
    let step = 0.15;
    let rounds = 0;
    while (rounds++ < 40) {
      if (opts.maxThreads && cur.idx.length <= opts.maxThreads) break;
      let drop = Math.max(1, Math.round(cur.idx.length * step));
      if (opts.maxThreads) drop = Math.min(drop, cur.idx.length - opts.maxThreads);
      if (cur.idx.length - drop < MIN_THREADS) break;
      const keep = [...cur.idx].sort((a, b) => cur.usage.get(a)! - cur.usage.get(b)! || a - b).slice(drop);
      progress(0.55 + Math.min(0.23, rounds * 0.015), `Экономлю нитки: пробую ${keep.length}`);
      const next = evaluate(keep.sort((a, b) => a - b));
      if (opts.maxThreads || next.sim >= floor) {
        cur = next;
        steps.push(next);
      } else if (drop === 1) break;
      else step /= 2;
    }

    let pick: { e: Engine; p: Plan } | null = null;
    if (steps.length > 1) {
      if (opts.maxThreads) {
        progress(0.82, 'Строю схему из оставшихся ниток');
        pick = eg === grid ? cur : planWith(cur.idx, grid, fullSingles);
      } else {
        // Шаги выше приняты по уменьшенной копии и до чистки редких цветов. На копии цвета
        // усреднены сильнее, и без убранных ниток сходство там падает меньше, чем на полной
        // схеме (в замерах — в 1,5–3 раза). Поэтому набор проверяется по готовой полной схеме:
        // берётся самый маленький шаг, после которого сходство не ниже допустимого (двоичный
        // поиск по шагам), и затем уточняется внутри следующего шага.
        const fullFloor = floorOf(finish(chosen).similarity);
        let checks = 0;
        const check = (idx: number[], known?: { e: Engine; p: Plan }) => {
          progress(Math.min(0.86, 0.79 + 0.015 * checks++), `Проверяю схему из ${idx.length} ниток`);
          const r = known ?? planWith(idx, grid, fullSingles);
          return finish(r.p).similarity >= fullFloor ? r : null;
        };
        let lo = 0; // steps[lo] подходит (исходный набор — по определению)
        let hi = steps.length; // steps[hi] уже нет (за последним шагом — условно)
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          // на маленькой схеме шаги уже посчитаны на полной сетке
          const r = check(steps[mid].idx, eg === grid ? steps[mid] : undefined);
          if (r) {
            lo = mid;
            pick = r;
          } else hi = mid;
        }
        if (hi < steps.length) {
          // из ниток, убранных на следующем шаге, пробуем убрать сначала половину самых редких
          const from = steps[lo];
          const next = new Set(steps[hi].idx);
          let removable = from.idx.filter((i) => !next.has(i)).sort((a, b) => from.usage.get(a)! - from.usage.get(b)! || a - b);
          let keep = from.idx;
          for (let t = 0; t < 2 && removable.length >= 2; t++) {
            const half = new Set(removable.slice(0, removable.length >> 1));
            const idx = keep.filter((i) => !half.has(i));
            const r = check(idx);
            if (r) {
              pick = r;
              keep = idx;
              removable = removable.filter((i) => !half.has(i));
            } else removable = removable.filter((i) => half.has(i));
          }
        }
      }
    }
    if (pick) {
      engine = pick.e;
      chosen = pick.p;
    }
  }

  progress(0.88, 'Убираю редкие цвета');
  const { final, accuracy, usedMin, similarity } = finish(chosen);
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
    const partStrands = engine.strandsOf(chosen, v);
    const parts: PatternPart[] = engine
      .partsOf(chosen, v)
      .map((ti, k) => ({ code: threads[ti].code, name: threads[ti].name, rgb: threads[ti].rgb, strands: partStrands[k] }));
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
    strands,
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

/** Для выбора смесей хватает выборки «плохих» клеток: больше стольких не берём. */
const PICK_SAMPLE = 20_000;
/** Сколько ближайших вариантов (в DIN99o) проверяется для каждой клетки при выборе смесей. */
const PICK_NEIGHBORS = 16;
/** Ошибка клетки в выгоде смеси ограничена сверху: безнадёжные клетки не перетягивают выбор. */
const PICK_CAP = 10;

/** Какие смеси подходят клеткам выборки: для смеси — номера клеток и её ошибка на них. */
export interface BlendOptions {
  tau: number;
  gain: number;
  /** Ошибка обычной нитки на клетках выборки (не больше PICK_CAP). */
  err0: Float32Array;
  slots: Map<number, number[]>;
  dists: Map<number, number[]>;
}

/**
 * Жадный выбор смесей. Выгода смеси — на сколько она уменьшает ошибки клеток, которым подходит
 * (с учётом уже выбранных смесей). Берётся смесь с наибольшей выгодой, и так до budget смесей;
 * первые k смесей одинаковы при любом budget ≥ k. В отличие от группировки цветов, выбор почти
 * не меняется, когда из набора убирают редкую нитку, — это нужно для экономии ниток.
 */
export function pickBlends(o: BlendOptions, budget: number): number[] {
  const cur = Float32Array.from(o.err0);
  const benefit = (e: number) => {
    const sl = o.slots.get(e)!;
    const dd = o.dists.get(e)!;
    let sum = 0;
    for (let j = 0; j < sl.length; j++) {
      const v = cur[sl[j]] - dd[j];
      if (v > 0) sum += v;
    }
    return sum;
  };
  // ленивый жадный выбор: выгода смеси со временем только уменьшается, поэтому старая оценка —
  // верхняя граница, и пересчитывать нужно только смесь с вершины кучи
  const heap = new MaxHeap([...o.slots.keys()].map((e) => [benefit(e), e]));
  const chosen: number[] = [];
  while (chosen.length < budget && heap.size) {
    const [, e] = heap.pop();
    const fresh = benefit(e);
    if (fresh <= 0) continue;
    if (heap.size && fresh < heap.top[0]) {
      heap.push([fresh, e]);
      continue;
    }
    chosen.push(e);
    const sl = o.slots.get(e)!;
    const dd = o.dists.get(e)!;
    for (let j = 0; j < sl.length; j++) if (dd[j] < cur[sl[j]]) cur[sl[j]] = dd[j];
  }
  return chosen;
}

/** Двоичная куча пар [выгода, номер]: сверху — наибольшая выгода, при равенстве — меньший номер. */
class MaxHeap {
  private readonly a: Array<[number, number]>;

  constructor(items: Array<[number, number]>) {
    // массив, отсортированный по убыванию, — уже правильная куча
    this.a = items.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  }

  get size(): number {
    return this.a.length;
  }

  get top(): [number, number] {
    return this.a[0];
  }

  private above(i: number, j: number): boolean {
    const x = this.a[i];
    const y = this.a[j];
    return x[0] > y[0] || (x[0] === y[0] && x[1] < y[1]);
  }

  push(item: [number, number]): void {
    const { a } = this;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.above(i, p)) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  pop(): [number, number] {
    const { a } = this;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        let m = i;
        if (l < a.length && this.above(l, m)) m = l;
        if (l + 1 < a.length && this.above(l + 1, m)) m = l + 1;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}
