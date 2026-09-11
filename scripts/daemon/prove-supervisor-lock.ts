#!/usr/bin/env bun
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const home = mkdtempSync(join(tmpdir(), 'mercury-suplock-'))
process.env.MERCURY_CONFIG_DIR = home
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const cs = (await import('../../src/daemon/controlSocket.js')) as typeof import('../../src/daemon/controlSocket.js')
const lockPath = join(home, 'daemon', 'supervisor.lock')

console.log('============================================================')
console.log(' Supervisor mutex — HB-0066/HB-0072 (one daemon per config home)')
console.log('============================================================')

section('clean acquire → lock file written → release removes it')
{
  const lock = await cs.acquireSupervisorLock()
  check('acquire on a clean home ⇒ a lock handle', lock !== null)
  check('lock file exists on disk', existsSync(lockPath))
  check('lock records THIS pid', JSON.parse(readFileSync(lockPath, 'utf8')).pid === process.pid)
  await lock!.release()
  check('release removes the lock file', !existsSync(lockPath))
}

section('a live holder (different pid) ⇒ acquire REFUSES (null), file untouched')
{
  const livePayload = JSON.stringify({ pid: 1, startedAt: Date.now(), id: 'other-live' })
  writeFileSync(lockPath, livePayload)
  const refused = await cs.acquireSupervisorLock()
  check('acquire REFUSES when a live daemon owns the home', refused === null)
  check('the live holder lock was NOT overwritten (no clobber)', readFileSync(lockPath, 'utf8') === livePayload)
  rmSync(lockPath)
}

section('a stale holder (dead pid) ⇒ acquire RECLAIMS the lock')
{
  writeFileSync(lockPath, JSON.stringify({ pid: 2_146_999_999, startedAt: 0, id: 'stale' }))
  const reclaimed = await cs.acquireSupervisorLock()
  check('acquire RECLAIMS a stale lock', reclaimed !== null)
  check('the reclaimed lock now records THIS pid', JSON.parse(readFileSync(lockPath, 'utf8')).pid === process.pid)
  await reclaimed!.release()
  check('release removes the reclaimed lock', !existsSync(lockPath))
}

section('release only removes OUR lock — a successor takeover is left intact')
{
  const mine = await cs.acquireSupervisorLock()
  check('acquired (ours)', mine !== null)
  const successor = JSON.stringify({ pid: 1, startedAt: Date.now(), id: 'successor' })
  writeFileSync(lockPath, successor)
  await mine!.release()
  check('our release did NOT remove the successor\'s lock', existsSync(lockPath) && readFileSync(lockPath, 'utf8') === successor)
  rmSync(lockPath)
}

section('structural: daemon main acquires before control, refuses on null, releases on shutdown')
{
  const main = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'main.ts'), 'utf8')
  check('acquires the lock', /supervisorLock = await acquireSupervisorLock\(\)/.test(main))
  check('refuses (returns) when contended', /if \(!supervisorLock\)[\s\S]{0,260}return/.test(main))
  check('acquire precedes the control server bind', main.indexOf('acquireSupervisorLock()') !== -1 && main.indexOf('acquireSupervisorLock()') < main.indexOf('startControlServer({'))
  check('releases the lock on shutdown', /supervisorLock\?\.release\(\)/.test(main))
}

rmSync(home, { recursive: true, force: true })

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SUPERVISOR-LOCK PROOFS PASS')
else console.log(`❌ ${failures} SUPERVISOR-LOCK PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
