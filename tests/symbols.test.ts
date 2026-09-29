import { readFileSync } from 'node:fs';
import * as fontkit from 'fontkit';
import { describe, expect, it } from 'vitest';
import { SYMBOLS } from '../src/core/symbols';
import { PALETTES } from '../src/palettes';
import metrics from '../src/core/symbol-metrics.json';

const font = fontkit.create(readFileSync(new URL('../public/fonts/DejaVuSans.ttf', import.meta.url))) as fontkit.Font;

describe('символы схемы', () => {
  it('не меньше 250 уникальных глифов', () => {
    expect(SYMBOLS.length).toBeGreaterThanOrEqual(250);
    expect(new Set(SYMBOLS).size).toBe(SYMBOLS.length);
  });

  it('символов хватает на всю палитру — цвета не урезаются из-за нехватки символов', () => {
    const largest = Math.max(...Object.values(PALETTES).map((p) => p.threads.length));
    expect(SYMBOLS.length).toBeGreaterThanOrEqual(largest);
  });

  it('каждый символ — один кодпоинт', () => {
    for (const s of SYMBOLS) expect([...s]).toHaveLength(1);
  });

  it('все символы есть во встроенном шрифте DejaVu Sans (не будет «квадратиков»)', () => {
    const missing = SYMBOLS.filter((s) => {
      const cp = s.codePointAt(0)!;
      if (!font.hasGlyphForCodePoint(cp)) return true;
      const glyph = font.glyphForCodePoint(cp);
      return glyph.id === 0 || glyph.bbox.width <= 0 || glyph.bbox.height <= 0;
    });
    expect(missing).toEqual([]);
  });

  it('метрики центрирования совпадают со шрифтом', () => {
    const m = metrics as { unitsPerEm: number; glyphs: Record<string, number[]> };
    expect(m.unitsPerEm).toBe(font.unitsPerEm);
    for (const s of SYMBOLS) {
      const bb = font.glyphForCodePoint(s.codePointAt(0)!).bbox;
      expect(m.glyphs[s]).toEqual([bb.minX, bb.minY, bb.maxX, bb.maxY]);
    }
  });
});
