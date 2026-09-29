import { skeinsFor } from './constants';
import type { Pattern, ThreadRef } from './pattern';

export interface ThreadUsage extends ThreadRef {
  /**
   * Расход в «полных крестиках»: крестик одной ниткой в 2 сложения — 1, крестик смеси
   * (по одной нитке двух цветов) — по ½ на каждую нитку.
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
    const share = c.count / c.parts.length;
    for (const part of c.parts) {
      let u = map.get(part.code);
      if (!u) {
        u = { ...part, stitches: 0, skeins: 0, usedIn: 0 };
        map.set(part.code, u);
      }
      u.stitches += share;
      u.usedIn++;
    }
  }
  const list = [...map.values()];
  for (const u of list) u.skeins = skeinsFor(Math.ceil(u.stitches));
  return list.sort((a, b) => b.stitches - a.stitches || a.code.localeCompare(b.code));
}
