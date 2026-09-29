/** Канва Aida 14: 14 крестиков на дюйм. */
export const AIDA_COUNT = 14;
/** Размер одного крестика на Aida 14, см. */
export const CM_PER_STITCH = 2.54 / AIDA_COUNT;

/**
 * Сколько полных крестиков выходит из одной пасмы мулине (8 м, 6 сложений)
 * на Aida 14 при вышивке в 2 сложения. Оценка с запасом; меняйте здесь.
 */
export const STITCHES_PER_SKEIN = 1800;

export function skeinsFor(stitches: number): number {
  return Math.max(1, Math.ceil(stitches / STITCHES_PER_SKEIN));
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
