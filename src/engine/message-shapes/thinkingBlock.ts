import type { ContentBlock, ContentBlockParam, RedactedThinkingBlock, RedactedThinkingBlockParam, ThinkingBlock, ThinkingBlockParam } from './wire.js'
import { isReasoningContent } from '../rows/content.js'

type ThinkingBlockType = ThinkingBlock | RedactedThinkingBlock | ThinkingBlockParam | RedactedThinkingBlockParam

export function isThinkingBlock(block: ContentBlockParam | ContentBlock): block is ThinkingBlockType {
  return isReasoningContent(block)
}
