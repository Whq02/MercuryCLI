import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mediaRows, mediaPullPlan, pullMedia, runMediaSetup, MediaSetupPaused, mediaSizeWords, type MediaProgress, type MediaSnapshot } from '../../src/services/media/setup.js'
import { modelFilePath, parseMediaCatalogue } from '../../src/services/media/catalogue.js'
import { catalogue, installFixture, proofHome, root, serverPath } from './fixture.ts'

try {
  installFixture()
  process.env.MERCURY_OAUTH_TOKEN = 'media-setup-fixture-token'
  process.env.MERCURY_BROWSER_SECRET_MEDIA_SETUP_FIXTURE = 'media-setup-fixture-secret'
  const setup = join(serverPath, '..', 'setup.js')
  writeFileSync(setup, `if (process.env.MERCURY_OAUTH_TOKEN !== undefined || process.env.MERCURY_BROWSER_SECRET_MEDIA_SETUP_FIXTURE !== undefined) { console.log(JSON.stringify({ event: 'error', message: 'Session secrets reached media setup' })); process.exit(1); }\n` + readFileSync(setup, 'utf8'))
  const machine = { totalMemoryBytes: 32 * 1024 ** 3, usableMemoryBytes: 24 * 1024 ** 3 }
  let rows = mediaRows(catalogue, root, machine, 100)
  assert.equal(rows[0]!.fit.fits, true)
  assert.equal(mediaRows(catalogue, root, { totalMemoryBytes: 8 * 1024 ** 3, usableMemoryBytes: 6 * 1024 ** 3 }, 100)[0]!.fit.fits, false)
  assert.equal(mediaRows(catalogue, root, machine, 1)[0]!.fit.diskFits, false)
  assert.match(rows[0]!.words, /12 s\/image/)
  assert.equal(rows[1]!.model.license, 'MIT')
  assert.match(rows[2]!.words, /— s\/clip/)
  mkdirSync(join(root, 'models'), { recursive: true })
  writeFileSync(join(root, 'models', 'encoder.gguf'), Buffer.alloc(2))
  rows = mediaRows(catalogue, root, machine, 100)
  assert.equal(rows[0]!.pullBytes, 8)
  assert.equal(rows[1]!.pullBytes, 4)
  writeFileSync(join(root, 'models', 'image.gguf.part'), Buffer.alloc(4))
  rows = mediaRows(catalogue, root, machine, 100)
  assert.equal(rows[0]!.pullBytes, 4)
  assert.equal(rows[0]!.installed, false)
  assert.equal(mediaSizeWords(37584335), '37.6 MB')
  const snapshot: MediaSnapshot = { root, catalogue, rows, config: { imageModel: 'image-one' }, runtimeInstalled: false, freeBytes: 100, ...machine }
  const plan = mediaPullPlan(snapshot, 'image-one')
  assert.deepEqual(plan.args, ['pull-model', 'image-one'])
  assert.equal(plan.bytes, 4)
  assert.equal(plan.license, 'Apache-2.0')
  assert.equal(mediaPullPlan(snapshot).bytes, 64)
  const progress: MediaProgress[] = []
  const runner = (args: string[], report: (event: MediaProgress) => void, signal?: AbortSignal) => runMediaSetup(args, report, signal, { root, serverPath })
  assert.equal(await pullMedia(plan, async () => false, runner, event => progress.push(event)), false)
  assert.equal(existsSync(join(root, 'called.jsonl')), false)
  assert.equal(await pullMedia(plan, async () => true, runner, event => progress.push(event)), true)
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'called.jsonl'), 'utf8').trim()), ['pull-model', 'image-one'])
  assert.equal(progress[0]!.bytes, 4)
  assert.equal(progress.at(-1)!.event, 'done')
  assert.equal(mediaRows(catalogue, root, machine, 100)[0]!.installed, true)
  await assert.rejects(runner(['fail'], () => {}), /digest mismatch/)
  const controller = new AbortController()
  const cancelled = runner(['hang'], () => controller.abort(), controller.signal)
  await assert.rejects(cancelled, error => error instanceof MediaSetupPaused && error.progress.bytes === 4 && error.message.includes('4 B kept'))
  assert.throws(() => modelFilePath(root, '../escape'), /models folder/)
  assert.throws(() => parseMediaCatalogue(catalogue, { models: [{ ...catalogue.models[0], id: 'bad', license: '' }] }))
  console.log('imagesetup: fit and shared sizes; consent; JSON progress; install reread; digest failure; cancellation; path validation')
} finally { rmSync(proofHome, { recursive: true, force: true }) }
