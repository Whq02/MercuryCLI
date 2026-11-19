#!/usr/bin/env bun

import * as rig from '../core-runtime/turnScenarios.ts'

const { runToolCalls } = await import('../../src/run-core/turn/runToolCalls.ts')
const { afterTools } = await import('../../src/run-core/turn/afterTools.ts')
const queue = await import('../../src/utils/messageQueueManager.ts')

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}


console.log('============================================================')
console.log(' Turn-engine preserve-contracts (R7) — the off-dist core')
console.log('============================================================')

console.log('\n── the tool-round attachment pass ──')
{
  const QUEUED = '22222222-2222-4222-8222-222222222222'
  const planted = await rig.plantReply({
    before: () => {
      queue.enqueue({ value: 'a line queued while the tools ran', mode: 'prompt', uuid: QUEUED } as never)
    },
    script: [rig.fixtures.yields(rig.fixtures.calls('tu_contract_1', 'EchoTool', { text: 'x' }))],
  })
  await rig.drain(runToolCalls(planted.run as never, planted.iter as never))
  const after = await rig.drain(afterTools(planted.run as never, planted.iter as never))
  const yielded = after.events.filter(event => event.kind === 'attachment').map(event => event.message)
  const carried = ((after.decision as { next?: { messages?: unknown[] } }).next?.messages ?? []) as unknown[]
  const result = carried.findIndex(row => JSON.stringify(row).includes('tu_contract_1') && (row as { type?: string }).type === 'user')
  check('the turn machine gathers attachments on tool rounds: a line queued while the tools ran comes out as an attachment row', rig.reasonOf(after.decision) === 'hand_over next_turn' && yielded.length >= 1 && JSON.stringify(yielded).includes('a line queued while the tools ran'))
  check('tool-round attachments are yielded and then carried: the next round is handed the very rows, after the tool result', yielded.length >= 1 && result >= 0 && yielded.every(row => carried.indexOf(row) > result))
  planted.close()
}


console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ TURN-ENGINE CONTRACTS GREEN')
else console.log(`❌ ${failures} TURN-ENGINE CONTRACT FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
