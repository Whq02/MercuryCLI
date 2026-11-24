#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import * as cp from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourse-workers/concourseWorkers.ts'

const platform = process.argv.find(arg => arg.startsWith('--platform='))?.slice(11) as NodeJS.Platform | undefined
if (!platform) {
  let failed = 0
  for (const target of ['darwin', 'win32']) {
    const result = cp.spawnSync(process.execPath, [import.meta.filename, `--platform=${target}`], { stdio: 'inherit', env: process.env })
    if (result.status !== 0) failed++
  }
  console.log(failed === 0 ? '\nprove-left-runner-strangers-cost-one-read: all green' : `\nprove-left-runner-strangers-cost-one-read: ${failed} platform(s) FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}

const HOST = process.platform
const SCRATCH = mkdtempSync(join(tmpdir(), 'left-runner-strangers-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })

const STRANGERS = [600_101, 600_102, 600_103, 600_104, 600_105]
const RUNNER = 600_106
const GONE = 600_107
const standIn = (pid: number): boolean => pid >= 600_100 && pid < 600_200
const alive = new Set<number>()
const realKill = process.kill
process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
  if (!standIn(pid)) return realKill(pid, signal)
  if (alive.has(pid)) return true
  throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
}) as typeof process.kill

const instants = platform === 'win32'
const second = (pid: number): string => String(pid % 60).padStart(2, '0')
const born = (pid: number): string => (instants ? `2026-11-24T10:00:${second(pid)}.0000000Z` : `Tue Nov 24 10:00:${second(pid)} 2026`)
const anEarlierBirth = (pid: number): string => (instants ? `2026-11-20T08:00:${second(pid)}.0000000Z` : `Fri Nov 20 08:00:${second(pid)} 2026`)

type Launch = { kind: 'first look' | 'tree listing' | 'single read'; pids: number[] }
let launches: Launch[] = []
let events: string[] = []
let firstLookAnswers = true
const noted = (launch: Launch): void => {
  launches.push(launch)
  events.push(`${launch.kind}${launch.pids.length > 0 ? ` ${launch.pids.join(',')}` : ''}`)
}
mock.module('node:child_process', () => ({
  ...cp,
  execFile: (file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const child = { kill: () => true }
    const command = args.at(-1) ?? ''
    if (file === 'ps' && args.includes('-A')) {
      noted({ kind: 'tree listing', pids: [] })
      const rows = [`${process.pid} ${process.ppid} ${process.pid} ${born(process.pid)}`, ...[...alive].map(pid => `${pid} 1 ${pid} ${born(pid)}`)]
      queueMicrotask(() => callback(null, `${rows.join('\n')}\n`, ''))
      return child
    }
    const together = file === 'ps' ? args.includes('pid=') : command.includes('ConvertTo-Json')
    const pids = file === 'ps' ? (args[args.indexOf('-p') + 1] ?? '').split(',').map(Number) : [...command.matchAll(/ProcessId\s*=\s*(\d+)/g)].map(match => Number(match[1]))
    noted({ kind: together ? 'first look' : 'single read', pids })
    const here = pids.filter(pid => alive.has(pid))
    if (!together) queueMicrotask(() => callback(null, here.length > 0 ? `${born(here[0]!)}\n` : '', ''))
    else if (firstLookAnswers) queueMicrotask(() => callback(null, file === 'ps' ? `${here.map(pid => `${pid} ${born(pid)}`).join('\n')}\n` : JSON.stringify(here.map(pid => ({ pid, token: born(pid) }))), ''))
    return child
  },
}))
const processGroup = { ...(await import('../../src/platform/processes/processGroup.ts')) }
mock.module('../../src/platform/processes/processGroup.ts', () => ({
  ...processGroup,
  endProcessTree: async (pid: number, signal: string) => {
    if (!standIn(pid)) throw new Error(`this proof signals no real process, and was asked to end ${pid}`)
    events.push(`${signal} ${pid}`)
    alive.delete(pid)
    return { ended: 1, survivors: [] }
  },
}))
const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const dir = process.env.MERCURY_DAEMON_DIR!

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${platform}: ${label}${cond ? '' : ` — ${[detail, 'change: endRunnersLeftWithoutHost in src/daemon/concourse-workers/park.ts: one first look (getProcessStartTokensAsync, src/daemon/control/ownerWatch.ts) reads the births of every record it may end, and a record whose pid now carries another birth is passed over on that look alone; a record the look binds, or cannot read, goes the road it went before (its tree listed, its birth read once more, then the ask)'].filter(Boolean).join(' | ')}`}`)
}
const j = (value: unknown): string => JSON.stringify(value)

type Swept = { ended: string[]; launches: Launch[]; events: string[]; tookMs: number }
async function sweep(strangers: readonly number[], answers: boolean): Promise<Swept> {
  alive.clear()
  for (const pid of [...strangers, RUNNER]) alive.add(pid)
  launches = []
  events = []
  firstLookAnswers = answers
  const now = Date.now()
  Object.defineProperty(process, 'platform', { value: HOST, configurable: true })
  sup.updateConcourseWorkers(workers => {
    for (const id of Object.keys(workers)) delete workers[id]
    const records: Array<[number, string]> = [...strangers.map((pid): [number, string] => [pid, anEarlierBirth(pid)]), [RUNNER, born(RUNNER)], [GONE, born(GONE)]]
    for (const [index, [pid, procStart]] of records.entries()) {
      const runnerId = `concourse-w${index + 1}`
      workers[runnerId] = { schema: 1, runnerId, sessionId: `00000000-eeee-4000-8000-${String(index + 1).padStart(12, '0')}`, workspaceId: SCRATCH, isolation: 'exclusive', modelKey: 'claude-sonnet-5', spawnedAt: now - 60_000, lastLiveAt: now - 1_000, pid, procStart } as ConcourseWorkerRecordV1
    }
  }, dir)
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  const startedAt = Date.now()
  const ended = await sup.endRunnersLeftWithoutHost(() => false, dir, { graceMs: 0 })
  return { ended: ended.map(e => e.runnerId), launches, events, tookMs: Date.now() - startedAt }
}
const of = (swept: Swept, kind: Launch['kind']): Launch[] => swept.launches.filter(launch => launch.kind === kind)
const signalled = (swept: Swept): string[] => swept.events.filter(event => event.startsWith('SIG'))
const runnerId = (strangers: readonly number[]): string => `concourse-w${strangers.length + 1}`

console.log(`\n── ${platform}: five records name pids that went to other processes, one names a runner that is still itself, one a pid that is gone ──`)
try {
  const swept = await sweep(STRANGERS, true)
  const firstLooks = of(swept, 'first look')
  const singles = of(swept, 'single read')
  check('one first look reads the births of every record it may end, in one launch', firstLooks.length === 1 && j([...(firstLooks[0]?.pids ?? [])].sort()) === j([...STRANGERS, RUNNER]), `${firstLooks.length} first look(s) naming ${j(firstLooks.map(look => look.pids))}; all launches: ${j(swept.events)}`)
  check('no record whose pid went to another process is read by itself', singles.filter(read => read.pids.some(pid => STRANGERS.includes(pid))).length === 0, `${singles.filter(read => read.pids.some(pid => STRANGERS.includes(pid))).length} single read(s) of pids that went to other processes: ${j(swept.events)}`)
  check('nor is its tree listed', of(swept, 'tree listing').length === (platform === 'win32' ? 0 : 1), `${of(swept, 'tree listing').length} tree listing(s): ${j(swept.events)}`)
  check('a pid that is gone is named by no read', swept.launches.every(launch => !launch.pids.includes(GONE)), j(swept.events))
  check('nothing is signalled but the runner that is still itself, and it alone is listed as ended', j(signalled(swept)) === j([`SIGTERM ${RUNNER}`]) && j(swept.ended) === j([runnerId(STRANGERS)]), j({ signalled: signalled(swept), ended: swept.ended }))
  const look = swept.events.indexOf(`single read ${RUNNER}`)
  check('that runner’s birth is read once more by itself, after the first look and its tree listing, before the ask', singles.filter(read => read.pids.includes(RUNNER)).length === 1 && look > swept.events.findIndex(event => event.startsWith('first look')) && look > swept.events.indexOf('tree listing') && look < swept.events.indexOf(`SIGTERM ${RUNNER}`), j(swept.events))

  console.log(`\n── ${platform}: the first look gets no answer ──`)
  const few = STRANGERS.slice(0, 2)
  const blind = await sweep(few, false)
  check('a look that cannot be read is no verdict: every record then goes the road it went before, read by itself', of(blind, 'first look').length === 1 && j(of(blind, 'single read').map(read => read.pids[0]).sort()) === j([...few, RUNNER]) && of(blind, 'tree listing').length === (platform === 'win32' ? 0 : 3), j(blind.events))
  check('the pids that went to other processes are still left alone and the runner is still ended', j(signalled(blind)) === j([`SIGTERM ${RUNNER}`]) && j(blind.ended) === j([runnerId(few)]), j({ signalled: signalled(blind), ended: blind.ended }))
} finally {
  Object.defineProperty(process, 'platform', { value: HOST, configurable: true })
  rmSync(SCRATCH, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
