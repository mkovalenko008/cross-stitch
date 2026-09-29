/** Канва Aida 14: 14 крестиков на дюйм. */
export const AIDA_COUNT = 14;
/** Размер одного крестика на Aida 14, см. */
export const CM_PER_STITCH = 2.54 / AIDA_COUNT;

/**
 * Сколько полных крестиков выходит из одной пасмы мулине (8 м, 6 сложений)
 * на Aida 14 при вышивке в 2 нити. Оценка с запасом; меняйте здесь.
 * При 3 нитях в игле из пасмы выходит в полтора раза меньше: 1800 × 2 / 3 = 1200.
 */
export const STITCHES_PER_SKEIN = 1800;

/** Крестиков из одной пасмы при заданном числе нитей в игле. */
export function stitchesPerSkein(strands: number): number {
  return Math.round((STITCHES_PER_SKEIN * 2) / strands);
}

/** Запас ниток на обрезки, закрепки и ошибки: 5% сверх расчётного расхода. */
export const THREAD_RESERVE = 0.05;

/**
 * Пасм на столько крестиков при заданном числе нитей в игле — с запасом THREAD_RESERVE,
 * округление вверх, минимум 1.
 */
export function skeinsFor(stitches: number, strands = 2): number {
  // 1e-9 — чтобы погрешность дробей (крестик смеси 2 + 1 — это ⅔ и ⅓) не добавила лишнюю пасму
  return Math.max(1, Math.ceil((stitches * (1 + THREAD_RESERVE)) / stitchesPerSkein(strands) - 1e-9));
}

/** Размер работы в см на Aida 14, с одним знаком после запятой. */
export function sizeCm(stitches: number): string {
  return (stitches * CM_PER_STITCH).toFixed(1).replace('.', ',');
}

export function formatInt(n: number): string {
  return n.toLocaleString('ru-RU');
}

export function formatPercent(fraction: number): string {
  // округляем вниз, чтобы 98.96% не превратилось в «99.0%»
  return (Math.floor(fraction * 1000) / 10).toFixed(1).replace('.', ',') + '%';
}
