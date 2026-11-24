#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

if (process.platform === 'win32') {
  console.log('prove-daemon-home-file-modes: POSIX file modes do not apply on win32 — SKIP')
  process.exit(0)
}

const ROOT = resolve(process.env.PROOF_SUBJECT_ROOT ?? join(import.meta.dir, '..', '..'))
const scratch = mkdtempSync(join(tmpdir(), 'mercury-daemon-modes-'))
const daemonHome = join(scratch, 'daemon')
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_DAEMON_DIR = daemonHome

const prevUmask = process.umask(0o022)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const modeOf = (p: string): number => statSync(p).mode & 0o777
const oct = (m: number): string => `0o${m.toString(8).padStart(3, '0')}`

try {
  const control = await import(pathToFileURL(join(ROOT, 'src/daemon/control/controlSocket.ts')).href)
  const store = await import(pathToFileURL(join(ROOT, 'src/daemon/concourse-workers/store.ts')).href)
  const dispatch = await import(pathToFileURL(join(ROOT, 'src/daemon/concourse-workers/concourseDispatch.ts')).href)
  const collisions = await import(pathToFileURL(join(ROOT, 'src/daemon/concourse-workers/collisions.ts')).href)

  await control.mintControlKey()
  await control.writeDaemonState({
    pid: process.pid,
    version: '1.0.0',
    origin: 'transient',
    startedAt: Date.now(),
    dir: scratch,
    controlSock: join(daemonHome, 'control.sock'),
  })
  store.updateConcourseWorkers(workers => {
    workers['r-1'] = {
      schema: 1,
      runnerId: 'r-1',
      sessionId: 's-1',
      workspaceId: scratch,
      isolation: 'shared',
      modelKey: 'fixture',
      effort: 'high',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
      pid: process.pid,
    }
  }, daemonHome)
  dispatch.recordConcourseControlOp({
    clientOpId: 'op-1',
    action: 'park',
    sessionId: 's-1',
    atMs: Date.now(),
    outcome: 'applied',
  }, daemonHome)
  collisions.recordCollisionEvidence({
    schema: 1,
    kind: 'exclusive-overlap',
    workspaceId: scratch,
    holders: [],
    observedAt: Date.now(),
    detail: 'test',
  }, daemonHome)

  const dirMode = modeOf(daemonHome)
  check('daemon home directory is private (0700, no group/other bits)', (dirMode & 0o077) === 0, `mode=${oct(dirMode)} — enforce 0700 in src/daemon/control/daemonHome.ts and controlSocket.ts`)

  const files: Array<[string, string]> = [
    ['control.key', control.controlKeyPath()],
    ['daemon.json', control.daemonStatePath()],
    ['concourse-workers.json', store.concourseWorkersPath(daemonHome)],
    ['concourse-delta.json', store.concourseDeltaPath(daemonHome)],
    ['concourse-control-ops.json', dispatch.concourseControlOpsPath(daemonHome)],
    ['concourse-collisions.json', collisions.concourseCollisionsPath(daemonHome)],
  ]
  for (const [label, filePath] of files) {
    const m = modeOf(filePath)
    check(`${label} is owner-only (0600, no group/other bits)`, (m & 0o077) === 0, `mode=${oct(m)} path=${filePath} — default mode 0600 in src/daemon/control/daemonHome.ts`)
  }

  const existingHome = join(scratch, 'daemon-existing')
  mkdirSync(existingHome, { recursive: true, mode: 0o755 })
  chmodSync(existingHome, 0o755)
  process.env.MERCURY_DAEMON_DIR = existingHome
  const lock = await control.acquireDaemonLock()
  try {
    const tightened = modeOf(existingHome)
    check('an existing 0755 daemon folder is tightened to 0700 on daemon start', (tightened & 0o077) === 0, `mode=${oct(tightened)} — tighten existing daemonDir() to 0700 in acquireDaemonLock (src/daemon/control/controlSocket.ts) via src/daemon/control/daemonHome.ts`)
  } finally {
    await lock?.release()
  }
} finally {
  process.umask(prevUmask)
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nprove-daemon-home-file-modes: ${failures === 0 ? 'ALL HOLD' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
export {}
