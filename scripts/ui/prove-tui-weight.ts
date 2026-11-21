#!/usr/bin/env bun
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}
const tailStoreHint = 'change createStreamingTailStore in src/utils/messages/streamingTailStore.ts'
const streamHint = 'change handleMessageFromStream in src/utils/messages/streaming.ts'
const receiptHint = 'change injectTurnReceipts in src/utils/cockpit/turnReceipt.ts'

console.log('============================================================')
console.log(' TUI weight/jump sources — proof')
console.log('============================================================')


{
  const { createStreamingTailStore } = await import('../../src/utils/messages/streamingTailStore.ts')
  let pending: (() => void) | null = null
  let sinks = 0
  const tail = createStreamingTailStore({
    now: () => 0,
    setTimer: fn => { pending = fn; return 1 },
    clearTimer: () => { pending = null },
  })
  tail.subscribe(() => sinks++)
  tail.update(() => '')
  check('the live tail opening publishes immediately', sinks === 1, `sinks ${sinks}`, tailStoreHint)
  for (let i = 0; i < 100; i++) tail.update(cur => (cur ?? '') + 'x')
  check('the storm coalesces behind one trailing publish', sinks === 1 && pending !== null, `sinks ${sinks}, trailing publish ${pending !== null ? 'pending' : 'missing'}`, tailStoreHint)
  check('the live tail stays ref-fresh during the storm', tail.read() === 'x'.repeat(100), '', tailStoreHint)
  ;(pending as (() => void) | null)?.()
  check('the trailing publish carries the complete value', sinks === 2 && tail.getSnapshot() === tail.read(), `sinks ${sinks}`, tailStoreHint)
  tail.update(() => null)
  check('settlement clears immediately and retains the final text', sinks === 3 && tail.getSnapshot() === null && tail.readSettled() === 'x'.repeat(100), `sinks ${sinks}`, tailStoreHint)
  tail.dispose()
}
{
  {
    const { handleMessageFromStream } = await import('../../src/utils/messages/streaming.ts')
    type Update = { updater: (current: never[]) => unknown; opts: { silent?: boolean; flushSilent?: boolean } | undefined }
    const updates: Update[] = []
    const drive = (event: Record<string, unknown>): void =>
      handleMessageFromStream(
        { type: 'stream_event', event } as never,
        () => {},
        () => {},
        () => {},
        ((updater: Update['updater'], opts?: Update['opts']) => { updates.push({ updater, opts }) }) as never,
      )
    drive({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } })
    check('input_json_delta routes through the silent path', updates.length === 1 && updates[0]!.opts?.silent === true, JSON.stringify(updates[0]?.opts), streamHint)
    drive({ type: 'message_stop' })
    const empty: never[] = []
    const cleared = updates[updates.length - 1]!.updater(empty)
    check('message_stop clear is identity when already empty', updates.length === 2 && cleared === empty, `updates ${updates.length}`, streamHint)
    check('message_stop clear empties a populated list', updates[1]!.updater([{ index: 0 }] as never) !== empty && (updates[1]!.updater([{ index: 0 }] as never) as unknown[]).length === 0, '', streamHint)
  }
}


{
  const { injectTurnReceipts } = await import('../../src/utils/cockpit/turnReceipt.ts')
  process.env.MERCURY_TURN_RECEIPT = '1'
  const boundary = (uuid: string, text: string) => ({
    type: 'user',
    uuid,
    message: { content: [{ type: 'text', text }] },
  })
  const toolUse = (uuid: string) => ({
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'tool_use', name: 'Read', id: `t-${uuid}`, input: {} }] },
  })
  const base = [boundary('u1', 'do the thing'), toolUse('a1')]
  const withMore = [...base, toolUse('a2'), toolUse('a3')]
  const r1 = injectTurnReceipts(base as never) as Array<{ type: string; uuid: string }>
  const r2 = injectTurnReceipts(withMore as never) as Array<{ type: string; uuid: string }>
  const tail1 = r1.find(m => m.type === 'turn_receipt')
  const tail2 = r2.find(m => m.type === 'turn_receipt')
  check(
    'live tail receipt keeps ONE identity as messages append',
    tail1 !== undefined && tail2 !== undefined && tail1.uuid === tail2.uuid,
    `${tail1?.uuid} vs ${tail2?.uuid}`,
    receiptHint,
  )
  check('the identity derives from the turn boundary', tail1?.uuid === 'u1-turn-receipt', `${tail1?.uuid}`, receiptHint)
  const twoTurns = [
    boundary('u1', 'first'),
    toolUse('a1'),
    boundary('u2', 'second'),
    toolUse('b1'),
  ]
  const r3 = injectTurnReceipts(twoTurns as never) as Array<{ type: string; uuid: string }>
  const receipts = r3.filter(m => m.type === 'turn_receipt').map(m => m.uuid)
  check(
    'each turn owns its receipt identity',
    receipts.length === 2 && receipts[0] === 'u1-turn-receipt' && receipts[1] === 'u2-turn-receipt',
    receipts.join(', '),
    receiptHint,
  )
  delete process.env.MERCURY_TURN_RECEIPT
}


console.log('\n' + '═'.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} TUI-WEIGHT CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL TUI-WEIGHT PROOFS PASS')
