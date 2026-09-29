import type { jsPDF } from 'jspdf';
import { formatInt, formatPercent, sizeCm } from '../core/constants';
import type { Pattern } from '../core/pattern';
import { threadUsage } from '../core/threads';
import { FONT, PAGE_H, PAGE_W, PT_PER_MM, createDoc, docToBytes, glyphPlacement, pageFooter, previewPng, symbolTextRgb, type PdfFonts } from './common';
import { chartLayout, type Chunk } from './layout';

const MARGIN = 8;
const HEADER = 18; // место под заголовок страницы
const FOOTER = 12;
// поля под номера и стрелки центра: сверху/снизу и слева/справа (номера строк шире)
const BAND_Y = 7;
const BAND_X = 9;
const MAX_CELL = 5;

const THIN = 0.08;
const THICK = 0.3;
const BORDER = 0.6;

export type ProgressFn = (fraction: number) => void;

export function buildChartPdf(pattern: Pattern, title: string, fonts: PdfFonts, onProgress?: ProgressFn): Uint8Array {
  const layout = chartLayout(pattern.cols, pattern.rows);
  const cell = Math.min(
    (PAGE_W - 2 * MARGIN - 2 * BAND_X) / layout.chunkCols,
    (PAGE_H - HEADER - FOOTER - 2 * BAND_Y) / layout.chunkRows,
    MAX_CELL,
  );
  const totalPages = 1 + layout.chunks.length;
  const doc = createDoc(fonts, `${title} — схема`);

  drawCover(doc, pattern, title, layout.chunks, layout.pagesX, layout.pagesY, totalPages);
  const symbols = prepareSymbols(doc, pattern, cell);

  layout.chunks.forEach((chunk, i) => {
    doc.addPage();
    drawChunk(doc, pattern, title, chunk, cell, totalPages, symbols);
    onProgress?.((i + 1) / layout.chunks.length);
  });
  return docToBytes(doc);
}

function drawCover(
  doc: jsPDF,
  p: Pattern,
  title: string,
  chunks: Chunk[],
  pagesX: number,
  pagesY: number,
  totalPages: number,
): void {
  doc.setFont(FONT, 'bold');
  doc.setFontSize(20);
  doc.text(title, PAGE_W / 2, 20, { align: 'center', maxWidth: PAGE_W - 2 * MARGIN });
  doc.setFont(FONT, 'normal');
  doc.setFontSize(11);
  doc.setTextColor(90, 90, 90);
  doc.text('Схема для вышивки крестом', PAGE_W / 2, 27, { align: 'center' });
  doc.setTextColor(0, 0, 0);

  // Превью: целое число пикселей на клетку, чтобы клетки были чёткими
  const k = Math.max(1, Math.min(8, Math.floor(1600 / Math.max(p.cols, p.rows))));
  const img = previewPng(p.cols, p.rows, p.cells, p.colors, k);
  const boxW = PAGE_W - 2 * 20;
  const boxH = 120;
  const scale = Math.min(boxW / p.cols, boxH / p.rows);
  const pw = p.cols * scale;
  const ph = p.rows * scale;
  const px = (PAGE_W - pw) / 2;
  const py = 34;
  doc.addImage(img, 'PNG', px, py, pw, ph, 'preview', 'FAST');
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.2);
  doc.rect(px, py, pw, ph);

  // Сведения
  let y = py + ph + 11;
  const info: [string, string][] = [
    ['Размер', `${p.cols} × ${p.rows} крестиков`],
    ['На канве Aida 14', `${sizeCm(p.cols)} × ${sizeCm(p.rows)} см`],
    ['Цветов', p.blendColors ? `${p.colors.length} (смесей двух ниток ${p.blendColors})` : String(p.colors.length)],
    ['Ниток к покупке', String(threadUsage(p).length)],
    ['Крестиков', formatInt(p.stitches)],
    ['Нитки', p.paletteTitle === p.brand ? p.brand : `${p.paletteTitle} (${p.brand})`],
    ['Сходство с фото', formatPercent(p.similarity)],
    ['Точность передачи цвета', formatPercent(p.accuracy)],
  ];
  doc.setFontSize(10.5);
  const labelX = 30;
  for (const [label, value] of info) {
    doc.setTextColor(90, 90, 90);
    doc.text(label, labelX, y);
    doc.setTextColor(0, 0, 0);
    doc.setFont(FONT, 'bold');
    doc.text(value, labelX + 52, y);
    doc.setFont(FONT, 'normal');
    y += 6.2;
  }

  // Карта разбивки на страницы
  const mapTop = y + 4;
  doc.setFont(FONT, 'bold');
  doc.setFontSize(11);
  doc.text('Страницы схемы', PAGE_W / 2, mapTop, { align: 'center' });
  doc.setFont(FONT, 'normal');
  const mapBoxW = PAGE_W - 2 * 30;
  const mapBoxH = PAGE_H - FOOTER - (mapTop + 5) - 4;
  const ms = Math.min(mapBoxW / p.cols, mapBoxH / p.rows);
  const mw = p.cols * ms;
  const mh = p.rows * ms;
  const mx = (PAGE_W - mw) / 2;
  const my = mapTop + 5;
  // бледное превью под сеткой страниц
  doc.addImage(img, 'PNG', mx, my, mw, mh, 'preview', 'FAST');
  doc.saveGraphicsState();
  doc.setGState(doc.GState({ opacity: 0.72 }));
  doc.setFillColor(255, 255, 255);
  doc.rect(mx, my, mw, mh, 'F');
  doc.restoreGraphicsState();
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.35);
  const fontSize = Math.max(6, Math.min(16, (Math.min(mw / pagesX, mh / pagesY) / 2.2) * (72 / 25.4)));
  doc.setFontSize(fontSize);
  for (const c of chunks) {
    const x = mx + c.x0 * ms;
    const yy = my + c.y0 * ms;
    doc.rect(x, yy, c.cols * ms, c.rows * ms);
    doc.setFont(FONT, 'bold');
    doc.text(String(c.page), x + (c.cols * ms) / 2, yy + (c.rows * ms) / 2, { align: 'center', baseline: 'middle' });
  }
  doc.setFont(FONT, 'normal');
  pageFooter(doc, 1, totalPages);
}

/** Дописать готовые команды PDF в содержимое текущей страницы (jsPDF internal.write, нет в типах). */
function rawWrite(doc: jsPDF, commands: string): void {
  (doc.internal as unknown as { write: (s: string) => void }).write(commands);
}

/** Короткая запись числа для команд PDF. */
function num(v: number, digits = 2): string {
  const m = 10 ** digits;
  return String(Math.round(v * m) / m);
}

interface SymbolGlyphs {
  fontId: string;
  glyphs: { hex: string; em: string; ox: number; oy: number; white: number }[];
}

/** Код глифа каждого символа во встроенном шрифте (заодно глиф попадает в подмножество шрифта), кегль и смещение. */
function prepareSymbols(doc: jsPDF, p: Pattern, s: number): SymbolGlyphs {
  doc.setFont(FONT, 'normal');
  const font = doc.getFont() as unknown as { id: string };
  const escape = (doc as unknown as { pdfEscape16: (t: string, f: unknown) => string }).pdfEscape16;
  return {
    fontId: font.id,
    glyphs: p.colors.map((col) => {
      const { em, ox, oy } = glyphPlacement(col.symbol, s * 0.78, s * 0.74);
      return {
        hex: escape(col.symbol, font),
        em: num(em * PT_PER_MM),
        ox,
        oy,
        white: symbolTextRgb(col.rgb)[0] === 255 ? 1 : 0,
      };
    }),
  };
}

function drawChunk(doc: jsPDF, p: Pattern, title: string, c: Chunk, s: number, totalPages: number, symbols: SymbolGlyphs): void {
  const gw = c.cols * s;
  const gh = c.rows * s;
  const gx = (PAGE_W - gw) / 2;
  const gy = HEADER + BAND_Y;

  // Заголовок
  doc.setFont(FONT, 'bold');
  doc.setFontSize(10);
  doc.text(title, MARGIN, 10);
  doc.setFont(FONT, 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(70, 70, 70);
  doc.text(
    `Столбцы ${c.x0 + 1}–${c.x0 + c.cols} · Строки ${c.y0 + 1}–${c.y0 + c.rows}`,
    MARGIN,
    14.5,
  );
  doc.setTextColor(0, 0, 0);

  // Клеток на странице до 4800, поэтому заливку и символы пишем прямо командами PDF
  // (единицы — пункты, ось Y вверх), а не тысячами вызовов jsPDF: так в разы быстрее.
  const K = PT_PER_MM;
  const X = (mm: number) => num(mm * K);
  const Y = (mm: number) => num((PAGE_H - mm) * K);

  // Заливка: подряд идущие клетки одного цвета — один прямоугольник; прямоугольники сгруппированы по цвету
  const rects = new Map<number, string[]>();
  for (let r = 0; r < c.rows; r++) {
    const rowBase = (c.y0 + r) * p.cols + c.x0;
    const top = gy + r * s;
    let run = -1;
    let runStart = 0;
    for (let x = 0; x <= c.cols; x++) {
      const v = x < c.cols ? p.cells[rowBase + x] : -2;
      if (v !== run) {
        if (run >= 0) {
          let list = rects.get(run);
          if (!list) rects.set(run, (list = []));
          list.push(`${X(gx + runStart * s)} ${Y(top + s)} ${num((x - runStart) * s * K)} ${num(s * K)} re`);
        }
        run = v;
        runStart = x;
      }
    }
  }
  const fill: string[] = ['q'];
  for (const [ci, list] of rects) {
    const [r, g, b] = p.colors[ci].rgb;
    fill.push(`${num(r / 255, 4)} ${num(g / 255, 4)} ${num(b / 255, 4)} rg`, list.join('\n'), 'f');
  }
  fill.push('Q');
  rawWrite(doc, fill.join('\n'));

  // Символы: один текстовый блок на страницу; кегль и положение каждого символа — в матрице Tm
  const text: string[] = ['q', 'BT', `/${symbols.fontId} 1 Tf`];
  let curWhite = -1;
  for (let r = 0; r < c.rows; r++) {
    const rowBase = (c.y0 + r) * p.cols + c.x0;
    const cy = gy + (r + 0.5) * s;
    for (let x = 0; x < c.cols; x++) {
      const v = p.cells[rowBase + x];
      if (v < 0) continue;
      const g = symbols.glyphs[v];
      if (g.white !== curWhite) {
        text.push(g.white ? '1 g' : '0 g');
        curWhite = g.white;
      }
      text.push(`${g.em} 0 0 ${g.em} ${X(gx + (x + 0.5) * s - g.ox)} ${Y(cy + g.oy)} Tm <${g.hex}> Tj`);
    }
  }
  text.push('ET', 'Q');
  rawWrite(doc, text.join('\n'));

  // Сетка: тонкие линии, жирные каждые 10 клеток (по абсолютным номерам)
  doc.setDrawColor(40, 40, 40);
  for (let i = 0; i <= c.cols; i++) {
    const abs = c.x0 + i;
    if (abs % 10 === 0 || abs === p.cols) continue;
    doc.setLineWidth(THIN);
    doc.line(gx + i * s, gy, gx + i * s, gy + gh);
  }
  for (let j = 0; j <= c.rows; j++) {
    const abs = c.y0 + j;
    if (abs % 10 === 0 || abs === p.rows) continue;
    doc.setLineWidth(THIN);
    doc.line(gx, gy + j * s, gx + gw, gy + j * s);
  }
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(THICK);
  for (let i = 0; i <= c.cols; i++) {
    const abs = c.x0 + i;
    if (abs % 10 === 0 && abs !== 0 && abs !== p.cols) doc.line(gx + i * s, gy, gx + i * s, gy + gh);
  }
  for (let j = 0; j <= c.rows; j++) {
    const abs = c.y0 + j;
    if (abs % 10 === 0 && abs !== 0 && abs !== p.rows) doc.line(gx, gy + j * s, gx + gw, gy + j * s);
  }
  // Края куска: жирная рамка там, где кусок совпадает с краем всей работы
  const edge = (atBorder: boolean) => doc.setLineWidth(atBorder ? BORDER : THICK);
  edge(c.y0 === 0);
  doc.line(gx, gy, gx + gw, gy);
  edge(c.y0 + c.rows === p.rows);
  doc.line(gx, gy + gh, gx + gw, gy + gh);
  edge(c.x0 === 0);
  doc.line(gx, gy, gx, gy + gh);
  edge(c.x0 + c.cols === p.cols);
  doc.line(gx + gw, gy, gx + gw, gy + gh);

  // Нумерация столбцов и строк (абсолютная, каждые 10)
  doc.setFontSize(6.5);
  doc.setTextColor(0, 0, 0);
  for (let i = 0; i <= c.cols; i++) {
    const abs = c.x0 + i;
    if (abs % 10 !== 0 || abs === 0) continue;
    const x = gx + i * s;
    doc.text(String(abs), x, gy - 1.6, { align: 'center' });
    doc.text(String(abs), x, gy + gh + 3.8, { align: 'center' });
  }
  for (let j = 0; j <= c.rows; j++) {
    const abs = c.y0 + j;
    if (abs % 10 !== 0 || abs === 0) continue;
    const y = gy + j * s;
    doc.text(String(abs), gx - 1.2, y, { align: 'right', baseline: 'middle' });
    doc.text(String(abs), gx + gw + 1.2, y, { baseline: 'middle' });
  }

  // Центр схемы: стрелки по краям (снаружи от номеров)
  const centerX = p.cols / 2;
  const centerY = p.rows / 2;
  const a = 1.6; // полуширина стрелки
  const off = 4.6; // от сетки до острия стрелки сверху/снизу
  const offX = 5.8; // слева/справа (номера строк шире)
  doc.setFillColor(200, 30, 30);
  if (centerX >= c.x0 && centerX <= c.x0 + c.cols) {
    const x = gx + (centerX - c.x0) * s;
    doc.triangle(x - a, gy - off - 2.4, x + a, gy - off - 2.4, x, gy - off, 'F');
    doc.triangle(x - a, gy + gh + off + 2.4, x + a, gy + gh + off + 2.4, x, gy + gh + off, 'F');
  }
  if (centerY >= c.y0 && centerY <= c.y0 + c.rows) {
    const y = gy + (centerY - c.y0) * s;
    doc.triangle(gx - offX - 2.4, y - a, gx - offX - 2.4, y + a, gx - offX, y, 'F');
    doc.triangle(gx + gw + offX + 2.4, y - a, gx + gw + offX + 2.4, y + a, gx + gw + offX, y, 'F');
  }

  pageFooter(doc, c.page, totalPages, `${p.cols} × ${p.rows} крестиков · ${p.brand}`);
}
