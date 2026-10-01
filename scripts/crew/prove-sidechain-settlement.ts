#!/usr/bin/env bun
import type { LegacyQueryYield } from '../../src/run-core/project-legacy.ts'
import { settledSidechainMessages } from '../../src/utils/sessionStorage/settledSidechainMessages.ts'
import { makeTally } from './crew-world.ts'

const tally = makeTally('prove-sidechain-settlement')
const event = (type: string): LegacyQueryYield => ({ type: 'stream_event', event: { type } }) as LegacyQueryYield
const message = (uuid: string, type = 'assistant') => ({ type, uuid, message: { content: uuid, usage: { output_tokens: 0 }, stop_reason: null as string | null }, apexProviderTurn: undefined as unknown })
const first = message('first')
const last = message('last')
const attachment = message('attachment', 'attachment')
const result = message('result', 'user')
const delivered: typeof first[] = []
let deltaBeforeRows = false
let settled = false
async function* response(): AsyncGenerator<LegacyQueryYield> {
  yield event('message_start')
  yield first as unknown as LegacyQueryYield
  yield attachment as unknown as LegacyQueryYield
  yield event('content_block_delta')
  deltaBeforeRows = delivered.length === 0
  yield last as unknown as LegacyQueryYield
  last.message.usage.output_tokens = 29
  last.message.stop_reason = 'tool_use'
  last.apexProviderTurn = { responseId: 'fixture-receipt' }
  settled = true
  yield event('message_delta')
  yield event('message_stop')
  yield result as unknown as LegacyQueryYield
}
for await (const item of settledSidechainMessages(response())) {
  if (item.type === 'stream_event') continue
  tally.check('a streamed row reaches the consumer only after settlement', settled)
  delivered.push(item as unknown as typeof first)
}
tally.check('stream progress remains immediate while message rows await settlement', deltaBeforeRows)
tally.check('multiple blocks and interleaved attachments retain their order', delivered.map(item => item.uuid).join(',') === 'first,attachment,last,result')
tally.check('the settled row carries the final usage, stop reason and replay receipt together', delivered[2] === last && last.message.usage.output_tokens === 29 && last.message.stop_reason === 'tool_use' && (last.apexProviderTurn as { responseId?: string }).responseId === 'fixture-receipt')

for (const ending of ['close', 'throw', 'restart', 'retract', 'plain'] as const) {
  const row = message(ending)
  const seen: LegacyQueryYield[] = []
  const failure = new Error('fixture interrupted stream')
  let caught: unknown
  async function* source(): AsyncGenerator<LegacyQueryYield> {
    if (ending !== 'plain') yield event('message_start')
    yield row as unknown as LegacyQueryYield
    if (ending === 'throw') throw failure
    if (ending === 'restart') yield { type: 'stream_request_start' }
    if (ending === 'retract') yield { type: 'tombstone', message: row } as unknown as LegacyQueryYield
  }
  try {
    for await (const item of settledSidechainMessages(source())) seen.push(item)
  } catch (error) {
    caught = error
  }
  const rows = seen.filter(item => 'uuid' in item)
  tally.check(`${ending}: every retained row is handed off once, retracted rows never are`, ending === 'retract' ? rows.length === 0 && seen.every(item => item.type !== 'tombstone') : rows.length === 1 && rows[0] === row)
  tally.check(`${ending}: the stream outcome is preserved`, ending === 'throw' ? caught === failure : caught === undefined)
}
tally.finish()
