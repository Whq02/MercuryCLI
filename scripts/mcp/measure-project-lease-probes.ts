#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import * as childProcess from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { mock } from 'bun:test'

const realExecFile = childProcess.execFile
let spawns = 0
mock.module('node:child_process', () => ({
  ...childProcess,
  execFile: (...args: Parameters<typeof realExecFile>) => { spawns++; return realExecFile(...args) },
}))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = join(proofHome, 'work')
mkdirSync(join(root, '.mercury'), { recursive: true })
const { setOriginalCwd, switchSession } = await import('../../src/bootstrap/state.ts')
setOriginalCwd(root)
switchSession('00000000-0000-4000-8000-000000000061' as never, root)
const { procStartToken } = await import('../../src/utils/genericProcessUtils.ts')
const { getProcessStartTokenAsync } = await import('../../src/daemon/ownerWatch.ts')
const leases = await import('../../src/services/vulcan/engine/leases.ts')
const holders = 40
const children: childProcess.ChildProcess[] = []
const exits: Promise<unknown>[] = []
let failures = 0

async function measure<T>(label: string, work: () => Promise<T>, valid: (value: T) => boolean): Promise<void> {
  spawns = 0
  const start = performance.now()
  const value = await work()
  const ms = performance.now() - start
  const ok = valid(value)
  if (!ok) failures++
  console.log(JSON.stringify({ label, platform: process.platform, holders, ms: Number(ms.toFixed(2)), spawns, ok }))
}

try {
  for (let i = 0; i < 3; i++) {
    await measure(`single-token-${i + 1}`, async () => procStartToken(process.pid) ?? await getProcessStartTokenAsync(process.pid), token => !!token)
  }
  const rows: Array<{ pid: number; procStart: string }> = []
  for (let i = 0; i < holders; i++) {
    const child = childProcess.spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'inherit'] })
    children.push(child)
    exits.push(once(child, 'close'))
    await once(child, 'spawn')
    const procStart = procStartToken(child.pid!) ?? await getProcessStartTokenAsync(child.pid!)
    if (!procStart) throw new Error('could not read the measurement holder start token')
    rows.push({ pid: child.pid!, procStart })
  }
  const db = new Database(join(root, '.mercury', 'project-leases.sqlite'))
  try {
    db.exec('CREATE TABLE leases (path TEXT PRIMARY KEY, record TEXT NOT NULL); BEGIN')
    const insert = db.prepare('INSERT INTO leases (path, record) VALUES (?, ?)')
    rows.forEach((row, i) => {
      const path = `holders/${i}.ts`
      insert.run(path, JSON.stringify({ path, holder: { sessionId: 'measurement', agentId: String(i), ...row }, acquiredAt: new Date().toISOString() }))
    })
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  await new Promise(resolve => setTimeout(resolve, 3100))
  await measure('list-cold', () => leases.describeProjectLeases(root), result => result.total === holders)
  await measure('list-warm', () => leases.describeProjectLeases(root), result => result.total === holders)
  const own = leases.projectLeaseHolder('measurement-taker')
  await measure('take', () => leases.takeProjectLeases(root, ['take.ts'], own), result => result.ok)
  await measure('release', () => leases.releaseProjectLeases(root, own), result => result.released === 1)
  children[0]!.stdin!.end()
  await exits[0]
  await measure('list-after-exit', () => leases.describeProjectLeases(root), result => result.total === holders - 1)
} finally {
  for (const child of children) child.stdin?.end()
  await Promise.all(exits)
}
process.exitCode = failures ? 1 : 0
