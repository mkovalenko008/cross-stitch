/// <reference lib="webworker" />
// Вся тяжёлая работа — в отдельном потоке, чтобы интерфейс не зависал:
// хранит картинку, строит схему и собирает файлы для скачивания.
import { buildPattern, type Pattern } from '../core/pattern';
import type { RgbaImage } from '../core/resize';
import { buildOxs } from '../export/oxs';
import { PALETTES } from '../palettes';
import type { PdfFonts } from '../pdf/common';
import type { ExportKind, WorkerRequest, WorkerResponse } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let image: RgbaImage | null = null;
let pattern: Pattern | null = null;
let fonts: Promise<PdfFonts> | null = null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

async function fetchBytes(path: string): Promise<Uint8Array> {
  const res = await fetch(`${import.meta.env.BASE_URL}${path}`);
  if (!res.ok) throw new Error(`Не удалось загрузить шрифт (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

function loadFonts(): Promise<PdfFonts> {
  fonts ??= Promise.all([fetchBytes('fonts/DejaVuSans.ttf'), fetchBytes('fonts/DejaVuSans-Bold.ttf')]).then(
    ([regular, bold]) => ({ regular, bold }),
    (err) => {
      fonts = null; // дать повторить попытку
      throw err;
    },
  );
  return fonts;
}

const PDF = 'application/pdf';
const OXS = 'application/xml';

async function exportFiles(kind: ExportKind, title: string, id: number) {
  if (!pattern) throw new Error('Сначала сделайте схему');
  const p = pattern;
  const progress = (fraction: number, stage: string) => post({ id, type: 'progress', fraction, stage });
  const needPdf = kind !== 'oxs';
  // jsPDF и шрифты грузятся только когда нужен PDF
  const [f, { buildChartPdf }, { buildColorsPdf }] = needPdf
    ? await Promise.all([loadFonts(), import('../pdf/chart'), import('../pdf/colors')])
    : [null, { buildChartPdf: null }, { buildColorsPdf: null }];

  const chart = () => {
    progress(0, 'Рисую схему');
    return { name: `${title}_схема.pdf`, bytes: buildChartPdf!(p, title, f!, (x) => progress(x * 0.9, 'Рисую схему')), mime: PDF };
  };
  const colors = () => ({ name: `${title}_цвета.pdf`, bytes: buildColorsPdf!(p, title, f!), mime: PDF });
  const oxs = () => ({ name: `${title}.oxs`, bytes: new TextEncoder().encode(buildOxs(p, title)), mime: OXS });

  if (kind === 'chart') return [chart()];
  if (kind === 'colors') return [colors()];
  if (kind === 'oxs') return [oxs()];

  const files = [chart(), colors(), oxs()];
  progress(0.92, 'Упаковываю архив');
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const file of files) zip.file(file.name, file.bytes, { compression: file.mime === OXS ? 'DEFLATE' : 'STORE' });
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return [{ name: `${title}.zip`, bytes, mime: 'application/zip' }];
}

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'image') {
      image = msg.image;
      pattern = null;
      post({ id: msg.id, type: 'image-ready' });
    } else if (msg.type === 'build') {
      if (!image) throw new Error('Сначала загрузите картинку');
      let last = -1;
      pattern = buildPattern(image, msg.options, PALETTES[msg.palette], (fraction, stage) => {
        const pct = Math.floor(fraction * 100);
        if (pct !== last) {
          last = pct;
          post({ id: msg.id, type: 'progress', fraction, stage });
        }
      });
      post({ id: msg.id, type: 'built', pattern });
    } else if (msg.type === 'export') {
      const files = await exportFiles(msg.kind, msg.title, msg.id);
      post(
        { id: msg.id, type: 'exported', kind: msg.kind, files },
        files.map((f) => f.bytes.buffer),
      );
    }
  } catch (err) {
    post({ id: msg.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
