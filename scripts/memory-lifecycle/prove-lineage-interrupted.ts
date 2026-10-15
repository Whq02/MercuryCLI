#!/usr/bin/env bun
// gate-watch: src/mneme/ledger.ts src/mneme/lineageSession.ts src/mneme/entryPage.ts src/utils/sessionStorage/paths.ts src/utils/sessionStorage/vnext.ts src/utils/sessionStorage/transcriptReader.ts src/fabric/transcriptDecode.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'lineage-interrupted-home-'))
process.env.NODE_ENV = 'test'
process.env.MERCURY_ENTRYPOINT = 'headless'
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { getSessionId } = await import('../../src/bootstrap/state.ts')
const ledger = await import('../../src/mneme/ledger.ts')
const lineage = await import('../../src/mneme/lineageSession.ts')
const { composeEntryPage, stampLocal } = await import('../../src/mneme/entryPage.ts')
const { mnemeProjectKey, lineagePath } = await import('../../src/mneme/paths.ts')
const { getTranscriptPathForSession } = await import('../../src/utils/sessionStorage/paths.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const { mnemeEnabled } = await import('../../src/mneme/mnemeGates.ts')

const projectKey = mnemeProjectKey()
const me = String(getSessionId())
check('the mneme is on and this session joins the lineage (the scratch home\'s defaults)', mnemeEnabled() && lineage.lineageJoined())

type Row = Record<string, unknown>
const ids = { closed: '00000000-aaaa-4000-8000-000000000001', idle: '00000000-aaaa-4000-8000-000000000002', bare: '00000000-aaaa-4000-8000-000000000003', killed: '00000000-aaaa-4000-8000-000000000004' }
const CUT_AT = '2026-10-15T20:51:40.000Z'

function writeTranscript(sessionId: string, entries: Row[]): string {
  const path = getTranscriptPathForSession(sessionId)
  mkdirSync(dirname(path), { recursive: true })
  let text = ''
  for (const entry of entries) text += encodeTranscriptLine(path, { ...entry, sessionId, cwd: process.cwd(), version: '1.0.0', isSidechain: false, entrypoint: 'cli' }).line
  writeFileSync(path, text)
  return path
}
const user = (uuid: string, parentUuid: string | null, timestamp: string, text: string): Row => ({ type: 'user', message: { role: 'user', content: text }, uuid, parentUuid, timestamp })
const assistantText = (uuid: string, parentUuid: string, timestamp: string, text: string): Row => ({ type: 'assistant', message: { role: 'assistant', model: 'proof-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }, uuid, parentUuid, timestamp })
const assistantTool = (uuid: string, parentUuid: string, timestamp: string): Row => ({ type: 'assistant', message: { role: 'assistant', model: 'proof-model', content: [{ type: 'text', text: 'Counting now.' }, { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'seq 1 200 | awk "{ print; system(\\"sleep 1\\") }"' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }, uuid, parentUuid, timestamp })
const rowsOf = (): Row[] => readFileSync(lineagePath(projectKey), 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Row)
const lastRowOf = (sessionId: string): Row | undefined => rowsOf().filter(r => r.sessionId === sessionId).at(-1)

section('§1 the Windows loop\'s shape (F37W-2B-15 / F37W-4D-05): one session killed mid-tool, then the next start in the same project reconciles its row and says so in one line (RED on the base: the row stays endedAt null / outcome null and the page reads "never closed")')
{
  rmSync(lineagePath(projectKey), { force: true })
  lineage._resetLineageSessionForTesting()
  ledger.openEntry(projectKey, { sessionId: ids.killed, model: 'proof-model' })
  writeTranscript(ids.killed, [
    user('u1', null, '2026-10-15T20:51:00.000Z', 'count slowly from 1 to 200'),
    assistantTool('a1', 'u1', CUT_AT),
  ])
  const before = lastRowOf(ids.killed)
  check('before the next start the killed row is open: endedAt null, outcome null', before?.endedAt === null && before?.outcome === null, JSON.stringify(before))

  lineage.noteSessionEngine('proof-model')
  const after = lastRowOf(ids.killed)
  check('the next start reconciles the row: outcome interrupted', after?.outcome === 'interrupted', JSON.stringify(after))
  check("endedAt is the transcript's last row time (the in-flight tool call), not the clock of the next start", after?.endedAt === CUT_AT, JSON.stringify(after))
  check('the reconciled row keeps its ordinal, start, engines and (no) handoff', after?.ordinal === 1 && after?.startedAt === before?.startedAt && JSON.stringify(after?.engines) === JSON.stringify(before?.engines) && after?.handoff === null, JSON.stringify(after))
  check('the ledger appends, never rewrites: the open row still stands above the reconciled one', rowsOf().filter(r => r.sessionId === ids.killed).length === 2)
  const mine = ledger.ledgerEntryOf(projectKey, me)
  check('this session opened its own row (ordinal 2, open)', mine?.ordinal === 2 && mine.endedAt === null, JSON.stringify(mine))

  const page = composeEntryPage(projectKey, me) ?? ''
  check('the page keeps the count words: "1 session before it (1 of them ended without closing its entry)"', page.includes('Session 2 of this work; 1 session before it (1 of them ended without closing its entry).'), page)
  check(`the page says it in one line: "The last session (1) was cut off mid-tool at ${stampLocal(CUT_AT)}; no note was left."`, page.includes(`The last session (1) was cut off mid-tool at ${stampLocal(CUT_AT)}; no note was left.`), page)
  check('the page never guesses what the session did and no longer says "never closed" for it', !page.includes('never closed') && !/did|was doing|probably/.test(page.split('\n').find(l => l.startsWith('The last session')) ?? ''), page)
  check('a second start in the same process does not reconcile again (no third row for the killed session)', (lineage.noteSessionEngine('proof-model'), rowsOf().filter(r => r.sessionId === ids.killed).length === 2))
}

section('§2 the ledger\'s other rows are untouched: a closed session, a session whose transcript ends on a plain reply (not mid-tool) and a session with no transcript stay exactly as they were')
{
  rmSync(lineagePath(projectKey), { force: true })
  rmSync(getTranscriptPathForSession(ids.killed), { force: true })
  lineage._resetLineageSessionForTesting()
  ledger.openEntry(projectKey, { sessionId: ids.closed, model: 'proof-model' })
  ledger.closeEntry(projectKey, ids.closed, { outcome: 'closed', handoff: 'Still to do: the lineage row.' })
  ledger.openEntry(projectKey, { sessionId: ids.idle, model: 'proof-model' })
  writeTranscript(ids.idle, [user('u1', null, '2026-10-15T21:00:00.000Z', 'hello'), assistantText('a1', 'u1', '2026-10-15T21:00:05.000Z', 'Hello. What shall we do?')])
  ledger.openEntry(projectKey, { sessionId: ids.bare, model: 'proof-model' })
  ledger.openEntry(projectKey, { sessionId: ids.killed, model: 'proof-model' })
  writeTranscript(ids.killed, [
    user('u1', null, '2026-10-15T20:51:00.000Z', 'count slowly from 1 to 200'),
    assistantText('a0', 'u1', '2026-10-15T20:51:10.000Z', 'Starting.'),
    user('u2', 'a0', '2026-10-15T20:51:20.000Z', 'go on'),
    assistantTool('a1', 'u2', CUT_AT),
  ])
  const snapshot = Object.fromEntries(Object.values(ids).map(id => [id, JSON.stringify(lastRowOf(id))]))

  lineage.noteSessionEngine('proof-model')
  check('the closed session\'s row is byte-identical', JSON.stringify(lastRowOf(ids.closed)) === snapshot[ids.closed], JSON.stringify(lastRowOf(ids.closed)))
  check('the session whose transcript ends on a plain reply is left open (it may be live, or it was cut at the prompt — not mid-tool)', JSON.stringify(lastRowOf(ids.idle)) === snapshot[ids.idle] && lastRowOf(ids.idle)?.endedAt === null, JSON.stringify(lastRowOf(ids.idle)))
  check('the session with no transcript is left open (nothing to read, nothing invented)', JSON.stringify(lastRowOf(ids.bare)) === snapshot[ids.bare] && lastRowOf(ids.bare)?.endedAt === null, JSON.stringify(lastRowOf(ids.bare)))
  const killed = lastRowOf(ids.killed)
  check('the killed session (its transcript ends on an in-flight tool call after earlier turns) is reconciled as interrupted at the last row time', killed?.outcome === 'interrupted' && killed?.endedAt === CUT_AT, JSON.stringify(killed))
  check('the file still carries every earlier row of every session (append-only)', rowsOf().length === 1 + 1 + 1 + 1 + 1 + 1 + 1, String(rowsOf().length))

  const page = composeEntryPage(projectKey, me) ?? ''
  check('the count line counts the interrupted row with the still-open ones: "4 sessions before it (3 of them ended without closing their entry)"', page.includes('Session 5 of this work; 4 sessions before it (3 of them ended without closing their entry).'), page)
  check('the last session (the killed one) is named in the one line, and the earlier note is still offered', page.includes(`The last session (4) was cut off mid-tool at ${stampLocal(CUT_AT)}; no note was left.`) && page.includes('## The last note left (session 1,') && page.includes('Still to do: the lineage row.'), page)
}

section('§3 the words for an unreconciled open row are kept: when the last session left no transcript the page still says "never closed"')
{
  rmSync(lineagePath(projectKey), { force: true })
  for (const id of Object.values(ids)) rmSync(getTranscriptPathForSession(id), { force: true })
  lineage._resetLineageSessionForTesting()
  ledger.openEntry(projectKey, { sessionId: ids.bare, model: 'proof-model' })
  lineage.noteSessionEngine('proof-model')
  const page = composeEntryPage(projectKey, me) ?? ''
  check('"The last session (1, never closed) left no note."', page.includes('The last session (1, never closed) left no note.'), page)
  check('the bare row is still open', lastRowOf(ids.bare)?.endedAt === null)
}

check('nothing was written outside the scratch home', existsSync(HOME) && lineagePath(projectKey).startsWith(HOME) && getTranscriptPathForSession(ids.killed).startsWith(HOME), `${lineagePath(projectKey)} · ${getTranscriptPathForSession(ids.killed)}`)
rmSync(HOME, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'lineage-interrupted: ALL LAWS HOLD' : `lineage-interrupted: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
