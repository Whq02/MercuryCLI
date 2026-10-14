#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'recall-mode-words-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
  if (!cond) failures++
}
const finish = (note: string): never => {
  rmSync(SCRATCH, { recursive: true, force: true })
  console.log(failures > 0 ? `\nprove-recall-mode-words-true: RED (${failures})` : `\nprove-recall-mode-words-true: green${note ? ` (${note})` : ''}`)
  process.exit(failures > 0 ? 1 : 0)
}

const pack = await import('../../src/mneme/embedPack.js')
const models = await import('../../src/mneme/embedModels.js')
const idx = await import('../../src/mneme/mnemeIndex.js')
const docs = await import('../../src/mneme/mnemeTopicDocs.js')
const { recallQuery, retainItems } = await import('../../src/mneme/memoryVerbs.js')
const { voicePackPlatform } = await import('../../src/services/voice/voicePack.js')

const PACK_DIR = pack.embedPackDirFor(ROOT, voicePackPlatform())
const CACHE_DIR = join(ROOT, models.EMBED_MODELS_VENDOR_PATH)
const built = existsSync(join(PACK_DIR, pack.EMBED_PACK_MANIFEST_FILE))
const defaultModel = models.embedDefaultModel()
const cachedDefault = join(CACHE_DIR, defaultModel.file)
if (!built || !existsSync(cachedDefault)) {
  console.log(`prove-recall-mode-words-true: SKIP (${built ? `${models.EMBED_MODELS_VENDOR_PATH}/${defaultModel.file} is absent — bun run scripts/vendor/fetch-embed-models.ts` : 'no embed pack on this host — bun run scripts/vendor/build-embed.ts'})`)
  rmSync(SCRATCH, { recursive: true, force: true })
  process.exit(0)
}

const artifactModels = join(SCRATCH, 'artifact-models')
mkdirSync(artifactModels, { recursive: true })
symlinkSync(cachedDefault, join(artifactModels, defaultModel.file))

const reset = (spec: string | null): void => {
  pack.resetEmbedAddonForTest()
  pack.seedEmbedPackDirForTest(PACK_DIR)
  models.seedEmbedModelForTest(spec, artifactModels)
  idx.resetEmbedIndexForTest()
}

console.log('\n[O] an Ollama pin with no server behind it')
{
  reset('ollama:prove-no-such-embedding-model-7f3a')
  const engine = idx.embedIndexEngineStatus()
  const words = models.memoryRecallModeWords({ home: HOME })
  check('the derived index does not serve an ollama pin', engine.state === 'off', JSON.stringify(engine))
  check('…so the recall-mode words do not claim meaning when no road can answer', words === models.WORD_MATCH_ONLY_WORDS || !words.includes('semantic'), words)
}

console.log('\n[C] every model the /config row offers serves on the install the artifact makes (one model rides)')
{
  for (const row of models.EMBED_MODELS) {
    reset(row.name)
    const ready = models.describeSemanticReadiness({ home: HOME })
    check(`${row.name}: offered as a shipped choice ⇒ ready on an artifact-shaped install`, ready.state === 'ok', ready.state === 'ok' ? '' : ready.note)
  }
}

console.log('\n[F] the front page sentence is what Recall does')
{
  reset(null)
  const dir = join(SCRATCH, 'library')
  mkdirSync(dir, { recursive: true })
  const a = docs.emptyDoc('clock', 'clock facts', '2026-10-13T09:00:00.000Z')
  a.sections.push({ heading: 'notes', entries: [
    { text: 'the notebook time zone was set wrong after the trip', seq: 1, time: '2026-10-13T10:00:00.000Z', source: 's:a' },
    { text: 'the build pipeline publishes a tarball every night', seq: 2, time: '2026-10-13T11:00:00.000Z', source: 's:a' },
  ] })
  writeFileSync(join(dir, 'topic-clock.md'), docs.serializeTopicDoc(a))
  const index = await idx.ensureEmbedIndex(dir)
  check('the derived index is built for the scratch library', index.built && index.rows === 2, JSON.stringify(index))
  const line = models.memoryRecallModeLine(dir)
  check('the front page says Recall ranks by meaning and words', line.includes('semantic + word match'), line)
  const hits = recallQuery('the laptop clock', { dir, now: new Date('2026-10-14T00:00:00.000Z') })
  const found = hits.hits.map(h => h.id)
  check('…and a query with no word in common finds the time-zone fact (the sentence is true)', found[0] === 'seq:1', JSON.stringify(found))
  const retained = retainItems([{ content: 'the desk lamp flickers whenever the heater starts' }], { session: 'fixture' }, dir)
  const id = retained[0]?.status === 'stored' ? retained[0].id : ''
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !(idx.readEmbedIndex(dir)?.rows.some(r => r.key === id) ?? false)) await new Promise(r => setTimeout(r, 25))
  check('a Retain embeds the new fact at once, under its pending id, off the thread', id.startsWith('pending:') && (idx.readEmbedIndex(dir)?.rows.some(r => r.key === id) ?? false), JSON.stringify({ id, keys: idx.readEmbedIndex(dir)?.rows.map(r => r.key) }))
  const byMeaning = recallQuery('the lamp blinks', { dir, now: new Date('2026-10-14T00:00:00.000Z') }).hits.map(h => h.id)
  check('…and Recall finds it by meaning before any consolidation', byMeaning[0] === id, JSON.stringify(byMeaning))
}

reset(null)
finish('')
