#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
const j = (value: unknown): string => JSON.stringify(value)

const sweep = await import('../../src/daemon/process-sweep/processSweep.ts')
const verbs = await import('../../src/daemon/control/verbs.ts')
const { parseProcessStartToken, tokenBinding, composeProcessSweepFacts, classifyMercuryProcess } = sweep

const BOX = '10 November 2026 11:59:11'
const INSTANT = '2026-11-10T11:59:11.1234567Z'
const INSTANT_MS = Date.UTC(2026, 10, 10, 11, 59, 11, 123)

console.log("S1 a token in the machine's own date words binds to nothing but its own bytes (the box's row, FRC2W-U-59)")
for (const [culture, same, others] of [
  ['en-GB, the box', BOX, ['10 November 2026 11:59:12', '9 November 2026 10:00:00', '10 November 2025 11:58:08']],
  ['de-DE', '10.11.2026 11:59:11', ['10.11.2026 11:59:12', '09.11.2026 11:59:11', '10.11.2025 11:59:11']],
  ['en-US', 'Tuesday, November 10, 2026 11:59:11 AM', ['Tuesday, November 10, 2026 11:59:12 AM', 'Monday, November 9, 2026 11:59:11 AM', 'Monday, November 10, 2025 11:59:11 AM']],
  ['ja-JP', '2026年11月10日 11:59:11', ['2026年11月10日 11:59:12', '2026年11月9日 11:59:11', '2025年11月10日 11:59:11']],
] as Array<[string, string, string[]]>) {
  check(`${culture}: it does not parse, and it is bound to its own bytes`, Number.isNaN(parseProcessStartToken(same)) && tokenBinding(same, same) === 'bound', `${parseProcessStartToken(same)} ${tokenBinding(same, same)}`, 'fix parseProcessStartToken and tokenBinding in src/daemon/process-sweep/processSweep.ts: a token in locale date words must parse to NaN and bind only to its identical bytes')
  check(`${culture}: a second later, the day before and another year are each uncertain — never bound`, others.every(other => tokenBinding(same, other) === 'uncertain' && tokenBinding(other, same) === 'uncertain'), j(others.map(other => tokenBinding(same, other))), 'fix tokenBinding in src/daemon/process-sweep/processSweep.ts: two different locale date-word tokens must be uncertain, never bound or stranger')
}

console.log('S2 the instant: a process born at another moment is a stranger')
{
  check('the round-trip instant parses to its own millisecond, with seven, three or no fraction digits', parseProcessStartToken(INSTANT) === INSTANT_MS && parseProcessStartToken('2026-11-10T11:59:11.123Z') === INSTANT_MS && parseProcessStartToken('2026-11-10T11:59:11Z') === INSTANT_MS - 123, j([parseProcessStartToken(INSTANT), INSTANT_MS]), 'fix parseProcessStartToken in src/daemon/process-sweep/processSweep.ts: an ISO instant with seven, three or no fraction digits must parse to its own millisecond')
  check('the same instant is bound', tokenBinding(INSTANT, INSTANT) === 'bound', '', 'fix tokenBinding in src/daemon/process-sweep/processSweep.ts: identical ISO instants must be bound')
  check('one second later, the day before and another year are each a stranger (red on the candidate: uncertain)', ['2026-11-10T11:59:12.1234567Z', '2026-11-09T11:59:11.1234567Z', '2025-11-10T11:59:11.1234567Z'].every(other => tokenBinding(INSTANT, other) === 'stranger' && tokenBinding(other, INSTANT) === 'stranger'), j(['2026-11-10T11:59:12.1234567Z', '2026-11-09T11:59:11.1234567Z', '2025-11-10T11:59:11.1234567Z'].map(other => tokenBinding(INSTANT, other))), 'fix tokenBinding in src/daemon/process-sweep/processSweep.ts: two ISO instants that differ must be stranger, not uncertain')
  check('a record in the old words against a probe in the new form, and the reverse, is uncertain: mixed versions hold, they never part', tokenBinding(BOX, INSTANT) === 'uncertain' && tokenBinding(INSTANT, BOX) === 'uncertain', '', 'fix tokenBinding in src/daemon/process-sweep/processSweep.ts: a recorded token and an observed token in different forms must be uncertain')
  check('a missing or empty side is uncertain', tokenBinding(undefined, INSTANT) === 'uncertain' && tokenBinding(INSTANT, '') === 'uncertain' && tokenBinding(null, null) === 'uncertain', '', 'fix tokenBinding in src/daemon/process-sweep/processSweep.ts: a missing or empty side must be uncertain')
  check('the ps form reads as before: bound to itself, a stranger one second apart', tokenBinding('Tue Nov 10 11:59:11 2026', 'Tue Nov 10 11:59:11 2026') === 'bound' && tokenBinding('Tue Nov 10 11:59:11 2026', 'Tue Nov 10 11:59:12 2026') === 'stranger' && Number.isFinite(parseProcessStartToken('Tue Nov 10 11:59:11 2026')), '', 'fix parseProcessStartToken and tokenBinding in src/daemon/process-sweep/processSweep.ts: the ps lstart form must stay bound to itself and stranger one second apart')
}

const scratch = mkdtempSync(join(tmpdir(), 'start-token-forms-'))
const bin = join(scratch, 'bin')
mkdirSync(bin)
const table = join(scratch, 'table.json')
const calls = join(scratch, 'calls.log')
writeFileSync(calls, '')
writeFileSync(join(bin, 'pwsh.exe'), `#!/usr/bin/env bun
const { readFileSync, appendFileSync } = require('node:fs')
const rows = JSON.parse(readFileSync(${JSON.stringify(table)}, 'utf8'))
if (rows.broken) {
  process.stderr.write('Get-CimInstance : Access denied')
  process.exit(1)
}
const script = process.argv[process.argv.length - 1]
const pids = [...script.matchAll(/ProcessId=(\\d+)/g)].map(m => Number(m[1]))
const instant = script.includes("ToString('o')")
const batch = script.includes('ConvertTo-Json')
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ instant, batch, pids }) + '\\n')
if (batch) process.stdout.write(JSON.stringify(pids.filter(pid => rows[pid]).map(pid => ({ pid, token: instant ? rows[pid].instant : rows[pid].text }))))
else if (rows[pids[0]]) process.stdout.write(instant ? rows[pids[0]].instant + '\\r\\n' : '\\r\\n' + rows[pids[0]].text + '\\r\\n\\r\\n')
`)
chmodSync(join(bin, 'pwsh.exe'), 0o755)
const GONE = 2_147_000_000
writeFileSync(table, JSON.stringify({ [process.pid]: { text: BOX, instant: INSTANT } }))
const asked = (): Array<{ instant: boolean; batch: boolean; pids: number[] }> => readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))

const owner = await import('../../src/daemon/control/ownerWatch.ts')
const ABSENT = 'no such probe'
const watch = {
  ...owner,
  getProcessStartInstant: (pid: number): string | null => (typeof owner.getProcessStartInstant === 'function' ? owner.getProcessStartInstant(pid) : ABSENT),
  getProcessStartInstantAsync: async (pid: number): Promise<string | null> => (typeof owner.getProcessStartInstantAsync === 'function' ? owner.getProcessStartInstantAsync(pid) : ABSENT),
  getProcessStartInstantCachedOrRefresh: (pid: number, maxAgeMs?: number): string | null => (typeof owner.getProcessStartInstantCachedOrRefresh === 'function' ? owner.getProcessStartInstantCachedOrRefresh(pid, maxAgeMs) : ABSENT),
}

console.log('S3 off Windows the added argument changes no answer: one form there')
{
  const plain = watch.getProcessStartToken(process.pid)
  check('this process has a start token here, in the ps form', typeof plain === 'string' && Number.isFinite(parseProcessStartToken(plain ?? '')), String(plain), 'fix getProcessStartToken in src/daemon/control/ownerWatch.ts: off Windows it must return the ps-form token')
  check('the probe answers the same with a recorded token in either form beside the pid, and the instant is that same token', watch.getProcessStartToken(process.pid, BOX) === plain && watch.getProcessStartToken(process.pid, INSTANT) === plain && watch.getProcessStartInstant(process.pid) === plain, '', 'fix getProcessStartToken and getProcessStartInstant in src/daemon/control/ownerWatch.ts: off Windows the recorded-token argument must not change the answer')
  check('…the awaited probe too', (await watch.getProcessStartTokenAsync(process.pid)) === plain && (await watch.getProcessStartTokenAsync(process.pid, INSTANT)) === plain && (await watch.getProcessStartInstantAsync(process.pid)) === plain, '', 'fix getProcessStartTokenAsync and getProcessStartInstantAsync in src/daemon/control/ownerWatch.ts: off Windows they must answer the same ps-form token')
  const batch = await watch.getProcessStartTokensAsync([{ pid: process.pid, procStart: INSTANT }])
  check('…and the batch and the cached read', batch.get(process.pid) === plain && watch.getProcessStartTokenCachedOrRefresh(process.pid, 10_000, INSTANT) === plain && watch.getProcessStartInstantCachedOrRefresh(process.pid) === plain, j([...batch]), 'fix getProcessStartTokensAsync, getProcessStartTokenCachedOrRefresh and getProcessStartInstantCachedOrRefresh in src/daemon/control/ownerWatch.ts: off Windows they must answer the same ps-form token')
  check('no PowerShell was asked', asked().length === 0, j(asked()), 'src/daemon/control/ownerWatch.ts must not start PowerShell off Windows')
}

console.log("S4 on Windows the probe answers in the form the record holds: today's words for a record in today's bytes, the instant for a record in the new form (a stand-in pwsh.exe answers both)")
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const realPath = process.env.PATH
try {
  process.env.PATH = `${bin}${delimiter}${realPath ?? ''}`
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  check('with nothing recorded the probe answers in today\'s words, byte for byte what 1.0.8 records and compares', watch.getProcessStartToken(process.pid) === BOX && (await watch.getProcessStartTokenAsync(process.pid)) === BOX, j(watch.getProcessStartToken(process.pid)), 'fix getProcessStartToken and getProcessStartTokenAsync in src/daemon/control/ownerWatch.ts: on Windows with no recorded token they must answer in the date words')
  check("a record in today's words is answered in today's words: its own process compares equal, another's text does not", watch.getProcessStartToken(process.pid, BOX) === BOX && watch.getProcessStartToken(process.pid, '9 November 2026 10:00:00') === BOX && (await watch.getProcessStartTokenAsync(process.pid, BOX)) === BOX, '', 'fix getProcessStartToken and getProcessStartTokenAsync in src/daemon/control/ownerWatch.ts: on Windows a recorded token in date words must be answered in date words')
  check('a record in the new form is answered with the instant: its own process compares equal, another instant does not', watch.getProcessStartToken(process.pid, INSTANT) === INSTANT && watch.getProcessStartToken(process.pid, '2026-11-09T08:00:00.0000000Z') === INSTANT && (await watch.getProcessStartTokenAsync(process.pid, INSTANT)) === INSTANT, j(watch.getProcessStartToken(process.pid, INSTANT)), 'fix getProcessStartToken and getProcessStartTokenAsync in src/daemon/control/ownerWatch.ts: on Windows a recorded ISO instant must be answered with the instant')
  check('a writer of the records the sweep binds asks for the instant', watch.getProcessStartInstant(process.pid) === INSTANT && (await watch.getProcessStartInstantAsync(process.pid)) === INSTANT, '', 'fix getProcessStartInstant and getProcessStartInstantAsync in src/daemon/control/ownerWatch.ts: on Windows they must answer the ISO instant')
  check('a pid that is gone answers empty in both forms, never a token and never unknown', watch.getProcessStartToken(GONE) === '' && watch.getProcessStartToken(GONE, INSTANT) === '' && (await watch.getProcessStartInstantAsync(GONE)) === '', '', 'fix the getProcessStart* readers in src/daemon/control/ownerWatch.ts: on Windows a pid that is gone must answer an empty string in both forms')
  const legacy = await watch.getProcessStartTokensAsync([{ pid: process.pid, procStart: BOX }], 0)
  const fresh = await watch.getProcessStartTokensAsync([{ pid: process.pid, procStart: INSTANT }], 0)
  check('the batch reads each pid in the form its recorded token has', legacy.get(process.pid) === BOX && fresh.get(process.pid) === INSTANT, j([[...legacy], [...fresh]]), 'fix getProcessStartTokensAsync in src/daemon/control/ownerWatch.ts: each pid must be read in the form of its recorded procStart')
  watch.getProcessStartTokenCachedOrRefresh(process.pid, 60_000, INSTANT)
  watch.getProcessStartTokenCachedOrRefresh(process.pid, 60_000, BOX)
  await new Promise(resolve => setTimeout(resolve, 400))
  check('the cached read keeps the two forms apart', watch.getProcessStartTokenCachedOrRefresh(process.pid, 60_000, INSTANT) === INSTANT && watch.getProcessStartTokenCachedOrRefresh(process.pid, 60_000, BOX) === BOX && watch.getProcessStartTokenCachedOrRefresh(process.pid, 60_000) === BOX && watch.getProcessStartInstantCachedOrRefresh(process.pid, 60_000) === INSTANT, '', 'fix getProcessStartTokenCachedOrRefresh in src/daemon/control/ownerWatch.ts: its cache must key the date-words and instant forms apart')
  const singles = asked().filter(call => !call.batch)
  check('the stand-in was asked in both forms, and only the instant form names the round-trip format', singles.some(call => call.instant) && singles.some(call => !call.instant), j(asked().slice(0, 6)), 'src/daemon/control/ownerWatch.ts must run the Windows probe in the instant form for an instant record and in the date-words form otherwise')
  writeFileSync(table, JSON.stringify({ broken: true }))
  check('a probe that cannot answer says unknown in either form, never a token: every reader then keeps what it holds', watch.getProcessStartToken(process.pid, BOX) === null && watch.getProcessStartToken(process.pid, INSTANT) === null && (await watch.getProcessStartTokenAsync(process.pid, INSTANT)) === null && watch.getProcessStartInstant(process.pid) === null, j([watch.getProcessStartToken(process.pid, BOX), watch.getProcessStartToken(process.pid, INSTANT)]), 'fix the getProcessStart* readers in src/daemon/control/ownerWatch.ts: when the Windows probe fails they must answer null in either form')
} finally {
  Object.defineProperty(process, 'platform', realPlatform)
  process.env.PATH = realPath
}



console.log('S7 the daemon record: one owner, exact in either form')
{
  const startedAt = Date.UTC(2026, 10, 10, 12, 0, 0)
  check("today's bytes: the same words are the recorded daemon, other words are not (the rule 1.0.8 applies, kept)", verbs.daemonRecordIdentity({ startedAt, startToken: BOX }, BOX) === 'same-process' && verbs.daemonRecordIdentity({ startedAt, startToken: BOX }, '9 November 2026 10:00:00') === 'not-recorded-process', '', 'fix daemonRecordIdentity in src/daemon/control/verbs.ts: equal date-word tokens are same-process, different ones not-recorded-process')
  check('a record with no token is judged by its own stamp against the instant: born before it is the daemon, born after it is not', verbs.daemonRecordIdentity({ startedAt, startToken: null }, INSTANT) === 'same-process' && verbs.daemonRecordIdentity({ startedAt, startToken: null }, '2026-11-10T12:00:06.0000000Z') === 'not-recorded-process' && verbs.daemonRecordIdentity({ startedAt }, null) === 'unknown', '', 'fix daemonRecordIdentity in src/daemon/control/verbs.ts: a record with no token is judged by its startedAt against the observed instant, and unknown when nothing is observed')
}

console.log("S8 the sweep binds a daemon's row through the instant its record carries")
{
  const NOW = Date.UTC(2026, 10, 10, 13, 0, 0)
  const row = (pid: number, ppid: number, args: string[]): never => ({ process: { pid, ppid, exe: 'node.exe', args, startedAtMs: INSTANT_MS, user: 'S-1-5-21-1', terminal: null }, startToken: INSTANT, state: 'S', terminalAlive: null }) as never
  const tableOf = { observations: [row(4001, 1, ['C:\\mercury\\mercury.mjs', 'daemon', 'run', 'C:\\work'])], complete: true } as never
  const recordsOf = (daemon: Record<string, unknown>): never => ({
    nowMs: NOW, platform: 'win32', selfPid: 9999, user: 'S-1-5-21-1', configHome: 'C:\\home', drainMs: 600_000, heartbeatAllowanceMs: 90_000,
    planes: [{ daemonDir: 'C:\\home\\daemon', daemon: { pid: 4001, ownerPid: 3002, persist: false, startedAt: NOW - 3_600_000, ...daemon }, daemonReadable: true, answer: null, runners: [] }],
    registrations: [], memory: null,
  }) as never
  const ownership = (daemon: Record<string, unknown>): unknown => composeProcessSweepFacts(tableOf, recordsOf(daemon)).find(facts => facts.process.pid === 4001)?.ownership
  check("a 1.0.9 record (today's words, and the instant beside them) is bound to its row: ownership read", ownership({ startToken: BOX, startInstant: INSTANT }) === true, j(ownership({ startToken: BOX, startInstant: INSTANT })), 'fix composeProcessSweepFacts in src/daemon/process-sweep/processSweep.ts: a daemon record carrying startInstant must bind to the row and give ownership true')
  check("a 1.0.8 record (today's words alone) stays unread, as before: nothing is ended on it", ownership({ startToken: BOX }) === null && classifyMercuryProcess(composeProcessSweepFacts(tableOf, recordsOf({ startToken: BOX })).find(facts => facts.process.pid === 4001)!).classification !== 'stale', '', 'fix composeProcessSweepFacts and classifyMercuryProcess in src/daemon/process-sweep/processSweep.ts: a record with only startToken must leave ownership null and the row not stale')
  const strange = composeProcessSweepFacts(tableOf, recordsOf({ startToken: BOX, startInstant: '2026-11-09T08:00:00.0000000Z' })).find(facts => facts.process.pid === 4001)
  check("a record whose instant names another birth does not speak for the row: no owner, no home and no closure are read from it", strange !== undefined && strange.liveness.owner === null && strange.sameHome === null && strange.closed === null, j(strange), 'fix composeProcessSweepFacts in src/daemon/process-sweep/processSweep.ts: a record whose startInstant names another birth must give owner, home and closure null')
}

console.log("S9 a pid lock's holder in either form: alive when the probe answers its own bytes or cannot answer, gone only when the probe answers another birth")
{
  const { holderAlive } = await import('../../src/platform/substrate/pidLock.ts')
  const holder = (procStart: string): { owner: string; pid: number; acquiredAt: number; procStart: string } => ({ owner: 'start-token-forms', pid: process.pid, acquiredAt: Date.now(), procStart })
  check("a holder recorded in today's words", holderAlive(holder(BOX), 'assume-alive', BOX) && holderAlive(holder(BOX), 'assume-alive', null) && !holderAlive(holder(BOX), 'assume-alive', '9 November 2026 10:00:00') && !holderAlive(holder(BOX), 'assume-alive', ''), '', 'fix holderAlive in src/platform/substrate/pidLock.ts: alive when the probe answers the same bytes or null, gone when it answers another birth or empty')
  check('a holder recorded in the new form', holderAlive(holder(INSTANT), 'assume-alive', INSTANT) && holderAlive(holder(INSTANT), 'assume-alive', null) && !holderAlive(holder(INSTANT), 'assume-alive', '2026-11-09T08:00:00.0000000Z') && !holderAlive(holder(INSTANT), 'assume-alive', ''), '', 'fix holderAlive in src/platform/substrate/pidLock.ts: for an ISO instant holder, alive when the probe answers the same instant or null, gone when it answers another or empty')
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-start-token-forms: ALL LAWS HOLD' : `\nprove-start-token-forms: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
