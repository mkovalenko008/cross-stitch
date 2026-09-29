import dmcRaw from './dmc.json';
import gammaRaw from './gamma.json';

export interface Thread {
  code: string;
  name: string;
  rgb: [number, number, number];
  /** Только для Гаммы: откуда взят RGB. */
  rgbSource?: 'gamma-official' | 'dmc-equivalent';
  /** Только для Гаммы: аналоги DMC по официальной таблице («*» — наиболее похожий цвет). */
  dmc?: string[];
}

export type PaletteId = 'dmc' | 'gamma';

export interface Palette {
  id: PaletteId;
  /** Производитель, как пишется в OXS и PDF. */
  brand: 'DMC' | 'Gamma';
  /** Название для интерфейса. */
  title: string;
  threads: Thread[];
}

export const PALETTES: Record<PaletteId, Palette> = {
  dmc: { id: 'dmc', brand: 'DMC', title: 'DMC', threads: dmcRaw as Thread[] },
  gamma: { id: 'gamma', brand: 'Gamma', title: 'Гамма', threads: gammaRaw as Thread[] },
};
