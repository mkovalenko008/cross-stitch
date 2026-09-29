import './style.css';
import { contrastTextIsBlack } from './core/color';
import { formatInt, formatPercent, sizeCm, skeinsFor } from './core/constants';
import { TARGET_ACCURACY } from './core/cleanup';
import type { Pattern } from './core/pattern';
import { gridHeight, type RgbaImage } from './core/resize';
import { PALETTES, type PaletteId } from './palettes';
import type { ExportKind, WorkerRequest, WorkerResponse } from './workers/protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const MIN_WIDTH = 20;
const MAX_WIDTH = 1000;
/** Больше этого браузеры (особенно Safari на iPhone) не дают прочитать с canvas. */
const MAX_PIXELS = 16_000_000;

const els = {
  file: $<HTMLInputElement>('file'),
  dropzone: $<HTMLDivElement>('dropzone'),
  dropEmpty: $<HTMLDivElement>('dropEmpty'),
  dropLoaded: $<HTMLDivElement>('dropLoaded'),
  pick: $<HTMLButtonElement>('pick'),
  replace: $<HTMLButtonElement>('replace'),
  sourcePreview: $<HTMLImageElement>('sourcePreview'),
  fileName: $<HTMLParagraphElement>('fileName'),
  fileDims: $<HTMLParagraphElement>('fileDims'),
  uploadError: $<HTMLParagraphElement>('uploadError'),
  form: $<HTMLFormElement>('settings'),
  width: $<HTMLInputElement>('width'),
  heightOut: $<HTMLOutputElement>('heightOut'),
  sizeHint: $<HTMLParagraphElement>('sizeHint'),
  minStitches: $<HTMLInputElement>('minStitches'),
  minSimilarity: $<HTMLInputElement>('minSimilarity'),
  transparentEmpty: $<HTMLInputElement>('transparentEmpty'),
  go: $<HTMLButtonElement>('go'),
  progress: $<HTMLDivElement>('progress'),
  progressBar: $<HTMLDivElement>('progressBar'),
  progressStage: $<HTMLParagraphElement>('progressStage'),
  buildError: $<HTMLParagraphElement>('buildError'),
  result: $<HTMLElement>('result'),
  resultTitle: $<HTMLHeadingElement>('resultTitle'),
  resultSub: $<HTMLParagraphElement>('resultSub'),
  canvas: $<HTMLCanvasElement>('resultCanvas'),
  statAccuracy: $<HTMLElement>('statAccuracy'),
  statSimilarity: $<HTMLElement>('statSimilarity'),
  statIsolated: $<HTMLElement>('statIsolated'),
  statColors: $<HTMLElement>('statColors'),
  statStitches: $<HTMLElement>('statStitches'),
  statMin: $<HTMLElement>('statMin'),
  resultNote: $<HTMLParagraphElement>('resultNote'),
  exportProgress: $<HTMLDivElement>('exportProgress'),
  exportBar: $<HTMLDivElement>('exportBar'),
  exportStage: $<HTMLParagraphElement>('exportStage'),
  exportError: $<HTMLParagraphElement>('exportError'),
  legendSummary: $<HTMLElement>('legendSummary'),
  legendBody: $<HTMLTableSectionElement>('legendBody'),
};

$('dmcCount').textContent = `${PALETTES.dmc.threads.length} цветов`;
$('gammaCount').textContent = `${PALETTES.gamma.threads.length} цветов`;

// ——— Связь с воркером ———
const worker = new Worker(new URL('./workers/pattern.worker.ts', import.meta.url), { type: 'module' });
let nextId = 1;
const pending = new Map<number, { resolve: (m: WorkerResponse) => void; reject: (e: Error) => void; onProgress?: (f: number, s: string) => void }>();

worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data;
  const p = pending.get(msg.id);
  if (!p) return;
  if (msg.type === 'progress') {
    p.onProgress?.(msg.fraction, msg.stage);
    return;
  }
  pending.delete(msg.id);
  if (msg.type === 'error') p.reject(new Error(msg.message));
  else p.resolve(msg);
};
worker.onerror = (e) => {
  for (const p of pending.values()) p.reject(new Error(e.message || 'Ошибка в фоновом потоке'));
  pending.clear();
};

type Req = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

function call(req: Req, onProgress?: (f: number, s: string) => void, transfer: Transferable[] = []): Promise<WorkerResponse> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ ...req, id }, transfer);
  });
}

// ——— Состояние ———
let source: { name: string; width: number; height: number } | null = null;
let pattern: Pattern | null = null;
let patternTitle = '';
let busy = false;

// ——— Загрузка картинки ———
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

function baseName(fileName: string): string {
  const name = fileName.replace(/\.[^.]+$/, '').trim() || 'схема';
  return name.replace(/[\\/:*?"<>|]+/g, '_');
}

async function decode(file: File): Promise<RgbaImage> {
  let bitmap: ImageBitmap | HTMLImageElement;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // запасной путь для старых браузеров
    bitmap = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Не получилось открыть картинку'));
      img.src = URL.createObjectURL(file);
    });
  }
  let w = 'naturalWidth' in bitmap ? bitmap.naturalWidth : bitmap.width;
  let h = 'naturalHeight' in bitmap ? bitmap.naturalHeight : bitmap.height;
  if (!w || !h) throw new Error('Не получилось прочитать размер картинки');
  if (w * h > MAX_PIXELS) {
    // очень большие фото уменьшаем до ~16 Мп: для схемы до 500 крестиков этого с запасом хватает
    const k = Math.sqrt(MAX_PIXELS / (w * h));
    w = Math.max(1, Math.floor(w * k));
    h = Math.max(1, Math.floor(h * k));
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Браузер не дал нарисовать картинку');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  if ('close' in bitmap) bitmap.close();
  const data = ctx.getImageData(0, 0, w, h);
  canvas.width = canvas.height = 0;
  return { width: w, height: h, data: data.data };
}

function showError(el: HTMLElement, text: string | null) {
  el.textContent = text ?? '';
  el.hidden = !text;
}

async function loadFile(file: File | undefined) {
  if (!file || busy) return;
  showError(els.uploadError, null);
  if (!ACCEPTED.includes(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) {
    showError(els.uploadError, 'Подойдут картинки JPG, PNG или WebP.');
    return;
  }
  busy = true;
  els.go.disabled = true;
  try {
    const url = URL.createObjectURL(file);
    els.sourcePreview.src = url;
    els.sourcePreview.onload = () => URL.revokeObjectURL(url);
    const img = await decode(file);
    await call({ type: 'image', image: img }, undefined, [img.data.buffer]);
    // старая схема относится к прежней картинке — прячем её
    pattern = null;
    els.result.hidden = true;
    source = { name: baseName(file.name), width: img.width, height: img.height };
    els.fileName.textContent = file.name;
    els.fileDims.textContent = `${img.width} × ${img.height} пикселей`;
    els.dropEmpty.hidden = true;
    els.dropLoaded.hidden = false;
    updateSize();
  } catch (err) {
    source = null;
    els.dropEmpty.hidden = false;
    els.dropLoaded.hidden = true;
    showError(els.uploadError, err instanceof Error ? err.message : 'Не получилось открыть картинку');
  } finally {
    busy = false;
    els.go.disabled = !source;
  }
}

els.pick.addEventListener('click', (e) => {
  e.stopPropagation();
  els.file.click();
});
els.replace.addEventListener('click', () => els.file.click());
els.dropzone.addEventListener('click', () => {
  if (!source) els.file.click();
});
els.file.addEventListener('change', () => {
  void loadFile(els.file.files?.[0]);
  els.file.value = '';
});

let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  els.dropzone.classList.add('is-over');
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropzone.classList.remove('is-over');
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.dropzone.classList.remove('is-over');
  void loadFile(e.dataTransfer?.files[0]);
});

// ——— Размер ———
function readWidth(): number | null {
  const v = Number(els.width.value);
  if (!Number.isFinite(v) || v < MIN_WIDTH || v > MAX_WIDTH || !Number.isInteger(v)) return null;
  return v;
}

function updateSize() {
  const w = readWidth();
  els.width.classList.toggle('is-invalid', w === null && els.width.value !== '');
  if (w === null) {
    els.heightOut.textContent = '—';
    els.sizeHint.textContent = `Целое число от ${MIN_WIDTH} до ${MAX_WIDTH}.`;
    return;
  }
  if (!source) {
    els.heightOut.textContent = '—';
    els.sizeHint.textContent = `${sizeCm(w)} см по ширине на Aida 14.`;
    return;
  }
  const h = gridHeight(w, source.width, source.height);
  els.heightOut.textContent = String(h);
  els.sizeHint.textContent =
    `На канве Aida 14: ${sizeCm(w)} × ${sizeCm(h)} см.` +
    (w > source.width
      ? ` Картинка шириной ${source.width} пикселей — крестиков больше, чем пикселей, новых деталей не появится.`
      : '');
}

els.width.addEventListener('input', updateSize);
els.width.addEventListener('blur', () => {
  const v = Math.round(Number(els.width.value));
  if (Number.isFinite(v) && els.width.value !== '') els.width.value = String(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v)));
  updateSize();
});
els.minSimilarity.addEventListener('blur', () => {
  const v = Math.round(Number(els.minSimilarity.value));
  els.minSimilarity.value = String(Number.isFinite(v) && els.minSimilarity.value !== '' ? Math.min(99, Math.max(0, v)) : 85);
});
els.minStitches.addEventListener('blur', () => {
  const v = Math.round(Number(els.minStitches.value));
  els.minStitches.value = String(Number.isFinite(v) ? Math.min(100, Math.max(2, v)) : 10);
});
updateSize();

// ——— Построение схемы ———
function setProgress(bar: HTMLElement, stageEl: HTMLElement, fraction: number, stage: string) {
  bar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  stageEl.textContent = stage;
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!source || busy) return;
  const cols = readWidth();
  if (cols === null) {
    els.width.focus();
    updateSize();
    return;
  }
  const rows = gridHeight(cols, source.width, source.height);
  const palette = (new FormData(els.form).get('palette') as PaletteId) ?? 'dmc';
  const minStitches = Math.max(2, Math.round(Number(els.minStitches.value)) || 10);
  const simValue = Math.round(Number(els.minSimilarity.value));
  const minSimilarity = (els.minSimilarity.value === '' || !Number.isFinite(simValue) ? 85 : Math.min(99, Math.max(0, simValue))) / 100;

  busy = true;
  els.go.disabled = true;
  showError(els.buildError, null);
  els.progress.hidden = false;
  setProgress(els.progressBar, els.progressStage, 0, 'Начинаю');
  try {
    const res = await call(
      { type: 'build', options: { cols, rows, minStitches, transparentEmpty: els.transparentEmpty.checked, minSimilarity }, palette },
      (f, s) => setProgress(els.progressBar, els.progressStage, f, s),
    );
    if (res.type !== 'built') throw new Error('Неожиданный ответ');
    pattern = res.pattern;
    patternTitle = source.name;
    renderResult(pattern, minStitches);
    els.result.hidden = false;
    els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError(els.buildError, err instanceof Error ? err.message : String(err));
  } finally {
    busy = false;
    els.go.disabled = !source;
    els.progress.hidden = true;
  }
});

function renderResult(p: Pattern, requestedMin: number) {
  els.resultTitle.textContent = patternTitle;
  els.resultSub.textContent =
    `${p.cols} × ${p.rows} крестиков · ${sizeCm(p.cols)} × ${sizeCm(p.rows)} см на Aida 14 · нитки ${p.paletteTitle} · ` +
    (p.style === 'smooth' ? 'плавные переходы' : 'ровные пятна');
  els.statAccuracy.textContent = formatPercent(p.accuracy);
  els.statSimilarity.textContent = formatPercent(p.similarity);
  els.statIsolated.textContent = formatPercent(p.isolated);
  els.statColors.textContent = String(p.colors.length);
  els.statStitches.textContent = formatInt(p.stitches);
  els.statMin.textContent = String(p.minStitches);

  const notes: string[] = [];
  if (p.minStitches < requestedMin) {
    notes.push(`Минимум снижен с ${requestedMin} до ${p.minStitches}, чтобы точность цвета была не ниже 99,9%.`);
  }
  if (p.accuracy < TARGET_ACCURACY) {
    notes.push(
      `Точность ниже 99,9% даже при минимуме ${p.minStitches} крестика на цвет: в картинке много мелких редких цветов. ` +
        `Помогут бо́льшая ширина или картинка с более крупными деталями.`,
    );
  }
  if (p.similarity < p.minSimilarity) {
    notes.push(
      `Сходство ${formatPercent(p.similarity)} — меньше заданных ${Math.round(p.minSimilarity * 100)}%: ` +
        `в палитре ${p.paletteTitle} нет нужных оттенков, это самый точный вариант. ` +
        (p.brand === 'DMC' ? 'Попробуйте нитки Гамма — у них больше промежуточных оттенков.' : 'Попробуйте нитки DMC.'),
    );
  }
  els.resultNote.textContent = notes.join(' ');
  els.resultNote.hidden = notes.length === 0;

  drawPreview(p);
  renderLegend(p);
  showError(els.exportError, null);
}

function drawPreview(p: Pattern) {
  // целое число пикселей на клетку, чтобы клетки были чёткими
  const dpr = window.devicePixelRatio || 1;
  const target = Math.min(980, document.documentElement.clientWidth) * dpr;
  const k = Math.max(1, Math.min(Math.ceil(target / p.cols), Math.floor(4096 / Math.max(p.cols, p.rows))));
  const small = new ImageData(p.cols, p.rows);
  for (let i = 0; i < p.cells.length; i++) {
    const c = p.cells[i];
    const o = i * 4;
    if (c < 0) {
      small.data[o] = small.data[o + 1] = small.data[o + 2] = 255;
      small.data[o + 3] = 255;
      continue;
    }
    const rgb = p.colors[c].rgb;
    small.data[o] = rgb[0];
    small.data[o + 1] = rgb[1];
    small.data[o + 2] = rgb[2];
    small.data[o + 3] = 255;
  }
  const tmp = document.createElement('canvas');
  tmp.width = p.cols;
  tmp.height = p.rows;
  tmp.getContext('2d')!.putImageData(small, 0, 0);
  const c = els.canvas;
  c.width = p.cols * k;
  c.height = p.rows * k;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, c.width, c.height);
  // экранный размер задаёт CSS: вписать в колонку и в 72% высоты окна с сохранением пропорций
}

function renderLegend(p: Pattern) {
  els.legendSummary.textContent = `Цвета и нитки · ${p.colors.length}`;
  const rows = p.colors.map((c) => {
    const tr = document.createElement('tr');
    const sym = document.createElement('span');
    sym.className = 'sym';
    sym.textContent = c.symbol;
    sym.style.background = `rgb(${c.rgb.join(',')})`;
    sym.style.color = contrastTextIsBlack(c.rgb) ? '#000' : '#fff';
    const cells = [sym, c.code, c.name || '—', formatInt(c.count), String(skeinsFor(c.count))];
    const classes = ['', 'code', 'name', 'num', 'num'];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      if (classes[i]) td.className = classes[i];
      if (typeof v === 'string') td.textContent = v;
      else td.append(v);
      tr.append(td);
    });
    return tr;
  });
  els.legendBody.replaceChildren(...rows);
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => pattern && !els.result.hidden && drawPreview(pattern), 150);
});

// ——— Скачивание ———
function download(name: string, bytes: Uint8Array, mime: string) {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const exportButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-export]')];
let exporting = false;

for (const btn of exportButtons) {
  btn.addEventListener('click', async () => {
    if (!pattern || exporting) return;
    exporting = true;
    exportButtons.forEach((b) => (b.disabled = b !== btn));
    btn.classList.add('is-busy');
    showError(els.exportError, null);
    els.exportProgress.hidden = false;
    setProgress(els.exportBar, els.exportStage, 0, 'Готовлю файл');
    try {
      const res = await call({ type: 'export', kind: btn.dataset.export as ExportKind, title: patternTitle }, (f, s) =>
        setProgress(els.exportBar, els.exportStage, f, s),
      );
      if (res.type !== 'exported') throw new Error('Неожиданный ответ');
      for (const f of res.files) download(f.name, f.bytes, f.mime);
    } catch (err) {
      showError(els.exportError, err instanceof Error ? err.message : String(err));
    } finally {
      exporting = false;
      exportButtons.forEach((b) => (b.disabled = false));
      btn.classList.remove('is-busy');
      els.exportProgress.hidden = true;
    }
  });
}
