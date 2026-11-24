#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import * as cp from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourse-workers/concourseWorkers.ts'

const platform = process.argv.find(arg => arg.startsWith('--platform='))?.slice(11) as NodeJS.Platform | undefined
const scene = process.argv.find(arg => arg.startsWith('--scene='))?.slice(8) as 'the live sessions of a folder' | 'the count of live sessions' | undefined
if (!platform || !scene) {
  let failed = 0
  for (const target of ['darwin', 'win32']) {
    for (const each of ['the live sessions of a folder', 'the count of live sessions']) {
      const result = cp.spawnSync(process.execPath, [import.meta.filename, `--platform=${target}`, `--scene=${each}`], { stdio: 'inherit', env: process.env })
      if (result.status !== 0) failed++
    }
  }
  console.log(failed === 0 ? '\nprove-record-loops-ask-births-in-one-read: all green' : `\nprove-record-loops-ask-births-in-one-read: ${failed} scene(s) FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}

const HOST = process.platform
const SCRATCH = mkdtempSync(join(tmpdir(), 'record-loops-one-read-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
const WORK = join(SCRATCH, 'work')
const elsewhere = (n: number): string => join(SCRATCH, `elsewhere-${n}`)
for (const dir of [process.env.MERCURY_CONFIG_DIR, process.env.MERCURY_DAEMON_DIR, WORK, ...[1, 2, 3, 4, 5].map(elsewhere)]) mkdirSync(dir, { recursive: true })

const OTHER_FOLDERS = [600_201, 600_202, 600_203, 600_204, 600_205]
const HERE_GONE_TO_OTHERS = [600_206, 600_207]
const HERE_ITSELF = 600_208
const HERE_DEAD = 600_209
const ALIVE = [...OTHER_FOLDERS, ...HERE_GONE_TO_OTHERS, HERE_ITSELF]
const standIn = (pid: number): boolean => pid >= 600_200 && pid < 600_300
const realKill = process.kill
process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
  if (!standIn(pid)) return realKill(pid, signal)
  if (ALIVE.includes(pid)) return true
  throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
}) as typeof process.kill

const instants = platform === 'win32'
const second = (pid: number): string => String(pid % 60).padStart(2, '0')
const born = (pid: number): string => (instants ? `2026-11-24T10:00:${second(pid)}.0000000Z` : `Tue Nov 24 10:00:${second(pid)} 2026`)
const anEarlierBirth = (pid: number): string => (instants ? `2026-11-20T08:00:${second(pid)}.0000000Z` : `Fri Nov 20 08:00:${second(pid)} 2026`)

const reads: number[][] = []
mock.module('node:child_process', () => ({
  ...cp,
  execFile: (file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const command = args.at(-1) ?? ''
    const pids = file === 'ps' ? (args[args.indexOf('-p') + 1] ?? '').split(',').map(Number) : [...command.matchAll(/ProcessId\s*=\s*(\d+)/g)].map(match => Number(match[1]))
    reads.push(pids)
    const here = pids.filter(pid => ALIVE.includes(pid))
    queueMicrotask(() => callback(null, file === 'ps' ? `${here.map(pid => `${pid} ${born(pid)}`).join('\n')}\n` : JSON.stringify(here.map(pid => ({ pid, token: born(pid) }))), ''))
    return { kill: () => true }
  },
}))

const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const ledger = await import('../../src/sessions/mneme/ledger.ts')
const { mnemeProjectKeyFor } = await import('../../src/sessions/mneme/paths.ts')
const dir = process.env.MERCURY_DAEMON_DIR!

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${platform}: ${label}${cond ? '' : ` — ${[detail, 'change: the loops over the session records (readLiveSessions in src/sessions/mneme/ledger.ts, countLiveConcourseWorkers in src/daemon/concourse-workers/queries.ts) ask for the births they lack in one read (askWorkerPidStarts in src/daemon/concourse-workers/workerIdentity.ts, over refreshProcessStartTokens in src/daemon/control/ownerWatch.ts) before they look at each record, and readLiveSessions looks only at the records of its own folder'].filter(Boolean).join(' | ')}`}`)
}
const j = (value: unknown): string => JSON.stringify(value)
const sessionOf = (pid: number): string => `00000000-ffff-4000-8000-${String(pid).padStart(12, '0')}`
const answered = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30))

const now = Date.now()
sup.updateConcourseWorkers(workers => {
  const records: Array<[number, string, string]> = [
    ...OTHER_FOLDERS.map((pid, index): [number, string, string] => [pid, anEarlierBirth(pid), elsewhere(index + 1)]),
    ...HERE_GONE_TO_OTHERS.map((pid): [number, string, string] => [pid, anEarlierBirth(pid), WORK]),
    [HERE_ITSELF, born(HERE_ITSELF), WORK],
    [HERE_DEAD, born(HERE_DEAD), WORK],
  ]
  for (const [index, [pid, procStart, workspaceId]] of records.entries()) {
    const runnerId = `concourse-w${index + 1}`
    workers[runnerId] = { schema: 1, runnerId, sessionId: sessionOf(pid), workspaceId, isolation: 'shared', modelKey: 'claude-sonnet-5', spawnedAt: now - 60_000 + index, lastLiveAt: now - 1_000, pid, procStart } as ConcourseWorkerRecordV1
  }
}, dir)
const projectKey = mnemeProjectKeyFor(WORK)
Object.defineProperty(process, 'platform', { value: platform, configurable: true })

console.log(`\n── ${platform}: ${scene}; five records of other folders and two of this one name pids that went to other processes, one names a session that is itself, one a pid that is gone ──`)
try {
  if (scene === 'the live sessions of a folder') {
    const first = ledger.liveSessions(projectKey).map(session => session.sessionId)
    await answered()
    check('before any birth is known the folder’s three records with a living pid are its live sessions, as they were', j(first) === j([...HERE_GONE_TO_OTHERS, HERE_ITSELF].map(sessionOf)), j(first))
    check('one read asks for the births of the folder’s three, in one launch', reads.length === 1 && j([...(reads[0] ?? [])].sort()) === j([...HERE_GONE_TO_OTHERS, HERE_ITSELF]), `${reads.length} read(s): ${j(reads)}`)
    check('no read names a record of another folder, or a pid that is gone', reads.every(pids => pids.every(pid => !OTHER_FOLDERS.includes(pid) && pid !== HERE_DEAD)), j(reads))
    const then = ledger.liveSessions(projectKey).map(session => session.sessionId)
    await answered()
    check('once the read has answered, the session that is itself is the folder’s one live session, and nothing more is read', j(then) === j([sessionOf(HERE_ITSELF)]) && reads.length === 1, `${j(then)} after ${reads.length} read(s)`)
  } else {
    const first = sup.countLiveConcourseWorkers(dir)
    await answered()
    check('before any birth is known every record with a living pid counts, as it did', first === ALIVE.length, `${first}`)
    check('one read asks for the births of all eight, in one launch', reads.length === 1 && j([...(reads[0] ?? [])].sort()) === j(ALIVE), `${reads.length} read(s): ${j(reads)}`)
    check('no read names the pid that is gone', reads.every(pids => !pids.includes(HERE_DEAD)), j(reads))
    const then = sup.countLiveConcourseWorkers(dir)
    await answered()
    check('once the read has answered, one session counts, and nothing more is read', then === 1 && reads.length === 1, `${then} after ${reads.length} read(s)`)
  }
} finally {
  Object.defineProperty(process, 'platform', { value: HOST, configurable: true })
  rmSync(SCRATCH, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
