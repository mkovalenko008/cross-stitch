// Считает габариты глифов символов схемы в шрифте DejaVu Sans, чтобы в PDF
// центрировать каждый символ в клетке по его реальным границам.
// Запуск: npx vite-node scripts/build-symbol-metrics.ts
import { readFileSync, writeFileSync } from 'node:fs';
import * as fontkit from 'fontkit';
import { SYMBOLS } from '../src/core/symbols';

const font = fontkit.create(readFileSync(new URL('../public/fonts/DejaVuSans.ttf', import.meta.url))) as fontkit.Font;
const glyphs: Record<string, number[]> = {};
for (const s of SYMBOLS) {
  const bb = font.glyphForCodePoint(s.codePointAt(0)!).bbox;
  glyphs[s] = [bb.minX, bb.minY, bb.maxX, bb.maxY];
}
const json =
  '{\n  "unitsPerEm": ' + font.unitsPerEm + ',\n  "glyphs": {\n' +
  Object.entries(glyphs).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n') +
  '\n  }\n}\n';
writeFileSync(new URL('../src/core/symbol-metrics.json', import.meta.url), json);
console.log(`Метрики для ${SYMBOLS.length} символов записаны`);
