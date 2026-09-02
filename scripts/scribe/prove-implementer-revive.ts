#!/usr/bin/env bun
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

const home = mkdtempSync(join(tmpdir(), 'hermes-revive-'))
process.env.MERCURY_CONFIG_DIR = home
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

console.log('============================================================')
console.log(' Implementer revive — stale/wedged daemon respawn on engage')
console.log('============================================================')

section('clearDeadSupervisorRecords clears supervisor.json AND supervisor.lock')
{
  const cs = (await import('../../src/daemon/controlSocket.js')) as typeof import('../../src/daemon/controlSocket.js')
  const daemonDir = join(home, 'daemon')
  mkdirSync(daemonDir, { recursive: true })
  const sj = join(daemonDir, 'supervisor.json')
  const sl = join(daemonDir, 'supervisor.lock')
  writeFileSync(sj, JSON.stringify({ pid: 999999, version: 'stale', startedAt: 0 }))
  writeFileSync(sl, JSON.stringify({ pid: 999999, startedAt: 0, id: 'stale' }))
  check('both records present before', existsSync(sj) && existsSync(sl))
  await cs.clearDeadSupervisorRecords()
  check('supervisor.json removed', !existsSync(sj))
  check('supervisor.lock removed', !existsSync(sl))
  await cs.clearDeadSupervisorRecords()
  check('clearDeadSupervisorRecords is idempotent (no throw on absent)', true)
}

section("decideScribeDaemonAction: 'live' ⇒ noop · 'unavailable'/'off' ⇒ spawn")
{
  const esd = (await import('../../src/utils/scribe/ensureScribeDaemon.js')) as typeof import('../../src/utils/scribe/ensureScribeDaemon.js')
  check("'live' ⇒ noop (then ping-confirmed in ensureScribeDaemon)", esd.decideScribeDaemonAction('live') === 'noop')
  check("'unavailable' (dead pid) ⇒ spawn", esd.decideScribeDaemonAction('unavailable') === 'spawn')
  check("'off' (no record) ⇒ spawn", esd.decideScribeDaemonAction('off') === 'spawn')
}

section('structural: a live snapshot is PING-CONFIRMED before trusting it')
{
  const esd = src('utils', 'scribe', 'ensureScribeDaemon.ts')
  check('imports daemonControlRpc + clearDeadSupervisorRecords', /daemonControlRpc/.test(esd) && /clearDeadSupervisorRecords/.test(esd))
  check("pings the control socket with op:'ping'", /daemonControlRpc\(\{ op: 'ping' \}/.test(esd))
  check('ping.ok ⇒ return (noop only when genuinely serving, after the foreign-daemon hosting verify)', /if \(ping\.ok\) \{/.test(esd) && /return \/\/ idempotent/.test(esd))
  check('ping fail ⇒ clearDeadSupervisorRecords() then respawn', /clearDeadSupervisorRecords\(\)[\s\S]{0,160}spawnScribeDaemon/.test(esd))
  check('still gates on scribeBusLiveEnabled (OFF ⇒ no auto-start)', /if \(!scribeBusLiveEnabled\(\)\) return/.test(esd))
}

rmSync(home, { recursive: true, force: true })

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL IMPLEMENTER-REVIVE PROOFS PASS')
else console.log(`❌ ${failures} IMPLEMENTER-REVIVE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
