import type { Pattern } from '../core/pattern';
import { AIDA_COUNT } from '../core/constants';

// Open Cross Stitch (.oxs), версия 1.0 — по описанию формата Ursa Software
// (https://www.ursasoftware.com/OXSFormat/) и сверено с файлом, который пишет их программа:
// - палитра: элемент 0 — ткань (cloth), дальше нитки; palettecount не включает ткань;
// - number = «Бренд номер» (Ursa выравнивает номер пробелами: "DMC    310");
// - symbol у Ursa — порядковый номер глифа их шрифта; другие программы пишут код символа
//   и fontname (так делает, например, Embroiderly) — пишем код Unicode и шрифт DejaVu Sans;
// - fullstitches: координаты x, y с нуля, palindex — индекс в палитре; пустые клетки не пишутся;
// - properties, fullstitches и backstitches обязательны даже пустыми.

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const hex = (rgb: readonly number[]) => rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

const FORMAT_COMMENTS = [
  'Designed to allow interchange of basic pattern data between any cross stitch style software',
  "the 'properties' section establishes size, copyright, authorship and software used",
  'The features of each software package varies, but using XML each can pick out the things it can deal with, while ignoring others',
  'The basic items are :',
  "'palette'..a set of colors used in the design: palettecount excludes cloth color, which is item 0",
  "'fullstitches'.. simple crosses",
  "'backstitches'.. lines/objects with a start and end point",
  '(There is a wide variety of ways of treating part stitches, knots, beads and so on.)',
  'Colors are expressed in hex RGB format.',
  "Decimal numbers use US/UK format where '.' is the indicator - eg 0.5 is 'half'",
  'For readability, please use words not enumerations',
  'The properties, fullstitches, and backstitches elements should be considered mandatory, even if empty',
  'element and attribute names are always lowercase',
];

export const OXS_SYMBOL_FONT = 'DejaVu Sans';

export function buildOxs(p: Pattern, title: string): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<chart>');
  out.push(
    '<format ' + FORMAT_COMMENTS.map((c, i) => `comments${String(i + 1).padStart(2, '0')}="${esc(c)}"`).join(' ') + '/>',
  );
  out.push(
    `<properties oxsversion="1.0" software="Cross Stitch Pattern Generator" software_version="1.0" ` +
      `chartheight="${p.rows}" chartwidth="${p.cols}" charttitle="${esc(title)}" author="" copyright="" instructions="" ` +
      `stitchesperinch="${AIDA_COUNT}" stitchesperinch_y="${AIDA_COUNT}" palettecount="${p.colors.length}"/>`,
  );
  out.push('<palette>');
  out.push(
    '<palette_item index="0" number="cloth" name="cloth" color="FFFFFF" printcolor="FFFFFF" blendcolor="nil" ' +
      'comments="aida" strands="2" symbol="0" dashpattern="" bsstrands="2" bscolor="FFFFFF"/>',
  );
  p.colors.forEach((c, i) => {
    const color = hex(c.rgb);
    out.push(
      `<palette_item index="${i + 1}" number="${esc(`${p.brand} ${c.code.padStart(6)}`)}" name="${esc(c.name || c.code)}" ` +
        `color="${color}" printcolor="${color}" blendcolor="nil" comments="" strands="2" ` +
        `symbol="${c.symbol.codePointAt(0)}" fontname="${OXS_SYMBOL_FONT}" dashpattern="" bsstrands="2" bscolor="${color}"/>`,
    );
  });
  out.push('</palette>');
  out.push('<fullstitches>');
  for (let y = 0; y < p.rows; y++) {
    for (let x = 0; x < p.cols; x++) {
      const v = p.cells[y * p.cols + x];
      if (v >= 0) out.push(`<stitch x="${x}" y="${y}" palindex="${v + 1}"/>`);
    }
  }
  out.push('</fullstitches>');
  out.push('<partstitches/>');
  out.push('<backstitches/>');
  out.push('<ornaments_inc_knots_and_beads/>');
  out.push('<commentboxes/>');
  out.push('</chart>');
  return out.join('\n') + '\n';
}
