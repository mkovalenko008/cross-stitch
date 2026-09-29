/** Не больше столько клеток на странице схемы. */
export const MAX_COLS_PER_PAGE = 60;
export const MAX_ROWS_PER_PAGE = 80;

export interface Chunk {
  /** Номер страницы в PDF (обложка — страница 1). */
  page: number;
  px: number;
  py: number;
  /** Первая клетка куска (0-based) и размер. */
  x0: number;
  y0: number;
  cols: number;
  rows: number;
}

export interface ChartLayout {
  pagesX: number;
  pagesY: number;
  chunkCols: number;
  chunkRows: number;
  chunks: Chunk[];
}

/** Размер куска по одной оси: поровну между страницами, кратно 10 (жирные линии совпадают с краями). */
function split(total: number, max: number): { pages: number; size: number } {
  let pages = Math.ceil(total / max);
  const size = Math.min(max, Math.ceil(total / pages / 10) * 10);
  pages = Math.ceil(total / size);
  return { pages, size };
}

export function chartLayout(cols: number, rows: number): ChartLayout {
  const sx = split(cols, MAX_COLS_PER_PAGE);
  const sy = split(rows, MAX_ROWS_PER_PAGE);
  const chunks: Chunk[] = [];
  for (let py = 0; py < sy.pages; py++) {
    for (let px = 0; px < sx.pages; px++) {
      const x0 = px * sx.size;
      const y0 = py * sy.size;
      chunks.push({
        page: 2 + py * sx.pages + px,
        px,
        py,
        x0,
        y0,
        cols: Math.min(sx.size, cols - x0),
        rows: Math.min(sy.size, rows - y0),
      });
    }
  }
  return { pagesX: sx.pages, pagesY: sy.pages, chunkCols: sx.size, chunkRows: sy.size, chunks };
}
