#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }



const { emptyRunSnapshot, reduceRunEvent } = await import('../../src/engine/run/runKernel.ts')

let failures = 0
const failureWhere = 'change the model-transition case of reduceRunEvent (and emptyRunSnapshot) in src/engine/run/runKernel.ts so modelState carries current, pendingNext and the last receipt as the check says'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ' — ' + (detail ? detail + ' — ' : '') + failureWhere : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§A the kernel fold — durable, merging, additive')
{
  const s0 = emptyRunSnapshot({
    runId: 'run-a04',
    owner: 'a04-owner' as never,
    objective: 'prove the projection',
    rootMessageId: null,
    at: 1,
  })
  check('the empty snapshot carries no modelState', s0.modelState === undefined)

  const queued = reduceRunEvent(s0, {
    type: 'model-transition',
    at: 2,
    current: 'claude-opus-5',
    pendingNext: 'gpt-5.2',
  })
  check(
    'a queue note lands current + pendingNext',
    queued.modelState?.current === 'claude-opus-5' && queued.modelState?.pendingNext === 'gpt-5.2',
  )

  const settledEvent = {
    type: 'model-transition',
    at: 3,
    current: 'gpt-5.2',
    pendingNext: null,
    last: {
      previous: 'claude-opus-5',
      applied: 'gpt-5.2',
      resolution: 'applied',
      boundary: 'turn-boundary',
      crossProvider: true,
    },
  } as const
  const settled = reduceRunEvent(queued, settledEvent as never)
  check(
    'a settlement note lands the receipt summary (old/current/next complete)',
    settled.modelState?.last?.previous === 'claude-opus-5' &&
      settled.modelState?.last?.applied === 'gpt-5.2' &&
      settled.modelState?.last?.boundary === 'turn-boundary' &&
      settled.modelState?.last?.crossProvider === true,
  )

  const afterClear = reduceRunEvent(settled, {
    type: 'model-transition',
    at: 4,
    current: 'gpt-5.2',
    pendingNext: null,
  } as never)
  check(
    'a receipt-less note (consume-and-clear seam) KEEPS the settlement',
    afterClear.modelState?.last?.applied === 'gpt-5.2' && afterClear.modelState?.pendingNext === null,
  )
}


console.log(failures === 0 ? '\n ✅ MODEL STATE IS DURABLE + ACP-VISIBLE' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
