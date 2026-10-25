#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SCRATCH = mkdtempSync(join(tmpdir(), 'resume-sidecars-'))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)

const loading = await import('../../src/utils/sessionStorage/loading.ts')
const reader = await import('../../src/utils/sessionStorage/transcriptReader.ts')
const { snapshotPathFor, SNAPSHOT_SCHEMA } = await import('../../src/utils/sessionStorage/resumeSnapshot.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const { TRANSCRIPT_FORMAT_REFUSAL } = await import('../../src/fabric/transcriptDecode.ts')
const boot = await import('../../src/utils/bootCardFacts.ts')
const { readUsageHistory } = await import('../../src/utils/usageHistory.ts')

const SESSION = '009c13c0-b123-4fae-ad0b-25e6060405e4'
const PROJ = join(SCRATCH, 'Café Ledger')
mkdirSync(PROJ, { recursive: true })
const STORE = getProjectDir(PROJ)
mkdirSync(STORE, { recursive: true })
const TRANSCRIPT = join(STORE, `${SESSION}.jsonl`)
const RECEIPTS = join(STORE, `${SESSION}.receipts.jsonl`)
const RECEIPTS_OF_RECEIPTS = join(STORE, `${SESSION}.receipts.receipts.jsonl`)
const SNAPSHOT = snapshotPathFor(TRANSCRIPT)

const entryLine = (path: string, n: number, parent: number | null, sessionId: string): string =>
  (encodeTranscriptLine as (p: string, e: Record<string, unknown>) => { line: string })(path, {
    isSidechain: false,
    entrypoint: 'cli',
    cwd: PROJ,
    sessionId,
    version: '1.0.0-beta.44',
    gitBranch: '',
    parentUuid: parent === null ? null : `00000000-0000-4000-8000-${String(parent).padStart(12, '0')}`,
    uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    timestamp: `2026-10-25T06:${String(n % 60).padStart(2, '0')}:00.000Z`,
    ...(n % 2 === 0
      ? { type: 'user', message: { role: 'user', content: `turn ${n} ${'x'.repeat(400)}` } }
      : {
          type: 'assistant',
          message: {
            id: `m_${n}`, type: 'message', role: 'assistant', model: 'glm-5.3', stop_reason: 'end_turn', stop_sequence: null,
            content: [{ type: 'text', text: `reply ${n} ${'y'.repeat(400)}` }],
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }),
  }).line

const seedTranscript = (path: string, sessionId: string, count: number): void => {
  let content = ''
  for (let i = 0; i < count; i++) content += entryLine(path, i + 1, i === 0 ? null : i, sessionId)
  writeFileSync(path, content)
}

const receiptsText = [
  { at: '2026-10-25T15:52:27.246Z', by: 'daemon', kind: 'machine-floor', summary: 'parked after 9h 41m · 16 prompts · 183 replies', details: { closedBy: 'park', turns: { user: 16, assistant: 183 } } },
  { at: '2026-10-25T15:52:27.246Z', by: 'session', kind: 'agent-close', summary: 'the work stands', details: {} },
].map(row => JSON.stringify(row)).join('\n') + '\n'

section('§1 the store as the box left it — a parked chat: the transcript, then its receipts written LATER, then a snapshot')
{
  seedTranscript(TRANSCRIPT, SESSION, 1200)
  boot.catalogFirstChat(PROJ, SESSION)
  const first = await loading.loadTranscriptFile(TRANSCRIPT)
  check('the transcript folds whole', first.messages.size === 1200, String(first.messages.size))
  check('a cold read of a transcript past the snapshot floor wrote its sidecar', existsSync(SNAPSHOT), SNAPSHOT)
  const parkedAt = Date.now() - 5 * 60_000
  writeFileSync(RECEIPTS, receiptsText)
  writeFileSync(RECEIPTS_OF_RECEIPTS, JSON.stringify({ at: '2026-10-25T15:54:17.579Z', by: 'daemon:admit', kind: 'kit-restamp', summary: 'record-less resume' }) + '\n')
  utimesSync(TRANSCRIPT, new Date(parkedAt - 5 * 60_000), new Date(parkedAt - 5 * 60_000))
  utimesSync(RECEIPTS, new Date(parkedAt), new Date(parkedAt))
  utimesSync(RECEIPTS_OF_RECEIPTS, new Date(parkedAt + 1000), new Date(parkedAt + 1000))
  utimesSync(SNAPSHOT, new Date(parkedAt + 2000), new Date(parkedAt + 2000))
  check('the receipts sidecar is the NEWEST .jsonl in the store (the box at 15:54Z)', statSync(RECEIPTS).mtimeMs > statSync(TRANSCRIPT).mtimeMs && statSync(RECEIPTS_OF_RECEIPTS).mtimeMs > statSync(TRANSCRIPT).mtimeMs)
}

section('§2 Continue Last Session and the project card point at the TRANSCRIPT, never at a sidecar')
{
  const facts = boot.scanBootCardFacts(PROJ)
  check('the boot face\'s continue target is the session id of the transcript', facts.cwdProject?.sessionId === SESSION, String(facts.cwdProject?.sessionId))
  check('…and its transcript path is the transcript file', facts.cwdProject?.transcriptPath === TRANSCRIPT, String(facts.cwdProject?.transcriptPath))
  check('the recent-last door (another project\'s Continue) agrees', facts.recentLast?.transcriptPath === TRANSCRIPT, String(facts.recentLast?.transcriptPath))
  const identity = boot.projectIdentity(PROJ)
  check('the project identity\'s newest chat is the transcript', identity.newestChat?.transcriptPath === TRANSCRIPT && identity.newestChat.sessionId === SESSION, JSON.stringify(identity.newestChat))
  const parked = boot.parkedSessionsOf(PROJ)
  check('the parked list names the transcript alone — no receipts row, no receipts-of-receipts row', parked.length === 1 && parked[0]!.transcriptPath === TRANSCRIPT, JSON.stringify(parked.map(p => p.sessionId)))
  check('the chat count counts the one chat', boot.projectChatCount(PROJ) === 1, String(boot.projectChatCount(PROJ)))
  check('a session id never carries a sidecar\'s dotted stem', [facts.cwdProject?.sessionId, identity.newestChat?.sessionId, ...parked.map(p => p.sessionId)].every(id => typeof id === 'string' && !id.includes('.')))
}

section('§3 the usage history reads transcripts only — a sidecar is not "could not read"')
{
  const report = await readUsageHistory({})
  check('no warning names a receipts file', !report.warnings.some(w => w.includes('.receipts')), JSON.stringify(report.warnings))
  check('exactly the one transcript was read', report.filesRead + report.filesCached === 1, `${report.filesRead}+${report.filesCached}`)
}

section('§4 the refusal the owner saw is the receipts file read as a transcript — and its footer line is scoped to the chat that faulted')
{
  loading._resetTranscriptLoadDegradationForTesting()
  reader._resetTranscriptReaderForTesting()
  let fired = 0
  const off = loading.subscribeTranscriptLoadDegradation(() => { fired++ })
  const refused = await loading.loadTranscriptFile(RECEIPTS)
  const fact = loading.transcriptLoadDegradation()
  check('a receipts file read as a transcript is refused as a retired format (the words on the owner\'s footer)', refused.messages.size === 0 && fact?.refusal === TRANSCRIPT_FORMAT_REFUSAL && fact.path === RECEIPTS, JSON.stringify(fact))
  check('the listener fired for the refusal', fired >= 1, String(fired))
  check('the fact answers for the chat that faulted', loading.transcriptLoadDegradation(RECEIPTS)?.path === RECEIPTS)
  check('the fact does NOT answer for another chat (the next chat\'s footer stays clean)', loading.transcriptLoadDegradation(TRANSCRIPT) === null, JSON.stringify(loading.transcriptLoadDegradation(TRANSCRIPT)))
  const before = fired
  const good = await loading.loadTranscriptFile(TRANSCRIPT)
  check('the real session then loads whole', good.messages.size === 1200, String(good.messages.size))
  check('a different chat\'s clean load leaves the other chat\'s fact where it is', loading.transcriptLoadDegradation(RECEIPTS)?.path === RECEIPTS && fired === before)

  const DAMAGED = join(STORE, '11111111-1111-4111-8111-111111111111.jsonl')
  writeFileSync(DAMAGED, '{"not":"a transcript"}\n')
  await loading.loadTranscriptFile(DAMAGED)
  check('a refused chat latches its own fact', loading.transcriptLoadDegradation(DAMAGED)?.refusal === TRANSCRIPT_FORMAT_REFUSAL)
  seedTranscript(DAMAGED, '11111111-1111-4111-8111-111111111111', 4)
  reader._resetTranscriptReaderForTesting()
  const afterRepair = fired
  const healed = await loading.loadTranscriptFile(DAMAGED)
  check('the same file, read clean once it is a transcript, loads', healed.messages.size === 4, String(healed.messages.size))
  check('…and the stale fact for that file is gone', loading.transcriptLoadDegradation(DAMAGED) === null, JSON.stringify(loading.transcriptLoadDegradation(DAMAGED)))
  check('…and the footer is told (the listener fires once more)', fired === afterRepair + 1, `${afterRepair} -> ${fired}`)
  off()
}

section('§5 a transcript with a valid schema-5 resume snapshot resumes without refusal and the snapshot file is never decoded as a transcript')
{
  loading._resetTranscriptLoadDegradationForTesting()
  reader._resetTranscriptReaderForTesting()
  const snapshotBytes = readFileSync(SNAPSHOT)
  const snapshotMtime = statSync(SNAPSHOT).mtimeMs
  const written = JSON.parse(snapshotBytes.toString('utf8')) as { schemaVersion?: number; byteCursor?: number }
  check('the sidecar is a schema-5 resume snapshot with a byte cursor', written.schemaVersion === SNAPSHOT_SCHEMA && SNAPSHOT_SCHEMA === 5 && typeof written.byteCursor === 'number' && written.byteCursor > 0, JSON.stringify({ schema: written.schemaVersion, cursor: written.byteCursor }))
  const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.ts')
  check('the snapshot decoded as a transcript WOULD be refused (so any decode of it would be seen below)', decodeTranscriptBuffer(snapshotBytes).refusal === TRANSCRIPT_FORMAT_REFUSAL)
  appendFileSync(TRANSCRIPT, entryLine(TRANSCRIPT, 1201, 1200, SESSION) + entryLine(TRANSCRIPT, 1202, 1201, SESSION))
  let fired = 0
  const off = loading.subscribeTranscriptLoadDegradation(() => { fired++ })
  const census = reader.transcriptReaderCensus
  const coldBefore = census.coldReads
  const view = await reader.readTranscript(TRANSCRIPT, { policy: 'resume' })
  check('the snapshot-plus-tail read resumes: no refusal', view.refusal === null && view.read.refusal === null, String(view.refusal))
  check('it was a cold read that rode the snapshot (the 2-record tail only)', census.coldReads === coldBefore + 1 && view.fold.messages.size === 1202, `${view.fold.messages.size}`)
  const all = await reader.readTranscript(TRANSCRIPT, { policy: 'all', cache: false })
  check('policy all resumes without refusal too', all.refusal === null && all.fold.messages.size === 1202, String(all.refusal))
  check('nothing was stated to the footer and no listener fired', loading.transcriptLoadDegradation() === null && fired === 0, `${fired} ${JSON.stringify(loading.transcriptLoadDegradation())}`)
  check('the snapshot file is untouched by the reads (a hit under the refresh floor rewrites nothing)', readFileSync(SNAPSHOT).equals(snapshotBytes) && statSync(SNAPSHOT).mtimeMs === snapshotMtime, String(statSync(SNAPSHOT).mtimeMs))
  check('the snapshot is not a session: no listing names it', boot.parkedSessionsOf(PROJ).every(p => !p.transcriptPath.endsWith('.resume-snapshot.json')))
  off()
}

removeScratch(SCRATCH)
removeScratch(proofHome)
console.log(failures === 0 ? '\nPASS prove-resume-sidecars-not-sessions' : `\nFAIL prove-resume-sidecars-not-sessions (${failures} failure(s))`)
process.exit(failures === 0 ? 0 : 1)
