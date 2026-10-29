import { proofHome } from '../lib/hermetic.ts'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { MediaCatalogue } from '../../src/services/media/catalogue.js'

for (const key of ['MEDIA_ROOT', 'MEDIA_CATALOG', 'MEDIA_IMAGE_MODEL', 'MEDIA_VIDEO_MODEL', 'MEDIA_OUTPUT_DIR']) delete process.env[key]
export { proofHome }
export const root = join(proofHome, 'media')
const engine = join(proofHome, 'engine')
export const serverPath = join(engine, 'dist', 'server.js')
export const catalogue: MediaCatalogue = {
  runtime: { tag: 'fixture-1', families: [], platforms: { 'darwin-arm64': [{ variant: 'metal', binary: 'sd-server', files: [{ asset: 'fixture.zip', bytes: 64, sha256: 'a'.repeat(64) }] }] } },
  recipes: [],
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
if (process.argv.includes('pull-model')) {
  const catalogue = ${JSON.stringify(catalogue)};
  const model = catalogue.models.find(model => model.id === process.argv[3]);
  if (!model) { console.log(JSON.stringify({ event: 'error', message: 'Unknown fixture model' })); process.exit(1); }
  await mkdir(join(root, 'models'), { recursive: true });
  for (const path of Object.values(model.slots)) await writeFile(join(root, 'models', path), Buffer.alloc(catalogue.files.find(file => file.path === path).bytes));
}
console.log(JSON.stringify({ event: 'done' }));
`)
}

export function installLiveFixture(): void {
  installFixture()
  const setup = readFileSync(join(dirname(serverPath), 'setup.js'), 'utf8')
  cpSync(new URL('../../src/extensions/bundled/mercury-media/server/', import.meta.url), dirname(serverPath), { recursive: true })
  writeFileSync(join(dirname(serverPath), 'setup.js'), setup)
  writeFileSync(join(root, 'catalog.json'), JSON.stringify({ files: catalogue.files, models: catalogue.models.map(model => ({ ...model, recipe: 'fixture-recipe', residentBytes: 1, peakBytes: 1 })) }))
  const runtime = join(root, 'runtime')
  mkdirSync(runtime, { recursive: true })
  const binary = join(runtime, 'sd-server')
  writeFileSync(binary, `#!/usr/bin/env node
import { createServer } from 'node:http';
import { readdir, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5r8AAAAASUVORK5CYII=';
let recipe = null;
const server = createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : null;
  const route = req.url.replace('/sdcpp/v1/', '');
  await appendFile(join(root, 'engine-calls.jsonl'), JSON.stringify({ route, body, pid: process.pid }) + '\\n');
  let result;
  if (route === 'models/status') result = { state: recipe ? 'ready' : 'empty', recipe };
  else if (route === 'recipes') result = { recipes: ['fixture-recipe', 'sd1-checkpoint', 'sd1-controlnet', 'sdxl-controlnet'].map(id => ({ id })) };
  else if (route === 'model-files') result = { files: (await readdir(join(root, 'models'))).map(path => ({ id: path, relative_path: path })) };
  else if (route === 'models/load') { recipe = body.recipe; result = { state: 'ready' }; }
  else if (route === 'models/unload') { recipe = null; result = { state: 'empty' }; }
  else if (route === 'models/refresh') result = { errors: [] };
  else if (route === 'img_gen') result = { id: 'fixture-job' };
  else if (route === 'jobs/fixture-job') result = { status: 'completed', result: { images: [{ b64_json: png }] } };
  else { res.statusCode = 404; result = { error: route }; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(result));
});
server.listen(Number(process.argv[process.argv.indexOf('--listen-port') + 1]), '127.0.0.1');
process.on('SIGTERM', () => { server.close(); process.exit(0); });
`, { mode: 0o700 })
  const bundled = JSON.parse(readFileSync(join(dirname(serverPath), 'catalog.json'), 'utf8'))
  writeFileSync(join(root, 'runtime.json'), JSON.stringify({ binary, tag: bundled.runtime.tag }))
}

export async function stopFixtureEngine(): Promise<void> {
  const file = join(root, 'run', 'engine-image.json')
  let record: { ownerPid: number; pid: number }
  try { record = JSON.parse(readFileSync(file, 'utf8')) } catch { return }
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
  if (alive(record.ownerPid)) process.kill(record.ownerPid, 'SIGTERM')
  const deadline = Date.now() + 10000
  while (alive(record.ownerPid) || alive(record.pid)) {
    if (Date.now() > deadline) throw new Error('Fixture engine did not stop')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
