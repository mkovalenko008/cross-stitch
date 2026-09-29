// Цветовые преобразования: sRGB ↔ линейный RGB, линейный RGB → CIE XYZ → CIELAB (D65),
// и цветовое отличие CIEDE2000 (Sharma, Wu, Dalal, 2005).

/** sRGB 0..255 → линейная яркость канала 0..1 (таблица на 256 значений). */
export const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb8(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

// Матрица sRGB (IEC 61966-2-1) → XYZ, белая точка D65 = суммы строк матрицы.
const M = [
  0.4124564, 0.3575761, 0.1804375,
  0.2126729, 0.7151522, 0.072175,
  0.0193339, 0.119192, 0.9503041,
];
const XN = M[0] + M[1] + M[2];
const YN = M[3] + M[4] + M[5];
const ZN = M[6] + M[7] + M[8];

const EPS = 216 / 24389; // (6/29)^3
const KAPPA = 24389 / 27;
const f = (t: number) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);

/** Линейный RGB (0..1) → Lab. Результат пишется в out[offset..offset+2]. */
export function linearRgbToLab(
  r: number,
  g: number,
  b: number,
  out: Float32Array | Float64Array | number[],
  offset = 0,
): void {
  const x = (M[0] * r + M[1] * g + M[2] * b) / XN;
  const y = (M[3] * r + M[4] * g + M[5] * b) / YN;
  const z = (M[6] * r + M[7] * g + M[8] * b) / ZN;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  out[offset] = 116 * fy - 16;
  out[offset + 1] = 500 * (fx - fy);
  out[offset + 2] = 200 * (fy - fz);
}

export type Lab = [number, number, number];

export function rgb8ToLab(rgb: readonly [number, number, number] | readonly number[]): Lab {
  const out: Lab = [0, 0, 0];
  linearRgbToLab(SRGB_TO_LINEAR[rgb[0]], SRGB_TO_LINEAR[rgb[1]], SRGB_TO_LINEAR[rgb[2]], out);
  return out;
}

/** Относительная яркость (WCAG) цвета sRGB 0..255. */
export function relativeLuminance(rgb: readonly number[]): number {
  return 0.2126 * SRGB_TO_LINEAR[rgb[0]] + 0.7152 * SRGB_TO_LINEAR[rgb[1]] + 0.0722 * SRGB_TO_LINEAR[rgb[2]];
}

/** Чёрный или белый текст на фоне цвета rgb — что контрастнее. */
export function contrastTextIsBlack(rgb: readonly number[]): boolean {
  const y = relativeLuminance(rgb);
  return (y + 0.05) / 0.05 >= 1.05 / (y + 0.05);
}

const DEG = Math.PI / 180;
const POW25_7 = Math.pow(25, 7);

/** CIEDE2000 (kL = kC = kH = 1). */
export function ciede2000(L1: number, a1: number, b1: number, L2: number, a2: number, b2: number): number {
  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar2 = Cbar * Cbar;
  const Cbar7 = Cbar2 * Cbar2 * Cbar2 * Cbar;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);

  let h1p = a1p === 0 && b1 === 0 ? 0 : Math.atan2(b1, a1p) / DEG;
  if (h1p < 0) h1p += 360;
  let h2p = a2p === 0 && b2 === 0 ? 0 : Math.atan2(b2, a2p) / DEG;
  if (h2p < 0) h2p += 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const CpProd = C1p * C2p;

  let dhp = 0;
  if (CpProd !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(CpProd) * Math.sin((dhp / 2) * DEG);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp: number;
  if (CpProd === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
  else hbarp = (h1p + h2p - 360) / 2;

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * DEG) +
    0.24 * Math.cos(2 * hbarp * DEG) +
    0.32 * Math.cos((3 * hbarp + 6) * DEG) -
    0.2 * Math.cos((4 * hbarp - 63) * DEG);
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp2 = Cbarp * Cbarp;
  const Cbarp7 = Cbarp2 * Cbarp2 * Cbarp2 * Cbarp;
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW25_7));
  const Lm = (Lbarp - 50) * (Lbarp - 50);
  const SL = 1 + (0.015 * Lm) / Math.sqrt(20 + Lm);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * DEG) * RC;

  const l = dLp / SL;
  const c = dCp / SC;
  const h = dHp / SH;
  return Math.sqrt(l * l + c * c + h * h + RT * c * h);
}

/**
 * Нижняя граница CIEDE2000 только по светлоте: ΔE00 ≥ |ΔL| / SL.
 * Верна, потому что остаток формулы c² + h² + RT·c·h ≥ 0 при |RT| < 2.
 * Растёт монотонно с |L2 − L1|, поэтому годится для отсечения при поиске по палитре,
 * отсортированной по L.
 */
export function lightnessLowerBound(L1: number, L2: number): number {
  const Lbar = (L1 + L2) / 2;
  const Lm = (Lbar - 50) * (Lbar - 50);
  const SL = 1 + (0.015 * Lm) / Math.sqrt(20 + Lm);
  return Math.abs(L2 - L1) / SL;
}

const C26 = Math.cos((26 * Math.PI) / 180);
const S26 = Math.sin((26 * Math.PI) / 180);
const H26 = (26 * Math.PI) / 180;

/**
 * Lab → DIN99o (DIN 6176). В этом пространстве обычное евклидово расстояние близко
 * к воспринимаемой разнице цветов (и к CIEDE2000), поэтому оно годится для быстрого
 * отбора кандидатов в k-d дереве.
 */
export function labToDin99o(L: number, a: number, b: number, out: Float64Array | number[], offset = 0): void {
  const e = a * C26 + b * S26;
  const f = 0.83 * (-a * S26 + b * C26);
  const g = Math.sqrt(e * e + f * f);
  const c = Math.log(1 + 0.075 * g) / 0.0435;
  const h = Math.atan2(f, e) + H26;
  out[offset] = 303.67 * Math.log(1 + 0.0039 * L);
  out[offset + 1] = c * Math.cos(h);
  out[offset + 2] = c * Math.sin(h);
}
