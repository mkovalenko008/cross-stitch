import { jsPDF } from 'jspdf';
import { contrastTextIsBlack } from '../core/color';
import metrics from '../core/symbol-metrics.json';
import { encodePngRgb } from './png';

export interface PdfFonts {
  regular: Uint8Array;
  bold: Uint8Array;
}

export const FONT = 'DejaVuSans';

export const PAGE_W = 210;
export const PAGE_H = 297;

function toBinaryString(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return s;
}

export function createDoc(fonts: PdfFonts, title: string): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  doc.addFileToVFS('DejaVuSans.ttf', toBinaryString(fonts.regular));
  doc.addFont('DejaVuSans.ttf', FONT, 'normal', 'Identity-H');
  doc.addFileToVFS('DejaVuSans-Bold.ttf', toBinaryString(fonts.bold));
  doc.addFont('DejaVuSans-Bold.ttf', FONT, 'bold', 'Identity-H');
  doc.setFont(FONT, 'normal');
  doc.setProperties({ title, creator: 'Генератор схем для вышивки крестом' });
  return doc;
}

export const PT_PER_MM = 72 / 25.4;
const glyphs = (metrics as { unitsPerEm: number; glyphs: Record<string, number[]> }).glyphs;
const UPM = (metrics as { unitsPerEm: number }).unitsPerEm;

/**
 * Размер и смещение символа: центр реальных габаритов глифа должен совпасть с центром клетки.
 * size — желаемый кегль в мм (высота em); крупные глифы уменьшаются, чтобы уместиться в maxBox мм.
 * Возвращает кегль em (мм) и смещение начала глифа относительно центра (ox, oy, мм).
 */
export function glyphPlacement(symbol: string, size: number, maxBox: number): { em: number; ox: number; oy: number } {
  const bb = glyphs[symbol];
  if (!bb) return { em: size, ox: 0, oy: size * 0.35 };
  const w = ((bb[2] - bb[0]) / UPM) * size;
  const h = ((bb[3] - bb[1]) / UPM) * size;
  const em = size * Math.min(1, maxBox / Math.max(w, h));
  return { em, ox: ((bb[0] + bb[2]) / 2 / UPM) * em, oy: ((bb[1] + bb[3]) / 2 / UPM) * em };
}

/** Рисует символ так, чтобы центр его реальных габаритов совпал с (cx, cy). */
export function drawSymbol(doc: jsPDF, symbol: string, cx: number, cy: number, size: number, maxBox: number): void {
  const { em, ox, oy } = glyphPlacement(symbol, size, maxBox);
  doc.setFontSize(em * PT_PER_MM);
  doc.text(symbol, cx - ox, cy + oy, { baseline: 'alphabetic' });
}

export function setFill(doc: jsPDF, rgb: readonly number[]): void {
  doc.setFillColor(rgb[0], rgb[1], rgb[2]);
}

export function symbolTextRgb(rgb: readonly number[]): [number, number, number] {
  return contrastTextIsBlack(rgb) ? [0, 0, 0] : [255, 255, 255];
}

/** Нижний колонтитул «Стр. N из M». */
export function pageFooter(doc: jsPDF, n: number, total: number, left?: string): void {
  doc.setFont(FONT, 'normal');
  doc.setFontSize(8);
  doc.setTextColor(90, 90, 90);
  doc.text(`Стр. ${n} из ${total}`, PAGE_W - 10, PAGE_H - 7, { align: 'right' });
  if (left) doc.text(left, 10, PAGE_H - 7);
  doc.setTextColor(0, 0, 0);
}

/** PNG-превью: по k×k пикселей на клетку, пустые клетки белые. */
export function previewPng(
  cols: number,
  rows: number,
  cells: Int16Array,
  colors: { rgb: readonly number[] }[],
  k: number,
): Uint8Array {
  const w = cols * k;
  const h = rows * k;
  const rgb = new Uint8Array(w * h * 3).fill(255);
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / k) * cols;
    for (let x = 0; x < w; x++) {
      const c = cells[row + Math.floor(x / k)];
      if (c < 0) continue;
      const o = (y * w + x) * 3;
      const col = colors[c].rgb;
      rgb[o] = col[0];
      rgb[o + 1] = col[1];
      rgb[o + 2] = col[2];
    }
  }
  return encodePngRgb(rgb, w, h);
}

export function docToBytes(doc: jsPDF): Uint8Array {
  return new Uint8Array(doc.output('arraybuffer'));
}
