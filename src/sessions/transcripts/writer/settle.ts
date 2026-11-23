import { isDeepStrictEqual } from 'node:util'
import type { Entry } from '../transcriptEntries.js'
import type { Message } from '../../../engine/message-shapes/message.js'
import { SYNTHETIC_MODEL } from '../../../engine/message-shapes/factories.js'
import { jsonParse, jsonStringify } from '../../../platform/logs/slowOperations.js'
import { cleanForTranscript } from '../chain.js'
import { encodeTranscriptLine } from '../vnext.js'
import type { QueuePart } from './queue.js'

interface SettleNeeds {
  enqueueRawLine: QueuePart['enqueueRawLine']
  writeQueues(): QueuePart['writeQueues']
  shouldSkipPersistence(): boolean
}

type OpenMessage = {
  file: string
  entry: Entry
  semanticLine: string
  creationOrdinal?: string
  queued?: { line: string; resolve: () => void }
}

type OpenReply = { id: string; messages: Map<string, OpenMessage> }

export class SettlePart {
  private settleState = new Map<string, { reply?: OpenReply; minted?: OpenReply }>()
  private settledBeforeRecord = new Map<string, Message>()

  constructor(private readonly needs: SettleNeeds) {}

  resetSettled(): void {
    this.settleState = new Map()
    this.settledBeforeRecord = new Map()
  }

  closeTranscript(file: string): void {
    this.settleState.delete(file)
  }

  private openReply(file: string, message: { id: string; model: string }): Map<string, OpenMessage> {
    let open = this.settleState.get(file)
    if (open === undefined) this.settleState.set(file, (open = {}))
    const slot = message.model === SYNTHETIC_MODEL ? 'minted' : 'reply'
    const reply = open[slot]
    if (reply?.id === message.id) return reply.messages
    const messages = new Map<string, OpenMessage>()
    open[slot] = { id: message.id, messages }
    return messages
  }

  private openMessage(uuid: string): OpenMessage | undefined {
    for (const open of this.settleState.values()) {
      const message = open.reply?.messages.get(uuid) ?? open.minted?.messages.get(uuid)
      if (message !== undefined) return message
    }
    return undefined
  }

  enqueueMessageWrite(file: string, entry: Entry): void {
    if (entry.type === 'user' || entry.type === 'assistant') {
      const settled = this.settledBeforeRecord.get(entry.uuid)
      if (settled !== undefined) {
        this.settledBeforeRecord.delete(entry.uuid)
        const [cleaned] = cleanForTranscript([settled])
        if (cleaned) entry = { ...entry, ...cleaned } as Entry
      }
    }
    const encoded = encodeTranscriptLine(file, entry as Record<string, unknown>)
    const line = encoded.line
    if (entry.type === 'assistant') {
      const state: OpenMessage = {
        file,
        entry,
        semanticLine: jsonStringify(entry) + '\n',
        ...(encoded.record
          ? { creationOrdinal: String(encoded.record.creationOrdinal) }
          : {}),
      }
      void this.needs.enqueueRawLine(file, line, item => {
        state.queued = item
      }).then(() => {
        state.queued = undefined
      })
      this.openReply(file, entry.message).set(entry.uuid, state)
    } else {
      void this.needs.enqueueRawLine(file, line, undefined, encoded.record)
    }
  }

  async settleMessage(message: Message): Promise<void> {
    if (this.needs.shouldSkipPersistence()) return
    const cached = this.openMessage(message.uuid)
    if (!cached) {
      this.settledBeforeRecord.set(message.uuid, message)
      return
    }
    const [cleaned] = cleanForTranscript([message])
    if (!cleaned) return
    const settled = { ...cached.entry, ...cleaned } as Entry
    const semanticLine = jsonStringify(settled) + '\n'
    if (semanticLine === cached.semanticLine || isDeepStrictEqual(jsonParse(semanticLine), jsonParse(cached.semanticLine))) return
    const line = encodeTranscriptLine(
      cached.file,
      settled as Record<string, unknown>,
      {
        ...(cached.creationOrdinal
          ? { settleCreationOrdinal: cached.creationOrdinal }
          : {}),
      },
    ).line
    cached.entry = settled
    cached.semanticLine = semanticLine
    const queue = this.needs.writeQueues().get(cached.file)
    if (cached.queued && queue && queue.includes(cached.queued)) {
      cached.queued.line = line
      return
    }
    cached.queued = undefined
    await this.needs.enqueueRawLine(cached.file, line)
  }
}
