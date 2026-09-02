#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-route-health.ts
//  PROOF (#82 router hardening — the two evidence-backed mechanisms):
//    A. STORE-IDENTITY GATING: spawnOwnedDaemon stamps the RESOLVED
//       MERCURY_CONFIG_DIR into every owned daemon's env (the split-store
//       class: the live-E2E's first run had a daemon healing an empty
//       ~/.claude/teams while the session's mail sat in ~/.mercury).
//    B. DISPATCH-ACK BACKEND HEALTH: composeDispatchAckHealth truth table
//       (route-time health, never fabricated) + the SendMessageTool wiring
//       (scribe dispatch only, never the Implementer's own sends).
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-route-health.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const srcOf = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

section('A. owned-daemon store-identity stamp')
const owned = srcOf('daemon', 'ownedDaemon.ts')
check('spawnOwnedDaemon stamps the resolved config home', owned.includes('env.MERCURY_CONFIG_DIR = getMercuryHome()'))
const stampIdx = owned.indexOf('env.MERCURY_CONFIG_DIR = getMercuryHome()')
const overlayIdx = owned.indexOf("Object.entries(opts?.extraEnv ?? {})")
check('explicit extraEnv still overrides the stamp (stamp before overlay)', stampIdx >= 0 && overlayIdx > stampIdx)

section('B. dispatch-ack health — truth table + wiring')
const tel = await import('../../src/utils/scribe/implementerTelemetry.js')
const h = tel.composeDispatchAckHealth
check('no daemon ⇒ UNCONFIRMED + send≠receipt', h({ daemonUp: false, present: false }).includes('UNCONFIRMED') && h({ daemonUp: false, present: false }).includes('send≠receipt'))
check('daemon up, no implementer ⇒ MISSING', h({ daemonUp: true, present: false }).includes('MISSING'))
check('settled entry ⇒ SETTLED (dead/degraded)', h({ daemonUp: true, present: true, settled: true }).includes('SETTLED'))
const midtask = h({ daemonUp: true, present: true, busy: true, turnElapsedMs: 4 * 60_000 })
check('busy ⇒ MID-TASK with elapsed minutes + held-for-idle', midtask.includes('MID-TASK ~4 min in') && midtask.includes('idle boundary'))
check('idle ⇒ LIVE + immediate delivery', h({ daemonUp: true, present: true, busy: false }).includes('LIVE (idle)'))
// rpc floor: a send the daemon just answered must never be
// acked 'no daemon answer yet'; roster facts stay poll-owned (no fabricated
// MISSING/LIVE from the floor alone).
check('empty cache + rpcConfirmed ⇒ honest pending-first-poll clause', h({ daemonUp: false, present: false }, { rpcConfirmed: true }).includes('daemon answered this send'))
check('empty cache + no rpc ⇒ still UNCONFIRMED', h({ daemonUp: false, present: false }, { rpcConfirmed: false }).includes('UNCONFIRMED'))
check('rpc floor never invents roster facts', !h({ daemonUp: false, present: false }, { rpcConfirmed: true }).includes('MISSING'))
const sendTool = srcOf('tools', 'SendMessageTool', 'SendMessageTool.ts')
check(
  'ack wiring: scribe dispatch only, never the Implementer role',
  /teamName === 'scribe' && envelope\.kind === 'dispatch' && !isImplementerRole\(\)/.test(sendTool) &&
    sendTool.includes('composeDispatchAckHealth(getImplementerTelemetry(), { rpcConfirmed: deliveredViaRpc })'),
)

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('✅ route health — ALL CHECKS PASS')
