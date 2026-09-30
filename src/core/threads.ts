import { skeinsFor } from './constants';
import type { Pattern, PatternColor, ThreadRef } from './pattern';

/** Где встречается нитка: цвет схемы и сколько нитей этой нитки в игле в этом цвете. */
export interface ThreadUse {
  color: PatternColor;
  strands: number;
}

export interface ThreadUsage extends ThreadRef {
  /**
   * Расход в полных крестиках: крестик обычной ниткой — 1, крестик смеси — доля по числу нитей
   * (1 + 1 — по ½, 2 + 1 — ⅔ и ⅓). По нему считаются пасмы.
   */
  stitches: number;
  /** Во скольких крестиках схемы есть эта нитка — обычных и в смесях. */
  inStitches: number;
  skeins: number;
  /** В скольких цветах схемы встречается нитка (одна или в смесях). */
  usedIn: number;
  /** Цвета схемы с этой ниткой — из них складывается расход. */
  uses: ThreadUse[];
}

/** Нитки к покупке: суммарный расход каждой нитки по всем цветам схемы, по убыванию. */
export function threadUsage(p: Pattern): ThreadUsage[] {
  const map = new Map<string, ThreadUsage>();
  for (const c of p.colors) {
    for (const part of c.parts) {
      let u = map.get(part.code);
      if (!u) {
        u = { code: part.code, name: part.name, rgb: part.rgb, stitches: 0, inStitches: 0, skeins: 0, usedIn: 0, uses: [] };
        map.set(part.code, u);
      }
      u.stitches += (c.count * part.strands) / p.strands;
      u.inStitches += c.count;
      u.usedIn++;
      u.uses.push({ color: c, strands: part.strands });
    }
  }
  const list = [...map.values()];
  for (const u of list) u.skeins = skeinsFor(u.stitches, p.strands);
  return list.sort((a, b) => b.stitches - a.stitches || a.code.localeCompare(b.code));
}
