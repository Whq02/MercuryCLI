#!/usr/bin/env bun
import * as cp from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'

const platform = process.argv.find(arg => arg.startsWith('--platform='))?.slice(11) as NodeJS.Platform | undefined
if (!platform) {
  let failed = 0
  for (const target of ['darwin', 'win32']) {
    const result = cp.spawnSync(process.execPath, [import.meta.filename, `--platform=${target}`], { stdio: 'inherit', env: process.env })
    if (result.status !== 0) failed++
  }
  console.log(failed === 0 ? '\nprove-own-start-token-asked-once: all green' : `\nprove-own-start-token-asked-once: ${failed} platform(s) FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}

const OTHER = 600_123
const realKill = process.kill
const realNow = Date.now
let age = 0
Date.now = () => realNow() + age
type Launch = { file: string; pid: number; form: 'token' | 'instant' }
const launches: Launch[] = []
let answers = true
const tokenOf = (pid: number, form: Launch['form']): string => (form === 'instant' ? `2026-11-24T10:00:${String(pid % 60).padStart(2, '0')}.0000000Z` : `Tue Nov 24 10:00:${String(pid % 60).padStart(2, '0')} 2026`)
mock.module('node:child_process', () => ({
  ...cp,
  execFile: (file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const command = args.at(-1) ?? ''
    const pid = file === 'ps' ? Number(args[args.indexOf('-p') + 1]) : Number(/ProcessId\s*=\s*(\d+)/.exec(command)?.[1])
    const form: Launch['form'] = file !== 'ps' && command.includes("ToString('o')") ? 'instant' : 'token'
    launches.push({ file, pid, form })
    const said = answers
    queueMicrotask(() => callback(said ? null : Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), said ? `${tokenOf(pid, form)}\n` : '', ''))
    return { kill: () => true }
  },
}))
process.kill = ((pid: number, signal?: NodeJS.Signals | number) => (pid === OTHER ? true : realKill(pid, signal))) as typeof process.kill

const scratch = mkdtempSync(join(tmpdir(), 'own-start-token-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
const watch = await import('../../src/daemon/control/ownerWatch.ts')
const locks = await import('../../src/platform/substrate/pidLock.ts')
Object.defineProperty(process, 'platform', { value: platform, configurable: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${platform}: ${label}${cond ? '' : ` — ${[detail, 'change: startTokenOfAsync and the cached reads in src/daemon/control/ownerWatch.ts: a process’s own start token cannot change, so one answered read serves every later ask of this process, and asks made while it is out share it'].filter(Boolean).join(' | ')}`}`)
}
const own = (form: Launch['form']): number => launches.filter(launch => launch.pid === process.pid && launch.form === form).length
const instantForm: Launch['form'] = platform === 'win32' ? 'instant' : 'token'

console.log(`\n── ${platform}: this process asks for its own start token ──`)
try {
  answers = false
  const unanswered = await watch.getProcessStartTokenAsync(process.pid)
  check('a read that gave no answer is not kept', unanswered === null && own('token') === 1, `${JSON.stringify(unanswered)} after ${own('token')} read(s)`)
  answers = true
  const together = await Promise.all([watch.getProcessStartTokenAsync(process.pid), watch.getProcessStartTokenAsync(process.pid), watch.getProcessStartTokenAsync(process.pid)])
  check('three asks made at once are one read', own('token') === 2 && together.every(token => token === tokenOf(process.pid, 'token')), `${own('token') - 1} read(s) for three asks: ${JSON.stringify(together)}`)
  const later = [await watch.getProcessStartTokenAsync(process.pid), await watch.getProcessStartTokenAsync(process.pid)]
  check('asks after the answer read nothing more', own('token') === 2 && later.every(token => token === tokenOf(process.pid, 'token')), `${own('token') - 2} more read(s)`)
  const lock = join(scratch, 'one.lock')
  const taken = await locks.acquirePidLock(lock, 'owner-one', { liveness: 'assume-alive' })
  const again = await locks.acquirePidLock(join(scratch, 'two.lock'), 'owner-two', { liveness: 'assume-alive' })
  check('two locks taken by this process read nothing more', taken.held && again.held && own('token') === 2, `${own('token') - 2} more read(s); held ${taken.held} ${again.held}`)
  age = 60_000
  const cached = watch.getProcessStartTokenCachedOrRefresh(process.pid)
  await new Promise(resolve => setTimeout(resolve, 20))
  check('a minute later the cached ask still answers and reads nothing', cached === tokenOf(process.pid, 'token') && own('token') === 2, `${JSON.stringify(cached)} after ${own('token') - 2} more read(s)`)
  const before = own(instantForm)
  const instants = [await watch.getProcessStartInstantAsync(process.pid), await watch.getProcessStartInstantAsync(process.pid)]
  check(platform === 'win32' ? 'the instant form is its own single read' : 'the instant form is the token form here, so it reads nothing', own(instantForm) - before === (platform === 'win32' ? 1 : 0) && instants.every(token => token === tokenOf(process.pid, instantForm)), `${own(instantForm) - before} read(s): ${JSON.stringify(instants)}`)

  console.log(`\n── ${platform}: another process is read each time it is asked ──`)
  const others = [await watch.getProcessStartTokenAsync(OTHER), await watch.getProcessStartTokenAsync(OTHER)]
  check('two asks about another pid are two reads', launches.filter(launch => launch.pid === OTHER).length === 2 && others.every(token => token === tokenOf(OTHER, 'token')), `${launches.filter(launch => launch.pid === OTHER).length} read(s)`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
