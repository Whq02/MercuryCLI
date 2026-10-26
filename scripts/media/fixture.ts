import { proofHome } from '../lib/hermetic.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MediaCatalogue } from '../../src/services/media/catalogue.js'

for (const key of ['MEDIA_ROOT', 'MEDIA_CATALOG', 'MEDIA_IMAGE_MODEL', 'MEDIA_VIDEO_MODEL', 'MEDIA_OUTPUT_DIR']) delete process.env[key]
export { proofHome }
export const root = join(proofHome, 'media')
const engine = join(proofHome, 'engine')
export const serverPath = join(engine, 'dist', 'server.js')
export const catalogue: MediaCatalogue = {
  runtime: { tag: 'fixture-1', asset: 'fixture.zip', bytes: 64, sha256: 'a'.repeat(64) },
  files: [
    { path: 'image.gguf', bytes: 8, repo: 'fixture/images', source: 'image.gguf', sha256: 'b'.repeat(64) },
    { path: 'other.gguf', bytes: 4, repo: 'fixture/images', source: 'other.gguf', sha256: 'c'.repeat(64) },
    { path: 'video.gguf', bytes: 16, repo: 'fixture/videos', source: 'video.gguf', sha256: 'd'.repeat(64) },
    { path: 'encoder.gguf', bytes: 2, repo: 'fixture/shared', source: 'encoder.gguf', sha256: 'e'.repeat(64) },
  ],
  models: [
    { id: 'image-one', kind: 'image', license: 'Apache-2.0', steps: 9, multiple: 16, residentBytes: 6 * 1024 ** 3, secondsPerImage: 12, slots: { diffusion_model: 'image.gguf', llm: 'encoder.gguf' } },
    { id: 'image-two', kind: 'image', license: 'MIT', steps: 4, multiple: 16, residentBytes: 4 * 1024 ** 3, slots: { diffusion_model: 'other.gguf', llm: 'encoder.gguf' } },
    { id: 'video-one', kind: 'video', license: 'Apache-2.0', steps: 20, multiple: 32, residentBytes: 20 * 1024 ** 3, slots: { diffusion_model: 'video.gguf' } },
  ],
}
export function installFixture(): void {
  mkdirSync(join(engine, 'dist'), { recursive: true })
  mkdirSync(root, { recursive: true })
  writeFileSync(join(engine, 'catalog.json'), JSON.stringify(catalogue))
  writeFileSync(serverPath, 'throw new Error("Fixture server must not launch")\n')
  writeFileSync(join(engine, 'dist', 'config.js'), `import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
export async function readMediaConfig(root) { try { return JSON.parse(await readFile(join(root, 'config.json'), 'utf8')); } catch(e) { if(e.code !== 'ENOENT') throw e; return { imageModel: 'image-one', videoModel: 'video-one' }; } }
export async function writeMediaConfig(root, patch) { await mkdir(root, { recursive: true }); const next = { ...await readMediaConfig(root), ...patch }; await writeFile(join(root, 'config.json'), JSON.stringify(next)); return next; }
`)
  writeFileSync(join(engine, 'dist', 'setup.js'), `import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.env.MEDIA_ROOT;
await mkdir(root, { recursive: true });
await appendFile(join(root, 'called.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');
process.once('SIGTERM', () => { console.log(JSON.stringify({ event: 'cancelled', file: join(root, 'models', 'image.gguf') })); process.exit(143); });
console.log(JSON.stringify({ event: 'progress', file: 'image.gguf', bytes: 4, total: 8 }));
if (process.argv.includes('fail')) { console.log(JSON.stringify({ event: 'error', message: 'digest mismatch' })); process.exit(1); }
if (process.argv.includes('hang')) { await new Promise(resolve => setTimeout(resolve, 60000)); }
if (process.argv.includes('pull-model')) { await mkdir(join(root, 'models'), { recursive: true }); await writeFile(join(root, 'models', 'image.gguf'), Buffer.alloc(8)); await writeFile(join(root, 'models', 'encoder.gguf'), Buffer.alloc(2)); }
console.log(JSON.stringify({ event: 'done' }));
`)
}
