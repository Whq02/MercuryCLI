#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-supervisor-lock.ts
//  PROOF: the per-config-home supervisor mutex. At most ONE
//  daemon per daemonDir() holds it; a 2nd `mercury daemon` (or a racing
//  ensureScribeDaemon double-spawn) for the same ~/.claude must REFUSE rather
//  than clobber the live socket / overwrite control.key.
//
//  Tests the REAL acquireSupervisorLock against a temp MERCURY_CONFIG_DIR, driving
//  the lock file directly to simulate a live / stale / successor holder.
//  Run:  ~/.bun/bin/bun run scripts/daemon/prove-supervisor-lock.ts
// ============================================================================
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

// Isolate the config home so we never touch the real ~/.claude/daemon.
const home = mkdtempSync(join(tmpdir(), 'hermes-suplock-'))
process.env.MERCURY_CONFIG_DIR = home
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const cs = (await import('../../src/daemon/controlSocket.js')) as typeof import('../../src/daemon/controlSocket.js')
const lockPath = join(home, 'daemon', 'supervisor.lock')

console.log('============================================================')
console.log(' Supervisor mutex — HB-0066/HB-0072 (one daemon per config home)')
console.log('============================================================')

// ── 1. clean acquire + release round-trip ──────────────────────────────────
section('clean acquire → lock file written → release removes it')
{
  const lock = await cs.acquireSupervisorLock()
  check('acquire on a clean home ⇒ a lock handle', lock !== null)
  check('lock file exists on disk', existsSync(lockPath))
  check('lock records THIS pid', JSON.parse(readFileSync(lockPath, 'utf8')).pid === process.pid)
  await lock!.release()
  check('release removes the lock file', !existsSync(lockPath))
}

// ── 2. a LIVE different holder ⇒ REFUSE (the core no-clobber guarantee) ─────
section('a live holder (different pid) ⇒ acquire REFUSES (null), file untouched')
{
  // pid 1 (init/launchd) is always alive and is never this process.
  const livePayload = JSON.stringify({ pid: 1, startedAt: Date.now(), id: 'other-live' })
  writeFileSync(lockPath, livePayload)
  const refused = await cs.acquireSupervisorLock()
  check('acquire REFUSES when a live daemon owns the home', refused === null)
  check('the live holder lock was NOT overwritten (no clobber)', readFileSync(lockPath, 'utf8') === livePayload)
  rmSync(lockPath)
}

// ── 3. a STALE holder (dead pid) ⇒ RECLAIM ─────────────────────────────────
section('a stale holder (dead pid) ⇒ acquire RECLAIMS the lock')
{
  // A pid astronomically unlikely to be alive.
  writeFileSync(lockPath, JSON.stringify({ pid: 2_146_999_999, startedAt: 0, id: 'stale' }))
  const reclaimed = await cs.acquireSupervisorLock()
  check('acquire RECLAIMS a stale lock', reclaimed !== null)
  check('the reclaimed lock now records THIS pid', JSON.parse(readFileSync(lockPath, 'utf8')).pid === process.pid)
  await reclaimed!.release()
  check('release removes the reclaimed lock', !existsSync(lockPath))
}

// ── 4. release is OWNERSHIP-checked (never unlinks a successor's lock) ──────
section('release only removes OUR lock — a successor takeover is left intact')
{
  const mine = await cs.acquireSupervisorLock()
  check('acquired (ours)', mine !== null)
  // Simulate a successor having reclaimed + rewritten the lock under a live pid.
  const successor = JSON.stringify({ pid: 1, startedAt: Date.now(), id: 'successor' })
  writeFileSync(lockPath, successor)
  await mine!.release()
  check('our release did NOT remove the successor\'s lock', existsSync(lockPath) && readFileSync(lockPath, 'utf8') === successor)
  rmSync(lockPath)
}

// ── 5. structural: main.ts actually WIRES acquire→refuse→release ───────────
section('structural: daemon main acquires before control, refuses on null, releases on shutdown')
{
  const main = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'main.ts'), 'utf8')
  check('acquires the lock', /supervisorLock = await acquireSupervisorLock\(\)/.test(main))
  check('refuses (returns) when contended', /if \(!supervisorLock\)[\s\S]{0,260}return/.test(main))
  check('acquire precedes the control server bind', main.indexOf('acquireSupervisorLock()') !== -1 && main.indexOf('acquireSupervisorLock()') < main.indexOf('startControlServer({'))
  check('releases the lock on shutdown', /supervisorLock\?\.release\(\)/.test(main))
  const server = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'controlServer.ts'), 'utf8')
  check('controlServer documents the unlink is lock-guarded', /supervisor lock/.test(server))
}

// hygiene
rmSync(home, { recursive: true, force: true })

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SUPERVISOR-LOCK PROOFS PASS')
else console.log(`❌ ${failures} SUPERVISOR-LOCK PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
