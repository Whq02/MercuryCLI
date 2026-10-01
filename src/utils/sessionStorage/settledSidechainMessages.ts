import type { LegacyQueryYield } from '../../run-core/project-legacy.js'

export async function* settledSidechainMessages(
  stream: AsyncIterable<LegacyQueryYield>,
): AsyncGenerator<LegacyQueryYield, void> {
  let responseOpen = false
  let pending: LegacyQueryYield[] = []
  try {
    for await (const item of stream) {
      if (item.type === 'stream_event') {
        if (item.event.type === 'message_start') {
          yield* pending.splice(0)
          responseOpen = true
        } else if (item.event.type === 'message_stop') {
          responseOpen = false
          yield* pending.splice(0)
        }
        yield item
      } else if (item.type === 'stream_request_start') {
        yield* pending.splice(0)
        responseOpen = false
        yield item
      } else if (item.type === 'tombstone') {
        const retained = pending.filter(candidate => !('uuid' in candidate) || candidate.uuid !== item.message.uuid)
        if (retained.length !== pending.length) pending = retained
        else yield item
      } else if (responseOpen) {
        pending.push(item)
      } else {
        yield item
      }
    }
  } catch (error) {
    yield* pending.splice(0)
    throw error
  }
  yield* pending
}
