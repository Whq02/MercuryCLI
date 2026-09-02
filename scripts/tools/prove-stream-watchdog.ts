#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-stream-watchdog.ts
//  PROOF for: the streaming idle watchdog (which actively aborts a stream
//  with no inter-chunk progress) defaults ON (CLAUDE_ENABLE_STREAM_WATCHDOG=0
//  opts out). Without it a silently-dropped mid-stream
//  connection wedges the turn until the user hits ESC (the SDK request timeout only
//  covers the initial fetch, not inter-chunk gaps).
//
//  claude.ts is unloadable under bun-run (heavy API graph), so this locks the gate
//  by source-text + the real envUtils predicates.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-stream-watchdog.ts
// ============================================================================
import { readdirSync } from 'node:fs'
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
// Module-scoped read: the stream core lives in the claude/ submodules.
const _apiDir = join(import.meta.dir, '..', '..', 'src', 'services', 'providers', 'anthropic')
const claude = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'providers', 'anthropic', 'index.ts'), 'utf-8') + readdirSync(_apiDir).filter(f => f.endsWith('.ts')).map(f => readFileSync(join(_apiDir, f), 'utf-8')).join('\n')

console.log('============================================================')
console.log(' stream idle watchdog — default-ON (HB-0119)')
console.log('============================================================')

section('source: the watchdog is ALWAYS armed — no enablement gate, no env spelling')
// The idle watchdog has no opt-out: every stream arms the single deadline
// timer (one lazy timer serves the warning AND the abort thresholds); a
// wedged stream always aborts. No env read gates it, so no retired
// spelling survives anywhere in the api estate.
check('the watchdog arms unconditionally at stream start (stamp + arm, no gate between)', /lastStreamEventAtMs = Date\.now\(\)\s*armStreamIdleWatchdog\(\)/.test(claude))
check('the deadline handler serves BOTH thresholds (abort at full budget, warning at half)', /function onStreamIdleDeadline\(\): void \{[\s\S]{0,900}STREAM_IDLE_TIMEOUT_MS[\s\S]{0,900}STREAM_IDLE_WARNING_MS/.test(claude))
check('no watchdog enablement variable exists', !/streamWatchdogEnabled/.test(claude))
check('no retired watchdog env spelling survives', !/STREAM_WATCHDOG/.test(claude))

section('PT-1: a watchdog abort skips the non-streaming fallback (no inc-4258 double-exec)')
// The fork enabled the watchdog (the trigger) but disableFallback lacked the matching
// guard, so a watchdog abort AFTER a tool_use streamed routed into the non-streaming
// fallback, which re-issues the request and runs the SAME Bash/Write/Edit again.
check(
  'disableFallback trips on (streamIdleAborted && streamedToolUse) — unconditional',
  /const disableFallback =[\s\S]{0,700}\(streamIdleAborted && streamedToolUse\)/.test(claude),
)
check(
  'the watchdog signal streamIdleAborted is still set by the idle deadline firing',
  /function onStreamIdleDeadline\(\): void \{[\s\S]{0,300}streamIdleAborted = true/.test(claude),
)
// CRITICAL: the guard must be gated on a tool having actually streamed, else a
// PRE-tool watchdog stall (the common case) is wrongly converted to an errored turn.
check(
  'streamedToolUse is set only when a local tool_use block finishes streaming (content_block_stop)',
  /if \(contentBlock\.type === 'tool_use'\) \{[\s\S]{0,400}streamedToolUse = true/.test(claude),
)
check(
  'streamedToolUse defaults false (a pre-tool stall keeps the recovering fallback)',
  /let streamedToolUse = false/.test(claude),
)

section('PT-2: the model_error path synthesizes missing tool_results (no next-turn 400)')
// (The phantom-spinner discard needle died with StreamingToolExecutor — the
// native-core T9 cut deleted the permanently-gated executor; runTools is the
// one tool path and registers nothing before the tool round starts. The
// model lane itself lives in the run-core TurnMachine since the T8 cut.)
const query = readFileSync(join(import.meta.dir, '..', '..', 'src', 'run-core', 'turn-machine.ts'), 'utf-8')
const meIdx = query.indexOf("reason: 'model_error'")
check('the turn machine has the model_error terminal', meIdx !== -1)
const catchIdx = query.lastIndexOf('} catch (error) {', meIdx)
const modelErrCatch = catchIdx !== -1 && meIdx !== -1 ? query.slice(catchIdx, meIdx) : ''
check(
  'the model_error catch still synthesizes the missing tool_result pairings (no next-turn 400)',
  /emitSyntheticSettlements/.test(modelErrCatch),
)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL STREAM-WATCHDOG PROOFS PASS')
else console.log(`❌ ${failures} STREAM-WATCHDOG PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
