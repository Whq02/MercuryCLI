import type { RenderableMessage } from '../../types/message.js'
import { isTurnBoundary } from '../../utils/cockpit/turnReceipt.js'
import { thinkingTextWithheld } from './AssistantThinkingMessage.js'
import { notBuilt } from '../../pi/holes.js'

type Thinking = { thinking?: string; signature?: string }

export function withheldThinkingDisclosure(rows: RenderableMessage[]): {
  hidden: Set<string>
  byRow: Map<string, Thinking>
} {
  return notBuilt('src/components/messages/withheldThinkingDisclosure.ts:7')
}
