#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const owner = join(import.meta.dir, '../../src/daemon/processSweep.ts')
const posix = join(import.meta.dir, '../../src/daemon/processSweepPosix.ts')
assert.ok(existsSync(owner) && existsSync(posix), 'Mercury composes process facts from its own records and one POSIX table reader')
const { composeProcessSweepFacts, classifyMercuryProcess, readProcessSweepCensus, processSweepCounts, PROCESS_SWEEP_WORDS, processNamesMercury, tokenBinding }: typeof import('../../src/daemon/processSweep.ts') = await import(owner)
const { parsePosixProcessTable, parseProcessStartToken, parsePidColumn, probePosixTerminal, collectPosixProcessTable }: typeof import('../../src/daemon/processSweepPosix.ts') = await import(posix)
const { doctorProcessesReport }: typeof import('../../src/cli/doctorProcesses.ts') = await import(join(import.meta.dir, '../../src/cli/doctorProcesses.ts'))
import type { ProcessSweepObservation, ProcessSweepRecords, ProcessSweepTable } from '../../src/daemon/processSweep.ts'

let checks = 0
const check = (label: string, run: () => void | Promise<void>): Promise<void> => Promise.resolve(run()).then(() => {
  checks++
  console.log(`[PASS] ${label}`)
})

const NOW = Date.parse('2026-09-20T10:30:00.000Z')
const born = (iso: string): number => Date.parse(iso)
const tokenOf = (ms: number): string => {
  const date = new Date(ms)
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()]
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()]
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${day} ${String(date.getDate()).padStart(2, ' ')} ${month} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())} ${date.getFullYear()}`
}

await check('the birth token parses in the C and the en_GB spellings and refuses garbage', () => {
  const c = parseProcessStartToken('Sun Sep 20 04:14:19 2026')
  const gb = parseProcessStartToken('Sun 20 Sep 04:14:19 2026')
  assert.equal(c, gb)
  assert.ok(Number.isFinite(c) && c > 0)
  assert.ok(Number.isNaN(parseProcessStartToken('garbage')))
  assert.ok(Number.isNaN(parseProcessStartToken('')))
})

await check('two spellings of one birth bind; two births are strangers; a spelling that cannot be read is uncertain, never a stranger', () => {
  assert.equal(tokenBinding('Sun Sep 20 04:14:19 2026', 'Sun 20 Sep 04:14:19 2026'), 'bound')
  assert.equal(tokenBinding('Sun 20 Sep 04:14:19 2026', 'Sun 20 Sep 04:14:19 2026'), 'bound')
  assert.equal(tokenBinding('Sun 20 Sep 04:14:19 2026', 'Sun 20 Sep 04:14:20 2026'), 'stranger')
  assert.equal(tokenBinding('So. 20 Sep. 04:14:19 2026', 'Sun 20 Sep 04:14:19 2026'), 'uncertain')
  assert.equal(tokenBinding('dim. 20 sept. 04:14:19 2026', 'Sun 20 Sep 04:14:19 2026'), 'uncertain')
  assert.equal(tokenBinding(null, 'Sun 20 Sep 04:14:19 2026'), 'uncertain')
  assert.equal(tokenBinding('   ', 'Sun 20 Sep 04:14:19 2026'), 'uncertain')
})

const darwinTable = [
  '    1     0     0 ??       Ss   Tue  1 Sep 20:57:05 2026',
  ' 3001  3000   501 ttys003  Ss   Sun 20 Sep 09:00:00 2026',
  ' 3002  3001   501 ttys003  S+   Sun 20 Sep 09:01:00 2026',
  ' 4001     1   501 ??       Ss   Sun 20 Sep 09:02:00 2026',
  ' 4002  4001   501 ??       S    Sun 20 Sep 09:03:00 2026',
  ' 4003  4001   501 ??       T    Sun 20 Sep 09:04:00 2026',
  ' 5001     1   501 ttys007  Ts+  Sun 20 Sep 08:00:00 2026',
  ' 6001     1   501 ??       Ss   Sun 20 Sep 07:00:00 2026',
  ' 7001  7000   502 ttys009  S+   Sun 20 Sep 09:05:00 2026',
  ' 8001     1   501 ttys005  Us+  Wed 16 Sep 21:52:47 2026',
  ' 9001     1   501 ??       S    Sun 20 Sep 09:06:00 2026',
].join('\n')

await check('the darwin table parses pids, users, terminals, states and verbatim birth tokens', () => {
  const table = parsePosixProcessTable(darwinTable)
  assert.equal(table.complete, true)
  assert.equal(table.observations.length, 11)
  const window = table.observations.find(row => row.process.pid === 3002)!
  assert.equal(window.process.terminal, 'ttys003')
  assert.equal(window.startToken, 'Sun 20 Sep 09:01:00 2026')
  assert.equal(window.process.user, '501')
  assert.equal(window.state, 'S+')
  const launchd = table.observations[0]!
  assert.equal(launchd.process.terminal, null)
  assert.equal(launchd.terminalAlive, false)
  assert.equal(launchd.startToken, 'Tue  1 Sep 20:57:05 2026')
})

await check('a linux table with pts terminals and D states parses the same way', () => {
  const table = parsePosixProcessTable([
    '    1     0     0 ?        Ss   Sun Sep 20 09:00:00 2026',
    ' 2001  2000  1000 pts/3    Ss   Sun Sep 20 09:00:10 2026',
    ' 2002  2001  1000 pts/3    Sl+  Sun Sep 20 09:00:20 2026',
    ' 2003     1  1000 ?        D    Sun Sep 20 09:00:30 2026',
  ].join('\n'))
  assert.equal(table.complete, true)
  assert.equal(table.observations[1]!.process.terminal, 'pts/3')
  assert.equal(table.observations[3]!.state, 'D')
  assert.equal(table.observations[3]!.process.startedAtMs, parseProcessStartToken('Sun Sep 20 09:00:30 2026'))
})

await check('an unreadable row makes the table incomplete instead of a shorter success', () => {
  const table = parsePosixProcessTable(`${darwinTable}\nnot a process row`)
  assert.equal(table.complete, false)
  assert.match(table.error ?? '', /unreadable row/)
})

await check('the pid column parser keeps the whole command line', () => {
  const args = parsePidColumn(' 3002 /opt/mercury/vendor/node/bin/node /opt/mercury/dist/mercury.mjs --resume abc\n 4001 mercury\n')
  assert.equal(args.get(3002), '/opt/mercury/vendor/node/bin/node /opt/mercury/dist/mercury.mjs --resume abc')
  assert.equal(args.get(4001), 'mercury')
})

await check('Mercury naming reads the launcher, the bundle and the title, never an unrelated program', () => {
  assert.equal(processNamesMercury(['/opt/mercury/dist/mercury.mjs']), true)
  assert.equal(processNamesMercury(['mercury']), true)
  assert.equal(processNamesMercury(['/Users/x/.local/bin/mercury', '--resume']), true)
  assert.equal(processNamesMercury(['/usr/bin/vim', 'mercury-notes.md']), false)
  assert.equal(processNamesMercury(['node', 'other.mjs']), false)
})

await check('the terminal probe reads another live session leader as alive, a missing node as gone, a self-led node as unknown unless its output is fresh, and never opens the device', () => {
  const table = parsePosixProcessTable(darwinTable).observations
  assert.equal(probePosixTerminal('ttys003', 3002, table), true)
  assert.equal(probePosixTerminal('ttys999', 5001, table), false)
  assert.equal(probePosixTerminal('../etc/passwd', 5001, table), null)
  const source = require('node:fs').readFileSync(posix, 'utf8') as string
  assert.ok(/nowMs - node\.mtimeMs <= freshMs \? true : null/.test(source), 'a self-led terminal is alive only by fresh output through it, otherwise unknown — never gone by the absence of a shell')
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  for (const file of [owner, posix, join(import.meta.dir, '../../src/daemon/processSweepRun.ts')]) {
    const source = readFileSync(file, 'utf8')
    assert.ok(!/openSync\(/.test(source) && !/O_NOCTTY/.test(source) && !/\/dev\/tty/.test(source) && !/\bopen\(\s*['"`]?\/dev/.test(source), `${file} never opens a terminal device: an open of a dead pty is itself an uninterruptible kernel wait on macOS`)
  }
  assert.ok(/statSync\(`\/dev\/\$\{terminal\}`\)/.test(readFileSync(posix, 'utf8')), 'stat of the node is the most the probe touches')
})

await check('the collector tolerates a ps that exits non-zero on a vanished pid and keeps the table', async () => {
  const calls: string[][] = []
  const table = await collectPosixProcessTable({
    waitMs: 500,
    recordedPids: [4001],
    ps: async args => {
      calls.push([...args])
      if (args.includes('pid=,ppid=,uid=,tty=,stat=,lstart=')) return darwinTable
      if (args.includes('pid=,args=')) return ' 3002 /opt/mercury/vendor/node/bin/node /opt/mercury/dist/mercury.mjs\n 4001 mercury\n 4002 mercury\n 8001 mercury\n 7001 mercury\n 6001 /usr/bin/mercury-other\n'
      if (args.includes('pid=,ucomm=')) return ' 3002 node\n 4001 node\n 4002 node\n 8001 node\n 7001 node\n 6001 mercury-other\n'
      throw new Error('unexpected ps call')
    },
    probeTerminal: () => null,
  })
  assert.equal(table.complete, true)
  assert.equal(calls.length, 3)
  assert.equal(table.observations.find(row => row.process.pid === 3002)!.process.exe, 'node')
  assert.equal(table.observations.find(row => row.process.pid === 6001)!.process.exe, '')
  assert.deepEqual(table.observations.find(row => row.process.pid === 4001)!.process.args, ['mercury'])
})

await check('a ps that cannot run yields an incomplete table naming the failure', async () => {
  const table = await collectPosixProcessTable({ waitMs: 500, recordedPids: [], ps: async () => { throw Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' }) } })
  assert.equal(table.complete, false)
  assert.match(table.error ?? '', /could not be read/)
  assert.equal(table.observations.length, 0)
})

await check('a ps that answers no rows is an incomplete table, never an empty success, and prunes no registration', async () => {
  const empty = await collectPosixProcessTable({ waitMs: 500, recordedPids: [4001], ps: async () => '' })
  assert.equal(empty.complete, false)
  assert.match(empty.error ?? '', /no rows/)
  const source = (require('node:fs') as typeof import('node:fs')).readFileSync(posix, 'utf8')
  assert.ok(/!args\.includes\('-p'\) \|\| failed\.code === 'ENOENT'/.test(source), 'only the named-pid read tolerates a non-zero exit; a failed whole-table read rejects')
  const runSource = (require('node:fs') as typeof import('node:fs')).readFileSync(join(import.meta.dir, '../../src/daemon/processSweepRun.ts'), 'utf8')
  assert.ok(/async function pruneDeadRegistrations[\s\S]*?if \(!table\.complete\) return/.test(runSource), 'an incomplete table prunes nothing')
})

function world(): { table: ProcessSweepTable; records: ProcessSweepRecords } {
  const table = parsePosixProcessTable(darwinTable)
  const args: Record<number, string[]> = {
    3002: ['/opt/mercury/vendor/node/bin/node', '/opt/mercury/dist/mercury.mjs'],
    4001: ['/opt/mercury/vendor/node/bin/node', '/opt/mercury/dist/mercury.mjs', 'daemon', 'run', '/work'],
    4002: ['mercury'],
    4003: ['mercury'],
    5001: ['mercury'],
    6001: ['/opt/mercury/vendor/node/bin/node', '/opt/mercury/dist/mercury.mjs', 'daemon', 'run', '/elsewhere'],
    7001: ['mercury'],
    8001: ['mercury'],
    9001: ['mercury'],
  }
  const terminals: Record<number, boolean | null> = { 3001: true, 3002: true, 5001: false, 7001: true, 8001: null }
  for (const row of table.observations) {
    row.process.args = args[row.process.pid] ?? [row.process.pid === 3001 ? '/bin/zsh' : '/usr/libexec/other']
    row.process.exe = row.process.pid in args ? 'node' : row.process.pid === 3001 ? 'zsh' : 'other'
    if (row.process.terminal !== null) row.terminalAlive = terminals[row.process.pid] ?? null
  }
  const tokenFor = (pid: number): string => table.observations.find(row => row.process.pid === pid)!.startToken!
  const records: ProcessSweepRecords = {
    nowMs: NOW,
    platform: 'darwin',
    selfPid: 9999,
    user: '501',
    configHome: '/home/one',
    drainMs: 600_000,
    heartbeatAllowanceMs: 90_000,
    planes: [{
      daemonDir: '/home/one/daemon',
      supervisor: { pid: 4001, startToken: tokenFor(4001), ownerPid: 3002, persist: false, startedAt: born('2026-09-20T09:02:00+01:00') },
      supervisorReadable: true,
      answer: { pid: 4001, ownerPid: 3002, live: 1, liveSessions: 1, persist: false, runners: [
        { pid: 4002, procStart: tokenFor(4002), endedAt: undefined, stoppedAt: undefined, attachedBy: 'operator:3002', focusedBy: undefined, schedules: 0, activity: 'idle', warm: false },
        { pid: 4003, procStart: tokenFor(4003), endedAt: NOW - 1_200_000, stoppedAt: undefined, attachedBy: undefined, focusedBy: undefined, schedules: 0, activity: undefined, warm: false },
        { pid: 9001, procStart: tokenFor(9001), endedAt: undefined, stoppedAt: undefined, attachedBy: undefined, focusedBy: undefined, schedules: 0, activity: undefined, warm: true },
      ] },
      runners: null,
    }],
    registrations: [
      { id: 'reg-live', pid: 3002, startToken: tokenFor(3002), configHome: '/home/one', daemonDir: '/home/one/daemon', terminal: 'ttys003', bornAt: NOW - 3_600_000, heartbeatAt: NOW - 5_000 },
      { id: 'reg-dead', pid: 5001, startToken: tokenFor(5001), configHome: '/home/one', daemonDir: '/home/one/daemon', terminal: 'ttys007', bornAt: NOW - 7_200_000, heartbeatAt: NOW - 3_600_000 },
    ],
    memory: null,
  }
  return { table, records }
}

const classes = (table: ProcessSweepTable, records: ProcessSweepRecords): Map<number, { classification: string; reason: string; kind: string }> => {
  const out = new Map<number, { classification: string; reason: string; kind: string }>()
  for (const facts of composeProcessSweepFacts(table, records)) {
    const entry = classifyMercuryProcess(facts)
    out.set(entry.process.pid, { classification: entry.classification, reason: entry.reason, kind: entry.kind })
  }
  return out
}

await check('the recorded darwin world classifies the live window, daemon and runner as running by their own facts', () => {
  const { table, records } = world()
  const got = classes(table, records)
  assert.equal(got.get(3002)!.classification, 'running')
  assert.match(got.get(3002)!.reason, /terminal|registration/)
  assert.equal(got.get(3002)!.kind, 'window')
  assert.equal(got.get(4001)!.classification, 'running')
  assert.match(got.get(4001)!.reason, /owner/)
  assert.equal(got.get(4002)!.classification, 'running')
  assert.match(got.get(4002)!.reason, /session/)
  assert.equal(got.get(9001)!.classification, 'running')
  assert.match(got.get(9001)!.reason, /persistence/)
})

await check('the released runner and the dead-heartbeat window read stale; the shell and the other program are never listed', () => {
  const { table, records } = world()
  const got = classes(table, records)
  assert.equal(got.get(4003)!.classification, 'stale')
  assert.equal(got.get(4003)!.kind, 'runner')
  assert.equal(got.get(5001)!.classification, 'stale')
  assert.equal(got.get(5001)!.kind, 'window')
  assert.match(got.get(5001)!.reason, /heartbeat expired/)
  assert.equal(got.has(3001), false)
  assert.equal(got.has(1), false)
})

await check('another user\'s Mercury is not ours; a title-only process without a record cannot be ended and its kernel wait is named', () => {
  const { table, records } = world()
  const got = classes(table, records)
  assert.equal(got.get(7001)!.classification, 'not-ours')
  assert.equal(got.get(8001)!.classification, 'cannot-end')
  assert.match(got.get(8001)!.reason, /bundle identity/)
  assert.match(got.get(8001)!.reason, /kernel wait now \(state U\)/)
})

await check('a bundle-named daemon of a plane this reader holds no records for cannot be ended', () => {
  const { table, records } = world()
  const got = classes(table, records)
  assert.equal(got.get(6001)!.classification, 'cannot-end')
  assert.match(got.get(6001)!.reason, /config home/)
})

await check('a live cockpit on the plane protects an owner-gone daemon; without one it waits for the drain allowance, then reads stale once its first sighting is old enough', () => {
  const guarded = world()
  const protectedRecords = { ...guarded.records, planes: [{ ...guarded.records.planes[0]!, supervisor: { ...guarded.records.planes[0]!.supervisor!, ownerPid: 3999 }, answer: { ...guarded.records.planes[0]!.answer!, ownerPid: 3999, live: 0, liveSessions: 0, runners: [] } }] }
  assert.match(classes(guarded.table, protectedRecords).get(4001)!.reason, /registration/)
  const { table, records } = world()
  const gone = { ...records, registrations: [records.registrations![1]!], planes: [{ ...records.planes[0]!, supervisor: { ...records.planes[0]!.supervisor!, ownerPid: 3999 }, answer: { ...records.planes[0]!.answer!, ownerPid: 3999, live: 0, liveSessions: 0, runners: [] } }] }
  const first = readProcessSweepCensus(table, gone)
  const daemon = first.entries.find(entry => entry.process.pid === 4001)!
  assert.equal(daemon.classification, 'running')
  assert.match(daemon.reason, /waiting/)
  const key = Object.keys(first.memory)[0]!
  assert.equal(first.memory[key], NOW)
  const later = readProcessSweepCensus(table, { ...gone, nowMs: NOW + 600_001, memory: first.memory })
  assert.equal(later.entries.find(entry => entry.process.pid === 4001)!.classification, 'stale')
  assert.equal(later.memory[key], NOW)
})

await check('an explicit daemon and a persistent daemon stay running even with their owner gone', () => {
  const { table, records } = world()
  for (const shape of [{ ownerPid: null, persist: false }, { ownerPid: 3999, persist: true }]) {
    const variant = { ...records, registrations: [records.registrations![1]!], planes: [{ ...records.planes[0]!, supervisor: { ...records.planes[0]!.supervisor!, ...shape }, answer: { ...records.planes[0]!.answer!, ownerPid: shape.ownerPid, persist: shape.persist, live: 0, liveSessions: 0, runners: [] } }], memory: { [`daemon:4001:${table.observations.find(row => row.process.pid === 4001)!.startToken}`]: NOW - 700_000 } }
    const got = classes(table, variant)
    assert.equal(got.get(4001)!.classification, 'running')
    assert.match(got.get(4001)!.reason, /persistence/)
  }
})

await check('a daemon record without the persistence fact cannot be ended', () => {
  const { table, records } = world()
  const variant = { ...records, registrations: [records.registrations![1]!], planes: [{ ...records.planes[0]!, supervisor: { ...records.planes[0]!.supervisor!, ownerPid: 3999, persist: undefined }, answer: null, runners: [] }], memory: { [`daemon:4001:${table.observations.find(row => row.process.pid === 4001)!.startToken}`]: NOW - 700_000 } }
  const got = classes(table, variant)
  assert.equal(got.get(4001)!.classification, 'cannot-end')
  assert.match(got.get(4001)!.reason, /could not be read/)
})

await check('a recycled pid never inherits a record: the stranger is judged on its own', () => {
  const { table, records } = world()
  const variant = { ...records, registrations: [{ ...records.registrations![1]!, startToken: 'Sun 20 Sep 01:00:00 2026' }, records.registrations![0]!] }
  const got = classes(table, variant)
  assert.equal(got.get(5001)!.classification, 'cannot-end')
  assert.match(got.get(5001)!.reason, /bundle identity/)
})

await check('a registration written under another locale still binds its own window, and one written in an unreadable locale is uncertain, not a stranger', () => {
  const { table, records } = world()
  const spelled = tokenOf(table.observations.find(row => row.process.pid === 3002)!.process.startedAtMs).replace(/^(\w+) +(\d+) (\w+) /, '$1 $3 $2 ')
  assert.notEqual(spelled, table.observations.find(row => row.process.pid === 3002)!.startToken)
  const other = { ...records, registrations: [{ ...records.registrations![0]!, startToken: spelled }, records.registrations![1]!] }
  assert.equal(classes(table, other).get(3002)!.classification, 'running')
  const unreadable = { ...records, registrations: [{ ...records.registrations![0]!, startToken: 'So. 20 Sep. 09:01:00 2026' }, records.registrations![1]!] }
  assert.match(classes(table, unreadable).get(3002)!.reason, /in use: terminal/)
  table.observations.find(row => row.process.pid === 3002)!.terminalAlive = null
  const silent = { ...records, registrations: [{ ...records.registrations![0]!, startToken: 'So. 20 Sep. 09:01:00 2026', heartbeatAt: NOW - 3_600_000 }, records.registrations![1]!] }
  assert.equal(classes(table, silent).get(3002)!.classification, 'cannot-end')
})

await check('a registration from another config home is left alone as running', () => {
  const { table, records } = world()
  const variant = { ...records, registrations: [records.registrations![0]!, { ...records.registrations![1]!, configHome: '/home/two' }] }
  const got = classes(table, variant)
  assert.equal(got.get(5001)!.classification, 'running')
  assert.match(got.get(5001)!.reason, /another config home/)
})

await check('a window whose terminal still has a live shell is running even with an expired heartbeat', () => {
  const { table, records } = world()
  const variant = { ...records, registrations: [{ ...records.registrations![0]!, heartbeatAt: NOW - 3_600_000 }, records.registrations![1]!] }
  const got = classes(table, variant)
  assert.equal(got.get(3002)!.classification, 'running')
  assert.match(got.get(3002)!.reason, /terminal/)
})

await check('a self-led window whose terminal cannot be read is never stale, however old its heartbeat', () => {
  const { table, records } = world()
  table.observations.find(row => row.process.pid === 5001)!.terminalAlive = null
  const got = classes(table, records)
  assert.equal(got.get(5001)!.classification, 'cannot-end')
  assert.match(got.get(5001)!.reason, /terminal/)
})

await check('a registered window whose tty the table no longer names is gone once its heartbeat expired', () => {
  const { table, records } = world()
  const row = table.observations.find(row => row.process.pid === 5001)!
  row.process.terminal = null
  row.terminalAlive = false
  const got = classes(table, records)
  assert.equal(got.get(5001)!.classification, 'stale')
  assert.match(got.get(5001)!.reason, /terminal is gone/)
})

await check('a released runner still held by a live seat, a scheduled one, and one whose daemon reads it working stay running', () => {
  const { table, records } = world()
  const runners = records.planes[0]!.answer!.runners!
  const held = { ...records, planes: [{ ...records.planes[0]!, answer: { ...records.planes[0]!.answer!, runners: runners.map(runner => (runner.pid === 4003 ? { ...runner, attachedBy: 'operator:3002' } : runner)) } }] }
  assert.equal(classes(table, held).get(4003)!.classification, 'running')
  const scheduled = { ...records, planes: [{ ...records.planes[0]!, answer: { ...records.planes[0]!.answer!, runners: runners.map(runner => (runner.pid === 4003 ? { ...runner, schedules: 1 } : runner)) } }] }
  assert.equal(classes(table, scheduled).get(4003)!.classification, 'running')
  const fresh = { ...records, planes: [{ ...records.planes[0]!, answer: { ...records.planes[0]!.answer!, runners: runners.map(runner => (runner.pid === 4003 ? { ...runner, endedAt: NOW - 1_000 } : runner)) } }] }
  assert.match(classes(table, fresh).get(4003)!.reason, /waiting/)
})

await check('the reading process itself is running, and the roster file stands in when the daemon does not answer', () => {
  const { table, records } = world()
  const self = { ...records, selfPid: 3002 }
  assert.match(classes(table, self).get(3002)!.reason, /reading the processes/)
  const silent = { ...records, planes: [{ ...records.planes[0]!, answer: null, runners: records.planes[0]!.answer!.runners! }] }
  const got = classes(table, silent)
  assert.equal(got.get(4003)!.classification, 'stale')
  assert.equal(got.get(4001)!.classification, 'running')
})

await check('a win32 table that is incomplete lists nothing and says so, never an empty success', () => {
  const { records } = world()
  const census = readProcessSweepCensus({ observations: [], complete: false, error: 'Windows process reading is not built on this platform yet; nothing is listed and nothing is ended' }, { ...records, platform: 'win32' })
  assert.equal(census.complete, false)
  assert.equal(census.entries.length, 0)
  assert.match(census.error ?? '', /Windows/)
  const report = doctorProcessesReport(census, false)
  assert.equal(report.counts.stale, 0)
  assert.match(report.error ?? '', /Windows/)
})

await check('the doctor words and the JSON report carry the approved sentences', () => {
  const { table, records } = world()
  const census = readProcessSweepCensus(table, records)
  const counts = processSweepCounts(census.entries)
  assert.equal(PROCESS_SWEEP_WORDS.row, 'Mercury processes')
  assert.equal(PROCESS_SWEEP_WORDS.counts(counts), `${counts.running} running · ${counts.stale} stale · ${counts['cannot-end']} cannot end · ${counts['not-ours']} not ours`)
  assert.equal(PROCESS_SWEEP_WORDS.action, 'Review stale processes')
  assert.equal(PROCESS_SWEEP_WORDS.confirm(2), 'End these 2 stale processes?')
  assert.equal(PROCESS_SWEEP_WORDS.result(3, 1, 2), 'Ended 3 stale processes; 1 could not be ended; 2 left running')
  assert.equal(PROCESS_SWEEP_WORDS.unkillable, 'cannot end — needs a reboot')
  const report = doctorProcessesReport(census, false)
  assert.equal(report.row, 'Mercury processes')
  assert.equal(report.lines.length, counts.stale + counts['cannot-end'])
  assert.ok(report.lines.every(line => /^pid \d+ · .+ · .+ · .+$/.test(line)))
  assert.equal(report.result, undefined)
})

await check('a classifier exception is a refusal of the whole census, never a partial list', () => {
  const { table, records } = world()
  const poisoned = { ...records, registrations: [{ ...records.registrations![0]!, heartbeatAt: Number.NaN }, records.registrations![1]!] }
  const census = readProcessSweepCensus(table, poisoned)
  assert.equal(census.complete, true)
  assert.equal(census.entries.find(entry => entry.process.pid === 3002)!.classification, 'running')
  const broken = { ...records, planes: [{ ...records.planes[0]!, answer: { ...records.planes[0]!.answer!, runners: null as unknown as undefined } }] }
  const refused = readProcessSweepCensus({ ...table, observations: table.observations.map(row => (row.process.pid === 4001 ? ({ ...row, process: { ...row.process, get args(): string[] { throw new Error('poison') } } } as ProcessSweepObservation) : row)) }, broken)
  assert.equal(refused.complete, false)
  assert.match(refused.error ?? '', /classifier refused/)
  assert.equal(refused.entries.length, 0)
})

await check('a successor owner born after the daemon is a live owner, never a recycled pid', () => {
  const { table, records } = world()
  const successor = { ...records, registrations: [records.registrations![1]!], memory: { [`daemon:4001:${table.observations.find(row => row.process.pid === 4001)!.startToken}`]: NOW - 700_000 }, planes: [{ ...records.planes[0]!, supervisor: { ...records.planes[0]!.supervisor!, ownerPid: 9001 }, answer: { ...records.planes[0]!.answer!, ownerPid: 9001, live: 0, liveSessions: 0, runners: [] } }] }
  const got = classes(table, successor)
  assert.equal(got.get(4001)!.classification, 'running')
  assert.match(got.get(4001)!.reason, /owner/)
  assert.ok(table.observations.find(row => row.process.pid === 9001)!.process.startedAtMs > records.planes[0]!.supervisor!.startedAt, 'the fixture\'s successor is younger than the daemon')
})

await check('a registration whose token could not be read is unknown, not absent: the owner-gone daemon cannot be ended', () => {
  const { table, records } = world()
  const uncertain = { ...records, registrations: [{ ...records.registrations![0]!, startToken: null }], memory: { [`daemon:4001:${table.observations.find(row => row.process.pid === 4001)!.startToken}`]: NOW - 700_000 }, planes: [{ ...records.planes[0]!, supervisor: { ...records.planes[0]!.supervisor!, ownerPid: 3999 }, answer: { ...records.planes[0]!.answer!, ownerPid: 3999, live: 0, liveSessions: 0, runners: [] } }] }
  const got = classes(table, uncertain)
  assert.equal(got.get(4001)!.classification, 'cannot-end')
  assert.match(got.get(4001)!.reason, /registration/)
})

await check('a parked session record is not an open session; an open one still protects the daemon', () => {
  const { table, records } = world()
  const runner = records.planes[0]!.answer!.runners![0]!
  const base = { ...records, registrations: [records.registrations![1]!], memory: { [`daemon:4001:${table.observations.find(row => row.process.pid === 4001)!.startToken}`]: NOW - 700_000 } }
  const parked = { ...base, planes: [{ ...records.planes[0]!, supervisor: { ...records.planes[0]!.supervisor!, ownerPid: 3999 }, answer: { ...records.planes[0]!.answer!, ownerPid: 3999, live: 0, liveSessions: 0, runners: [{ ...runner, pid: 4444, parkedAt: NOW - 5_000, attachedBy: undefined }] } }] }
  assert.equal(classes(table, parked).get(4001)!.classification, 'stale')
  const open = { ...base, planes: [{ ...records.planes[0]!, supervisor: { ...records.planes[0]!.supervisor!, ownerPid: 3999 }, answer: { ...records.planes[0]!.answer!, ownerPid: 3999, live: 0, liveSessions: 0, runners: [{ ...runner, pid: 4444, attachedBy: undefined }] } }] }
  assert.equal(classes(table, open).get(4001)!.classification, 'running')
  assert.match(classes(table, open).get(4001)!.reason, /session/)
})

await check('a runner record without a birth token binds nothing: the process cannot be ended', () => {
  const { table, records } = world()
  const runners = records.planes[0]!.answer!.runners!
  const blank = { ...records, planes: [{ ...records.planes[0]!, answer: { ...records.planes[0]!.answer!, runners: runners.map(entry => (entry.pid === 4003 ? { ...entry, procStart: undefined } : entry)) } }] }
  const got = classes(table, blank)
  assert.equal(got.get(4003)!.classification, 'cannot-end')
})

console.log('§ the ending ladder over injected ports in a scratch home')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs')
const { tmpdir } = require('node:os') as typeof import('node:os')
const { endStaleProcesses, readMercuryProcesses }: typeof import('../../src/daemon/processSweepRun.ts') = await import(join(import.meta.dir, '../../src/daemon/processSweepRun.ts'))
const SCRATCH = mkdtempSync(join(tmpdir(), 'orphan-sweep-ladder-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(home, 'daemon')
mkdirSync(join(home, 'processes'), { recursive: true })
mkdirSync(daemonDir, { recursive: true })
const ladderTable = (): ProcessSweepTable => {
  const table = parsePosixProcessTable(darwinTable)
  for (const row of table.observations) {
    row.process.args = row.process.pid === 4001 ? ['/opt/mercury/vendor/node/bin/node', '/opt/mercury/dist/mercury.mjs', 'daemon', 'run', '/work'] : row.process.pid === 4003 ? ['mercury'] : ['/usr/libexec/other']
    row.process.exe = row.process.pid === 4001 || row.process.pid === 4003 ? 'node' : 'other'
  }
  return table
}
const daemonToken = ladderTable().observations.find(row => row.process.pid === 4001)!.startToken
const runnerToken = ladderTable().observations.find(row => row.process.pid === 4003)!.startToken
writeFileSync(join(daemonDir, 'supervisor.json'), JSON.stringify({ pid: 4001, version: '1', origin: 'transient', startedAt: born('2026-09-20T09:02:00+01:00'), dir: '/work', controlSock: join(daemonDir, 'control.sock'), ownerPid: 3999, persist: false, startToken: daemonToken }))
writeFileSync(join(daemonDir, 'concourse-workers.json'), JSON.stringify({ version: 1, workers: { 'concourse-w1': { schema: 1, runnerId: 'concourse-w1', sessionId: 's-1', workspaceId: '/work', isolation: 'read-only', modelKey: 'm', spawnedAt: NOW - 2_000_000, lastLiveAt: NOW - 1_500_000, pid: 4003, procStart: runnerToken, endedAt: NOW - 1_200_000 } } }))
writeFileSync(join(home, 'processes', 'census.json'), JSON.stringify({ readAt: NOW - 700_000, platform: 'darwin', complete: true, entries: [], memory: { [`daemon:4001:${daemonToken}`]: NOW - 700_000 }, endings: [] }))
process.env.MERCURY_SESSION_PARK_DRAIN_MINUTES = '10'
type Port = { present: Set<number>; signals: string[]; rpc: (request: { action: string; expected?: { process: { pid: number } } }) => unknown }
const ladder = async (port: Port, targetPid: number): Promise<{ outcome: string; road: string; reason: string }> => {
  const collect = async (): Promise<ProcessSweepTable> => {
    const table = ladderTable()
    table.observations = table.observations.filter(row => port.present.has(row.process.pid) || (row.process.pid !== 4001 && row.process.pid !== 4003))
    return table
  }
  const deps = { home, ownDaemonDir: daemonDir, waitMs: 120, record: false, collect, nowMs: () => Date.now(), rpc: async (request: { action: string; expected?: { process: { pid: number } } }) => port.rpc(request) as never, signal: (pid: number, name: string): boolean => { port.signals.push(`${pid}:${name}`); return true } }
  const listing = await readMercuryProcesses({ ...deps, nowMs: () => NOW })
  const entry = listing.entries.find(item => item.process.pid === targetPid)
  assert.ok(entry !== undefined && entry.classification === 'stale', `the fixture reads ${targetPid} as ${entry?.classification}: ${entry?.reason}`)
  const after = await endStaleProcesses([entry], { ...deps, nowMs: () => Date.now() })
  const ending = after.endings[0]!
  return { outcome: ending.outcome, road: ending.road, reason: ending.reason }
}
const facts = { pid: 4001, ownerPid: 3999, live: 0, liveSessions: 0, persist: false, runners: [{ pid: 4003, procStart: runnerToken, endedAt: NOW - 1_200_000, stoppedAt: undefined, parkedAt: undefined, attachedBy: undefined, focusedBy: undefined, schedules: 0, activity: undefined, warm: false }] }
const answerFacts = { ok: true, op: 'processSweep', action: 'facts', facts }

await check('the daemon road that does not answer refuses the end of the reader\'s own daemon: no signal is sent', async () => {
  const port: Port = { present: new Set([4001, 4003]), signals: [], rpc: request => (request.action === 'facts' ? answerFacts : { ok: false, code: 'ETIMEOUT', error: 'no reply' }) }
  const ending = await ladder(port, 4001)
  assert.equal(ending.outcome, 'refused')
  assert.equal(ending.road, 'daemon')
  assert.match(ending.reason, /did not answer/)
  assert.deepEqual(port.signals, [])
})

await check('the daemon\'s own refusal is final: no signal is sent', async () => {
  const port: Port = { present: new Set([4001, 4003]), signals: [], rpc: request => (request.action === 'facts' ? answerFacts : { ok: true, op: 'processSweep', action: 'end', ended: false, road: 'daemon', reason: 'the owner pid 3999 is alive' }) }
  const ending = await ladder(port, 4001)
  assert.equal(ending.outcome, 'refused')
  assert.match(ending.reason, /owner pid 3999 is alive/)
  assert.deepEqual(port.signals, [])
})

await check('a daemon that confirmed the end and left is recorded on its own road, unsignalled', async () => {
  const port: Port = { present: new Set([4001, 4003]), signals: [], rpc: request => { if (request.action === 'end') port.present.delete(4001); return request.action === 'facts' ? answerFacts : { ok: true, op: 'processSweep', action: 'end', ended: true, road: 'daemon', reason: 'the daemon confirmed nothing uses it and shut itself down' } } }
  const ending = await ladder(port, 4001)
  assert.equal(ending.outcome, 'ended')
  assert.equal(ending.road, 'daemon')
  assert.deepEqual(port.signals, [])
})

await check('a daemon that confirmed the end but has not left within the wait is reported as not ended, with nothing else sent', async () => {
  const port: Port = { present: new Set([4001, 4003]), signals: [], rpc: request => (request.action === 'facts' ? answerFacts : { ok: true, op: 'processSweep', action: 'end', ended: true, road: 'daemon', reason: 'the daemon confirmed nothing uses it and shut itself down' }) }
  const ending = await ladder(port, 4001)
  assert.equal(ending.outcome, 'survived')
  assert.equal(ending.road, 'daemon')
  assert.match(ending.reason, /had not left within the wait/)
  assert.deepEqual(port.signals, [])
})

await check('a target already gone before anything was sent is not counted among the ended', () => {
  const { processSweepOutcomeLine }: typeof import('../../src/daemon/processSweepRun.ts') = require(join(import.meta.dir, '../../src/daemon/processSweepRun.ts'))
  const entry = { process: { pid: 1, ppid: 1, exe: '', args: [], startedAtMs: 0, user: '', terminal: null }, platform: 'darwin' as const, kind: 'window' as const, startToken: null, registrationId: null, classification: 'stale' as const, reason: '', state: '' }
  const line = processSweepOutcomeLine({ readAt: 0, platform: 'darwin', complete: true, entries: [], memory: {}, endings: [
    { entry, outcome: 'ended', road: 'none', reason: 'already gone before anything was sent', at: 0 },
    { entry, outcome: 'ended', road: 'signal', reason: 'ended on the termination signal', at: 0 },
    { entry, outcome: 'survived', road: 'signal', reason: PROCESS_SWEEP_WORDS.unkillable, at: 0 },
  ] })
  assert.equal(line, 'Ended 1 stale processes; 1 could not be ended; 0 left running')
})

await check('a released runner the daemon killed but that survived goes on to the ladder: TERM, then the identity and staleness re-read, then KILL, then the survivor is reported', async () => {
  const port: Port = { present: new Set([4001, 4003]), signals: [], rpc: request => (request.action === 'facts' ? answerFacts : { ok: true, op: 'processSweep', action: 'end', ended: true, road: 'daemon', reason: 'the daemon killed its released runner' }) }
  const ending = await ladder(port, 4003)
  assert.equal(ending.outcome, 'survived')
  assert.deepEqual(port.signals, ['4003:SIGTERM', '4003:SIGKILL'])
  assert.ok(ending.reason.startsWith(PROCESS_SWEEP_WORDS.unkillable))
})

await check('a process that leaves on the termination signal is never sent the kill signal', async () => {
  const port: Port = { present: new Set([4001, 4003]), signals: [], rpc: request => (request.action === 'facts' ? answerFacts : { ok: true, op: 'processSweep', action: 'end', ended: true, road: 'daemon', reason: 'the daemon killed its released runner' }) }
  const originalSignal = port.rpc
  void originalSignal
  const withExit: Port = { ...port, signals: port.signals, rpc: port.rpc }
  const collectingPort = withExit
  const deps = { home, ownDaemonDir: daemonDir, waitMs: 120, record: false, nowMs: () => Date.now(), collect: async (): Promise<ProcessSweepTable> => { const table = ladderTable(); table.observations = table.observations.filter(row => collectingPort.present.has(row.process.pid) || (row.process.pid !== 4001 && row.process.pid !== 4003)); return table }, rpc: async (request: { action: string }) => collectingPort.rpc(request) as never, signal: (pid: number, name: string): boolean => { collectingPort.signals.push(`${pid}:${name}`); if (name === 'SIGTERM') collectingPort.present.delete(pid); return true } }
  const listing = await readMercuryProcesses({ ...deps, nowMs: () => NOW })
  const entry = listing.entries.find(item => item.process.pid === 4003)!
  const after = await endStaleProcesses([entry], deps)
  assert.equal(after.endings[0]!.outcome, 'ended')
  assert.deepEqual(collectingPort.signals, ['4003:SIGTERM'])
})

await check('a process that is no longer stale after the termination signal is not sent the kill signal', async () => {
  let termed = false
  const port: Port = { present: new Set([4001, 4003]), signals: [], rpc: request => (request.action === 'facts' ? (termed ? { ...answerFacts, facts: { ...facts, runners: [{ ...facts.runners[0]!, endedAt: undefined, attachedBy: 'operator:3002' }] } } : answerFacts) : { ok: true, op: 'processSweep', action: 'end', ended: true, road: 'daemon', reason: 'the daemon killed its released runner' }) }
  const deps = { home, ownDaemonDir: daemonDir, waitMs: 120, record: false, nowMs: () => Date.now(), collect: async (): Promise<ProcessSweepTable> => ladderTable(), rpc: async (request: { action: string }) => port.rpc(request) as never, signal: (pid: number, name: string): boolean => { port.signals.push(`${pid}:${name}`); if (name === 'SIGTERM') termed = true; return true } }
  const listing = await readMercuryProcesses({ ...deps, nowMs: () => NOW })
  const entry = listing.entries.find(item => item.process.pid === 4003)!
  assert.equal(entry.classification, 'stale')
  const after = await endStaleProcesses([entry], deps)
  assert.equal(after.endings[0]!.outcome, 'refused')
  assert.match(after.endings[0]!.reason, /no longer stale after the termination signal/)
  assert.deepEqual(port.signals, ['4003:SIGTERM'])
})

rmSync(SCRATCH, { recursive: true, force: true })

console.log(`process sweep tables: ${checks} checks passed`)
