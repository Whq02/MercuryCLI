#!/usr/bin/env bun
// ============================================================================
//  scripts/sessionStorage/prove-transcript-consumers-owned.ts — every
//  transcript consumer reads through the one transcript reader (source
//  locks over the census), and the bounded window readers stay bounded.
//
//  The census (what each consumer asks the reader for):
//    · the focused chat's daemon connector — the conversation chain since
//      its cursor (readTranscriptChainSince), the path retained per slot;
//    · the resume load (loadTranscriptFile, and through it loadFullLog,
//      loadTranscriptFromFile, getLastSessionLog, getAgentTranscript,
//      loadAllLogsFromSessionFile, findUnresolvedToolUse, the resume
//      pipeline, the writer's dedup set) — the fold (readTranscript);
//    · the concourse mirror's byte cursor (workerTranscript, behind the
//      mirror pane's hook) — complete lines past its cursor
//      (readTranscriptBytesAfter);
//    · the close receipt's machine floor — the bounded window through the
//      same byte cursor;
//    · the re-admission's retained-model walk — the newest lines first
//      (scanTranscriptLinesBackward);
//    · the degradation latch — stated by the reader for every damaged read.
//  Bounded readers outside the reader, pinned to their bounds: the resume
//  path's 8 KB head (the workspace field), the resume picker's 64 KB head
//  plus tail (labels), the board's ≤8 KB head/tail windows and the title
//  mint's 48 KB head. None re-reads a growing file whole.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '../..')
const src = (rel: string): string => readFileSync(join(ROOT, 'src', rel), 'utf8')

section('the reader is the one owner of the transcript file')
{
  const reader = src('utils/sessionStorage/transcriptReader.ts')
  check('the reader keeps the offset, the fold and the window per path', /offset: number/.test(reader) && /window: Buffer/.test(reader) && /fold: TranscriptFoldState/.test(reader))
  check('a growth read fetches from offset minus the window and proves the window', reader.includes('io.readRangeSync(state.path, state.offset - W, st.size)') && reader.includes(".equals(state.window)) return reset(state, 'the covered prefix was rewritten')"))
  check('truncation and a replaced file reset', reader.includes("if (st.size < state.offset) return reset(state, 'the file was truncated')") && reader.includes("if (st.ino !== state.ino) return reset(state, 'the file was replaced')"))
  check('an append still in flight folds nothing', reader.includes('if (lastNl === -1) return none(state, st.size)'))
  check('the resume snapshot keeps its one writer (the reader only calls it)', (reader.match(/writeResumeSnapshot\(/g) ?? []).length >= 2 && !reader.includes('durableAtomicPublishSync'))
  check('the kill switch is the registered flag', reader.includes("flagEnabled('MERCURY_TRANSCRIPT_READER')"))
  const registry = src('substrate/flagRegistry.ts')
  check('the registry row names the reader and its evidence', /env: 'MERCURY_TRANSCRIPT_READER', kind: 'default-on', tier: 'behavioral', evidence: 'scripts\/sessionStorage\/prove-transcript-tail-reader\.ts'/.test(registry))
}

section('the resume load reads the fold through the reader')
{
  const loading = src('utils/sessionStorage/loading.ts')
  check('loadTranscriptFile asks the reader', loading.includes('await readTranscript(filePath, { policy:'))
  check('loading.ts opens no file of its own', !/from ['"](node:)?fs/.test(loading) && !loading.includes('readFile('))
  check('the degradation latch is the reader\'s (re-exported for the chat)', loading.includes('subscribeTranscriptLoadDegradation,') && src('utils/sessionStorage/transcriptReader.ts').includes('function noteLoadDegradation('))
  const logs = src('utils/sessionStorage/logs.ts')
  check('the log surface loads files only through loadTranscriptFile / loadSessionFile', (logs.match(/loadTranscriptFile\(/g) ?? []).length >= 4 && !logs.includes('readFileSync('))
  check('the picker\'s enrichment stays the bounded head+tail read', logs.includes('readHeadAndTail(filePath, fileSize, buf)') && src('utils/sessionStoragePortable.ts').includes('export const LITE_READ_BUF_SIZE = 65536'))
  const recovery = src('utils/conversationRecovery.ts')
  check('the resume pipeline walks files through loadTranscriptFile only', recovery.includes('await loadTranscriptFile(path)') && !/from ['"](node:)?fs/.test(recovery))
  const writer = src('utils/sessionStorage/writer.ts')
  check('the writer\'s dedup set comes from loadSessionFile (the reader), not a parse of its own', writer.includes('const { messages } = await loadSessionFile(sessionId)'))
}

section('the daemon connector reads the chain since its cursor')
{
  const connector = src('services/engine-connector/daemonConnector.ts')
  check('the tick asks for the chain since the cursor', connector.includes('reader.readTranscriptChainSince(this.transcriptPath, this.chainCursor)'))
  check('the tick no longer loads the whole log', !connector.includes('loadFullLog('))
  check('the path is retained while the slot holds the session and released at detach', connector.includes('this.releaseTranscript = reader.retainTranscript(this.transcriptPath)') && connector.includes('this.releaseTranscript?.()'))
  check('the merge signs rows by the reader\'s tokens (content by construction) and keeps its both-directions law', connector.includes('reader.chainRowSigner()') && /if \(merge\.reusedAll\) return/.test(connector))
  check('the live-turn fold refolds only from the cursor\'s moved index', connector.includes('this.liveFold.fold(this.rawRecords, chain.since)'))
  const identity = src('services/engine-connector/recordIdentity.ts')
  check('the merge seam takes a signer and defaults to serialization', identity.includes('sigOf: (record: unknown) => string = record => JSON.stringify(record)'))
  const recovery = src('utils/conversationRecovery.ts')
  check('liveTurnStateOf is the one-shot form of the settled-prefix fold (one arithmetic)', recovery.includes('return createLiveTurnFold().fold(messages, 0)'))
}

section('the line-folding consumers ride the reader\'s byte cursor and backward walk')
{
  const mirror = src('services/concourse/workerTranscript.ts')
  check('the mirror\'s cursor read is the reader\'s byte cursor', mirror.includes('readTranscriptBytesAfter(cursor.path, { offset: cursor.offset, carry: cursor.carry })') && !/from ['"]node:fs['"]/.test(mirror))
  const pane = src('components/concourse/workerTranscriptFold.ts')
  check('the mirror pane\'s hook reads only through the service seam', pane.includes("import('../../services/concourse/workerTranscript.js')") && !pane.includes('readFileSync('))
  const receipts = src('services/switchboard/sessionReceipts.ts')
  check('the close receipt\'s window reads through the byte cursor, carry re-joined as an unread line', receipts.includes("readTranscriptBytesAfter(path, { offset: from, carry: '' })") && receipts.includes('`${read.text}\\n${read.cursor.carry}`') && !receipts.includes('openSync('))
  const supervisor = src('daemon/concourseSupervisor.ts')
  check('the retained-model walk reads newest lines first through the reader', supervisor.includes('scanTranscriptLinesBackward(transcript, line => {') && !supervisor.includes('readFileSync(transcript'))
}

section('the bounded window readers stay bounded')
{
  const hop = src('services/switchboard/hopIntoSession.ts')
  check('the resume path\'s workspace read is the 8 KB head', hop.includes('fh.read(buf, 0, 8192, 0)'))
  const snapshot = src('services/concourse/concourseSnapshot.ts')
  check('the board\'s activity and brief reads are ≤8 KB windows', snapshot.includes("transcriptWindowLines(rec, 8192, 'tail')") && snapshot.includes("transcriptWindowLines(rec, 8192, 'head')"))
  const mint = src('services/concourse/sessionTitleMint.ts')
  check('the title mint reads a 48 KB head', mint.includes('const HEAD_BYTES = 48 * 1024'))
  const tiles = src('components/concourse/liveTiles.ts')
  check('the board\'s live tiles stat the transcript and read the projections, never the file', tiles.includes('statSync(this.deps.transcriptPath(') && !tiles.includes('readFileSync('))
  const runAll = readFileSync(join(ROOT, 'scripts/sessionStorage/run-all.sh'), 'utf8')
  check('the suite runs the reader proof and this census', runAll.includes('prove-transcript-tail-reader.ts') && runAll.includes('prove-transcript-consumers-owned.ts'))
}

console.log(failures === 0 ? '\n✅ ALL TRANSCRIPT-CONSUMER-OWNERSHIP PROOFS PASS' : `\n❌ ${failures} TRANSCRIPT-CONSUMER-OWNERSHIP PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
