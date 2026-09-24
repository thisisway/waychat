// Orçamento do widget: 50 KB gzip (seção 8 do plano da Fase 1). Falha o build se estourar.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const LIMIT = 50 * 1024;
const file = fileURLToPath(new globalThis.URL('../dist/waychat-widget.js', import.meta.url));
const size = gzipSync(readFileSync(file)).length;
process.stdout.write(
  `waychat-widget.js: ${(size / 1024).toFixed(1)} KB gzip (limite ${String(LIMIT / 1024)} KB)\n`,
);
if (size > LIMIT) {
  process.stderr.write('Orçamento estourado.\n');
  process.exit(1);
}
