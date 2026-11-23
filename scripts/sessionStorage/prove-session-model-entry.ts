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

const writer = await import('../../src/sessions/transcripts/writer.ts')
const logs = await import('../../src/sessions/transcripts/sessionListings.ts')
const { loadTranscriptFile } = await import('../../src/sessions/transcripts/loading.ts')
const { getSessionId } = await import('../../src/boot/process-state/processState.ts')
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
const STAMP_HINT = ' — What to change: saveSessionModel in src/sessions/transcripts/sessionListings.ts, or reAppendSessionMetadata in src/sessions/transcripts/writer.ts'
const FOLD_HINT = ' — What to change: the model row handler in src/sessions/transcripts/fold.ts, or resumeFactsOf in src/sessions/transcripts/sessionListings.ts'
const CACHE_HINT = ' — What to change: restoreSessionMetadata, clearSessionMetadata or reAppendSessionMetadata in src/sessions/transcripts/sessionListings.ts'

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
check('before the file exists the model is a cache fact only — nothing is written', project.currentSessionModel === CARRIER && !existsSync(file), 'saveSessionModel must only cache the model until the file exists' + STAMP_HINT)
writer.setSessionFileForTesting(file)
project.reAppendSessionMetadata()
check('the first metadata stamp writes one model entry beside the mode', modelLines().length === 1 && lines().some(l => l.includes('"metaKind":"mode"')), j({ lines: lines().length, model: modelLines().length }) + STAMP_HINT)
const entry = entriesOf()[0]
check('the entry is the transcript\'s own session-meta record: type model, the id verbatim (provider prefix kept), stamped with the session id', entry?.type === 'model' && entry?.model === CARRIER && entry?.sessionId === SID, j(entry) + STAMP_HINT)

section('§2 the fold reads the entry back, and the facts owner hands it to every resume reader')
{
  const fold = await loadTranscriptFile(file)
  check('the fold holds the session\'s model', fold.sessionModels.get(SID as never) === CARRIER, j([...fold.sessionModels.entries()]) + FOLD_HINT)
  const facts = logs.resumeFactsOf(fold, SID as never, [])
  check('resumeFactsOf carries it as `model`', facts.model === CARRIER, j({ model: facts.model }) + FOLD_HINT)
}

section('§3 a model change writes through at once; the same model again writes nothing; the newest entry wins on read')
{
  const before = modelLines().length
  logs.saveSessionModel(CARRIER)
  check('saving the model the session already runs appends nothing', modelLines().length === before, 'saveSessionModel must skip a model equal to the cached one' + STAMP_HINT)
  logs.saveSessionModel('claude-sonnet-4-6')
  check('a switch appends one more entry naming the new model', modelLines().length === before + 1 && entriesOf().at(-1)?.model === 'claude-sonnet-4-6', j(entriesOf().map(e => e.model)) + STAMP_HINT)
  const fold = await loadTranscriptFile(file)
  check('the fold reads the LAST entry — the model the session was switched to', fold.sessionModels.get(SID as never) === 'claude-sonnet-4-6', 'when several model entries exist the fold must keep the last one' + FOLD_HINT)
  logs.saveSessionModel('')
  check('an empty model is never written', modelLines().length === before + 1 && project.currentSessionModel === 'claude-sonnet-4-6', 'saveSessionModel must ignore an empty model' + STAMP_HINT)
}

section('§4 the metadata cache: a resume seeds it from the loaded facts, /clear drops it, the exit stamp re-appends it')
{
  logs.clearSessionMetadata()
  check('cleared: no model in the cache', project.currentSessionModel === undefined, 'clearSessionMetadata must drop the cached model' + CACHE_HINT)
  logs.restoreSessionMetadata({ model: CARRIER })
  check('restoreSessionMetadata seeds the cache from the transcript\'s entry', project.currentSessionModel === CARRIER, 'restoreSessionMetadata must copy facts.model into the cache' + CACHE_HINT)
  logs.restoreSessionMetadata({})
  check('facts without a model leave the cache as it stands', project.currentSessionModel === CARRIER, 'restoreSessionMetadata must keep the cached model when facts hold none' + CACHE_HINT)
  const before = modelLines().length
  project.reAppendSessionMetadata()
  check('the exit-time stamp re-appends the cached model so the tail reader finds it', modelLines().length === before + 1 && entriesOf().at(-1)?.model === CARRIER, 'reAppendSessionMetadata must write the cached model entry' + CACHE_HINT)
}

section('§5 an old-shape transcript — no model entry — folds to no model: the readers fall back to the served rows, then the default')
{
  const old = join(SCRATCH, 'store', 'old-shape.jsonl')
  writeFileSync(old, lines().filter(l => !l.includes(MODEL_MARK)).map(l => `${l}\n`).join(''))
  const fold = await loadTranscriptFile(old)
  check('the fold of an old-shape file holds no session model', fold.sessionModels.size === 0 && fold.modes.get(SID as never) === 'normal', j([...fold.sessionModels.entries()]) + FOLD_HINT)
  check('resumeFactsOf hands back no model for it', logs.resumeFactsOf(fold, SID as never, []).model === undefined, 'resumeFactsOf must return no model when the fold holds none' + FOLD_HINT)
}

section('§6 the source pins: the pre-boundary metadata pass keeps the entry across a compaction; the append path treats it as a metadata kind')
{
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const before = modelLines().length
  await project.appendEntry({ type: 'model', sessionId: SID as never, model: CARRIER })
  await writer.flushSessionStorage()
  check('the writer appends the model kind unconditionally, like every other session fact', modelLines().length === before + 1 && entriesOf().at(-1)?.model === CARRIER, 'appendEntry must write a model entry like any other session fact; see the project class in src/sessions/transcripts/writer.ts')
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ SESSION MODEL ENTRY GREEN' : '\n❌ SESSION MODEL ENTRY RED')
process.exit(failures)
