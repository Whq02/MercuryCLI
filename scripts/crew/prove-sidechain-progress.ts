#!/usr/bin/env bun
import type { LegacyTurnYield } from '../../src/engine/loop/project-legacy.ts'
import { settledSidechainMessages } from '../../src/sessions/transcripts/settledSidechainMessages.ts'
import { makeTally } from './crew-world.ts'

const tally = makeTally('prove-sidechain-progress')
const assistant = { type: 'assistant', uuid: 'response', message: { content: [], usage: { output_tokens: 0 } } }
const notice = { type: 'system', subtype: 'api_error', uuid: 'retry', retryInMs: 1000 }
const observed: LegacyTurnYield[] = []
const handedOn: LegacyTurnYield[] = []
let noticeWasImmediate = false
let pendingWasPrivate = false
let publishedUsage = -1
async function* source(): AsyncGenerator<LegacyTurnYield> {
  yield { type: 'stream_event', event: { type: 'message_start' } } as LegacyTurnYield
  yield assistant as LegacyTurnYield
  yield notice as LegacyTurnYield
  noticeWasImmediate = observed.includes(notice as LegacyTurnYield)
  pendingWasPrivate = handedOn.every(item => item.type === 'stream_event')
  assistant.message.usage.output_tokens = 19
  yield { type: 'stream_event', event: { type: 'message_stop' } }
}
for await (const item of settledSidechainMessages(source(), item => {
  observed.push(item)
  if (item.type === 'assistant') publishedUsage = item.message.usage.output_tokens
})) handedOn.push(item)
tally.check('recovery progress reaches its raw observer before the response settles', noticeWasImmediate, 'settledSidechainMessages in src/sessions/transcripts/settledSidechainMessages.ts must call onProgress for each item as it arrives, before holding any row back')
tally.check('the observer sees the raw assistant once, without publishing its unsettled row', publishedUsage === 0 && observed.filter(item => item.type === 'assistant').length === 1 && pendingWasPrivate, `usage seen by the observer ${publishedUsage}, assistant rows observed ${observed.filter(item => item.type === 'assistant').length}, hand-back stayed private ${pendingWasPrivate} \u2014 settledSidechainMessages in src/sessions/transcripts/settledSidechainMessages.ts must show the observer each raw item once and hand an assistant row back only at message_stop`)
tally.check('the hand-back still receives one settled assistant followed by its notice', handedOn.filter(item => item.type !== 'stream_event').map(item => 'uuid' in item ? item.uuid : '').join(',') === 'response,retry' && assistant.message.usage.output_tokens === 19, `${handedOn.filter(item => item.type !== 'stream_event').map(item => 'uuid' in item ? item.uuid : '').join(',')} \u2014 settledSidechainMessages in src/sessions/transcripts/settledSidechainMessages.ts must hand back the held assistant row, then the notice, at message_stop`)
tally.check('the progress observer sees every raw event exactly once', observed.length === 4, `${observed.length} items observed, expected 4 \u2014 settledSidechainMessages in src/sessions/transcripts/settledSidechainMessages.ts must call onProgress once per source item`)
tally.finish()
