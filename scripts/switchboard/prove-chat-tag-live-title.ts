#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'chat-tag-live-title-'))
const HOME = join(SCRATCH, 'home')
const DAEMON = join(SCRATCH, 'daemon')
mkdirSync(HOME, { recursive: true })
mkdirSync(DAEMON, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON

const TITLE_HINT = 'change liveTitleDeriverFor in src/daemon/switchboard/hopIntoSession.ts, headBriefLabel in src/screen/concourse-model/concourseSnapshot.ts, or extractFirstPromptFromHead in src/sessions/transcripts/sessionStoragePortable.ts so the live title follows the record, the first words, then the stage-1 title'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  const shown = cond ? detail : (detail ? detail + ' — ' : '') + TITLE_HINT
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}

const workers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { sessionTitleOf, newSessionTitle } = await import('../../src/screen/concourse-model/sessionNaming.ts')
const { headBriefLabel } = await import('../../src/screen/concourse-model/concourseSnapshot.ts')
const { liveTitleDeriverFor } = await import('../../src/daemon/switchboard/hopIntoSession.ts')
const paths = await import('../../src/sessions/transcripts/paths.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')

const workspace = join(SCRATCH, 'work')
mkdirSync(workspace, { recursive: true })
const sessionId = 'aaaaaaaa-1111-4222-8333-444444444444'
const record = { sessionId, runnerId: 'r1', title: newSessionTitle(workspace), projectLabel: 'work', workspaceId: workspace, home: paths.getProjectDir(workspace) }
const deriver = liveTitleDeriverFor(workers, sessionTitleOf, headBriefLabel)

check('§1a no record, no words ⇒ the stage-1 fact', deriver(record) === newSessionTitle(workspace), String(deriver(record)))

const workersPath = workers.concourseWorkersPath(DAEMON)
const writeWorkers = (title: string | undefined): void => {
  writeFileSync(workersPath, JSON.stringify({ version: 1, workers: { r1: { sessionId, runnerId: 'r1', workspaceId: workspace, ...(title !== undefined ? { title } : {}) } } }))
}
writeWorkers(undefined)
mkdirSync(paths.getProjectDir(workspace), { recursive: true })
const transcriptPath = join(paths.getProjectDir(workspace), `${sessionId}.jsonl`)
writeFileSync(
  transcriptPath,
  encodeSeedTranscript([{ type: 'user', uuid: 'u-1', timestamp: new Date().toISOString(), sessionId, message: { role: 'user', content: 'hello there tag' } }], sessionId),
)
check('§1b the first words land ⇒ stage 2 (the chat\'s own first line)', deriver(record) === 'hello there tag', String(deriver(record)))
check('§1b the first words are memoized (a second read answers the same without the file)', deriver(record) === 'hello there tag')

writeWorkers('Tag greeting session')
const t = new Date(Date.now() + 2000)
utimesSync(workersPath, t, t)
check('§1c a minted title on the record ⇒ stage 3 wins', deriver(record) === 'Tag greeting session', String(deriver(record)))

writeWorkers('Renamed by the operator')
const t2 = new Date(Date.now() + 4000)
utimesSync(workersPath, t2, t2)
check('§1d a rename on the record follows (the record is the one owner)', deriver(record) === 'Renamed by the operator', String(deriver(record)))


const { extractFirstPromptFromHead } = await import('../../src/sessions/transcripts/sessionStoragePortable.ts')
const { tellSessionStorageTheBuiltInCommands } = await import('../../src/sessions/transcripts/builtInCommands.ts')
const { formatCommandInputTags, createSyntheticUserCaveatMessage } = await import('../../src/engine/message-shapes/factories.ts')
tellSessionStorageTheBuiltInCommands(() => new Set(['model']))
for (const entry of [
  { kind: 'built-in', withPrompt: false, command: 'model', args: 'claude-sonnet-5', id: 'aaaaaaaa-1111-4222-8333-666666666666', runnerId: 'command-false' },
  { kind: 'with-prompt', withPrompt: true, command: 'model', args: 'claude-sonnet-5', id: 'aaaaaaaa-1111-4222-8333-555555555555', runnerId: 'command-true' },
  { kind: 'custom', withPrompt: false, command: 'deploy', args: '', id: 'aaaaaaaa-1111-4222-8333-666666666667', runnerId: 'command-custom' },
] as const) {
  const commandRows = [
    createSyntheticUserCaveatMessage(),
    { type: 'user', message: { role: 'user', content: formatCommandInputTags(entry.command, entry.args) } },
    { type: 'user', message: { role: 'user', content: `<local-command-stdout>Ran ${entry.command}</local-command-stdout>` } },
    ...(entry.withPrompt ? [{ type: 'user', message: { role: 'user', content: 'hello after a command' } }] : []),
  ].map((row, index) => ({ ...row, uuid: `command-first-${index}`, sessionId: entry.id, timestamp: new Date().toISOString() }))
  const bytes = encodeSeedTranscript(commandRows, entry.id)
  writeFileSync(join(paths.getProjectDir(workspace), `${entry.id}.jsonl`), bytes)
  const rec = { ...record, sessionId: entry.id, runnerId: entry.runnerId }
  const actual = headBriefLabel(rec, 48)
  if (entry.kind === 'built-in') {
    check('command-first command only, a built-in: the session takes no name from it', actual === null && extractFirstPromptFromHead(bytes) === '', JSON.stringify({ actual, extracted: extractFirstPromptFromHead(bytes) }))
    check('the live view-header title of a session that only ran a built-in command stays the new-session words', deriver(rec) === `new session · ${record.projectLabel} · ready`, String(deriver(rec)))
  } else {
    const expected = entry.withPrompt ? 'hello after a command' : `/${entry.command}`
    check(`command-first ${entry.withPrompt ? 'with prompt' : 'command only'}: the view title uses the session list's clean words`, actual === expected && actual === extractFirstPromptFromHead(bytes) && !actual.includes('<'), String(actual))
    check('the live view-header title follows the same cleanup', deriver(rec) === expected, String(deriver(rec)))
  }
}

{
  const { QueuePart } = await import('../../src/sessions/transcripts/writer/queue.ts')
  const { historyHead } = await import('../../src/sessions/transcripts/historyParts.ts')
  const foldedId = 'aaaaaaaa-1111-4222-8333-777777777777'
  const foldedPath = join(paths.getProjectDir(workspace), `${foldedId}.jsonl`)
  const queue = new QueuePart()
  const land = async (entry: Record<string, unknown>): Promise<void> => {
    const done = queue.enqueueWrite(foldedPath, entry as never)
    await queue.flush()
    await done
  }
  const ts = new Date().toISOString()
  await land({ type: 'user', uuid: 'bf-u1', parentUuid: null, sessionId: foldedId, cwd: workspace, timestamp: ts, isSidechain: false, message: { role: 'user', content: 'first opening prompt before fold' } })
  await land({ type: 'assistant', uuid: 'bf-a1', parentUuid: 'bf-u1', sessionId: foldedId, cwd: workspace, timestamp: ts, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'first reply before fold' }] } })
  await land({ type: 'system', subtype: 'compact_boundary', uuid: 'bf-cb1', parentUuid: null, sessionId: foldedId, timestamp: ts, content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 10000 } })
  await land({ type: 'user', uuid: 'bf-sum', parentUuid: 'bf-cb1', sessionId: foldedId, cwd: workspace, timestamp: ts, isSidechain: false, isCompactSummary: true, message: { role: 'user', content: 'The context window turned over' } })
  await land({ type: 'user', uuid: 'bf-u2', parentUuid: 'bf-sum', sessionId: foldedId, cwd: workspace, timestamp: ts, isSidechain: false, message: { role: 'user', content: 'later follow-up prompt after fold' } })
  const foldedRec = { ...record, sessionId: foldedId, runnerId: 'folded-1' }
  const sealed = historyHead(foldedPath)
  const brief = headBriefLabel(foldedRec, 48)
  check('a folded session seals its first prompt and headBriefLabel still reads the opening prompt', sealed.before > 0 && brief === 'first opening prompt before fold', JSON.stringify({ before: sealed.before, brief }))
  check('the live view-header title of an untitled folded session keeps the opening prompt', deriver(foldedRec) === 'first opening prompt before fold', String(deriver(foldedRec)))
}

console.log(failures === 0 ? '\nprove-chat-tag-live-title: ALL LAWS HOLD' : `\nprove-chat-tag-live-title: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
