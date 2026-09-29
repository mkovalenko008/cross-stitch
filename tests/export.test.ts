import { readFileSync } from 'node:fs';
import { unzlibSync } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { STITCHES_PER_SKEIN, skeinsFor } from '../src/core/constants';
import { buildPattern, type Pattern } from '../src/core/pattern';
import { buildOxs } from '../src/export/oxs';
import { PALETTES } from '../src/palettes';
import { buildChartPdf } from '../src/pdf/chart';
import { buildColorsPdf } from '../src/pdf/colors';
import { chartLayout, MAX_COLS_PER_PAGE, MAX_ROWS_PER_PAGE } from '../src/pdf/layout';

const fonts = {
  regular: new Uint8Array(readFileSync(new URL('../public/fonts/DejaVuSans.ttf', import.meta.url))),
  bold: new Uint8Array(readFileSync(new URL('../public/fonts/DejaVuSans-Bold.ttf', import.meta.url))),
};

function testPattern(cols: number, rows: number, withHoles = true): Pattern {
  const data = new Uint8ClampedArray(cols * 4 * rows * 4 * 4);
  const w = cols * 4;
  for (let y = 0; y < rows * 4; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const hole = withHoles && x < 8 && y < 8; // прозрачный угол 2×2 клетки
      data.set([(x * 5) % 256, (y * 3) % 256, ((x + y) * 2) % 256, hole ? 0 : 255], o);
    }
  }
  return buildPattern(
    { width: w, height: rows * 4, data },
    { cols, rows, minStitches: 10, transparentEmpty: true, style: 'smooth' },
    PALETTES.dmc,
  );
}

describe('пасмы', () => {
  it('1 пасма на 1800 крестиков, округление вверх, минимум 1', () => {
    expect(STITCHES_PER_SKEIN).toBe(1800);
    expect(skeinsFor(1)).toBe(1);
    expect(skeinsFor(1800)).toBe(1);
    expect(skeinsFor(1801)).toBe(2);
    expect(skeinsFor(5400)).toBe(3);
  });
});

describe('разбивка схемы на страницы', () => {
  it.each([
    [100, 96],
    [300, 289],
    [500, 482],
    [20, 20],
    [61, 81],
  ])('%i×%i: куски не больше 60×80 и покрывают всю схему ровно один раз', (cols, rows) => {
    const l = chartLayout(cols, rows);
    const seen = new Uint8Array(cols * rows);
    for (const c of l.chunks) {
      expect(c.cols).toBeLessThanOrEqual(MAX_COLS_PER_PAGE);
      expect(c.rows).toBeLessThanOrEqual(MAX_ROWS_PER_PAGE);
      expect(c.x0 % 10).toBe(0); // края кусков совпадают с жирными линиями
      expect(c.y0 % 10).toBe(0);
      for (let y = c.y0; y < c.y0 + c.rows; y++) for (let x = c.x0; x < c.x0 + c.cols; x++) seen[y * cols + x]++;
    }
    expect(seen.every((v) => v === 1)).toBe(true);
    expect(l.chunks.map((c) => c.page)).toEqual(l.chunks.map((_, i) => i + 2)); // обложка — стр. 1
  });
});

describe('OXS', () => {
  const p = testPattern(40, 30);
  const title = 'Тест & <кот> "Мурзик"';
  const xml = buildOxs(p, title);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', isArray: (name) => ['palette_item', 'stitch'].includes(name) });
  const doc = parser.parse(xml).chart;

  it('валидный XML', () => {
    expect(XMLValidator.validate(xml)).toBe(true);
  });

  it('структура как у Ursa Software: format, properties, palette, fullstitches, backstitches', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    for (const key of ['format', 'properties', 'palette', 'fullstitches', 'partstitches', 'backstitches']) expect(doc).toHaveProperty(key);
    const props = doc.properties;
    expect(props.oxsversion).toBe('1.0');
    expect(Number(props.chartwidth)).toBe(40);
    expect(Number(props.chartheight)).toBe(30);
    expect(props.charttitle).toBe(title); // спецсимволы экранированы и читаются обратно
    expect(props.stitchesperinch).toBe('14');
    expect(Number(props.palettecount)).toBe(p.colors.length);
  });

  it('палитра: 0 — ткань, дальше нитки с номером, названием, цветом, символом, strands=2', () => {
    const items = doc.palette.palette_item;
    expect(items).toHaveLength(p.colors.length + 1);
    expect(items[0].number).toBe('cloth');
    expect(items[0].index).toBe('0');
    items.slice(1).forEach((it: Record<string, string>, i: number) => {
      const c = p.colors[i];
      expect(it.index).toBe(String(i + 1));
      expect(it.number).toMatch(/^DMC\s+\S+$/);
      expect(it.number.split(/\s+/)[1]).toBe(c.code);
      expect(it.name).toBe(c.name);
      expect(it.color).toMatch(/^[0-9A-F]{6}$/);
      expect(it.color).toBe(c.rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase());
      expect(it.strands).toBe('2');
      expect(String.fromCodePoint(Number(it.symbol))).toBe(c.symbol);
    });
  });

  it('крестики: только непустые клетки, координаты с нуля, palindex в палитре', () => {
    const st = doc.fullstitches.stitch as Record<string, string>[];
    const nonEmpty = [...p.cells].filter((c) => c >= 0).length;
    expect(st).toHaveLength(nonEmpty);
    expect(nonEmpty).toBe(40 * 30 - 4); // прозрачный угол 2×2 не записан
    for (const s of st) {
      const x = Number(s.x);
      const y = Number(s.y);
      const pi = Number(s.palindex);
      expect(x >= 0 && x < 40 && y >= 0 && y < 30).toBe(true);
      expect(p.cells[y * 40 + x]).toBe(pi - 1);
    }
  });

  it('Гамма пишется как «Gamma»', () => {
    const img = { width: 20, height: 20, data: new Uint8ClampedArray(20 * 20 * 4).fill(200) };
    const g = buildPattern(img, { cols: 20, rows: 20, minStitches: 10, transparentEmpty: true, style: 'smooth' }, PALETTES.gamma);
    expect(buildOxs(g, 'x')).toMatch(/number="Gamma\s+\d{4}"/);
  });
});

describe('PDF', () => {
  const pageCount = (bytes: Uint8Array) => (new TextDecoder('latin1').decode(bytes).match(/\/Type \/Page\b/g) ?? []).length;

  it('схема: обложка + страницы по кускам', () => {
    const p = testPattern(100, 90);
    const bytes = buildChartPdf(p, 'Тест', fonts);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    expect(pageCount(bytes)).toBe(1 + chartLayout(100, 90).chunks.length);
  });

  it('схема: символ нарисован в каждой непустой клетке (прямые команды PDF)', () => {
    const p = testPattern(70, 50);
    const bytes = buildChartPdf(p, 'Тест', fonts);
    // распаковываем все потоки и считаем команды символов вида «… Tm <гггг> Tj»
    const raw = new TextDecoder('latin1').decode(bytes);
    let glyphs = 0;
    for (const m of raw.matchAll(/stream\r?\n/g)) {
      const start = m.index! + m[0].length;
      const end = raw.indexOf('endstream', start);
      try {
        const data = new TextDecoder('latin1').decode(unzlibSync(bytes.subarray(start, end)));
        glyphs += (data.match(/ Tm <[0-9a-f]{4}> Tj/g) ?? []).length;
      } catch {
        // не сжатый поток или шрифт — пропускаем
      }
    }
    expect(glyphs).toBe([...p.cells].filter((c) => c >= 0).length);
  });

  it('цвета: открывается, есть итог', () => {
    const p = testPattern(60, 60);
    const bytes = buildColorsPdf(p, 'Тест', fonts);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    expect(pageCount(bytes)).toBeGreaterThanOrEqual(1);
  });
});
