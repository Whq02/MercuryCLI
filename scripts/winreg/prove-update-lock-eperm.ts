#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LayoutRoots } from '../../src/services/privateChannel/installLayout.js'

const { acquireUpdateLock, releaseUpdateLock, sweepUpdaterResidue } = await import('../../src/services/privateChannel/installLayout.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const PRIVILEGED = 4242420
const DEAD = 4242421
const realKill = process.kill.bind(process)
process.kill = ((pid: number, signal?: string | number) => {
  if (pid === PRIVILEGED && signal === 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
  if (pid === DEAD && signal === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
  return realKill(pid, signal as NodeJS.Signals)
}) as typeof process.kill

const home = mkdtempSync(join(tmpdir(), 'update-lock-eperm-'))
const roots = {
  versionsDir: join(home, 'versions'),
  binDir: join(home, 'bin'),
  shimPath: join(home, 'bin', 'mercury'),
  isWindows: process.platform === 'win32',
} as LayoutRoots
const lockDir = join(roots.versionsDir, '.update.lock')
const holdLock = (pid: number): void => {
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(join(lockDir, 'pid'), String(pid))
}

console.log('============================================================')
console.log(' the update lock and a holder the probe may not signal')
console.log('============================================================')

holdLock(PRIVILEGED)
const privileged = acquireUpdateLock(roots)
check('a lock whose holder answers EPERM stays held', privileged.state === 'held' && privileged.byPid === PRIVILEGED, JSON.stringify(privileged))
check("the privileged holder's lock is left in place", existsSync(join(lockDir, 'pid')) && readFileSync(join(lockDir, 'pid'), 'utf8').trim() === String(PRIVILEGED))
rmSync(lockDir, { recursive: true, force: true })

holdLock(DEAD)
const dead = acquireUpdateLock(roots)
check('a lock whose holder is gone is taken over as before', dead.state === 'acquired', JSON.stringify(dead))
releaseUpdateLock(roots)

mkdirSync(join(roots.versionsDir, `.download-${PRIVILEGED}`), { recursive: true })
mkdirSync(join(roots.versionsDir, `.download-${DEAD}`), { recursive: true })
sweepUpdaterResidue(roots)
check("a download in flight under a privileged updater survives the sweep", existsSync(join(roots.versionsDir, `.download-${PRIVILEGED}`)))
check("a dead updater's download is swept as before", !existsSync(join(roots.versionsDir, `.download-${DEAD}`)))

process.kill = realKill as typeof process.kill
try {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 })
} catch {
}
console.log(failures === 0 ? '\nALL UPDATE LOCK EPERM CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
