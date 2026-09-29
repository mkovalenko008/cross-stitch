// Тестовая схема, в которой встречаются ВСЕ символы: для проверки, что ни один
// не рендерится «квадратиком». Пишет samples-out/symbols_схема.pdf и symbols_цвета.pdf.
// Запуск: npx vite-node scripts/symbol-sheet.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { SYMBOLS } from '../src/core/symbols';
import type { Pattern } from '../src/core/pattern';
import { buildChartPdf } from '../src/pdf/chart';
import { buildColorsPdf } from '../src/pdf/colors';
import { PALETTES } from '../src/palettes';

const threads = PALETTES.gamma.threads;
const cols = 30;
const n = SYMBOLS.length;
const rows = Math.ceil((n * 2) / cols);
const cells = new Int16Array(cols * rows).fill(-1);
for (let i = 0; i < n * 2; i++) cells[i] = i % n;
const colors = SYMBOLS.map((symbol, i) => {
  const t = threads[(i * 7) % threads.length];
  return { code: t.code, name: t.name, rgb: t.rgb, count: 2, symbol };
});
const p: Pattern = {
  cols, rows, cells, colors, brand: 'Gamma', paletteTitle: 'Гамма', style: 'flat',
  accuracy: 1, similarity: 1, isolated: 0, minStitches: 2, referenceColors: n, stitches: n * 2,
};
const fonts = {
  regular: new Uint8Array(readFileSync(new URL('../public/fonts/DejaVuSans.ttf', import.meta.url))),
  bold: new Uint8Array(readFileSync(new URL('../public/fonts/DejaVuSans-Bold.ttf', import.meta.url))),
};
const out = new URL('../samples-out/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('symbols_схема.pdf', out), buildChartPdf(p, 'Все символы', fonts));
writeFileSync(new URL('symbols_цвета.pdf', out), buildColorsPdf(p, 'Все символы', fonts));
writeFileSync(new URL('symbols.txt', out), SYMBOLS.join(''));
console.log(`${n} символов, ${cols}×${rows}`);
