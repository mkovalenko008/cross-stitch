import type { Pattern, PatternOptions } from '../core/pattern';
import type { RgbaImage } from '../core/resize';
import type { PaletteId } from '../palettes';

export type ExportKind = 'chart' | 'colors' | 'oxs' | 'zip';

export type WorkerRequest =
  | { id: number; type: 'image'; image: RgbaImage }
  | { id: number; type: 'build'; options: PatternOptions; palette: PaletteId }
  | { id: number; type: 'export'; kind: ExportKind; title: string };

export type WorkerResponse =
  | { id: number; type: 'progress'; fraction: number; stage: string }
  | { id: number; type: 'image-ready' }
  | { id: number; type: 'built'; pattern: Pattern }
  | { id: number; type: 'exported'; kind: ExportKind; files: { name: string; bytes: Uint8Array; mime: string }[] }
  | { id: number; type: 'error'; message: string };
