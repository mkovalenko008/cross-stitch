import { SRGB_TO_LINEAR, linearRgbToLab } from './color';

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 8 бит на канал, sRGB. */
  data: Uint8ClampedArray | Uint8Array;
}

export interface GridColors {
  cols: number;
  rows: number;
  /** Lab каждой клетки: [L, a, b] × (cols·rows). Для пустых клеток — нули. */
  lab: Float32Array;
  /** Линейный RGB (0..1) каждой клетки — для дизеринга и оценки сходства. */
  lin: Float32Array;
  /** 1 — клетка пустая (прозрачная). */
  empty: Uint8Array;
}

/** Высота сетки по ширине и пропорциям исходника. */
export function gridHeight(cols: number, srcWidth: number, srcHeight: number): number {
  return Math.max(1, Math.round((cols * srcHeight) / srcWidth));
}

interface Span {
  first: number; // первый индекс выходной клетки
  weights: number[]; // доли пикселя, попадающие в клетки first, first+1, …
}

/** Для каждого пикселя исходника — в какие клетки и с каким весом он попадает (по одной оси). */
function spans(src: number, dst: number): Span[] {
  const scale = dst / src; // ширина пикселя в единицах клеток
  const out: Span[] = [];
  for (let i = 0; i < src; i++) {
    const start = i * scale;
    const end = (i + 1) * scale;
    const first = Math.min(dst - 1, Math.floor(start));
    const weights: number[] = [];
    for (let j = first; j < dst && j < end; j++) {
      // вес может выйти ≤ 0 только из-за погрешности округления — индексы при этом не сдвигаем
      weights.push(Math.max(0, Math.min(end, j + 1) - Math.max(start, j)));
    }
    out.push({ first, weights });
  }
  return out;
}

/**
 * Ресайз усреднением по площади: каждая клетка — среднее всех пикселей исходника,
 * попадающих в неё (с долями для пикселей на границе). Усреднение в линейном RGB,
 * с учётом прозрачности (премультипликация альфой).
 *
 * transparentEmpty = true: клетка пустая, если непрозрачная часть покрывает < 50% площади;
 * иначе её цвет — среднее непрозрачной части.
 * transparentEmpty = false: прозрачность смешивается с белым фоном.
 */
export function resizeToGrid(
  img: RgbaImage,
  cols: number,
  rows: number,
  transparentEmpty: boolean,
  onProgress?: (fraction: number) => void,
): GridColors {
  const { width, height, data } = img;
  const xs = spans(width, cols);
  const ys = spans(height, rows);
  const n = cols * rows;
  const acc = new Float64Array(n * 4); // r·a, g·a, b·a, a — суммы с весами площади
  const rowAcc = new Float64Array(cols * 4);

  for (let y = 0; y < height; y++) {
    rowAcc.fill(0);
    let p = y * width * 4;
    for (let x = 0; x < width; x++, p += 4) {
      const a = data[p + 3] / 255;
      if (a === 0) continue;
      const r = SRGB_TO_LINEAR[data[p]] * a;
      const g = SRGB_TO_LINEAR[data[p + 1]] * a;
      const b = SRGB_TO_LINEAR[data[p + 2]] * a;
      const s = xs[x];
      for (let k = 0; k < s.weights.length; k++) {
        const w = s.weights[k];
        const o = (s.first + k) * 4;
        rowAcc[o] += r * w;
        rowAcc[o + 1] += g * w;
        rowAcc[o + 2] += b * w;
        rowAcc[o + 3] += a * w;
      }
    }
    const sy = ys[y];
    for (let k = 0; k < sy.weights.length; k++) {
      const w = sy.weights[k];
      const base = (sy.first + k) * cols * 4;
      for (let i = 0; i < cols * 4; i++) acc[base + i] += rowAcc[i] * w;
    }
    if (onProgress && (y & 63) === 0) onProgress(y / height);
  }

  // площадь клетки в единицах «пиксель исходника → клетка»: (cols/width)·(rows/height) на пиксель,
  // а полная клетка = 1·1. Поэтому покрытие клетки = сумма альфы с весами.
  const lab = new Float32Array(n * 3);
  const lin = new Float32Array(n * 3);
  const empty = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const coverage = acc[o + 3];
    let r: number;
    let g: number;
    let b: number;
    if (transparentEmpty) {
      if (coverage < 0.5) {
        empty[i] = 1;
        continue;
      }
      r = acc[o] / coverage;
      g = acc[o + 1] / coverage;
      b = acc[o + 2] / coverage;
    } else {
      const bg = Math.max(0, 1 - coverage); // белый фон под прозрачной частью
      r = acc[o] + bg;
      g = acc[o + 1] + bg;
      b = acc[o + 2] + bg;
    }
    r = Math.min(1, r);
    g = Math.min(1, g);
    b = Math.min(1, b);
    lin[i * 3] = r;
    lin[i * 3 + 1] = g;
    lin[i * 3 + 2] = b;
    linearRgbToLab(r, g, b, lab, i * 3);
  }
  onProgress?.(1);
  return { cols, rows, lab, lin, empty };
}
