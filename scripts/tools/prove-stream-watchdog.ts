#!/usr/bin/env bun
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' stream idle watchdog — default-ON (HB-0119)')
console.log('============================================================')


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
  ended ? '' : `the model call's catch (streamModel, src/engine/loop/turn/streamModel.ts) must end the run { reason: 'model_error', error }; the run ended ${JSON.stringify(failed.terminal)}`,
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
