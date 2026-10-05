#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'session-model-entry-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_SKIP_PROMPT_HISTORY

const writer = await import('../../src/utils/sessionStorage/writer.ts')
const logs = await import('../../src/utils/sessionStorage/logs.ts')
const { loadTranscriptFile } = await import('../../src/utils/sessionStorage/loading.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
type MetaRecord = { payload?: { kind?: unknown; metaKind?: unknown; fields?: Record<string, unknown> } }
const entryOfRecord = (record: MetaRecord): Record<string, unknown> =>
  record.payload?.kind === 'session-meta' ? { type: record.payload.metaKind, ...(record.payload.fields ?? {}) } : {}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const SID = getSessionId()
const MODEL_MARK = '"metaKind":"model"'
const CARRIER = 'openrouter/stealth/space-bunny-alpha'
const file = join(SCRATCH, 'store', `${SID}.jsonl`)
mkdirSync(join(SCRATCH, 'store'), { recursive: true })
const lines = (): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '') : [])
const modelLines = (): string[] => lines().filter(l => l.includes(MODEL_MARK))
const entriesOf = (): Array<Record<string, unknown>> =>
  modelLines().map(l => entryOfRecord(JSON.parse(l) as MetaRecord))
const project = writer.getProject()

section('§1 the model is cached when the session starts and stamped on the file with the first record, beside the mode')
logs.saveMode('normal')
logs.saveSessionModel(CARRIER)
check('before the file exists the model is a cache fact only — nothing is written', project.currentSessionModel === CARRIER && !existsSync(file))
writer.setSessionFileForTesting(file)
project.reAppendSessionMetadata()
check('the first metadata stamp writes one model entry beside the mode', modelLines().length === 1 && lines().some(l => l.includes('"metaKind":"mode"')), j({ lines: lines().length, model: modelLines().length }))
const entry = entriesOf()[0]
check('the entry is the transcript\'s own session-meta record: type model, the id verbatim (provider prefix kept), stamped with the session id', entry?.type === 'model' && entry?.model === CARRIER && entry?.sessionId === SID, j(entry))

section('§2 the fold reads the entry back, and the facts owner hands it to every resume reader')
{
  const fold = await loadTranscriptFile(file)
  check('the fold holds the session\'s model', fold.sessionModels.get(SID as never) === CARRIER, j([...fold.sessionModels.entries()]))
  const facts = logs.resumeFactsOf(fold, SID as never, [])
  check('resumeFactsOf carries it as `model`', facts.model === CARRIER, j({ model: facts.model }))
}

section('§3 a model change writes through at once; the same model again writes nothing; the newest entry wins on read')
{
  const before = modelLines().length
  logs.saveSessionModel(CARRIER)
  check('saving the model the session already runs appends nothing', modelLines().length === before)
  logs.saveSessionModel('claude-sonnet-4-6')
  check('a switch appends one more entry naming the new model', modelLines().length === before + 1 && entriesOf().at(-1)?.model === 'claude-sonnet-4-6', j(entriesOf().map(e => e.model)))
  const fold = await loadTranscriptFile(file)
  check('the fold reads the LAST entry — the model the session was switched to', fold.sessionModels.get(SID as never) === 'claude-sonnet-4-6')
  logs.saveSessionModel('')
  check('an empty model is never written', modelLines().length === before + 1 && project.currentSessionModel === 'claude-sonnet-4-6')
}

section('§4 the metadata cache: a resume seeds it from the loaded facts, /clear drops it, the exit stamp re-appends it')
{
  logs.clearSessionMetadata()
  check('cleared: no model in the cache', project.currentSessionModel === undefined)
  logs.restoreSessionMetadata({ model: CARRIER })
  check('restoreSessionMetadata seeds the cache from the transcript\'s entry', project.currentSessionModel === CARRIER)
  logs.restoreSessionMetadata({})
  check('facts without a model leave the cache as it stands', project.currentSessionModel === CARRIER)
  const before = modelLines().length
  project.reAppendSessionMetadata()
  check('the exit-time stamp re-appends the cached model so the tail reader finds it', modelLines().length === before + 1 && entriesOf().at(-1)?.model === CARRIER)
}

section('§5 an old-shape transcript — no model entry — folds to no model: the readers fall back to the served rows, then the default')
{
  const old = join(SCRATCH, 'store', 'old-shape.jsonl')
  writeFileSync(old, lines().filter(l => !l.includes(MODEL_MARK)).map(l => `${l}\n`).join(''))
  const fold = await loadTranscriptFile(old)
  check('the fold of an old-shape file holds no session model', fold.sessionModels.size === 0 && fold.modes.get(SID as never) === 'normal', j([...fold.sessionModels.entries()]))
  check('resumeFactsOf hands back no model for it', logs.resumeFactsOf(fold, SID as never, []).model === undefined)
}

section('§6 the source pins: the pre-boundary metadata pass keeps the entry across a compaction; the append path treats it as a metadata kind')
{
  const reader = readFileSync(join(import.meta.dir, '../../src/utils/sessionStorage/transcriptReader.ts'), 'utf8')
  check('the pre-boundary metadata pass lists the model kind beside the mode and the advisor switch', reader.includes(`'"metaKind":"model"'`) && reader.includes(`'"metaKind":"mode"'`))
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const before = modelLines().length
  await project.appendEntry({ type: 'model', sessionId: SID as never, model: CARRIER })
  await writer.flushSessionStorage()
  check('the writer appends the model kind unconditionally, like every other session fact', modelLines().length === before + 1 && entriesOf().at(-1)?.model === CARRIER)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ SESSION MODEL ENTRY GREEN' : '\n❌ SESSION MODEL ENTRY RED')
process.exit(failures)
