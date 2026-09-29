import { skeinsFor } from './constants';
import type { Pattern, ThreadRef } from './pattern';

export interface ThreadUsage extends ThreadRef {
  /**
   * Расход в полных крестиках: крестик обычной ниткой — 1, крестик смеси — доля по числу нитей
   * (1 + 1 — по ½, 2 + 1 — ⅔ и ⅓).
   */
  stitches: number;
  skeins: number;
  /** В скольких вариантах схемы встречается нитка (одна или в смесях). */
  usedIn: number;
}

/** Нитки к покупке: суммарный расход каждой нитки по всем вариантам схемы, по убыванию. */
export function threadUsage(p: Pattern): ThreadUsage[] {
  const map = new Map<string, ThreadUsage>();
  for (const c of p.colors) {
    for (const part of c.parts) {
      let u = map.get(part.code);
      if (!u) {
        u = { code: part.code, name: part.name, rgb: part.rgb, stitches: 0, skeins: 0, usedIn: 0 };
        map.set(part.code, u);
      }
      u.stitches += (c.count * part.strands) / p.strands;
      u.usedIn++;
    }
  }
  const list = [...map.values()];
  for (const u of list) u.skeins = skeinsFor(u.stitches, p.strands);
  return list.sort((a, b) => b.stitches - a.stitches || a.code.localeCompare(b.code));
}
