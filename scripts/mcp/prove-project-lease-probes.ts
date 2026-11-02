#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import * as cp from 'node:child_process'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { mock } from 'bun:test'

const platform = process.argv.find(arg => arg.startsWith('--platform='))?.slice(11) as NodeJS.Platform | undefined
if (!platform) {
  let failures = 0
  for (const target of ['darwin', 'win32', 'linux']) {
    const result = cp.spawnSync(process.execPath, [import.meta.filename, `--platform=${target}`], { stdio: 'inherit', env: process.env })
    if (result.status !== 0) failures++
  }
  process.exit(failures ? 1 : 0)
}

const realPlatform = process.platform
const realKill = process.kill
const realRead = fs.readFileSync
const realNow = Date.now
let age = 0
Date.now = () => realNow() + age
const pids = Array.from({ length: 40 }, (_, i) => 600_000 + i)
const tokens = new Map(pids.map((pid, i) => [pid, platform === 'linux' ? String(100_000 + i) : `Mon Nov  2 12:00:${String(i).padStart(2, '0')} 2026`]))
let mode: 'ok' | 'hang' | 'batch-fails' | 'all-fail' | 'omit' | 'malformed' | 'fallback-hangs' = 'ok'
let onReply: (() => void) | undefined
const dead = new Set<number>()
let kills = 0
const calls: number[][] = []
const late: Array<() => void> = []
const batches: boolean[] = []

mock.module('node:fs', () => ({ ...fs, readFileSync: (path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
  const pid = /^\/proc\/(\d+)\/stat$/.exec(String(path))?.[1]
  if (pid && tokens.has(Number(pid))) {
    if (dead.has(Number(pid))) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    return `${pid} (proof) S ${Array(18).fill('0').join(' ')} ${tokens.get(Number(pid))} 0`
  }
  return (realRead as Function)(path, ...args)
} }))
mock.module('node:child_process', () => ({ ...cp, execFile: (file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
  const command = args.at(-1) ?? ''
  const ids = file === 'ps'
    ? (args[args.indexOf('-p') + 1] ?? '').split(',').map(Number)
    : [...command.matchAll(/ProcessId\s*=\s*(\d+)/g)].map(match => Number(match[1]))
  const batch = file === 'ps' ? args.includes('pid=') : command.includes('ConvertTo-Json')
  calls.push(ids)
  batches.push(batch)
  const fail = mode === 'all-fail' || ((mode === 'batch-fails' || mode === 'fallback-hangs') && batch)
  const present = ids.filter(pid => !dead.has(pid) && !(mode === 'omit' && pid === pids[1]))
  const output = mode === 'malformed' && batch ? 'not a process table' : fail ? '' : batch
    ? file === 'ps' ? present.map(pid => `${pid} ${tokens.get(pid)}`).join('\n') : JSON.stringify(present.map(pid => ({ pid, token: tokens.get(pid) })))
    : present.length ? tokens.get(present[0]!) ?? '' : ''
  const reply = () => {
    const effect = onReply
    onReply = undefined
    effect?.()
    callback(fail ? Object.assign(new Error('probe failed'), { code: 2 }) : null, output, fail ? 'unavailable' : '')
  }
  if (mode === 'hang' || (mode === 'fallback-hangs' && !batch)) late.push(reply)
  else queueMicrotask(reply)
  return { kill: () => { kills++; return true } }
} }))
process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
  if (!tokens.has(pid)) return realKill(pid, signal)
  if (dead.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
  return true
}) as typeof process.kill

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = join(proofHome, 'work')
fs.mkdirSync(join(root, '.mercury'), { recursive: true })
const { setOriginalCwd, switchSession } = await import('../../src/bootstrap/state.ts')
setOriginalCwd(root)
switchSession('00000000-0000-4000-8000-000000000062' as never, root)
const ownerWatch = await import('../../src/daemon/ownerWatch.ts')
const leases = await import('../../src/services/vulcan/engine/leases.ts')
Object.defineProperty(process, 'platform', { value: platform, configurable: true })
const holder = (i: number) => ({ sessionId: 'probe-proof', agentId: `holder-${i}`, pid: pids[i]!, procStart: tokens.get(pids[i]!)! })
function seed(i: number, suffix: string): void {
  const db = new Database(join(root, '.mercury', 'project-leases.sqlite'))
  try {
    db.exec('CREATE TABLE IF NOT EXISTS leases (path TEXT PRIMARY KEY, record TEXT NOT NULL, session TEXT, agent TEXT, pid INTEGER, proc_start TEXT)')
    const path = `holders/${i}-${suffix}.ts`
    const identity = holder(i)
    db.prepare('INSERT INTO leases (path, record, session, agent, pid, proc_start) VALUES (?, ?, ?, ?, ?, ?)').run(path, JSON.stringify({ path, holder: identity, acquiredAt: new Date().toISOString() }), identity.sessionId, identity.agentId, identity.pid, identity.procStart)
  } finally { db.close() }
}
for (let i = 0; i < pids.length; i++) { seed(i, 'a'); seed(i, 'b') }
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${platform}: ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const resetCalls = (): void => { calls.length = 0; batches.length = 0 }
const expectedSpawns = platform === 'linux' ? 0 : 1
const expire = (): void => { age += 3100; resetCalls() }

try {
  const cold = await leases.describeProjectLeases(root)
  check('40 holders retain both their rows', cold.total === 80 && cold.holders.length === 40, cold.total)
  check('one call probes all 40 pids in at most one spawn', calls.length === expectedSpawns && (expectedSpawns === 0 || (batches[0] && new Set(calls[0]).size === 40)), calls)
  resetCalls()
  const warm = await leases.describeProjectLeases(root)
  check('the second call inside three seconds uses zero spawns', warm.total === 80 && calls.length === 0, calls.length)
  if (platform !== 'linux') {
    const shared = ownerWatch.getProcessStartTokenCachedOrRefresh(pids[0]!)
    await Promise.resolve()
    check('the existing ownerWatch cache reads the same observation without a spawn', shared === tokens.get(pids[0]!) && calls.length === 0, { shared, calls: calls.length })
  }
  resetCalls()
  dead.add(pids[0]!)
  const gone = await leases.describeProjectLeases(root)
  check('a dead pid loses both rows on the next call, even inside the cache window', gone.total === 78 && !gone.holders.some(row => row.holder.pid === pids[0]) && calls.length === 0, { total: gone.total, spawns: calls.length })
  dead.delete(pids[0]!)
  tokens.set(pids[0]!, platform === 'linux' ? '200000' : 'Tue Nov  3 12:00:00 2026')
  seed(0, 'reused')
  resetCalls()
  const reused = await leases.describeProjectLeases(root)
  check('the dead cache entry cannot evict a newly reused pid', reused.total === 79 && calls.length === expectedSpawns, { total: reused.total, spawns: calls.length })
  tokens.set(pids[2]!, platform === 'linux' ? '200002' : 'Tue Nov  3 12:00:02 2026')
  seed(2, 'replacement')
  resetCalls()
  const replaced = await leases.describeProjectLeases(root)
  check('a different (pid, procStart) never reuses the previous identity verdict', replaced.total === 78 && replaced.holders.filter(row => row.holder.pid === pids[2]).length === 1 && calls.length === expectedSpawns, { total: replaced.total, spawns: calls.length })
  expire()
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => leases.describeProjectLeases(root)))
  check('expired observations refresh in one batch shared by concurrent callers', concurrent.every(result => result.total === 78) && calls.length === expectedSpawns, calls.length)
  expire()
  const take = await leases.takeProjectLeases(root, ['new.ts'], holder(0))
  check('a cold take includes its own holder in the same batch', take.ok && calls.length === expectedSpawns && (expectedSpawns === 0 || new Set(calls[0]).size === 40), calls)
  expire()
  const release = await leases.releaseProjectLeases(root, holder(0), ['new.ts'])
  check('a cold release also uses one batch', release.released === 1 && calls.length === expectedSpawns, calls)
  if (platform !== 'linux') {
    expire()
    mode = 'hang'
    const started = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = await Promise.race([
      leases.describeProjectLeases(root),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2000) }),
    ])
    clearTimeout(timer)
    const elapsed = performance.now() - started
    check('a hung probe returns within 1500 ms plus scheduling allowance, keeping every holder', timeout?.total === 78 && elapsed < 1900 && calls.length === 1 && kills > 0, { total: timeout?.total, elapsed, spawns: calls.length, kills })
    if (!timeout) process.exit(1)
    resetCalls()
    mode = 'ok'
    const retry = await leases.describeProjectLeases(root)
    check('the next call retries immediately rather than caching the timeout', retry.total === 78 && calls.length === 1, calls.length)
    for (const reply of late) reply()
    resetCalls()
    const afterLate = await leases.describeProjectLeases(root)
    check('a late timed-out callback cannot overwrite the new cache', afterLate.total === 78 && calls.length === 0, calls.length)
    expire()
    mode = 'batch-fails'
    const fallback = await leases.describeProjectLeases(root)
    check('only a failed batch falls back to one probe per distinct pid', fallback.total === 78 && calls.length === 41 && batches.filter(Boolean).length === 1, calls.length)
    expire()
    mode = 'all-fail'
    const unknown = await leases.describeProjectLeases(root)
    check('batch and fallback errors leave live rows alone', unknown.total === 78, unknown.total)
    resetCalls()
    mode = 'ok'
    await leases.describeProjectLeases(root)
    check('unknown answers are not cached', calls.length === 1, calls.length)
    expire()
    mode = 'omit'
    const omitted = await leases.describeProjectLeases(root)
    check('a successful probe reporting a departed pid evicts its rows without fallback', omitted.total === 76 && calls.length === 1, { total: omitted.total, calls: calls.length })
    mode = 'ok'
    tokens.set(pids[1]!, 'Tue Nov  3 12:00:01 2026')
    seed(1, 'returned')
    resetCalls()
    const returned = await leases.describeProjectLeases(root)
    check('a probe-dead verdict invalidates its cache before the next call', returned.total === 77 && calls.length === 1, { total: returned.total, calls: calls.length })
    mode = 'omit'
    const rawDead = await ownerWatch.getProcessStartTokenAsync(pids[1]!)
    mode = 'ok'
    resetCalls()
    await leases.describeProjectLeases(root)
    check('a dead answer from the uncached reader invalidates the shared cache too', rawDead === '' && calls.length === 1, { rawDead, calls: calls.length })
    expire()
    mode = 'malformed'
    const malformed = await leases.describeProjectLeases(root)
    check('malformed batch output falls back without reaping live rows', malformed.total === 77 && calls.length === 41, { total: malformed.total, calls: calls.length })
    expire()
    mode = 'fallback-hangs'
    const fallbackStarted = performance.now()
    const hungFallback = await leases.describeProjectLeases(root)
    check('a hung per-pid fallback shares one deadline, not forty', hungFallback.total === 77 && performance.now() - fallbackStarted < 1900 && calls.length === 2, { total: hungFallback.total, calls: calls.length })
    mode = 'ok'
    resetCalls()
    await leases.describeProjectLeases(root)
    check('the call after a fallback timeout retries all unknown pids in one batch', calls.length === 1, calls.length)
    expire()
    onReply = () => {
      tokens.set(pids[3]!, 'Tue Nov  3 12:00:03 2026')
      seed(3, 'during-probe')
    }
    const during = await leases.describeProjectLeases(root)
    check('an identity inserted during a probe is not reaped using an older observation', during.total === 78 && during.leases?.some(row => row.path === 'holders/3-during-probe.ts') === true, during.total)
    const after = await leases.describeProjectLeases(root)
    check('the next call checks that new identity and reaps only its old incarnation', after.total === 76 && after.leases?.some(row => row.path === 'holders/3-during-probe.ts') === true, after.total)
  }
} finally {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  process.kill = realKill
  Date.now = realNow
}
console.log(`${platform}: ${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
