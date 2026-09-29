import { ciede2000 } from './color';
import type { PaletteMatcher } from './match';

/**
 * Чистка редких цветов. Пока в схеме есть цвет, у которого меньше minCount крестиков
 * (или цветов больше maxColors), берём самый редкий и каждую его клетку переназначаем
 * на ближайший по CIEDE2000 цвет из оставшихся в схеме. Расстояние считается от
 * собственного цвета клетки (её усреднённого Lab), а не от удаляемой нитки: так клетка
 * получает нитку, которая лучше всего передаёт именно её цвет.
 *
 * assignment — индексы палитры по клеткам (-1 = пустая клетка). Возвращает новый массив.
 */
export function cleanupRareColors(
  assignment: Int16Array,
  cellLab: Float32Array | Float64Array,
  matcher: PaletteMatcher,
  minCount: number,
  maxColors = Infinity,
): Int16Array {
  const out = assignment.slice();
  const pal = matcher.lab;
  const cellsOf: number[][] = Array.from({ length: matcher.size }, () => []);
  for (let i = 0; i < out.length; i++) if (out[i] >= 0) cellsOf[out[i]].push(i);
  const active = new Set<number>();
  cellsOf.forEach((cells, c) => cells.length && active.add(c));

  while (active.size > 1) {
    let rare = -1;
    let rareCount = Infinity;
    for (const c of active) {
      const n = cellsOf[c].length;
      if (n < rareCount || (n === rareCount && c < rare)) {
        rare = c;
        rareCount = n;
      }
    }
    if (rareCount >= minCount && active.size <= maxColors) break;

    active.delete(rare);
    const remaining = [...active];
    for (const cell of cellsOf[rare]) {
      const L = cellLab[cell * 3];
      const a = cellLab[cell * 3 + 1];
      const b = cellLab[cell * 3 + 2];
      let best = -1;
      let bestD = Infinity;
      for (const c of remaining) {
        const d = ciede2000(L, a, b, pal[c * 3], pal[c * 3 + 1], pal[c * 3 + 2]);
        if (d < bestD || (d === bestD && c < best)) {
          bestD = d;
          best = c;
        }
      }
      out[cell] = best;
      cellsOf[best].push(cell);
    }
    cellsOf[rare] = [];
  }
  return out;
}

/** Порог ΔE2000, ниже которого замена нитки считается незаметной. */
export const ACCURACY_DELTA_E = 2;

/**
 * Точность передачи цвета: доля непустых клеток, у которых итоговая нитка совпадает
 * с эталонной или отличается от неё не больше чем на ΔE2000 = 2.
 */
export function colorAccuracy(final: Int16Array, reference: Int16Array, matcher: PaletteMatcher): number {
  const cache = new Map<number, boolean>();
  let total = 0;
  let ok = 0;
  for (let i = 0; i < reference.length; i++) {
    const r = reference[i];
    if (r < 0) continue;
    total++;
    const f = final[i];
    if (f === r) {
      ok++;
      continue;
    }
    const key = f * 65536 + r;
    let close = cache.get(key);
    if (close === undefined) {
      close = matcher.distance(f, r) <= ACCURACY_DELTA_E;
      cache.set(key, close);
    }
    if (close) ok++;
  }
  return total === 0 ? 1 : ok / total;
}

/** Целевая точность: не меньше 99,9% клеток сохраняют свою нитку (или почти такую же). */
export const TARGET_ACCURACY = 0.999;

/** Минимум крестиков на цвет никогда не опускается ниже 2: одиночных крестиков в схеме нет. */
export const MIN_STITCHES_FLOOR = 2;

/**
 * Лесенка значений минимума: заданное пользователем, затем 10 → 7 → 5 → 3 → 2
 * (только те, что меньше заданного).
 */
export function minLadder(requested: number): number[] {
  const start = Math.max(MIN_STITCHES_FLOOR, Math.round(requested));
  return [start, ...[10, 7, 5, 3, 2].filter((m) => m < start)];
}
