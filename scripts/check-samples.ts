// Прогон на тестовой картинке: строит схемы на 100 и 300 крестиков, пишет PDF и OXS
// в samples-out/ и печатает время и сводку.
// Запуск: npm run check-samples -- путь/к/картинке.png [ширина ...]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { PNG } from 'pngjs';
import { buildPattern } from '../src/core/pattern';
import { gridHeight } from '../src/core/resize';
import { formatPercent } from '../src/core/constants';
import { buildChartPdf } from '../src/pdf/chart';
import { buildColorsPdf } from '../src/pdf/colors';
import { buildOxs } from '../src/export/oxs';
import { PALETTES, type PaletteId } from '../src/palettes';

const [imagePath, ...widthArgs] = process.argv.slice(2);
if (!imagePath) {
  console.error('Укажите путь к PNG');
  process.exit(1);
}
const widths = widthArgs.length ? widthArgs.map(Number) : [100, 300];
const fonts = {
  regular: new Uint8Array(readFileSync(new URL('../public/fonts/DejaVuSans.ttf', import.meta.url))),
  bold: new Uint8Array(readFileSync(new URL('../public/fonts/DejaVuSans-Bold.ttf', import.meta.url))),
};
const png = PNG.sync.read(readFileSync(imagePath));
const name = basename(imagePath, extname(imagePath));
const outDir = new URL('../samples-out/', import.meta.url);
mkdirSync(outDir, { recursive: true });

for (const pid of ['dmc', 'gamma'] as PaletteId[]) {
  for (const cols of widths) {
    const rows = gridHeight(cols, png.width, png.height);
    let t = performance.now();
    const p = buildPattern(
      { width: png.width, height: png.height, data: png.data },
      { cols, rows, minStitches: 10, transparentEmpty: true },
      PALETTES[pid],
    );
    const tPattern = performance.now() - t;
    const base = `${name}_${cols}_${pid}`;
    t = performance.now();
    const chart = buildChartPdf(p, name, fonts);
    const tChart = performance.now() - t;
    t = performance.now();
    const colors = buildColorsPdf(p, name, fonts);
    const tColors = performance.now() - t;
    t = performance.now();
    const oxs = buildOxs(p, name);
    const tOxs = performance.now() - t;
    writeFileSync(new URL(`${base}_схема.pdf`, outDir), chart);
    writeFileSync(new URL(`${base}_цвета.pdf`, outDir), colors);
    writeFileSync(new URL(`${base}.oxs`, outDir), oxs);
    const kb = (n: number) => `${Math.round(n / 1024)} КБ`;
    console.log(
      `${pid} ${cols}×${rows}: цветов ${p.colors.length} (в эталоне ${p.referenceColors}), точность ${formatPercent(p.accuracy)}, ` +
        `минимум ${p.minStitches}; схема ${tPattern.toFixed(0)} мс; PDF-схема ${tChart.toFixed(0)} мс ${kb(chart.length)}; ` +
        `PDF-цвета ${tColors.toFixed(0)} мс ${kb(colors.length)}; OXS ${tOxs.toFixed(0)} мс ${kb(oxs.length)}`,
    );
  }
}
