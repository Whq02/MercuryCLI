#!/usr/bin/env bun
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
const _apiDir = join(import.meta.dir, '..', '..', 'src', 'services', 'providers', 'anthropic')
const runtime = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'providers', 'anthropic', 'index.ts'), 'utf-8') + readdirSync(_apiDir).filter(f => f.endsWith('.ts')).map(f => readFileSync(join(_apiDir, f), 'utf-8')).join('\n')
const budget = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'providers', 'streamIdleBudget.ts'), 'utf-8')

console.log('============================================================')
console.log(' stream idle watchdog — default-ON (HB-0119)')
console.log('============================================================')

section('source: the watchdog is ALWAYS armed — no enablement gate, no env spelling')
check('the watchdog is the one owner\'s, created at stream start with no gate between', runtime.includes('const streamIdleWatchdog = createStreamIdleWatchdog({') && runtime.includes('timeoutMs: STREAM_IDLE_TIMEOUT_MS,'))
check('the one owner serves BOTH thresholds (the fire at the budget, the warning at its own point — half, never before five minutes, never after the budget) and the stream wires both', /const warningMs = streamIdleWarningMsOf\(timeoutMs\)/.test(budget) && /onWarning\?: \(silentMs: number\) => void/.test(budget) && /onFire\?: \(fire: StreamIdleFire\) => void/.test(budget) && /onWarning: \(\) => \{/.test(runtime) && /onFire: \(\) => \{/.test(runtime))
check('no watchdog enablement variable exists', !/streamWatchdogEnabled/.test(runtime))
check('no retired watchdog env spelling survives', !/STREAM_WATCHDOG/.test(runtime))

section('PT-1: a watchdog abort skips the non-streaming fallback (no inc-4258 double-exec)')
check(
  'disableFallback trips on (streamIdleAborted && streamedToolUse) — unconditional',
  /const disableFallback =[\s\S]{0,700}\(streamIdleAborted && streamedToolUse\)/.test(runtime),
)
check(
  'the watchdog signal streamIdleAborted is still set by the idle deadline firing',
  /onFire: \(\) => \{\s*streamIdleAborted = true/.test(runtime),
)
check(
  'streamedToolUse is set only when a local tool_use block finishes streaming (content_block_stop)',
  /if \(contentBlock\.type === 'tool_use'\) \{[\s\S]{0,400}streamedToolUse = true/.test(runtime),
)
check(
  'streamedToolUse defaults false (a pre-tool stall keeps the recovering fallback)',
  /let streamedToolUse = false/.test(runtime),
)

section('PT-2: the model_error path synthesizes missing tool_results (no next-turn 400)')
const t = await import('../core-runtime/turnScenarios.ts')
const thrown = new Error('the stream went idle and the request was aborted')
const failed = await t.runScripted({
  script: [[...t.fixtures.yields(t.fixtures.calls('toolu_streamed', 'EchoTool', { text: 'x' })), { kind: 'throw', error: thrown }]],
})
const ended = failed.terminal.reason === 'model_error' && failed.terminal.error === thrown && failed.events.at(-1)?.kind === 'run_terminal'
check(
  'a model call that throws ends the run with the model_error terminal, the error on it',
  ended,
  ended ? '' : `the model call's catch (streamModel, src/run-core/turn/streamModel.ts) must end the run { reason: 'model_error', error }; the run ended ${JSON.stringify(failed.terminal)}`,
)
const pairings = failed.events.filter(event => event.kind === 'tool_settled')
const paired = pairings.map(event => {
  const block = ((event.message as { message: { content: Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }> } }).message.content)[0]
  return `${String(event.toolUseId)} ${String(event.outcome)} synthetic=${String(event.synthetic)} ${String(block?.type)} for ${String(block?.tool_use_id)} is_error=${String(block?.is_error)}: ${String(block?.content)}`
})
const synthesized =
  paired.join(' | ') === `toolu_streamed error synthetic=true tool_result for toolu_streamed is_error=true: ${thrown.message}` &&
  !failed.events.some(event => event.kind === 'tool_started')
check(
  'the model_error catch still synthesizes the missing tool_result pairings (no next-turn 400)',
  synthesized,
  synthesized ? '' : `the same catch must settle each tool_use the cut reply announced with a synthetic error tool_result before it ends, and run none of them; the run settled [${paired.join(' | ')}]`,
)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL STREAM-WATCHDOG PROOFS PASS')
else console.log(`❌ ${failures} STREAM-WATCHDOG PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
