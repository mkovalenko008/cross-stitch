import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const stub = fileURLToPath(new URL('./src/stubs/empty.ts', import.meta.url));

// base — путь сайта на GitHub Pages: https://<пользователь>.github.io/<репозиторий>/
// В GitHub Actions он подставляется из имени репозитория (BASE_PATH), локально — '/cross-stitch/'.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/cross-stitch/',
  worker: { format: 'es' },
  resolve: { alias: { html2canvas: stub, dompurify: stub, canvg: stub } },
  build: { target: 'es2020' },
  test: { include: ['tests/**/*.test.ts'] },
});
