#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}
const src = (...p: string[]) =>
  readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('=== PROOF — commit-gate wiring (the one chokepoint) ===')
const engine = src('QueryEngine.ts')
check('QueryEngine engages the gate', /engageCommitGate\(config\.setAppState, getSessionId\(\)\)/.test(engine))
check(
  'the engagement rides the per-run hook block that serves EVERY session kind (beside the wards registration)',
  engine.indexOf('registerWardsHook(config.setAppState, sessionId)') !== -1 &&
    engine.indexOf('engageCommitGate(config.setAppState, getSessionId())') !== -1 &&
    engine.indexOf('engageCommitGate(config.setAppState, getSessionId())') >
      engine.indexOf('registerWardsHook(config.setAppState, sessionId)'),
)
check('engage is per-session (a new session id re-arms)', src('utils', 'hooks', 'commitGate.ts').includes('commitGateEngagedSessions.has(sessionId)) return false'))

if (failures > 0) { console.log('❌ FAILED'); process.exit(1) }
console.log('✅ ALL PASS — commit-gate wiring')
