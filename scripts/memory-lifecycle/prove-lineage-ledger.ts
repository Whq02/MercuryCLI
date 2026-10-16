#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_ENTRYPOINT = 'headless'
const HOME = mkdtempSync(join(tmpdir(), 'lineage-ledger-home-'))
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
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const realNow = Date.now
let frozen = Date.UTC(2026, 9, 11, 1, 2, 3, 456)
Date.now = () => frozen
const frozenIso = (): string => new Date(frozen).toISOString()

const ledger = await import('../../src/mneme/ledger.ts')
const { composeEntryPage, FIRST_SESSION_LINE, ENTRY_PAGE_HEADING, NO_NOTE_LEFT } = await import('../../src/mneme/entryPage.ts')
const { HANDOFF_GRADE } = await import('../../src/mneme/memoryEvidence.ts')
const { lineagePath, mnemeProjectKeyFor } = await import('../../src/mneme/paths.ts')
const { handoffAskDue, _resetHandoffAskForTesting } = await import('../../src/mneme/handoffAsk.ts')
const { registerSessionCloser, registerSessionCloseAsk, runSessionClosers, sessionCloseAsks, _resetSessionClosersForTesting } = await import('../../src/mneme/sessionClose.ts')
const state = await import('../../src/bootstrap/state.ts')
const queue = await import('../../src/input-core/command-queue.ts')

const KEY = 'lineage-proof-project'

try {
  section('§1 the clock law: every time in an entry is the clock\'s at the write, never a caller\'s')
  {
    const opened = ledger.openEntry(KEY, { sessionId: 's-1', model: 'claude-fable-5-1' })
    check('the first session of a project is ordinal 1', opened.ordinal === 1, j(opened))
    check('startedAt and the first engine stamp are the frozen instant', opened.startedAt === frozenIso() && opened.engines[0]?.at === frozenIso(), j(opened))
    frozen += 60_000
    ledger.recordEngine(KEY, 's-1', 'gpt-6-astra')
    frozen += 60_000
    ledger.recordHandoff(KEY, 's-1', 'the note')
    frozen += 60_000
    const closed = ledger.closeEntry(KEY, 's-1', { outcome: 'closed' })!
    const times = {
      startedAt: Date.UTC(2026, 9, 11, 1, 2, 3, 456),
      engine2: Date.UTC(2026, 9, 11, 1, 3, 3, 456),
      handoff: Date.UTC(2026, 9, 11, 1, 4, 3, 456),
      endedAt: Date.UTC(2026, 9, 11, 1, 5, 3, 456),
    }
    const iso = (ms: number): string => new Date(ms).toISOString()
    check('the engine switch is stamped at ITS write, a minute after the open', closed.engines[1]?.model === 'gpt-6-astra' && closed.engines[1]?.at === iso(times.engine2), j(closed.engines))
    check('the handoff is stamped at ITS write', closed.handoff?.at === iso(times.handoff), j(closed.handoff))
    check('endedAt is stamped at the close', closed.endedAt === iso(times.endedAt), j(closed.endedAt))
    check('the open stamp did not move', closed.startedAt === iso(times.startedAt))
    const every = [closed.startedAt, closed.endedAt, closed.handoff?.at, ...closed.engines.map(e => e.at)]
    check('every time in the entry is an ISO-8601 instant with its zone', every.every(t => typeof t === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t)), j(every))
    check('a write-side function takes no time argument (the module signature is the law)', ledger.openEntry.length === 2 && ledger.recordEngine.length === 3 && ledger.closeEntry.length === 3)
    const file = readFileSync(lineagePath(KEY), 'utf8').split('\n').filter(Boolean)
    check('the file is append-only: one line per write, the last line for a session is its current state', file.length === 4 && JSON.parse(file[3]!).endedAt === iso(times.endedAt), `${file.length} lines`)
    check('readLedger folds the lines to one entry per session', ledger.readLedger(KEY).length === 1)
  }

  section('§2 the first session is "first session, no record" — never an invented predecessor')
  {
    const fresh = 'lineage-proof-fresh'
    check('an absent ledger reads as empty, never fatal', ledger.readLedger(fresh).length === 0 && !existsSync(lineagePath(fresh)))
    const page = composeEntryPage(fresh, 'me')
    check('the page for a project with no record is the one line', page === `${ENTRY_PAGE_HEADING}\n${FIRST_SESSION_LINE}`, j(page))
    ledger.openEntry(fresh, { sessionId: 'me', model: 'claude-fable-5-1' })
    const own = composeEntryPage(fresh, 'me')
    check('its own open entry does not make a predecessor: still the one line', own === `${ENTRY_PAGE_HEADING}\n${FIRST_SESSION_LINE}`, j(own))
    check('the one line names no count, no time, no engine', !/\d/.test(FIRST_SESSION_LINE))
  }

  section('§3 a session that ends without a note is marked "no note left"; the last note that exists is shown as what it is')
  {
    const key = 'lineage-proof-notes'
    ledger.openEntry(key, { sessionId: 'a', model: 'claude-fable-5-1' })
    ledger.closeEntry(key, 'a', { outcome: 'closed', handoff: 'A left this.\nTwo lines.' })
    ledger.openEntry(key, { sessionId: 'b', model: 'claude-fable-5-1' })
    const b = ledger.closeEntry(key, 'b', { outcome: 'closed' })!
    check('an absent handoff at the close is null, not a made-up note', b.handoff === null, j(b))
    ledger.openEntry(key, { sessionId: 'c', model: 'gpt-6-astra' })
    const page = composeEntryPage(key, 'c')!
    check('the page says the last session left no note', page.includes(`The last session (2, ended `) && page.includes(NO_NOTE_LEFT), page)
    check('the page carries the ordinal and the count from the ledger', page.includes('Session 3 of this work; 2 sessions before it'), page)
    check('the last note that exists is shown word for word, named by its session, every line graded as a model-authored note', page.includes('## The last note left (session 1, ') && page.includes(`${HANDOFF_GRADE} A left this.\n${HANDOFF_GRADE} Two lines.`), page)
    check('the engines line names the earlier sessions\' engine with its first time; the CURRENT engine is never named', page.includes('Engines before this session: claude-fable-5-1 from ') && page.includes('(session 1)') && !page.includes('gpt-6-astra'), page)
    check('the page points at the pinned section instead of duplicating it', page.includes('Standing rulings: none pinned.'), page)
    check('the page is apart from any question: it carries no user words and starts with its own heading', page.startsWith(ENTRY_PAGE_HEADING))
  }

  section('§4 the live-session line comes from the daemon\'s records: a live pid in this project, nothing else')
  {
    const key = 'lineage-proof-live'
    const workspace = mkdtempSync(join(tmpdir(), 'lineage-proof-workspace-'))
    const projectKey = mnemeProjectKeyFor(workspace)
    ledger.openEntry(projectKey, { sessionId: 'old', model: 'claude-fable-5-1' })
    ledger.closeEntry(projectKey, 'old', { outcome: 'closed', handoff: 'note' })
    ledger.openEntry(projectKey, { sessionId: 'me', model: 'claude-fable-5-1' })
    void key
    mkdirSync(process.env.MERCURY_DAEMON_DIR!, { recursive: true })
    const workersFile = join(process.env.MERCURY_DAEMON_DIR!, 'concourse-workers.json')
    const spawnedAt = Date.UTC(2026, 9, 11, 0, 30, 0, 0)
    const write = (workers: Record<string, unknown>): void => writeFileSync(workersFile, JSON.stringify({ version: 1, workers }))
    write({
      'concourse-w1': { schema: 1, runnerId: 'concourse-w1', sessionId: 'other-live', workspaceId: workspace, pid: process.pid, spawnedAt, modelKey: 'x', isolation: 'shared' },
      'concourse-w2': { schema: 1, runnerId: 'concourse-w2', sessionId: 'other-dead', workspaceId: workspace, pid: 2147483000, spawnedAt, modelKey: 'x', isolation: 'shared' },
      'concourse-w3': { schema: 1, runnerId: 'concourse-w3', sessionId: 'other-ended', workspaceId: workspace, pid: process.pid, spawnedAt, endedAt: spawnedAt + 1, modelKey: 'x', isolation: 'shared' },
      'concourse-w4': { schema: 1, runnerId: 'concourse-w4', sessionId: 'elsewhere', workspaceId: join(workspace, '..', 'another-place'), pid: process.pid, spawnedAt, modelKey: 'x', isolation: 'shared' },
      'concourse-w5': { schema: 1, runnerId: 'concourse-w5', sessionId: 'me', workspaceId: workspace, pid: process.pid, spawnedAt, modelKey: 'x', isolation: 'shared' },
    })
    const live = ledger.liveSessions(projectKey)
    check('liveSessions lists the live records of this project only (a dead pid, an ended record and another workspace are not live)', live.map(s => s.sessionId).sort().join(',') === 'me,other-live', j(live))
    check('their start times are the daemon\'s spawn stamps as ISO instants', live.every(s => s.startedAt === new Date(spawnedAt).toISOString()), j(live))
    const page = composeEntryPage(projectKey, 'me')!
    const lines = page.split('\n').filter(l => l.startsWith('Another session of this work has been live here since '))
    check('the page carries one live-session line for the OTHER live session, not for itself', lines.length === 1, page)
    check('the line carries the daemon\'s start time, rendered locally with its zone', lines[0]!.includes('(UTC') && /since \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(lines[0]!), lines[0])
    write({})
    check('with no live record of another session the line is absent', !composeEntryPage(projectKey, 'me')!.includes('has been live here'), composeEntryPage(projectKey, 'me')!)
    writeFileSync(workersFile, '{not json')
    check('a torn daemon file reads as no live sessions, never fatal', ledger.liveSessions(projectKey).length === 0)
  }

  section('§5 the stop-road gate: the ask is due only for the main seat of a run whose input has closed with nothing queued and no note yet')
  {
    _resetHandoffAskForTesting()
    const sessionId = String(state.getSessionId())
    const projectKey = (await import('../../src/mneme/paths.ts')).mnemeProjectKey()
    state.setRunInputClosed(false)
    ledger.openEntry(projectKey, { sessionId, model: 'claude-fable-5-1' })
    check('input still open: not due', handoffAskDue({ querySource: 'sdk' }) === false)
    state.setRunInputClosed(true)
    check('input closed, queue empty, no note: due', handoffAskDue({ querySource: 'sdk' }) === true)
    check('a crewmate is never asked', handoffAskDue({ querySource: 'sdk', agentId: 'agent-1' }) === false)
    check('a side query is never asked', handoffAskDue({ querySource: 'side_question' }) === false)
    queue.enqueue({ value: 'one more prompt', mode: 'prompt' })
    check('a prompt still queued: not due (the session has not ended)', handoffAskDue({ querySource: 'sdk' }) === false)
    queue.resetCommandQueue()
    ledger.recordHandoff(projectKey, sessionId, 'the seat wrote its own note')
    check('a note already written this session: not asked', handoffAskDue({ querySource: 'sdk' }) === false)
    state.setRunInputClosed(false)
  }

  section('§6 the close hook: closers run once per session; asks carry their lines and tools')
  {
    _resetSessionClosersForTesting()
    const seen: string[] = []
    const unregister = registerSessionCloser(async ctx => {
      seen.push(`${ctx.sessionId}:${ctx.outcome}:${ctx.handoff}`)
    })
    registerSessionCloser(async () => {
      throw new Error('a closer that fails')
    })
    const ctx = { projectKey: KEY, sessionId: 'close-1', endedAt: frozenIso(), outcome: 'quit', transcriptPath: '/nowhere', handoff: null }
    const first = await runSessionClosers(ctx)
    const second = await runSessionClosers(ctx)
    check('every registered closer ran; a failing one is counted, never fatal', first.ran === 1 && first.failed === 1 && !first.skipped, j(first))
    check('a second run for the same session is a no-op', second.skipped && second.ran === 0, j(second))
    check('the closer saw the context', seen.length === 1 && seen[0] === 'close-1:quit:null', j(seen))
    unregister()
    registerSessionCloseAsk(id => (id === 'ask-me' ? { line: 'and your journal entry with the Journal tool', tools: ['Journal'] } : null))
    registerSessionCloseAsk(() => null)
    const asks = sessionCloseAsks('ask-me')
    check('asks are listed with their lines and tools; a null ask is skipped', asks.length === 1 && asks[0]!.line.includes('Journal') && asks[0]!.tools?.[0] === 'Journal', j(asks))
    check('another session gets no ask from a source that declines', sessionCloseAsks('other').length === 0)
  }

  section('§7 reading: an unreadable line is skipped and counted; later lines supersede earlier ones')
  {
    const key = 'lineage-proof-torn'
    ledger.openEntry(key, { sessionId: 't1', model: 'm' })
    appendFileSync(lineagePath(key), 'this is not json\n{"ordinal":"x"}\n')
    ledger.closeEntry(key, 't1', { outcome: 'closed' })
    const read = ledger.readLedgerFile(key)
    check('two unreadable lines skipped and counted; the entry is the last good line', read.skipped === 2 && read.entries.length === 1 && read.entries[0]!.endedAt !== null, j(read))
    check('files are deduplicated and capped, never doubled', (() => {
      ledger.openEntry(key, { sessionId: 't2', model: 'm' })
      ledger.recordFile(key, 't2', 'src/a.ts')
      ledger.recordFile(key, 't2', 'src/a.ts')
      const e = ledger.recordFile(key, 't2', 'src/b.ts')!
      return e.files.join(',') === 'src/a.ts,src/b.ts'
    })())
    check('rulings and facts are recorded by id, once each', (() => {
      ledger.recordRuling(key, 't2', 'pending:1')
      ledger.recordRuling(key, 't2', 'pending:1')
      ledger.recordFact(key, 't2', 'pending:1', 'retained')
      const e = ledger.recordFact(key, 't2', 'seq:4', 'corrected')!
      return e.rulings.join(',') === 'pending:1' && e.retained.join(',') === 'pending:1' && e.corrected.join(',') === 'seq:4'
    })())
    check('a record for a session the ledger does not hold is refused as null, never an invented entry', ledger.recordFile(key, 'ghost', 'x') === null && ledger.closeEntry(key, 'ghost', { outcome: 'closed' }) === null)
  }
} finally {
  Date.now = realNow
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ LINEAGE LEDGER GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ LINEAGE LEDGER RED (${failures} of ${checks} checks failed)`)
process.exit(1)
