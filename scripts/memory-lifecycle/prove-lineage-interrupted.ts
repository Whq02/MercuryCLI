#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, uptime } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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
const { getProcessStartToken } = await import('../../src/daemon/ownerWatch.ts')
const { parseProcessStartToken } = await import('../../src/daemon/processSweep.ts')

const projectKey = mnemeProjectKey()
const me = String(getSessionId())
check('the mneme is on and this session joins the lineage (the scratch home\'s defaults)', mnemeEnabled() && lineage.lineageJoined())

type Row = Record<string, unknown>
const ids = {
  closed: '00000000-aaaa-4000-8000-000000000001',
  idle: '00000000-aaaa-4000-8000-000000000002',
  bare: '00000000-aaaa-4000-8000-000000000003',
  killed: '00000000-aaaa-4000-8000-000000000004',
  live: '00000000-aaaa-4000-8000-000000000005',
  oldDead: '00000000-aaaa-4000-8000-000000000006',
  oldRecent: '00000000-aaaa-4000-8000-000000000007',
}
const CUT_AT = '2026-10-15T20:51:40.000Z'

const OPENER = join(HOME, 'open-row.ts')
writeFileSync(
  OPENER,
  [
    ";(globalThis).MACRO = { VERSION: '1.0.0' }",
    `const { openEntry } = await import(${JSON.stringify(resolve(import.meta.dir, '../../src/mneme/ledger.ts'))})`,
    'const [projectKey, sessionId, stay] = process.argv.slice(2)',
    "openEntry(projectKey, { sessionId, model: 'proof-model' })",
    "console.log('opened')",
    "if (stay === 'stay') setInterval(() => {}, 1 << 30)",
    '',
  ].join('\n'),
)
function openFromDeadProcess(sessionId: string): void {
  const r = spawnSync(process.execPath, [OPENER, projectKey, sessionId, 'exit'], { encoding: 'utf8', env: process.env, timeout: 60_000 })
  if (r.status !== 0 || !r.stdout.includes('opened')) throw new Error(`opener failed: ${r.status} ${r.stderr}`)
}
async function openFromLiveProcess(sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<ChildProcess> {
  const child = spawn(process.execPath, [OPENER, projectKey, sessionId, 'stay'], { stdio: ['ignore', 'pipe', 'inherit'], env })
  await new Promise<void>((resolveOpened, reject) => {
    let out = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      out += String(chunk)
      if (out.includes('opened')) resolveOpened()
    })
    child.on('exit', code => reject(new Error(`opener exited early: ${code}`)))
    setTimeout(() => reject(new Error('opener did not report in 60s')), 60_000).unref()
  })
  return child
}

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
  openFromDeadProcess(ids.killed)
  writeTranscript(ids.killed, [
    user('u1', null, '2026-10-15T20:51:00.000Z', 'count slowly from 1 to 200'),
    assistantTool('a1', 'u1', CUT_AT),
  ])
  const before = lastRowOf(ids.killed)
  check('before the next start the killed row is open: endedAt null, outcome null', before?.endedAt === null && before?.outcome === null, JSON.stringify(before))
  check('the row carries the process that opened it: its pid (not ours) and the time it claimed the row', typeof before?.pid === 'number' && before.pid !== process.pid && typeof before?.pidAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(before.pidAt), JSON.stringify(before))

  lineage.noteSessionEngine('proof-model')
  const after = lastRowOf(ids.killed)
  check('the next start reconciles the row: outcome interrupted', after?.outcome === 'interrupted', JSON.stringify(after))
  check("endedAt is the transcript's last row time (the in-flight tool call), not the clock of the next start", after?.endedAt === CUT_AT, JSON.stringify(after))
  check('the reconciled row keeps its ordinal, start, engines, pid and (no) handoff', after?.ordinal === 1 && after?.startedAt === before?.startedAt && JSON.stringify(after?.engines) === JSON.stringify(before?.engines) && after?.handoff === null && after?.pid === before?.pid, JSON.stringify(after))
  check('the ledger appends, never rewrites: the open row still stands above the reconciled one', rowsOf().filter(r => r.sessionId === ids.killed).length === 2)
  const mine = ledger.ledgerEntryOf(projectKey, me)
  check('this session opened its own row (ordinal 2, open) stamped with this process', mine?.ordinal === 2 && mine.endedAt === null && mine.pid === process.pid && typeof mine.pidAt === 'string', JSON.stringify(mine))

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
  openFromDeadProcess(ids.closed)
  ledger.closeEntry(projectKey, ids.closed, { outcome: 'closed', handoff: 'Still to do: the lineage row.' })
  openFromDeadProcess(ids.idle)
  writeTranscript(ids.idle, [user('u1', null, '2026-10-15T21:00:00.000Z', 'hello'), assistantText('a1', 'u1', '2026-10-15T21:00:05.000Z', 'Hello. What shall we do?')])
  openFromDeadProcess(ids.bare)
  openFromDeadProcess(ids.killed)
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
  openFromDeadProcess(ids.bare)
  lineage.noteSessionEngine('proof-model')
  const page = composeEntryPage(projectKey, me) ?? ''
  check('"The last session (1, never closed) left no note."', page.includes('The last session (1, never closed) left no note.'), page)
  check('the bare row is still open', lastRowOf(ids.bare)?.endedAt === null)
}

section('§4 a LIVE second session is never reconciled: a session started by hand (no daemon worker row) whose transcript ends on an in-flight tool call keeps its open row while its process lives, and is reconciled once that process is gone (RED on the first fix: the row went interrupted and the page said "cut off mid-tool" while it was running)')
{
  rmSync(lineagePath(projectKey), { force: true })
  for (const id of Object.values(ids)) rmSync(getTranscriptPathForSession(id), { force: true })
  lineage._resetLineageSessionForTesting()
  const child = await openFromLiveProcess(ids.live)
  writeTranscript(ids.live, [
    user('u1', null, '2026-10-15T20:51:00.000Z', 'count slowly from 1 to 200'),
    assistantTool('a1', 'u1', CUT_AT),
  ])
  const opened = lastRowOf(ids.live)
  check('the live row carries the child\'s pid and claim time, and the daemon knows no worker for it', opened?.pid === child.pid && typeof opened?.pidAt === 'string' && ledger.liveSessions(projectKey).length === 0, JSON.stringify(opened))

  lineage.noteSessionEngine('proof-model')
  const stillOpen = lastRowOf(ids.live)
  check('the next start leaves the live row open: endedAt null, outcome null, one row only', stillOpen?.endedAt === null && stillOpen?.outcome === null && rowsOf().filter(r => r.sessionId === ids.live).length === 1, JSON.stringify(stillOpen))
  const pageLive = composeEntryPage(projectKey, me) ?? ''
  check('the page does not tell the new session that the running one was cut off', !pageLive.includes('cut off mid-tool'), pageLive)

  child.kill('SIGKILL')
  await new Promise<void>(done => child.on('exit', () => done()))
  lineage._resetLineageSessionForTesting()
  lineage.noteSessionEngine('proof-model')
  const gone = lastRowOf(ids.live)
  check('once the process is gone the same row is reconciled: outcome interrupted at the transcript\'s last row time', gone?.outcome === 'interrupted' && gone?.endedAt === CUT_AT, JSON.stringify(gone))
  check(`the page then says it: "The last session (1) was cut off mid-tool at ${stampLocal(CUT_AT)}; no note was left."`, (composeEntryPage(projectKey, me) ?? '').includes(`The last session (1) was cut off mid-tool at ${stampLocal(CUT_AT)}; no note was left.`), composeEntryPage(projectKey, me) ?? '')
}

section('§4b the pid claim is read against the process start the kernel reports, in one locale: a live row claimed under en_GB.UTF-8 is read by a next start under de_DE.UTF-8 and left open; a pid whose process started after the claim is a stranger (RED before the locale pin: `ps -o lstart=` answered "Fr. 16 Okt." under de_DE and "Fri 16 Oct" under en_GB — a token no two processes agreed on)')
{
  rmSync(lineagePath(projectKey), { force: true })
  for (const id of Object.values(ids)) rmSync(getTranscriptPathForSession(id), { force: true })
  lineage._resetLineageSessionForTesting()
  const PINNED = /^[A-Z][a-z]{2} [A-Z][a-z]{2} {1,2}\d{1,2} \d\d:\d\d:\d\d \d{4}$/
  const withLocale = <T>(locale: string, run: () => T): T => {
    const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, LC_TIME: process.env.LC_TIME }
    process.env.LC_ALL = locale
    process.env.LANG = locale
    delete process.env.LC_TIME
    try {
      return run()
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }
  const tokens = { de: withLocale('de_DE.UTF-8', () => getProcessStartToken(process.pid)), gb: withLocale('en_GB.UTF-8', () => getProcessStartToken(process.pid)), c: withLocale('C', () => getProcessStartToken(process.pid)) }
  check('the start token of one pid reads the same under de_DE, en_GB and C, in the pinned form (weekday, month, day)', typeof tokens.c === 'string' && PINNED.test(tokens.c) && tokens.de === tokens.c && tokens.gb === tokens.c, JSON.stringify(tokens))
  check('the pinned form parses to this process\'s start: at or before the moment it began running, never after', typeof tokens.c === 'string' && Number.isFinite(parseProcessStartToken(tokens.c)) && parseProcessStartToken(tokens.c) <= performance.timeOrigin && parseProcessStartToken(tokens.c) > performance.timeOrigin - 60_000, `${tokens.c} vs ${new Date(performance.timeOrigin).toISOString()}`)

  const child = await openFromLiveProcess(ids.live, { ...process.env, LC_ALL: 'en_GB.UTF-8', LANG: 'en_GB.UTF-8' })
  writeTranscript(ids.live, [
    user('u1', null, '2026-10-15T20:51:00.000Z', 'count slowly from 1 to 200'),
    assistantTool('a1', 'u1', CUT_AT),
  ])
  withLocale('de_DE.UTF-8', () => lineage.noteSessionEngine('proof-model'))
  const stillOpen = lastRowOf(ids.live)
  check('the next start under de_DE leaves the live row claimed under en_GB open: endedAt null, outcome null, one row only', stillOpen?.endedAt === null && stillOpen?.outcome === null && rowsOf().filter(r => r.sessionId === ids.live).length === 1, JSON.stringify(stillOpen))

  const strangerRow = { ...(lastRowOf(ids.live) as Row), sessionId: ids.oldRecent, ordinal: 3, pidAt: new Date(Date.now() - 3 * 24 * 3_600_000).toISOString(), startedAt: new Date(Date.now() - 3 * 24 * 3_600_000).toISOString() }
  appendFileSync(lineagePath(projectKey), `${JSON.stringify(strangerRow)}\n`)
  writeTranscript(ids.oldRecent, [user('u1', null, '2026-10-12T20:51:00.000Z', 'count'), assistantTool('a1', 'u1', '2026-10-12T20:51:40.000Z')])
  lineage._resetLineageSessionForTesting()
  lineage.noteSessionEngine('proof-model')
  const stranger = lastRowOf(ids.oldRecent)
  check('a row whose pid is alive but was claimed three days before that process started is a reused pid: reconciled at its transcript\'s cut', stranger?.outcome === 'interrupted' && stranger?.endedAt === '2026-10-12T20:51:40.000Z', JSON.stringify(stranger))
  check('…while the live row with the same pid, claimed after that process started, stays open', lastRowOf(ids.live)?.endedAt === null, JSON.stringify(lastRowOf(ids.live)))
  child.kill('SIGKILL')
  await new Promise<void>(done => child.on('exit', () => done()))
}

section('§5 an older store (rows with no pid) is reconciled only when the transcript was cut before this machine booted — a row cut since boot may be a live session and stays open')
{
  rmSync(lineagePath(projectKey), { force: true })
  for (const id of Object.values(ids)) rmSync(getTranscriptPathForSession(id), { force: true })
  lineage._resetLineageSessionForTesting()
  const bootAt = Date.now() - uptime() * 1000
  const beforeBoot = new Date(bootAt - 3_600_000).toISOString()
  const sinceBoot = new Date(Math.max(bootAt + 60_000, Date.now() - 60_000)).toISOString()
  const oldRow = (ordinal: number, sessionId: string, startedAt: string): string =>
    JSON.stringify({ ordinal, sessionId, startedAt, endedAt: null, engines: [{ model: 'proof-model', at: startedAt }], rulings: [], retained: [], corrected: [], files: [], outcome: null, handoff: null })
  mkdirSync(dirname(lineagePath(projectKey)), { recursive: true })
  appendFileSync(lineagePath(projectKey), `${oldRow(1, ids.oldDead, new Date(bootAt - 7_200_000).toISOString())}\n${oldRow(2, ids.oldRecent, new Date(bootAt + 30_000).toISOString())}\n`)
  writeTranscript(ids.oldDead, [user('u1', null, new Date(bootAt - 3_660_000).toISOString(), 'count'), assistantTool('a1', 'u1', beforeBoot)])
  writeTranscript(ids.oldRecent, [user('u1', null, new Date(Date.parse(sinceBoot) - 5_000).toISOString(), 'count'), assistantTool('a1', 'u1', sinceBoot)])
  check('the two older rows read as open rows without a pid', lastRowOf(ids.oldDead)?.pid === undefined && lastRowOf(ids.oldRecent)?.pid === undefined && ledger.readLedger(projectKey).length === 2)

  lineage.noteSessionEngine('proof-model')
  const dead = lastRowOf(ids.oldDead)
  const recent = lastRowOf(ids.oldRecent)
  check('the row whose transcript was cut before boot is reconciled (no process survives a boot)', dead?.outcome === 'interrupted' && dead?.endedAt === beforeBoot, JSON.stringify(dead))
  check('the row whose transcript was cut since boot stays open (it may be a live session of an older build)', recent?.endedAt === null && recent?.outcome === null && rowsOf().filter(r => r.sessionId === ids.oldRecent).length === 1, JSON.stringify(recent))
}

check('nothing was written outside the scratch home', existsSync(HOME) && lineagePath(projectKey).startsWith(HOME) && getTranscriptPathForSession(ids.killed).startsWith(HOME), `${lineagePath(projectKey)} · ${getTranscriptPathForSession(ids.killed)}`)
rmSync(HOME, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'lineage-interrupted: ALL LAWS HOLD' : `lineage-interrupted: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
