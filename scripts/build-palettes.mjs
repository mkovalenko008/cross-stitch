// Собирает src/palettes/dmc.json и src/palettes/gamma.json из открытых источников.
// Запуск: npm run palettes (нужен интернет, Node 18+).
//
// DMC:   makebead/craft-color-codes, data/json/dmc-floss.json (CC BY 4.0),
//        зафиксирован на коммите, чтобы результат был воспроизводимым.
// Гамма: официальная карта цветов мулине на сайте производителя firma-gamma.ru
//        (вид «сортировать по Gamma» — включает номера без аналога DMC).
//        У каждой строки есть образец цвета (background-color) — это цвет самой
//        нитки Гаммы, опубликованный производителем.

import { writeFile, mkdir } from 'node:fs/promises';

const DMC_URL =
  'https://raw.githubusercontent.com/makebead/craft-color-codes/84dbdc26a961247f2aba58c91f314966a38e64ae/data/json/dmc-floss.json';
const GAMMA_URL = 'https://firma-gamma.ru/articles/colormap-muline/gamma/';

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};

async function buildDmc() {
  const res = await fetch(DMC_URL);
  if (!res.ok) throw new Error(`DMC: HTTP ${res.status}`);
  const data = await res.json();
  // Косметика названий (цвета не трогаем): двойные пробелы, сокращение «Vy», опечатка «Darkv» у 3802
  const cleanName = (n) => n.replace(/\bVy\b/g, 'Very').replace(/\bDarkv\b/g, 'Dark').replace(/\s+/g, ' ').trim();
  const colors = data.colors.map((c) => ({ code: c.code, name: cleanName(c.name), rgb: c.rgb }));
  for (const c of colors) {
    const fromHex = hexToRgb(data.colors.find((x) => x.code === c.code).hex);
    if (fromHex.join() !== c.rgb.join()) throw new Error(`DMC ${c.code}: hex и rgb расходятся`);
  }
  const codes = new Set(colors.map((c) => c.code));
  if (codes.size !== colors.length) throw new Error('DMC: повторяющиеся номера');
  for (const must of ['Blanc', 'Ecru', 'B5200']) {
    if (!codes.has(must)) throw new Error(`DMC: нет ${must}`);
  }
  return colors;
}

const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

async function buildGamma(dmc) {
  const res = await fetch(GAMMA_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Гамма: HTTP ${res.status}`);
  const html = new TextDecoder('windows-1251').decode(await res.arrayBuffer());
  const start = html.indexOf('like-table__tbody');
  const body = html.slice(start, html.indexOf('</tbody>', start));
  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const dmcByCode = new Map(dmc.map((c) => [c.code.toUpperCase(), c]));

  // Один номер Гаммы может встречаться в нескольких строках (разные аналоги DMC,
  // один и тот же образец цвета) — такие строки объединяем.
  const byCode = new Map();
  for (const row of rows) {
    const tds = [...row.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)];
    // Столбцы: Gamma | DMC | Anchor | Madeira | Цвет
    if (tds.length !== 5) throw new Error(`Гамма: неожиданная строка ${row.slice(0, 200)}`);
    const gammaCell = stripTags(tds[0][2]);
    const code = gammaCell.replace('*', '');
    const dmcCell = stripTags(tds[1][2]);
    const swatch = /background-color:\s*#([0-9a-fA-F]{6})/.exec(tds[4][1]);
    if (!/^\d{4}$/.test(code)) throw new Error(`Гамма: странный номер ${code}`);
    if (!swatch) continue; // без образца цвета не включаем (таких в источнике нет)

    // «*» в источнике = «наиболее похожий цвет» (неточное соответствие) — сохраняем как есть;
    // звёздочка может стоять и у номера Гаммы — тогда неточны все аналоги этой строки
    const equivalents = dmcCell === '-' ? [] : dmcCell.split(',').map((s) => s.trim());
    if (gammaCell.endsWith('*')) {
      for (let i = 0; i < equivalents.length; i++) {
        if (!equivalents[i].endsWith('*')) equivalents[i] += '*';
      }
    }
    const rgb = hexToRgb(swatch[1]);
    const prev = byCode.get(code);
    if (prev) {
      if (prev.rgb.join() !== rgb.join()) throw new Error(`Гамма ${code}: разные образцы цвета`);
      prev.dmc.push(...equivalents.filter((e) => !prev.dmc.includes(e)));
      continue;
    }
    byCode.set(code, { code, name: '', rgb, rgbSource: 'gamma-official', dmc: equivalents });
  }

  const out = [...byCode.values()];
  for (const c of out) {
    // точные аналоги вперёд, приблизительные («*») — после
    c.dmc.sort((a, b) => Number(a.endsWith('*')) - Number(b.endsWith('*')));
    if (c.dmc.length) {
      const main = c.dmc[0];
      const approx = main.endsWith('*');
      const mainCode = main.replace('*', '');
      const ref = dmcByCode.get(mainCode.toUpperCase());
      const refName = ref && ref.name.toUpperCase() !== mainCode.toUpperCase() ? ` ${ref.name}` : '';
      c.name = `${approx ? '≈ ' : ''}DMC ${mainCode}${refName}`;
    }
  }
  out.sort((a, b) => Number(a.code) - Number(b.code));
  return out;
}

const toJson = (arr) => '[\n' + arr.map((c) => '  ' + JSON.stringify(c)).join(',\n') + '\n]\n';

const dmc = await buildDmc();
const gamma = await buildGamma(dmc);
await mkdir(new URL('../src/palettes/', import.meta.url), { recursive: true });
await writeFile(new URL('../src/palettes/dmc.json', import.meta.url), toJson(dmc));
await writeFile(new URL('../src/palettes/gamma.json', import.meta.url), toJson(gamma));
console.log(`DMC: ${dmc.length} цветов`);
console.log(
  `Гамма: ${gamma.length} цветов (без аналога DMC: ${gamma.filter((c) => !c.dmc.length).length}, ` +
    `rgbSource=dmc-equivalent: ${gamma.filter((c) => c.rgbSource === 'dmc-equivalent').length})`,
);
