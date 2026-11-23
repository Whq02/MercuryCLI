import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mediaRows, mediaPullPlan, mediaRuntimeChoice, pullMedia, runMediaSetup, MediaSetupPaused, mediaSizeWords, type MediaProgress, type MediaSnapshot } from '../../src/integrations/media/setup.js'
import { modelFilePath, parseMediaCatalogue } from '../../src/integrations/media/catalogue.js'
import { catalogue, installFixture, removeProofHome, root, serverPath } from './fixture.ts'

try {
  installFixture()
  process.env.MERCURY_OAUTH_TOKEN = 'media-setup-fixture-token'
  process.env.MERCURY_BROWSER_SECRET_MEDIA_SETUP_FIXTURE = 'media-setup-fixture-secret'
  const setup = join(serverPath, '..', 'setup.js')
  writeFileSync(setup, `if (process.env.MERCURY_OAUTH_TOKEN !== undefined || process.env.MERCURY_BROWSER_SECRET_MEDIA_SETUP_FIXTURE !== undefined) { console.log(JSON.stringify({ event: 'error', message: 'Session secrets reached media setup' })); process.exit(1); }\n` + readFileSync(setup, 'utf8'))
  const machine = { totalMemoryBytes: 32 * 1024 ** 3, usableMemoryBytes: 24 * 1024 ** 3 }
  let rows = mediaRows(catalogue, root, machine, 100)
  assert.equal(rows[0]!.fit.fits, true, 'mediaRows in src/integrations/media/setup.ts must mark a model that fits 24 GB usable memory as fits')
  assert.equal(mediaRows(catalogue, root, { totalMemoryBytes: 8 * 1024 ** 3, usableMemoryBytes: 6 * 1024 ** 3 }, 100)[0]!.fit.fits, false, 'mediaRows in src/integrations/media/setup.ts must mark a model too large for 6 GB usable memory as not fitting')
  assert.equal(mediaRows(catalogue, root, machine, 1)[0]!.fit.diskFits, false, 'mediaRows in src/integrations/media/setup.ts must report diskFits false when free bytes (1) are below the pull size')
  assert.match(rows[0]!.words, /12 s\/image/, 'the row words from mediaRows in src/integrations/media/setup.ts must carry the catalogue speed as 12 s/image')
  assert.equal(rows[1]!.model.license, 'MIT', 'mediaRows in src/integrations/media/setup.ts must keep the catalogue license on each row (catalogue from scripts/media/fixture.ts)')
  assert.match(rows[2]!.words, /— s\/clip/, 'the row words from mediaRows in src/integrations/media/setup.ts must show a dash where a clip model has no measured speed')
  mkdirSync(join(root, 'models'), { recursive: true })
  writeFileSync(join(root, 'models', 'encoder.gguf'), Buffer.alloc(2))
  rows = mediaRows(catalogue, root, machine, 100)
  assert.equal(rows[0]!.pullBytes, 8, 'mediaRows in src/integrations/media/setup.ts must count only the files not yet on disk (the shared encoder already present) in pullBytes')
  assert.equal(rows[1]!.pullBytes, 4, 'mediaRows in src/integrations/media/setup.ts must count only the files not yet on disk (the shared encoder already present) in pullBytes')
  writeFileSync(join(root, 'models', 'image.gguf.part'), Buffer.alloc(4))
  rows = mediaRows(catalogue, root, machine, 100)
  assert.equal(rows[0]!.pullBytes, 4, 'mediaRows in src/integrations/media/setup.ts must subtract the bytes of a .part file from pullBytes')
  assert.equal(rows[0]!.installed, false, 'mediaRows in src/integrations/media/setup.ts must not mark a model installed while only its .part file exists')
  assert.equal(mediaSizeWords(37584335), '37.6 MB', 'mediaSizeWords in src/integrations/media/setup.ts must print 37584335 bytes as 37.6 MB')
  const snapshot: MediaSnapshot = { root, catalogue, rows, config: { imageModel: 'image-one' }, runtimeInstalled: false, runtime: mediaRuntimeChoice(catalogue, 'darwin', 'arm64'), freeBytes: 100, ...machine }
  const plan = mediaPullPlan(snapshot, 'image-one')
  assert.deepEqual(plan.args, ['pull-model', 'image-one'], 'mediaPullPlan in src/integrations/media/setup.ts must plan a pull-model call for the named model')
  assert.equal(plan.bytes, 4, 'mediaPullPlan in src/integrations/media/setup.ts must size the plan from the remaining bytes of the model')
  assert.equal(plan.license, 'Apache-2.0', 'mediaPullPlan in src/integrations/media/setup.ts must carry the model license into the plan for the consent line')
  assert.equal(mediaPullPlan(snapshot).bytes, 64, 'mediaPullPlan in src/integrations/media/setup.ts must plan the runtime pull (64 bytes) when no model is named and the runtime is not installed')
  assert.deepEqual(mediaPullPlan(snapshot).args, ['pull-runtime', '--variant', 'metal'], 'mediaPullPlan in src/integrations/media/setup.ts must choose the metal runtime variant for darwin arm64 (mediaRuntimeChoice)')
  const progress: MediaProgress[] = []
  const runner = (args: string[], report: (event: MediaProgress) => void, signal?: AbortSignal) => runMediaSetup(args, report, signal, { root, serverPath })
  assert.equal(await pullMedia(plan, async () => false, runner, event => progress.push(event)), false, 'pullMedia in src/integrations/media/setup.ts must return false when the consent callback declines')
  assert.equal(existsSync(join(root, 'called.jsonl')), false, 'pullMedia in src/integrations/media/setup.ts must not start the setup runner when consent is declined')
  assert.equal(await pullMedia(plan, async () => true, runner, event => progress.push(event)), true, 'pullMedia in src/integrations/media/setup.ts must return true after a consented pull completes (the fixture server is scripts/media/fixture.ts)')
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'called.jsonl'), 'utf8').trim()), ['pull-model', 'image-one'], 'runMediaSetup in src/integrations/media/setup.ts must pass the plan args to the setup server unchanged')
  assert.equal(progress[0]!.bytes, 4, 'runMediaSetup in src/integrations/media/setup.ts must report the JSON progress events of the setup server, the first carrying bytes 4')
  assert.equal(progress.at(-1)!.event, 'done', 'runMediaSetup in src/integrations/media/setup.ts must report the final done event')
  assert.equal(mediaRows(catalogue, root, machine, 100)[0]!.installed, true, 'mediaRows in src/integrations/media/setup.ts must reread the models folder after a pull and mark the model installed')
  await assert.rejects(runner(['fail'], () => {}), /digest mismatch/, 'runMediaSetup in src/integrations/media/setup.ts must reject with the setup server error message (digest mismatch) when it exits with an error event')
  const controller = new AbortController()
  const cancelled = runner(['hang'], () => controller.abort(), controller.signal)
  await assert.rejects(cancelled, error => error instanceof MediaSetupPaused && error.progress.bytes === 4 && error.message.includes('4 B kept'), 'runMediaSetup in src/integrations/media/setup.ts must reject with MediaSetupPaused carrying progress bytes 4 and the words 4 B kept when the signal aborts')
  assert.throws(() => modelFilePath(root, '../escape'), /models folder/, 'modelFilePath in src/integrations/media/catalogue.ts must refuse a path that leaves the models folder')
  assert.throws(() => parseMediaCatalogue(catalogue, { models: [{ ...catalogue.models[0], id: 'bad', license: '' }] }), () => true,'parseMediaCatalogue in src/integrations/media/catalogue.ts must reject a model whose license is empty')
  console.log('imagesetup: fit and shared sizes; consent; JSON progress; install reread; digest failure; cancellation; path validation')
} finally { removeProofHome() }
