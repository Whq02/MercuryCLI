#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const j = (value: unknown): string => JSON.stringify(value)

const sweep = await import('../../src/daemon/processSweep.ts')
const verbs = await import('../../src/daemon/verbs.ts')
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
  check(`${culture}: it does not parse, and it is bound to its own bytes`, Number.isNaN(parseProcessStartToken(same)) && tokenBinding(same, same) === 'bound', `${parseProcessStartToken(same)} ${tokenBinding(same, same)}`)
  check(`${culture}: a second later, the day before and another year are each uncertain — never bound`, others.every(other => tokenBinding(same, other) === 'uncertain' && tokenBinding(other, same) === 'uncertain'), j(others.map(other => tokenBinding(same, other))))
}

console.log('S2 the instant: a process born at another moment is a stranger')
{
  check('the round-trip instant parses to its own millisecond, with seven, three or no fraction digits', parseProcessStartToken(INSTANT) === INSTANT_MS && parseProcessStartToken('2026-11-10T11:59:11.123Z') === INSTANT_MS && parseProcessStartToken('2026-11-10T11:59:11Z') === INSTANT_MS - 123, j([parseProcessStartToken(INSTANT), INSTANT_MS]))
  check('the same instant is bound', tokenBinding(INSTANT, INSTANT) === 'bound')
  check('one second later, the day before and another year are each a stranger (red on the candidate: uncertain)', ['2026-11-10T11:59:12.1234567Z', '2026-11-09T11:59:11.1234567Z', '2025-11-10T11:59:11.1234567Z'].every(other => tokenBinding(INSTANT, other) === 'stranger' && tokenBinding(other, INSTANT) === 'stranger'), j(['2026-11-10T11:59:12.1234567Z', '2026-11-09T11:59:11.1234567Z', '2025-11-10T11:59:11.1234567Z'].map(other => tokenBinding(INSTANT, other))))
  check('a record in the old words against a probe in the new form, and the reverse, is uncertain: mixed versions hold, they never part', tokenBinding(BOX, INSTANT) === 'uncertain' && tokenBinding(INSTANT, BOX) === 'uncertain')
  check('a missing or empty side is uncertain', tokenBinding(undefined, INSTANT) === 'uncertain' && tokenBinding(INSTANT, '') === 'uncertain' && tokenBinding(null, null) === 'uncertain')
  check('the ps form reads as before: bound to itself, a stranger one second apart', tokenBinding('Tue Nov 10 11:59:11 2026', 'Tue Nov 10 11:59:11 2026') === 'bound' && tokenBinding('Tue Nov 10 11:59:11 2026', 'Tue Nov 10 11:59:12 2026') === 'stranger' && Number.isFinite(parseProcessStartToken('Tue Nov 10 11:59:11 2026')))
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

const owner = await import('../../src/daemon/ownerWatch.ts')
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
  check('this process has a start token here, in the ps form', typeof plain === 'string' && Number.isFinite(parseProcessStartToken(plain ?? '')), String(plain))
  check('the probe answers the same with a recorded token in either form beside the pid, and the instant is that same token', watch.getProcessStartToken(process.pid, BOX) === plain && watch.getProcessStartToken(process.pid, INSTANT) === plain && watch.getProcessStartInstant(process.pid) === plain)
  check('…the awaited probe too', (await watch.getProcessStartTokenAsync(process.pid)) === plain && (await watch.getProcessStartTokenAsync(process.pid, INSTANT)) === plain && (await watch.getProcessStartInstantAsync(process.pid)) === plain)
  const batch = await watch.getProcessStartTokensAsync([{ pid: process.pid, procStart: INSTANT }])
  check('…and the batch and the cached read', batch.get(process.pid) === plain && watch.getProcessStartTokenCachedOrRefresh(process.pid, 10_000, INSTANT) === plain && watch.getProcessStartInstantCachedOrRefresh(process.pid) === plain, j([...batch]))
  check('no PowerShell was asked', asked().length === 0, j(asked()))
}

console.log("S4 on Windows the probe answers in the form the record holds: today's words for a record in today's bytes, the instant for a record in the new form (a stand-in pwsh.exe answers both)")
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const realPath = process.env.PATH
try {
  process.env.PATH = `${bin}${delimiter}${realPath ?? ''}`
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  check('with nothing recorded the probe answers in today\'s words, byte for byte what 1.0.8 records and compares', watch.getProcessStartToken(process.pid) === BOX && (await watch.getProcessStartTokenAsync(process.pid)) === BOX, j(watch.getProcessStartToken(process.pid)))
  check("a record in today's words is answered in today's words: its own process compares equal, another's text does not", watch.getProcessStartToken(process.pid, BOX) === BOX && watch.getProcessStartToken(process.pid, '9 November 2026 10:00:00') === BOX && (await watch.getProcessStartTokenAsync(process.pid, BOX)) === BOX)
  check('a record in the new form is answered with the instant: its own process compares equal, another instant does not', watch.getProcessStartToken(process.pid, INSTANT) === INSTANT && watch.getProcessStartToken(process.pid, '2026-11-09T08:00:00.0000000Z') === INSTANT && (await watch.getProcessStartTokenAsync(process.pid, INSTANT)) === INSTANT, j(watch.getProcessStartToken(process.pid, INSTANT)))
  check('a writer of the records the sweep binds asks for the instant', watch.getProcessStartInstant(process.pid) === INSTANT && (await watch.getProcessStartInstantAsync(process.pid)) === INSTANT)
  check('a pid that is gone answers empty in both forms, never a token and never unknown', watch.getProcessStartToken(GONE) === '' && watch.getProcessStartToken(GONE, INSTANT) === '' && (await watch.getProcessStartInstantAsync(GONE)) === '')
  const legacy = await watch.getProcessStartTokensAsync([{ pid: process.pid, procStart: BOX }], 0)
  const fresh = await watch.getProcessStartTokensAsync([{ pid: process.pid, procStart: INSTANT }], 0)
  check('the batch reads each pid in the form its recorded token has', legacy.get(process.pid) === BOX && fresh.get(process.pid) === INSTANT, j([[...legacy], [...fresh]]))
  watch.getProcessStartTokenCachedOrRefresh(process.pid, 60_000, INSTANT)
  watch.getProcessStartTokenCachedOrRefresh(process.pid, 60_000, BOX)
  await new Promise(resolve => setTimeout(resolve, 400))
  check('the cached read keeps the two forms apart', watch.getProcessStartTokenCachedOrRefresh(process.pid, 60_000, INSTANT) === INSTANT && watch.getProcessStartTokenCachedOrRefresh(process.pid, 60_000, BOX) === BOX && watch.getProcessStartTokenCachedOrRefresh(process.pid, 60_000) === BOX && watch.getProcessStartInstantCachedOrRefresh(process.pid, 60_000) === INSTANT)
  const singles = asked().filter(call => !call.batch)
  check('the stand-in was asked in both forms, and only the instant form names the round-trip format', singles.some(call => call.instant) && singles.some(call => !call.instant), j(asked().slice(0, 6)))
  writeFileSync(table, JSON.stringify({ broken: true }))
  check('a probe that cannot answer says unknown in either form, never a token: every reader then keeps what it holds', watch.getProcessStartToken(process.pid, BOX) === null && watch.getProcessStartToken(process.pid, INSTANT) === null && (await watch.getProcessStartTokenAsync(process.pid, INSTANT)) === null && watch.getProcessStartInstant(process.pid) === null, j([watch.getProcessStartToken(process.pid, BOX), watch.getProcessStartToken(process.pid, INSTANT)]))
} finally {
  Object.defineProperty(process, 'platform', realPlatform)
  process.env.PATH = realPath
}

console.log('S5 the lines Windows runs, as written')
{
  const probes = read('src/daemon/ownerWatch.ts')
  check("today's probe line is untouched (the bytes 1.0.8 records and compares raw: the daemon record, pid locks, service records, slots)", probes.includes('`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate`,') && probes.includes("($_.CreationDate | Out-String).Trim()"))
  check('the instant is the round-trip form in UTC, and a process that is not there prints nothing', probes.includes("`$d = (Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CreationDate; if ($d) { $d.ToUniversalTime().ToString('o') }`,") && probes.includes("instant: \"$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' })\","))
  const host = read('src/daemon/processSweepWindowsHost.ts')
  check("the sweep's table writes the same instant, no third rendering", host.includes("$token = $process.CreationDate.ToUniversalTime().ToString('o')") && !host.includes('"$($process.CreationDate)"'))
}

console.log('S6 who writes which form')
{
  const workers = read('src/daemon/concourseWorkers.ts')
  check("a session record's procStart is the instant; the sweep that ends a runner left without a host probes the runner twice in the form its record holds, and what is left of its tree by the instant it read at the ask", workers.includes('startToken = pid === undefined ? null : getProcessStartInstant(pid)') && workers.includes('getProcessStartInstantCachedOrRefresh(pid)') && (workers.match(/await getProcessStartInstantAsync\((?:claimed|reg)\.pid\)/g) ?? []).length === 3 && (workers.match(/getProcessStartInstantAsync\(/g) ?? []).length === 5 && workers.includes('const birth = await getProcessStartInstantAsync(member)') && workers.includes('tokenBinding(member.birth, await getProcessStartInstantAsync(member.pid))') && (workers.match(/getProcessStartToken(Async|CachedOrRefresh)?\(/g) ?? []).join('|') === 'getProcessStartTokenAsync(|getProcessStartTokenAsync(' && (workers.match(/getProcessStartTokenAsync\(pid, rec\.procStart\)/g) ?? []).length === 2)
  check("a window's registration is the instant", read('src/daemon/processSweepRun.ts').includes('startToken: await getProcessStartInstantAsync(process.pid),'))
  check("a launched task's ledger row is the instant, and its reader probes in the row's form", read('src/tasks/taskLaunchLedger.ts').includes('await getProcessStartInstantAsync(launch.pid)') && read('src/tasks/taskLaunchLedger.ts').includes('await getProcessStartTokenAsync(record.pid, record.startToken)'))
  check("a scratchpad's owner record is the instant", read('src/utils/scratchpad.ts').includes('getProcessStartInstantAsync(process.pid)'))
  const main = read('src/daemon/main.ts')
  check("the daemon record keeps startToken in today's bytes and carries the instant beside it", main.includes('const bootStartToken = await getProcessStartTokenAsync(process.pid)') && main.includes('startToken: bootStartToken,') && main.includes('...(bootStartInstant && bootStartInstant !== bootStartToken ? { startInstant: bootStartInstant } : {}),'))
  check("the daemon's own identity for the sweep's verbs is the instant", main.includes("tokenBinding(bootStartInstant, expected.startToken) !== 'bound'"))
  for (const [file, line] of [
    ['src/substrate/pidLock.ts', 'return getProcessStartTokenAsync(holder.pid, holder.procStart)'],
    ['src/substrate/pidLock.ts', 'getProcessStartTokenCachedOrRefresh(holder.pid, undefined, holder.procStart)'],
    ['src/utils/permissions/runtimeProtection.ts', 'await getProcessStartTokenAsync(state.pid, state.startToken)'],
    ['src/services/projectServices/serviceManager.ts', 'getProcessStartTokenCachedOrRefresh(pid, undefined, startToken)'],
    ['src/services/projectServices/serviceManager.ts', 'const live = owned ? null : await getProcessStartTokenAsync(record.pid, record.startToken)'],
    ['src/services/projectServices/serviceManager.ts', 'currentToken: stillOwned ? null : await getProcessStartTokenAsync(record.pid, record.startToken),'],
    ['src/services/providers/openaicompat/compatSlots.ts', 'getProcessStartTokenCachedOrRefresh(row.pid, undefined, row.start)'],
    ['src/services/tensorfold/adapter/serve.ts', '(io.startToken ?? getProcessStartTokenAsync)(stale.pid, stale.token)'],
    ['src/utils/pidAlive.ts', 'getProcessStartTokenCachedOrRefresh(pid, undefined, startToken)'],
    ['src/daemon/workerIdentity.ts', 'getProcessStartTokenCachedOrRefresh(rec.pid, undefined, rec.procStart)'],
  ] as Array<[string, string]>) {
    check(`${file} probes in the form its record holds`, read(file).includes(line), line)
  }
}

console.log('S7 the daemon record: one owner, exact in either form')
{
  const startedAt = Date.UTC(2026, 10, 10, 12, 0, 0)
  check("today's bytes: the same words are the recorded daemon, other words are not (the rule 1.0.8 applies, kept)", verbs.daemonRecordIdentity({ startedAt, startToken: BOX }, BOX) === 'same-process' && verbs.daemonRecordIdentity({ startedAt, startToken: BOX }, '9 November 2026 10:00:00') === 'not-recorded-process')
  check('a record with no token is judged by its own stamp against the instant: born before it is the daemon, born after it is not', verbs.daemonRecordIdentity({ startedAt, startToken: null }, INSTANT) === 'same-process' && verbs.daemonRecordIdentity({ startedAt, startToken: null }, '2026-11-10T12:00:06.0000000Z') === 'not-recorded-process' && verbs.daemonRecordIdentity({ startedAt }, null) === 'unknown')
  const main = read('src/daemon/main.ts')
  const reconcile = read('src/daemon/reconcileRecords.ts')
  check('both readers ask in the form the record holds, and for the instant when it holds none (a d.m.y text read as m.d.y can no longer call a live daemon recycled)', main.includes('daemonRecordIdentity(stale, stale.startToken ? getProcessStartToken(stale.pid, stale.startToken) : getProcessStartInstant(stale.pid))') && reconcile.includes('daemonRecordIdentity(sup, await (sup.startToken ? getProcessStartTokenAsync(sup.pid, sup.startToken) : getProcessStartInstantAsync(sup.pid)))'))
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
  check("a 1.0.9 record (today's words, and the instant beside them) is bound to its row: ownership read", ownership({ startToken: BOX, startInstant: INSTANT }) === true, j(ownership({ startToken: BOX, startInstant: INSTANT })))
  check("a 1.0.8 record (today's words alone) stays unread, as before: nothing is ended on it", ownership({ startToken: BOX }) === null && classifyMercuryProcess(composeProcessSweepFacts(tableOf, recordsOf({ startToken: BOX })).find(facts => facts.process.pid === 4001)!).classification !== 'stale')
  const strange = composeProcessSweepFacts(tableOf, recordsOf({ startToken: BOX, startInstant: '2026-11-09T08:00:00.0000000Z' })).find(facts => facts.process.pid === 4001)
  check("a record whose instant names another birth does not speak for the row: no owner, no home and no closure are read from it", strange !== undefined && strange.liveness.owner === null && strange.sameHome === null && strange.closed === null, j(strange))
}

console.log("S9 a pid lock's holder in either form: alive when the probe answers its own bytes or cannot answer, gone only when the probe answers another birth")
{
  const { holderAlive } = await import('../../src/substrate/pidLock.ts')
  const holder = (procStart: string): { owner: string; pid: number; acquiredAt: number; procStart: string } => ({ owner: 'start-token-forms', pid: process.pid, acquiredAt: Date.now(), procStart })
  check("a holder recorded in today's words", holderAlive(holder(BOX), 'assume-alive', BOX) && holderAlive(holder(BOX), 'assume-alive', null) && !holderAlive(holder(BOX), 'assume-alive', '9 November 2026 10:00:00') && !holderAlive(holder(BOX), 'assume-alive', ''))
  check('a holder recorded in the new form', holderAlive(holder(INSTANT), 'assume-alive', INSTANT) && holderAlive(holder(INSTANT), 'assume-alive', null) && !holderAlive(holder(INSTANT), 'assume-alive', '2026-11-09T08:00:00.0000000Z') && !holderAlive(holder(INSTANT), 'assume-alive', ''))
  const slots = read('src/services/providers/openaicompat/compatSlots.ts')
  const guard = read('src/utils/permissions/runtimeProtection.ts')
  check('a slot whose holder cannot be probed stays held, and the daemon stays protected when its probe cannot answer (both rules as they stood)', slots.includes('return token === null || token === row.start') && guard.includes('if (!state.startToken || token === null || token === state.startToken) pids.push(state.pid)'))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-start-token-forms: ALL LAWS HOLD' : `\nprove-start-token-forms: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
