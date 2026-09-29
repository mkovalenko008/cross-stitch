import { describe, expect, it } from 'vitest';
import { ACCURACY_DELTA_E, TARGET_ACCURACY, cleanupRareColors, colorAccuracy, minLadder } from '../src/core/cleanup';
import { despeckle, ditherAssign, farSimilarity, isolatedShare, threadsLinear } from '../src/core/dither';
import { rgb8ToLab } from '../src/core/color';
import { PaletteMatcher } from '../src/core/match';
import { buildPattern } from '../src/core/pattern';
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
    const p = buildPattern(img, { cols: 60, rows: 40, minStitches: 10, transparentEmpty: true, style: 'flat' }, PALETTES.dmc);
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
    const p = buildPattern(img, { cols: 80, rows: 80, minStitches: 10, transparentEmpty: true, style: 'flat' }, PALETTES.gamma);
    expect(p.minStitches).toBeGreaterThanOrEqual(2);
    expect(p.minStitches).toBeLessThan(10);
    for (const c of p.colors) expect(c.count).toBeGreaterThanOrEqual(2);
  });
});

describe('стиль «Как на фото»', () => {
  const gradient = () =>
    image(240, 160, (x, y) => [Math.round((x / 239) * 255), Math.round((y / 159) * 200), 90 + Math.round((x / 239) * 60), 255]);

  it('дизеринг использует только нитки палитры, пустые клетки остаются пустыми', () => {
    const img = image(60, 40, (x, y) => (x < 10 && y < 10 ? [0, 0, 0, 0] : [(x * 4) % 256, (y * 6) % 256, 120, 255]));
    const grid = resizeToGrid(img, 60, 40, true);
    const threads = PALETTES.dmc.threads;
    const m = new PaletteMatcher(threads.map((t) => t.rgb));
    const d = ditherAssign(grid, m, threadsLinear(threads.map((t) => t.rgb)));
    d.forEach((v, i) => {
      if (grid.empty[i]) expect(v).toBe(-1);
      else expect(v >= 0 && v < threads.length).toBe(true);
    });
  });

  it('уборка одиночных крестиков уменьшает их долю и не добавляет новых цветов', () => {
    const grid = resizeToGrid(gradient(), 120, 80, true);
    const threads = PALETTES.dmc.threads;
    const m = new PaletteMatcher(threads.map((t) => t.rgb));
    const pal = threadsLinear(threads.map((t) => t.rgb));
    const d = ditherAssign(grid, m, pal);
    const c = despeckle(d, grid, pal);
    expect(isolatedShare(c, 120, 80)).toBeLessThan(isolatedShare(d, 120, 80) / 2);
    const before = new Set(d);
    c.forEach((v) => expect(before.has(v)).toBe(true));
  });

  it('на плавном градиенте ближе к исходнику, чем «ровные пятна»', () => {
    const opts = { cols: 120, rows: 80, minStitches: 10, transparentEmpty: true };
    const smooth = buildPattern(gradient(), { ...opts, style: 'smooth' }, PALETTES.dmc);
    const flat = buildPattern(gradient(), { ...opts, style: 'flat' }, PALETTES.dmc);
    expect(smooth.similarity).toBeGreaterThan(flat.similarity);
    for (const c of smooth.colors) expect(c.count).toBeGreaterThanOrEqual(smooth.minStitches);
    expect(smooth.isolated).toBeLessThan(0.1);
    expect(smooth.accuracy).toBeGreaterThanOrEqual(0.999);
  });

  it('сходство с фото: одинаковая картинка — 100%', () => {
    const threads = PALETTES.dmc.threads;
    const t = threads.findIndex((x) => x.code === '310');
    const rgb = threads[t].rgb;
    const grid = resizeToGrid(image(20, 20, () => [...rgb, 255]), 20, 20, true);
    const r = farSimilarity(new Int16Array(400).fill(t), grid, threadsLinear(threads.map((x) => x.rgb)));
    expect(r.share).toBe(1);
    expect(r.meanDeltaE).toBeLessThan(0.01);
  });

  it('цель точности — 99,9%', () => {
    expect(TARGET_ACCURACY).toBe(0.999);
  });
});
