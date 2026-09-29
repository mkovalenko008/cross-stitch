import type { jsPDF } from 'jspdf';
import { STITCHES_PER_SKEIN, formatInt, sizeCm, skeinsFor } from '../core/constants';
import type { Pattern } from '../core/pattern';
import { FONT, PAGE_H, createDoc, docToBytes, drawSymbol, pageFooter, setFill, symbolTextRgb, type PdfFonts } from './common';

const LEFT = 14;
const TOP = 34; // первая страница: под заголовком
const TOP_NEXT = 16;
const ROW_H = 7;
const HEAD_H = 8;
const BOTTOM = PAGE_H - 18;

// символ | образец | номер | название | крестиков | пасм
const COLS = [
  { title: 'Символ', w: 16, align: 'center' as const },
  { title: 'Образец', w: 20, align: 'center' as const },
  { title: 'Номер', w: 20, align: 'left' as const },
  { title: 'Название', w: 72, align: 'left' as const },
  { title: 'Крестиков', w: 25, align: 'right' as const },
  { title: 'Пасм', w: 29, align: 'right' as const },
];
const TABLE_W = COLS.reduce((s, c) => s + c.w, 0);

export function buildColorsPdf(pattern: Pattern, title: string, fonts: PdfFonts): Uint8Array {
  const doc = createDoc(fonts, `${title} — цвета`);
  const rows = pattern.colors;

  // раскладка по страницам: сколько строк влезает на первую и следующие страницы
  const firstFit = Math.floor((BOTTOM - TOP - HEAD_H) / ROW_H);
  const nextFit = Math.floor((BOTTOM - TOP_NEXT - HEAD_H) / ROW_H);
  const TOTALS_H = 30;
  const pages: number[][] = [];
  let i = 0;
  let fit = firstFit;
  while (i < rows.length) {
    pages.push([i, Math.min(rows.length, i + fit)]);
    i += fit;
    fit = nextFit;
  }
  if (pages.length === 0) pages.push([0, 0]);
  // итог должен поместиться под последней строкой
  const last = pages[pages.length - 1];
  const lastTop = pages.length === 1 ? TOP : TOP_NEXT;
  if (lastTop + HEAD_H + (last[1] - last[0]) * ROW_H + TOTALS_H > BOTTOM) pages.push([rows.length, rows.length]);

  const totalPages = pages.length;
  pages.forEach(([from, to], pi) => {
    if (pi > 0) doc.addPage();
    let y = pi === 0 ? TOP : TOP_NEXT;
    if (pi === 0) {
      doc.setFont(FONT, 'bold');
      doc.setFontSize(17);
      doc.text(`${title} — цвета`, LEFT, 18);
      doc.setFont(FONT, 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(80, 80, 80);
      doc.text(
        `Нитки ${pattern.paletteTitle} · ${pattern.cols} × ${pattern.rows} крестиков (${sizeCm(pattern.cols)} × ${sizeCm(pattern.rows)} см на Aida 14) · ` +
          `пасмы — из расчёта ${formatInt(STITCHES_PER_SKEIN)} крестиков на пасму в 2 сложения`,
        LEFT,
        25,
        { maxWidth: TABLE_W },
      );
      doc.setTextColor(0, 0, 0);
    }
    if (to > from) {
      header(doc, y);
      y += HEAD_H;
      for (let r = from; r < to; r++) {
        row(doc, pattern, r, y);
        y += ROW_H;
      }
    }
    if (pi === totalPages - 1) totals(doc, pattern, y + 6);
    pageFooter(doc, pi + 1, totalPages, `${title} — цвета`);
  });
  return docToBytes(doc);
}

function header(doc: jsPDF, y: number): void {
  doc.setFillColor(236, 236, 236);
  doc.rect(LEFT, y, TABLE_W, HEAD_H, 'F');
  doc.setFont(FONT, 'bold');
  doc.setFontSize(8.5);
  let x = LEFT;
  for (const c of COLS) {
    const tx = c.align === 'center' ? x + c.w / 2 : c.align === 'right' ? x + c.w - 2 : x + 2;
    doc.text(c.title, tx, y + HEAD_H / 2, { align: c.align, baseline: 'middle' });
    x += c.w;
  }
  doc.setFont(FONT, 'normal');
}

function row(doc: jsPDF, p: Pattern, index: number, y: number): void {
  const c = p.colors[index];
  const mid = y + ROW_H / 2;
  if (index % 2 === 1) {
    doc.setFillColor(248, 248, 248);
    doc.rect(LEFT, y, TABLE_W, ROW_H, 'F');
  }
  let x = LEFT;
  // символ — как на схеме: клетка цвета нитки с символом
  const box = 5.4;
  const bx = x + (COLS[0].w - box) / 2;
  setFill(doc, c.rgb);
  doc.setDrawColor(60, 60, 60);
  doc.setLineWidth(0.15);
  doc.rect(bx, mid - box / 2, box, box, 'FD');
  const t = symbolTextRgb(c.rgb);
  doc.setTextColor(t[0], t[1], t[2]);
  drawSymbol(doc, c.symbol, bx + box / 2, mid, box * 0.8, box * 0.74);
  doc.setTextColor(0, 0, 0);
  x += COLS[0].w;
  // образец цвета
  setFill(doc, c.rgb);
  doc.rect(x + 3, mid - 2.5, COLS[1].w - 6, 5, 'FD');
  x += COLS[1].w;

  doc.setFontSize(9);
  doc.setFont(FONT, 'bold');
  doc.text(c.code, x + 2, mid, { baseline: 'middle' });
  doc.setFont(FONT, 'normal');
  x += COLS[2].w;
  doc.setFontSize(8.5);
  const name = c.name || '—';
  const fitted = doc.splitTextToSize(name, COLS[3].w - 3) as string[];
  doc.text(fitted.length > 1 ? fitted[0].replace(/\s*\S*$/, '') + '…' : name, x + 2, mid, { baseline: 'middle' });
  x += COLS[3].w;
  doc.setFontSize(9);
  doc.text(formatInt(c.count), x + COLS[4].w - 2, mid, { align: 'right', baseline: 'middle' });
  x += COLS[4].w;
  doc.text(String(skeinsFor(c.count)), x + COLS[5].w - 2, mid, { align: 'right', baseline: 'middle' });

  doc.setDrawColor(215, 215, 215);
  doc.setLineWidth(0.1);
  doc.line(LEFT, y + ROW_H, LEFT + TABLE_W, y + ROW_H);
}

function totals(doc: jsPDF, p: Pattern, y: number): void {
  const skeins = p.colors.reduce((s, c) => s + skeinsFor(c.count), 0);
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.4);
  doc.line(LEFT, y - 3, LEFT + TABLE_W, y - 3);
  const items: [string, string][] = [
    ['Всего цветов', String(p.colors.length)],
    ['Всего крестиков', formatInt(p.stitches)],
    ['Всего пасм', String(skeins)],
    ['Производитель', p.paletteTitle === p.brand ? p.brand : `${p.paletteTitle} (${p.brand})`],
  ];
  doc.setFontSize(10);
  items.forEach(([label, value], i) => {
    const yy = y + 2 + i * 5.6;
    doc.setFont(FONT, 'normal');
    doc.setTextColor(80, 80, 80);
    doc.text(label, LEFT + 2, yy);
    doc.setTextColor(0, 0, 0);
    doc.setFont(FONT, 'bold');
    doc.text(value, LEFT + 50, yy);
  });
  doc.setFont(FONT, 'normal');

}
