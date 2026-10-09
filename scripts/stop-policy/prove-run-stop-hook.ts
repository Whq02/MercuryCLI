#!/usr/bin/env bun
// gate-watch: src/guards/runStop.ts src/guards/guards.ts src/utils/config/globalConfig.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'run-stop-hook-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
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

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const guard = await import('../../src/guards/runStop.ts')
const { guardsEngaged, judgeTurnEnd, resetGuardsForTesting } = await import('../../src/guards/guards.ts')

section('§1 registration — one silent guard per session, under the executor ceiling')
{
  resetGuardsForTesting()
  const id = guard.registerRunStopGuard('proof-session')
  check('registration returns the stable guard id', id === guard.RUN_STOP_HOOK_ID)
  const again = guard.registerRunStopGuard('proof-session')
  check('registering the same session again returns the same id', again === id)
  const engaged = guardsEngaged('proof-session').turn.filter(entry => entry === guard.RUN_STOP_HOOK_ID)
  check('the guard is engaged exactly once at the turn\'s end', engaged.length === 1, String(engaged.length))
  check('the ceiling is 30 s', guard.RUN_STOP_HOOK_TIMEOUT_MS === 30_000)
  const started = Date.now()
  const holds = await judgeTurnEnd('proof-session', { messages: [] })
  check('a stop with no run passes untouched (no hold)', holds.length === 0, JSON.stringify(holds))
  check('…promptly', Date.now() - started < 5_000, `${Date.now() - started} ms`)
}

section('§2 the guard never holds — its one answer is "no hold", the record its one effect')
{
  const text = readFileSync(join(ROOT, 'src/guards/runStop.ts'), 'utf8')
  const judge = text.slice(text.indexOf('judge:'), text.indexOf('\n    },', text.indexOf('judge:')))
  const returns = judge.match(/\breturn\b[^\n]*/g) ?? []
  check('every return of the judge is `{ hold: false }`', returns.length > 0 && returns.every(r => /^return \{ hold: false \}/.test(r)), returns.join(' | '))
  check('the judge hands the stop to the adapter with the ceiling, the evidence-only posture and the signal — nothing more', /await evaluateStopAttempt\(messages, \{ maxBlocks: MAX_BLOCKS, wordingUnfinished: false, signal \}\)/.test(judge))
  check('the judge reads no environment and no setting', !/process\.env|flagEnv\(|getGlobalConfig\(|getSettings/.test(judge))
  check('the module composes no re-prompt', !/repromptWithNextAction|RUN_STOP_REPROMPT/.test(text))
  check('the guard is registered silent (it never paints the transcript)', /silent: true/.test(text))
  const exported = Object.keys(guard).sort()
  check('the module exports the guard id, the ceiling and the registrar — nothing else', exported.join(',') === ['RUN_STOP_HOOK_ID', 'RUN_STOP_HOOK_TIMEOUT_MS', 'registerRunStopGuard'].join(','), exported.join(','))
}

section('§3 the registry — a guard that holds nothing lets the turn end; a holding guard re-prompts with its words')
{
  resetGuardsForTesting()
  const { engageTurnGuard } = await import('../../src/guards/guards.ts')
  guard.registerRunStopGuard('proof-session-2')
  engageTurnGuard('proof-session-2', { id: 'probe-hold', judge: () => ({ hold: true, words: 'keep going: the probe is not done' }) })
  const holds = await judgeTurnEnd('proof-session-2', { messages: [] })
  check('the run-stop guard contributes no hold beside a holding guard', holds.length === 1 && holds[0]?.guard === 'probe-hold', JSON.stringify(holds))
  check('the hold carries the guard\'s own words, visible', holds[0]?.words === 'keep going: the probe is not done' && holds[0]?.silent === false)
}

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log(failures ? '\n❌ RUN-STOP-HOOK RED' : '\n✅ RUN-STOP-HOOK GREEN')
process.exit(failures)
