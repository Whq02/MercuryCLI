#!/usr/bin/env bun
import type { LegacyQueryYield } from '../../src/run-core/project-legacy.ts'
import { settledSidechainMessages } from '../../src/utils/sessionStorage/settledSidechainMessages.ts'
import { makeTally } from './crew-world.ts'

const tally = makeTally('prove-sidechain-progress')
const assistant = { type: 'assistant', uuid: 'response', message: { content: [], usage: { output_tokens: 0 } } }
const notice = { type: 'system', subtype: 'api_error', uuid: 'retry', retryInMs: 1000 }
const observed: LegacyQueryYield[] = []
const handedOn: LegacyQueryYield[] = []
let noticeWasImmediate = false
let pendingWasPrivate = false
let publishedUsage = -1
async function* source(): AsyncGenerator<LegacyQueryYield> {
  yield { type: 'stream_event', event: { type: 'message_start' } } as LegacyQueryYield
  yield assistant as LegacyQueryYield
  yield notice as LegacyQueryYield
  noticeWasImmediate = observed.includes(notice as LegacyQueryYield)
  pendingWasPrivate = handedOn.every(item => item.type === 'stream_event')
  assistant.message.usage.output_tokens = 19
  yield { type: 'stream_event', event: { type: 'message_stop' } }
}
for await (const item of settledSidechainMessages(source(), item => {
  observed.push(item)
  if (item.type === 'assistant') publishedUsage = item.message.usage.output_tokens
})) handedOn.push(item)
tally.check('recovery progress reaches its raw observer before the response settles', noticeWasImmediate)
tally.check('the observer sees the raw assistant once, without publishing its unsettled row', publishedUsage === 0 && observed.filter(item => item.type === 'assistant').length === 1 && pendingWasPrivate)
tally.check('the hand-back still receives one settled assistant followed by its notice', handedOn.filter(item => item.type !== 'stream_event').map(item => 'uuid' in item ? item.uuid : '').join(',') === 'response,retry' && assistant.message.usage.output_tokens === 19)
tally.check('the progress observer sees every raw event exactly once', observed.length === 4)
tally.finish()
