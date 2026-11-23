#!/usr/bin/env bun
// gate-watch: src/permissions/guards/runStop.ts src/permissions/guards/guards.ts src/platform/config/globalConfig.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'run-stop-hook-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures = 1
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' the default run stop guard — every stop stands; the record is the whole effect')
console.log('============================================================')

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const guard = await import('../../src/permissions/guards/runStop.ts')
const { guardsEngaged, judgeTurnEnd, resetGuardsForTesting } = await import('../../src/permissions/guards/guards.ts')

section('§1 registration — one silent guard per session, under the executor ceiling')
{
  resetGuardsForTesting()
  const id = guard.registerRunStopGuard('proof-session')
  check('registration returns the stable guard id', id === guard.RUN_STOP_HOOK_ID, `got ${String(id)}; registerRunStopGuard in src/permissions/guards/runStop.ts must return RUN_STOP_HOOK_ID`)
  const again = guard.registerRunStopGuard('proof-session')
  check('registering the same session again returns the same id', again === id, `got ${String(again)} after ${String(id)}; registerRunStopGuard in src/permissions/guards/runStop.ts must not register a second guard for one session`)
  const engaged = guardsEngaged('proof-session').turn.filter(entry => entry === guard.RUN_STOP_HOOK_ID)
  check('the guard is engaged exactly once at the turn\'s end', engaged.length === 1, `${String(engaged.length)}; registerRunStopGuard in src/permissions/guards/runStop.ts must engage the turn guard exactly once per session`)
  check('the ceiling is 30 s', guard.RUN_STOP_HOOK_TIMEOUT_MS === 30_000, `got ${guard.RUN_STOP_HOOK_TIMEOUT_MS}; set RUN_STOP_HOOK_TIMEOUT_MS in src/permissions/guards/runStop.ts to 30_000`)
  const started = Date.now()
  const holds = await judgeTurnEnd('proof-session', { messages: [] })
  check('a stop with no run passes untouched (no hold)', holds.length === 0, `${JSON.stringify(holds)}; the run-stop guard in src/permissions/guards/runStop.ts must not hold a stop that has no run`)
  check('…promptly', Date.now() - started < 5_000, `${Date.now() - started} ms; the run-stop guard in src/permissions/guards/runStop.ts must answer without waiting on its ceiling`)
}

section('§2 the guard never holds — its one answer is "no hold", the record its one effect')
{
  const exported = Object.keys(guard).sort()
  check('the module exports the guard id, the ceiling and the registrar — nothing else', exported.join(',') === ['RUN_STOP_HOOK_ID', 'RUN_STOP_HOOK_TIMEOUT_MS', 'registerRunStopGuard'].join(','), `${exported.join(',')}; src/permissions/guards/runStop.ts must export only RUN_STOP_HOOK_ID, RUN_STOP_HOOK_TIMEOUT_MS and registerRunStopGuard`)
}

section('§3 the registry — a guard that holds nothing lets the turn end; a holding guard re-prompts with its words')
{
  resetGuardsForTesting()
  const { engageTurnGuard } = await import('../../src/permissions/guards/guards.ts')
  guard.registerRunStopGuard('proof-session-2')
  engageTurnGuard('proof-session-2', { id: 'probe-hold', judge: () => ({ hold: true, words: 'keep going: the probe is not done' }) })
  const holds = await judgeTurnEnd('proof-session-2', { messages: [] })
  check('the run-stop guard contributes no hold beside a holding guard', holds.length === 1 && holds[0]?.guard === 'probe-hold', `${JSON.stringify(holds)}; the run-stop guard in src/permissions/guards/runStop.ts must never hold, and judgeTurnEnd in src/permissions/guards/guards.ts must return only the holding guard`)
  check('the hold carries the guard\'s own words, visible', holds[0]?.words === 'keep going: the probe is not done' && holds[0]?.silent === false, `${JSON.stringify(holds)}; judgeTurnEnd in src/permissions/guards/guards.ts must pass a holding guard's words through unchanged and not silent`)
}

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log(failures ? '\n❌ RUN-STOP-HOOK RED' : '\n✅ RUN-STOP-HOOK GREEN')
process.exit(failures)
