import { describe, expect, it } from 'vitest';
import { ACCURACY_DELTA_E, TARGET_ACCURACY, cleanupRareColors, colorAccuracy, minLadder } from '../src/core/cleanup';
import { despeckle, farSimilarity, isolatedShare, threadsLinear } from '../src/core/quality';
import { SRGB_TO_LINEAR, ciede2000, linearToSrgb8, rgb8ToLab } from '../src/core/color';
import { skeinsFor } from '../src/core/constants';
import { EntrySet } from '../src/core/entries';
import { KdTree } from '../src/core/kdtree';
import { PaletteMatcher } from '../src/core/match';
import { BLEND_RULES, buildPattern } from '../src/core/pattern';
import { SYMBOLS } from '../src/core/symbols';
import { threadUsage } from '../src/core/threads';
import { gridHeight, resizeToGrid } from '../src/core/resize';
import { PALETTES } from '../src/palettes';

let seed = 12345;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

describe('палитры', () => {
  it.each(Object.values(PALETTES))('$title: корректные записи без повторов', (p) => {
    const codes = new Set(p.threads.map((t) => t.code));
    expect(codes.size).toBe(p.threads.length);
    for (const t of p.threads) {
      expect(t.code).toBeTruthy();
      expect(t.rgb).toHaveLength(3);
      for (const v of t.rgb) expect(Number.isInteger(v) && v >= 0 && v <= 255).toBe(true);
    }
  });

  it('DMC: полная палитра, есть Blanc, Ecru, B5200', () => {
    const codes = PALETTES.dmc.threads.map((t) => t.code);
    expect(codes.length).toBeGreaterThanOrEqual(450);
    for (const c of ['Blanc', 'Ecru', 'B5200', '310', '01', '35']) expect(codes).toContain(c);
  });

  it('Гамма: у каждого цвета указан источник RGB', () => {
    expect(PALETTES.gamma.threads.length).toBeGreaterThanOrEqual(450);
    for (const t of PALETTES.gamma.threads) expect(['gamma-official', 'dmc-equivalent']).toContain(t.rgbSource);
  });
});

describe('поиск ближайшей нитки', () => {
  it.each(Object.values(PALETTES))('$title: быстрый поиск совпадает с полным перебором', (p) => {
    const m = new PaletteMatcher(p.threads.map((t) => t.rgb));
    for (let i = 0; i < 5000; i++) {
      const lab = rgb8ToLab([Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)]);
      expect(m.nearest(...lab)).toBe(m.nearestBruteForce(...lab));
    }
  });

  it('цвет из палитры находит сам себя', () => {
    const threads = PALETTES.dmc.threads;
    const m = new PaletteMatcher(threads.map((t) => t.rgb));
    threads.forEach((t) => {
      const i = m.nearest(...rgb8ToLab(t.rgb));
      expect(threads[i].rgb).toEqual(t.rgb); // у B5200/White одинаковые RGB возможны — сравниваем цвет
    });
  });
});

function image(w: number, h: number, px: (x: number, y: number) => number[]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

describe('ресайз усреднением по площади', () => {
  it('высота по пропорциям', () => {
    expect(gridHeight(100, 4000, 3000)).toBe(75);
    expect(gridHeight(100, 3000, 4000)).toBe(133);
  });

  it('усредняет в линейном RGB, а не в sRGB', () => {
    // шахматка чёрное/белое → середина в линейном RGB = 0.5 → sRGB ≈ 188, а не 128
    const img = image(2, 2, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const g = resizeToGrid(img, 1, 1, true);
    const expected = rgb8ToLab([188, 188, 188]);
    expect(g.lab[0]).toBeCloseTo(expected[0], 0);
    expect(g.lab[0]).toBeGreaterThan(rgb8ToLab([160, 160, 160])[0]);
  });

  it('учитывает доли пикселей на границе клеток', () => {
    // 3 пикселя → 2 клетки: клетка 0 = пиксель 0 + половина пикселя 1
    const img = image(3, 1, (x) => (x === 0 ? [255, 0, 0, 255] : x === 1 ? [0, 0, 255, 255] : [0, 0, 255, 255]));
    const g = resizeToGrid(img, 2, 1, true);
    const right = rgb8ToLab([0, 0, 255]);
    expect(g.lab[3]).toBeCloseTo(right[0], 3); // клетка 1 — чисто синяя
    expect(g.lab[0]).not.toBeCloseTo(right[0], 0); // клетка 0 — смесь
  });

  it('прозрачные пиксели → пустые клетки, либо белый фон', () => {
    const img = image(4, 2, (x) => (x < 2 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    const g = resizeToGrid(img, 2, 1, true);
    expect([...g.empty]).toEqual([0, 1]);
    const g2 = resizeToGrid(img, 2, 1, false);
    expect([...g2.empty]).toEqual([0, 0]);
    expect(g2.lab[3]).toBeCloseTo(100, 3); // прозрачная клетка на белом фоне
  });

  it('увеличение маленькой картинки тоже работает', () => {
    const img = image(2, 1, (x) => (x ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const g = resizeToGrid(img, 4, 2, true);
    expect(g.lab[0]).toBeCloseTo(0, 3);
    expect(g.lab[3 * 3]).toBeCloseTo(100, 3);
  });
});

describe('чистка редких цветов', () => {
  // Случайное «изображение» из цветов палитры с шумом: много редких цветов.
  function randomCase(n: number) {
    const threads = PALETTES.dmc.threads;
    const m = new PaletteMatcher(threads.map((t) => t.rgb));
    const lab = new Float64Array(n * 3);
    const reference = new Int16Array(n);
    const main = [10, 50, 120, 200, 300, 400];
    for (let i = 0; i < n; i++) {
      const base = rnd() < 0.9 ? main[Math.floor(rnd() * main.length)] : Math.floor(rnd() * threads.length);
      const [L, a, b] = rgb8ToLab(threads[base].rgb);
      lab.set([L + (rnd() - 0.5) * 6, a + (rnd() - 0.5) * 6, b + (rnd() - 0.5) * 6], i * 3);
      reference[i] = rnd() < 0.05 ? -1 : m.nearest(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]);
    }
    return { m, lab, reference };
  }

  it.each([2, 3, 5, 10, 25])('после чистки нет цветов реже минимума (%i)', (min) => {
    const { m, lab, reference } = randomCase(4000);
    const out = cleanupRareColors(reference, lab, m, min);
    const counts = new Map<number, number>();
    out.forEach((c) => c >= 0 && counts.set(c, (counts.get(c) ?? 0) + 1));
    for (const c of counts.values()) expect(c).toBeGreaterThanOrEqual(min);
    // пустые клетки остаются пустыми, непустые — непустыми
    reference.forEach((r, i) => expect(out[i] < 0).toBe(r < 0));
  });

  it('частые цвета не трогает', () => {
    const { m, lab, reference } = randomCase(4000);
    const out = cleanupRareColors(reference, lab, m, 10);
    const counts = new Map<number, number>();
    reference.forEach((c) => c >= 0 && counts.set(c, (counts.get(c) ?? 0) + 1));
    reference.forEach((r, i) => {
      if (r >= 0 && counts.get(r)! >= 10) expect(out[i]).toBe(r);
    });
  });

  it('переназначает только на цвета, оставшиеся в схеме', () => {
    const { m, lab, reference } = randomCase(3000);
    const out = cleanupRareColors(reference, lab, m, 10);
    const inRef = new Set(reference);
    out.forEach((c) => expect(inRef.has(c)).toBe(true));
  });

  it('ограничение числа цветов', () => {
    const { m, lab, reference } = randomCase(3000);
    const out = cleanupRareColors(reference, lab, m, 2, 5);
    expect(new Set([...out].filter((c) => c >= 0)).size).toBeLessThanOrEqual(5);
  });

  it('лесенка минимума: 10 → 7 → 5 → 3 → 2, не ниже 2', () => {
    expect(minLadder(10)).toEqual([10, 7, 5, 3, 2]);
    expect(minLadder(20)).toEqual([20, 10, 7, 5, 3, 2]);
    expect(minLadder(4)).toEqual([4, 3, 2]);
    expect(minLadder(1)).toEqual([2]);
    expect(minLadder(0)).toEqual([2]);
  });
});

describe('метрика точности', () => {
  const threads = PALETTES.dmc.threads;
  const m = new PaletteMatcher(threads.map((t) => t.rgb));
  const idx = (code: string) => threads.findIndex((t) => t.code === code);

  it('совпадение = 100%, пустые клетки не считаются', () => {
    const ref = Int16Array.from([1, 2, 3, -1]);
    expect(colorAccuracy(ref, ref, m)).toBe(1);
  });

  it('близкая замена (ΔE ≤ 2) засчитывается, далёкая — нет', () => {
    const black = idx('310');
    const white = idx('Blanc');
    // ближайший к Blanc другой цвет с ΔE ≤ 2
    const near = threads.findIndex((_, j) => j !== white && m.distance(j, white) <= ACCURACY_DELTA_E);
    expect(near).toBeGreaterThanOrEqual(0);
    const ref = Int16Array.from([white, white, white, white]);
    expect(colorAccuracy(Int16Array.from([near, white, white, white]), ref, m)).toBe(1);
    expect(colorAccuracy(Int16Array.from([black, white, white, white]), ref, m)).toBe(0.75);
  });
});

describe('сборка схемы', () => {
  it('гладкий градиент: без одиночных крестиков, точность считается, символы уникальны', () => {
    const img = image(300, 200, (x, y) => [Math.round((x / 299) * 255), Math.round((y / 199) * 255), 128, 255]);
    const p = buildPattern(img, { cols: 60, rows: 40, minStitches: 10, transparentEmpty: true, minSimilarity: 0 }, PALETTES.dmc);
    expect(p.cells.length).toBe(60 * 40);
    expect(p.stitches).toBe(60 * 40);
    for (const c of p.colors) expect(c.count).toBeGreaterThanOrEqual(p.minStitches);
    expect(p.minStitches).toBeGreaterThanOrEqual(2);
    expect(new Set(p.colors.map((c) => c.symbol)).size).toBe(p.colors.length);
    // по убыванию количества
    for (let i = 1; i < p.colors.length; i++) expect(p.colors[i - 1].count).toBeGreaterThanOrEqual(p.colors[i].count);
    expect(p.accuracy).toBeGreaterThan(0.5);
    expect(p.accuracy).toBeLessThanOrEqual(1);
  });

  it('при точности < 99,9% минимум уменьшается, но не ниже 2', () => {
    // шум: много цветов, почти все редкие
    const img = image(80, 80, () => [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256), 255]);
    const p = buildPattern(img, { cols: 80, rows: 80, minStitches: 10, transparentEmpty: true, minSimilarity: 0, threadEconomy: 0 }, PALETTES.gamma);
    expect(p.minStitches).toBeGreaterThanOrEqual(2);
    expect(p.minStitches).toBeLessThan(10);
    for (const c of p.colors) expect(c.count).toBeGreaterThanOrEqual(2);
  });
});

describe('смеси ниток (по одной нитке двух цветов)', () => {
  // Плавный переход между цветами четырёх ниток DMC (в линейном RGB): одиночными нитками
  // такие оттенки не передать, а смесями — можно.
  const corners = ['3865', '3750', '355', '3347'].map((code) => PALETTES.dmc.threads.find((t) => t.code === code)!.rgb);
  const gradient = () =>
    image(240, 160, (x, y) => {
      const u = x / 239;
      const v = y / 159;
      const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
      return [0, 1, 2].map((ch) => linearToSrgb8(w.reduce((sum, wk, k) => sum + wk * SRGB_TO_LINEAR[corners[k][ch]], 0))).concat(255);
    });
  const threads = PALETTES.dmc.threads;
  const rgbs = threads.map((t) => t.rgb);

  it('варианты: сначала все нитки палитры, потом смеси близких пар; цвет смеси — среднее в линейном RGB', () => {
    const set = new EntrySet(rgbs, 10);
    for (let i = 0; i < threads.length; i++) expect(set.parts[i]).toEqual([i]);
    expect(set.size).toBeGreaterThan(threads.length);
    for (let e = threads.length; e < set.size; e += 97) {
      const [i, j] = set.parts[e] as [number, number];
      expect(set.distance(i, j)).toBeLessThanOrEqual(10.000001);
      for (let ch = 0; ch < 3; ch++) {
        const mix = (SRGB_TO_LINEAR[rgbs[i][ch]] + SRGB_TO_LINEAR[rgbs[j][ch]]) / 2;
        expect(set.lin[e * 3 + ch]).toBeCloseTo(mix, 5);
      }
    }
  });

  it('k-d дерево находит те же ближайшие точки, что и полный перебор', () => {
    const pts = new Float64Array(3000);
    for (let i = 0; i < pts.length; i++) pts[i] = rnd() * 100 - 50;
    const tree = new KdTree(pts);
    const out = new Int32Array(5);
    for (let q = 0; q < 300; q++) {
      const x = rnd() * 100 - 50;
      const y = rnd() * 100 - 50;
      const z = rnd() * 100 - 50;
      const got = tree.knn(x, y, z, 5, out);
      const brute = Array.from({ length: 1000 }, (_, i) => i)
        .map((i) => [i, (pts[i * 3] - x) ** 2 + (pts[i * 3 + 1] - y) ** 2 + (pts[i * 3 + 2] - z) ** 2])
        .sort((a, b) => a[1] - b[1])
        .slice(0, 5)
        .map((a) => a[0]);
      expect(got).toBe(5);
      expect([...out]).toEqual(brute);
    }
  });

  it('быстрый поиск среди смесей совпадает с полным перебором по CIEDE2000', () => {
    const set = new EntrySet(rgbs, 20);
    const brute = (lab: number[]) => {
      let best = 0;
      let bestD = Infinity;
      for (let e = 0; e < set.size; e++) {
        const d = ciede2000(lab[0], lab[1], lab[2], set.lab[e * 3], set.lab[e * 3 + 1], set.lab[e * 3 + 2]);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
      return { best, bestD };
    };
    const dist = (lab: number[], e: number) => ciede2000(lab[0], lab[1], lab[2], set.lab[e * 3], set.lab[e * 3 + 1], set.lab[e * 3 + 2]);
    // цвета, которые встречаются в картинках: случайные смеси трёх ниток
    let same = 0;
    for (let q = 0; q < 600; q++) {
      const pick = [0, 1, 2].map(() => rgbs[Math.floor(rnd() * rgbs.length)]);
      const w = [rnd(), rnd(), rnd()];
      const ws = w[0] + w[1] + w[2];
      const rgb = [0, 1, 2].map((ch) => linearToSrgb8(pick.reduce((s2, c, k) => s2 + (w[k] / ws) * SRGB_TO_LINEAR[c[ch]], 0)));
      const lab = rgb8ToLab(rgb);
      const fast = set.nearest(lab[0], lab[1], lab[2]);
      const { best, bestD } = brute(lab);
      if (fast === best) same++;
      expect(dist(lab, fast) - bestD).toBeLessThan(0.5);
    }
    expect(same / 600).toBeGreaterThan(0.98);
    // ядовитые цвета вне ниток: выбранный вариант лишь чуть дальше лучшего
    let sum = 0;
    for (let q = 0; q < 300; q++) {
      const lab = rgb8ToLab([Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)]);
      const d = dist(lab, set.nearest(lab[0], lab[1], lab[2])) - brute(lab).bestD;
      expect(d).toBeLessThan(6);
      sum += d;
    }
    expect(sum / 300).toBeLessThan(0.2);
  });

  it('градиент между нитками: без смесей сходство низкое, «сколько нужно» — не ниже 85%', () => {
    const opts = { cols: 120, rows: 80, minStitches: 10, transparentEmpty: true, minSimilarity: 0.85, threadEconomy: 0 };
    const plain = buildPattern(gradient(), { ...opts, blendMode: 'none' }, PALETTES.dmc);
    const mixed = buildPattern(gradient(), { ...opts, blendMode: 'needed' }, PALETTES.dmc);
    expect(plain.style).toBe('flat');
    expect(plain.blendColors).toBe(0);
    expect(plain.similarity).toBeLessThan(0.85);
    expect(mixed.style).toBe('blend');
    expect(mixed.similarity).toBeGreaterThanOrEqual(0.85);
    expect(mixed.accuracy).toBeGreaterThanOrEqual(TARGET_ACCURACY);
    expect(mixed.colors.length).toBeLessThanOrEqual(SYMBOLS.length);
    expect(mixed.isolated).toBeLessThan(0.05);
    for (const c of mixed.colors) {
      expect(c.count).toBeGreaterThanOrEqual(mixed.minStitches);
      expect(c.parts.length === 1 || c.parts.length === 2).toBe(true);
      expect(c.code).toBe(c.parts.map((x) => x.code).join('+'));
    }
    expect(mixed.colors.filter((c) => c.parts.length === 2).length).toBe(mixed.blendColors);
  });

  it('«в исключительных случаях»: смесей немного, основа — обычные нитки', () => {
    const opts = { cols: 120, rows: 80, minStitches: 10, transparentEmpty: true, minSimilarity: 0.85, threadEconomy: 0 };
    const rare = buildPattern(gradient(), { ...opts, blendMode: 'rare' }, PALETTES.dmc);
    const plain = buildPattern(gradient(), { ...opts, blendMode: 'none' }, PALETTES.dmc);
    expect(rare.blendColors).toBeGreaterThan(0);
    expect(rare.blendColors).toBeLessThanOrEqual(Math.max(...BLEND_RULES.rare.budgets));
    expect(rare.colors.length - rare.blendColors).toBeGreaterThan(rare.blendColors); // обычных ниток больше, чем смесей
    expect(rare.similarity).toBeGreaterThan(plain.similarity);
    // смеси — только в клетках, где обычная нитка явно не подходит: картинку из ниток они не трогают
    const threadsOnly = ['310', '666', '3865'].map((code) => threads.find((t) => t.code === code)!.rgb);
    const img = image(90, 60, (x) => [...threadsOnly[Math.floor(x / 30)], 255]);
    const flat = buildPattern(img, { cols: 90, rows: 60, minStitches: 10, transparentEmpty: true, minSimilarity: 0.85, blendMode: 'rare' }, PALETTES.dmc);
    expect(flat.blendColors).toBe(0);
    expect(flat.blendShare).toBe(0);
  });

  it('картинка из ровных цветов ниток — без смесей', () => {
    const cols3 = ['310', '666', '3865'].map((code) => threads.find((t) => t.code === code)!.rgb);
    const img = image(90, 60, (x) => [...cols3[Math.floor(x / 30)], 255]);
    const p = buildPattern(img, { cols: 90, rows: 60, minStitches: 10, transparentEmpty: true, minSimilarity: 0.85 }, PALETTES.dmc);
    expect(p.style).toBe('flat');
    expect(p.colors.length).toBe(3);
    expect(p.similarity).toBeGreaterThanOrEqual(0.85);
    expect(p.isolated).toBe(0);
  });

  it('экономия ниток: меньше ниток, сходство почти то же; предел «не больше N» соблюдается', () => {
    const photo = image(240, 160, (x, y) => [
      Math.round(128 + 100 * Math.sin(x / 17) * Math.cos(y / 23)),
      Math.round(110 + 80 * Math.cos(x / 29 + y / 31)),
      Math.round(140 + 90 * Math.sin((x + y) / 37)),
      255,
    ]);
    const opts = { cols: 120, rows: 80, minStitches: 10, transparentEmpty: true, minSimilarity: 0.85, blendMode: 'needed' as const };
    const all = buildPattern(photo, { ...opts, threadEconomy: 0 }, PALETTES.dmc);
    const eco = buildPattern(photo, { ...opts, threadEconomy: 0.01 }, PALETTES.dmc);
    const cap = buildPattern(photo, { ...opts, threadEconomy: 0, maxThreads: 25 }, PALETTES.dmc);
    const nAll = threadUsage(all).length;
    expect(all.threadsBeforeEconomy).toBeUndefined();
    expect(eco.threadsBeforeEconomy).toBe(nAll);
    expect(threadUsage(eco).length).toBeLessThan(nAll);
    expect(eco.similarity).toBeGreaterThan(all.similarity - 0.025);
    expect(threadUsage(cap).length).toBeLessThanOrEqual(25);
  }, 60_000);

  it('нитки к покупке: крестик смеси — по половине на каждую нитку', () => {
    const p = buildPattern(gradient(), { cols: 120, rows: 80, minStitches: 10, transparentEmpty: true, minSimilarity: 0.85, blendMode: 'needed', threadEconomy: 0 }, PALETTES.dmc);
    expect(p.blendColors).toBeGreaterThan(0);
    const usage = threadUsage(p);
    const total = usage.reduce((s, u) => s + u.stitches, 0);
    expect(total).toBeCloseTo(p.stitches, 6); // каждый крестик — ровно одна «полная» единица расхода
    for (const u of usage) expect(u.skeins).toBe(skeinsFor(Math.ceil(u.stitches)));
    const codes = new Set(p.colors.flatMap((c) => c.parts.map((x) => x.code)));
    expect(usage.length).toBe(codes.size);
  });

  it('уборка одиночных крестиков уменьшает их долю и не добавляет новых цветов', () => {
    const grid = resizeToGrid(gradient(), 120, 80, true);
    const pal = threadsLinear(rgbs);
    const noisy = new Int32Array(120 * 80);
    for (let i = 0; i < noisy.length; i++) noisy[i] = Math.floor(rnd() * 5) + 100;
    const c = despeckle(noisy, grid, pal, 8, 5);
    expect(isolatedShare(c, 120, 80)).toBeLessThan(isolatedShare(noisy, 120, 80));
    c.forEach((v) => expect(v >= 100 && v < 105).toBe(true));
  });

  it('правила смесей: сначала пробуются обычные нитки, исключительный режим строже', () => {
    for (const r of Object.values(BLEND_RULES)) {
      expect(r.budgets[0]).toBe(0);
      for (let i = 1; i < r.budgets.length; i++) expect(r.budgets[i]).toBeGreaterThan(r.budgets[i - 1]);
    }
    expect(BLEND_RULES.rare.tau).toBeGreaterThan(BLEND_RULES.needed.tau);
    expect(BLEND_RULES.rare.gain).toBeGreaterThan(BLEND_RULES.needed.gain);
  });

  it('сходство с фото: одинаковая картинка — 100%', () => {
    const t = threads.findIndex((x) => x.code === '310');
    const grid = resizeToGrid(image(20, 20, () => [...rgbs[t], 255]), 20, 20, true);
    const r = farSimilarity(new Int16Array(400).fill(t), grid, threadsLinear(rgbs));
    expect(r.share).toBe(1);
    expect(r.meanDeltaE).toBeLessThan(0.01);
  });

  it('цель точности — 99,9%', () => {
    expect(TARGET_ACCURACY).toBe(0.999);
  });
});
