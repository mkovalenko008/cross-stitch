import type { jsPDF } from 'jspdf';
import { STITCHES_PER_SKEIN, formatInt, sizeCm } from '../core/constants';
import type { Pattern } from '../core/pattern';
import { threadUsage } from '../core/threads';
import { FONT, PAGE_H, createDoc, docToBytes, drawSymbol, pageFooter, setFill, symbolTextRgb, type PdfFonts } from './common';

const LEFT = 14;
const WIDTH = 182;
const TOP = 16;
const BOTTOM = PAGE_H - 18;
const ROW_H = 7;
const HEAD_H = 8;

interface Column {
  title: string;
  w: number;
  align: 'left' | 'center' | 'right';
}

// Цвета схемы: символ | образец | номер | название | нитки в игле | крестиков
const COLOR_COLS: Column[] = [
  { title: 'Символ', w: 15, align: 'center' },
  { title: 'Образец', w: 17, align: 'center' },
  { title: 'Номер', w: 30, align: 'left' },
  { title: 'Название', w: 76, align: 'left' },
  { title: 'Нитки', w: 18, align: 'center' },
  { title: 'Крестиков', w: 26, align: 'right' },
];
// Нитки к покупке: образец | номер | название | крестиков | пасм
const THREAD_COLS: Column[] = [
  { title: 'Образец', w: 17, align: 'center' },
  { title: 'Номер', w: 22, align: 'left' },
  { title: 'Название', w: 85, align: 'left' },
  { title: 'Крестиков', w: 34, align: 'right' },
  { title: 'Пасм', w: 24, align: 'right' },
];

/** Простой постраничный вывод: строки добавляются сверху вниз, при нехватке места — новая страница. */
class Pager {
  y = TOP;
  page = 1;
  private repeatHeader: (() => void) | null = null;

  constructor(private readonly doc: jsPDF) {}

  /** Место под блок высотой h; при переносе на новую страницу повторяет шапку таблицы. */
  need(h: number): void {
    if (this.y + h <= BOTTOM) return;
    this.doc.addPage();
    this.page++;
    this.y = TOP;
    this.repeatHeader?.();
  }

  table(cols: Column[]): void {
    this.repeatHeader = () => header(this.doc, cols, this);
    this.need(HEAD_H + ROW_H);
    header(this.doc, cols, this);
  }

  endTable(): void {
    this.repeatHeader = null;
  }
}

export function buildColorsPdf(pattern: Pattern, title: string, fonts: PdfFonts): Uint8Array {
  const doc = createDoc(fonts, `${title} — цвета`);
  const pager = new Pager(doc);
  const threads = threadUsage(pattern);

  // Заголовок
  doc.setFont(FONT, 'bold');
  doc.setFontSize(17);
  doc.text(`${title} — цвета`, LEFT, 18);
  doc.setFont(FONT, 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(80, 80, 80);
  const blendNote = pattern.blendColors
    ? ` «1 + 1» — смесь: в иглу по одной нитке двух цветов, крестик шьётся как обычно.`
    : '';
  const intro = doc.splitTextToSize(
    `Нитки ${pattern.paletteTitle} · ${pattern.cols} × ${pattern.rows} крестиков (${sizeCm(pattern.cols)} × ${sizeCm(pattern.rows)} см на Aida 14) · ` +
      `2 сложения, пасмы — из расчёта ${formatInt(STITCHES_PER_SKEIN)} крестиков на пасму.${blendNote}`,
    WIDTH,
  ) as string[];
  doc.text(intro, LEFT, 25);
  doc.setTextColor(0, 0, 0);
  pager.y = 25 + intro.length * 4.4 + 4;

  // 1. Цвета схемы
  section(doc, pager, `Цвета схемы · ${pattern.colors.length}${pattern.blendColors ? `, из них смесей ${pattern.blendColors}` : ''}`);
  pager.table(COLOR_COLS);
  pattern.colors.forEach((c, i) => {
    pager.need(ROW_H);
    const y = pager.y;
    const mid = y + ROW_H / 2;
    stripe(doc, i, y);
    let x = LEFT;
    // символ — как на схеме: клетка цвета с символом
    const box = 5.4;
    const bx = x + (COLOR_COLS[0].w - box) / 2;
    setFill(doc, c.rgb);
    doc.setDrawColor(60, 60, 60);
    doc.setLineWidth(0.15);
    doc.rect(bx, mid - box / 2, box, box, 'FD');
    const t = symbolTextRgb(c.rgb);
    doc.setTextColor(t[0], t[1], t[2]);
    drawSymbol(doc, c.symbol, bx + box / 2, mid, box * 0.8, box * 0.74);
    doc.setTextColor(0, 0, 0);
    x += COLOR_COLS[0].w;
    swatches(doc, c.parts.length > 1 ? [c.rgb, ...c.parts.map((p) => p.rgb)] : [c.rgb], x, mid, COLOR_COLS[1].w);
    x += COLOR_COLS[1].w;
    doc.setFontSize(9);
    doc.setFont(FONT, 'bold');
    doc.text(c.parts.map((p) => p.code).join(' + '), x + 2, mid, { baseline: 'middle' });
    doc.setFont(FONT, 'normal');
    x += COLOR_COLS[2].w;
    cellText(doc, c.name || '—', x, mid, COLOR_COLS[3].w, 8);
    x += COLOR_COLS[3].w;
    doc.setFontSize(8.5);
    doc.text(c.parts.length > 1 ? '1 + 1' : '2', x + COLOR_COLS[4].w / 2, mid, { align: 'center', baseline: 'middle' });
    x += COLOR_COLS[4].w;
    doc.setFontSize(9);
    doc.text(formatInt(c.count), x + COLOR_COLS[5].w - 2, mid, { align: 'right', baseline: 'middle' });
    rule(doc, y);
    pager.y += ROW_H;
  });
  pager.endTable();

  // 2. Нитки к покупке
  pager.y += 8;
  pager.need(12 + HEAD_H + ROW_H);
  section(doc, pager, `Нитки к покупке · ${threads.length}`);
  pager.table(THREAD_COLS);
  threads.forEach((u, i) => {
    pager.need(ROW_H);
    const y = pager.y;
    const mid = y + ROW_H / 2;
    stripe(doc, i, y);
    let x = LEFT;
    swatches(doc, [u.rgb], x, mid, THREAD_COLS[0].w);
    x += THREAD_COLS[0].w;
    doc.setFontSize(9);
    doc.setFont(FONT, 'bold');
    doc.text(u.code, x + 2, mid, { baseline: 'middle' });
    doc.setFont(FONT, 'normal');
    x += THREAD_COLS[1].w;
    cellText(doc, u.name || '—', x, mid, THREAD_COLS[2].w, 8.5);
    x += THREAD_COLS[2].w;
    doc.setFontSize(9);
    doc.text(formatInt(Math.round(u.stitches)), x + THREAD_COLS[3].w - 2, mid, { align: 'right', baseline: 'middle' });
    x += THREAD_COLS[3].w;
    doc.text(String(u.skeins), x + THREAD_COLS[4].w - 2, mid, { align: 'right', baseline: 'middle' });
    rule(doc, y);
    pager.y += ROW_H;
  });
  pager.endTable();

  // Итог
  const skeins = threads.reduce((s, u) => s + u.skeins, 0);
  const items: [string, string][] = [
    ['Цветов в схеме', pattern.blendColors ? `${pattern.colors.length} (смесей ${pattern.blendColors})` : String(pattern.colors.length)],
    ['Ниток к покупке', String(threads.length)],
    ['Всего крестиков', formatInt(pattern.stitches)],
    ['Всего пасм', String(skeins)],
    ['Производитель', pattern.paletteTitle === pattern.brand ? pattern.brand : `${pattern.paletteTitle} (${pattern.brand})`],
  ];
  pager.y += 6;
  pager.need(items.length * 5.6 + 6);
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.4);
  doc.line(LEFT, pager.y, LEFT + WIDTH, pager.y);
  doc.setFontSize(10);
  items.forEach(([label, value], i) => {
    const yy = pager.y + 6 + i * 5.6;
    doc.setFont(FONT, 'normal');
    doc.setTextColor(80, 80, 80);
    doc.text(label, LEFT + 2, yy);
    doc.setTextColor(0, 0, 0);
    doc.setFont(FONT, 'bold');
    doc.text(value, LEFT + 52, yy);
  });
  doc.setFont(FONT, 'normal');

  // Номера страниц — когда их общее число уже известно
  const total = pager.page;
  for (let pno = 1; pno <= total; pno++) {
    doc.setPage(pno);
    pageFooter(doc, pno, total, `${title} — цвета`);
  }
  return docToBytes(doc);
}

function section(doc: jsPDF, pager: Pager, text: string): void {
  pager.need(12);
  doc.setFont(FONT, 'bold');
  doc.setFontSize(12);
  doc.text(text, LEFT, pager.y + 5);
  doc.setFont(FONT, 'normal');
  pager.y += 9;
}

function header(doc: jsPDF, cols: Column[], pager: Pager): void {
  const y = pager.y;
  doc.setFillColor(236, 236, 236);
  doc.rect(LEFT, y, WIDTH, HEAD_H, 'F');
  doc.setFont(FONT, 'bold');
  doc.setFontSize(8.5);
  let x = LEFT;
  for (const c of cols) {
    const tx = c.align === 'center' ? x + c.w / 2 : c.align === 'right' ? x + c.w - 2 : x + 2;
    doc.text(c.title, tx, y + HEAD_H / 2, { align: c.align, baseline: 'middle' });
    x += c.w;
  }
  doc.setFont(FONT, 'normal');
  pager.y += HEAD_H;
}

function stripe(doc: jsPDF, i: number, y: number): void {
  if (i % 2 === 1) {
    doc.setFillColor(248, 248, 248);
    doc.rect(LEFT, y, WIDTH, ROW_H, 'F');
  }
}

function rule(doc: jsPDF, y: number): void {
  doc.setDrawColor(215, 215, 215);
  doc.setLineWidth(0.1);
  doc.line(LEFT, y + ROW_H, LEFT + WIDTH, y + ROW_H);
}

/** Образец: один цвет или (для смеси) смешанный цвет и две нитки маленькими полосками. */
function swatches(doc: jsPDF, colors: ReadonlyArray<readonly number[]>, x: number, mid: number, w: number): void {
  doc.setDrawColor(60, 60, 60);
  doc.setLineWidth(0.15);
  const sw = w - 6;
  if (colors.length === 1) {
    setFill(doc, colors[0]);
    doc.rect(x + 3, mid - 2.5, sw, 5, 'FD');
    return;
  }
  setFill(doc, colors[0]);
  doc.rect(x + 3, mid - 2.5, sw, 3.2, 'FD');
  const half = sw / 2;
  setFill(doc, colors[1]);
  doc.rect(x + 3, mid + 0.9, half, 1.6, 'FD');
  setFill(doc, colors[2]);
  doc.rect(x + 3 + half, mid + 0.9, half, 1.6, 'FD');
}

/** Текст в ячейке: если не влезает — обрезается с многоточием. */
function cellText(doc: jsPDF, text: string, x: number, mid: number, w: number, size: number): void {
  doc.setFontSize(size);
  const lines = doc.splitTextToSize(text, w - 3) as string[];
  doc.text(lines.length > 1 ? lines[0].replace(/\s*\S*$/, '') + '…' : text, x + 2, mid, { baseline: 'middle' });
}
