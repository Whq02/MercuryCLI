import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundledRoster } from '../../src/extensions/bundled/index.js'
import { proofHome } from './fixture.ts'

try {
  const source = resolve(import.meta.dir, '../../src/extensions/bundled/mercury-media/server')
  const root = join(proofHome, 'isolated-engine')
  cpSync(source, root, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as { version: string; runtimeTag: string; files: Record<string, string> }
  assert.match(manifest.version, /^\d+\.\d+\.\d+/)
  assert.equal(manifest.runtimeTag, JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8')).runtime.tag)
  for (const name of ['server.js', 'setup.js', 'config.js', 'catalog.json', 'LICENSE', 'NOTICE']) assert.ok(manifest.files[name], name)
  assert.deepEqual(readdirSync(root).sort(), [...Object.keys(manifest.files), 'manifest.json'].sort())
  const delivered = bundledRoster().find(row => row.name === 'mercury-media')!
  assert.ok(delivered)
  for (const [file, sha256] of Object.entries(manifest.files)) {
    assert.equal(createHash('sha256').update(readFileSync(join(root, file))).digest('hex'), sha256, file)
    const materialized = join(delivered.root, 'server', file)
    assert.equal(createHash('sha256').update(readFileSync(materialized)).digest('hex'), sha256, file)
    if (file === 'media-memory' && process.platform !== 'win32') assert.ok(statSync(materialized).mode & 0o111)
  }
  const { readMediaConfig, writeMediaConfig } = await import(pathToFileURL(join(root, 'config.js')).href)
  const storage = join(proofHome, 'media')
  await writeMediaConfig(storage, { imageModel: 'fixture-image', videoModel: 'fixture-video', nice: 6 })
  const config = await readMediaConfig(storage)
  assert.equal(config.imageModel, 'fixture-image')
  assert.equal(config.videoModel, 'fixture-video')
  assert.equal(config.nice, 6)
  const { updateSettingsForSource, getSettingsForSource } = await import('../../src/utils/settings/settings.ts')
  const { saveMediaSettings } = await import('../../src/services/media/settings.ts')
  assert.equal(updateSettingsForSource('userSettings', { media: { root: storage, serverPath: join(root, 'server.js') } }).error, null)
  await saveMediaSettings({ imageModel: 'flux2-klein-4b', videoModel: 'wan22-ti2v-5b' })
  assert.equal((await readMediaConfig(storage)).imageModel, 'flux2-klein-4b')
  assert.equal((await readMediaConfig(storage)).videoModel, 'wan22-ti2v-5b')
  assert.equal(getSettingsForSource('userSettings')?.media?.imageModel, undefined)
  assert.equal(getSettingsForSource('userSettings')?.media?.videoModel, undefined)
  const { readMediaCatalogue } = await import('../../src/services/media/catalogue.ts')
  const { mediaRows } = await import('../../src/services/media/setup.ts')
  const catalogue = await readMediaCatalogue()
  const docs = readFileSync(resolve(import.meta.dir, '../../docs/MEDIA.md'), 'utf8')
  for (const row of mediaRows(catalogue, storage, { totalMemoryBytes: 1024 ** 4, usableMemoryBytes: 1024 ** 4 }, 1024 ** 4)) {
    const line = docs.split('\n').find(line => line.startsWith(`| \`${row.model.id}\` |`))
    assert.ok(line, row.model.id)
    assert.ok(line.includes(`${(row.bytes / 1e9).toFixed(2)} GB`), row.model.id)
    assert.ok(line.includes(`${((row.model.peakBytes ?? row.fit.residentBytes) / 1024 ** 3).toFixed(2)} GiB`), row.model.id)
  }
  console.log('media vendor manifest: exact inventory and digests; binary bytes and mode; shared config writer/reader; documented model sizes')
} finally { rmSync(proofHome, { recursive: true, force: true }) }
