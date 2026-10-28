import { marked } from 'marked'
import { setClipboardWithReceipt, type ClipboardReceipt } from '../../ink/termio/osc.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { stripPromptXMLTags } from '../../utils/messages.js'

const LOOK_BACK_CAP = 20

export const COPY_WORDS = {
  copied: (characters: number) => `copied · ${characters} characters`,
  copiedThroughTerminal: (characters: number) =>
    `copied through the terminal · ${characters} characters (if nothing pastes, allow clipboard writes in your terminal)`,
  noRoad: 'nothing copied: no clipboard tool answered and this terminal takes no clipboard writes',
  noReply: 'nothing to copy yet: no reply in this session',
  noCode: 'nothing to copy: no fenced code block in the recent replies',
  onlyOne: 'only 1 reply to copy',
  onlyN: (count: number) => `only ${count} replies to copy`,
  usage: (received: string) => `/copy takes a whole number (1 is the last reply) or code; received: ${received}`,
} as const

export function collectReplies(messages: readonly Message[]): string[] {
  const replies: string[] = []
  let open: { id: string; parts: string[] } | null = null
  const close = (): void => {
    if (open !== null && open.parts.length > 0) replies.push(open.parts.join('\n\n'))
    open = null
  }
  for (let i = messages.length - 1; i >= 0 && replies.length < LOOK_BACK_CAP; i--) {
    const message = messages[i]
    if (message?.type === 'user') {
      close()
      continue
    }
    if (message?.type !== 'assistant') continue
    const assistant = message as AssistantMessage
    if (assistant.isApiErrorMessage) {
      close()
      continue
    }
    const content = assistant.message.content
    if (!Array.isArray(content)) continue
    const id = typeof assistant.message.id === 'string' ? assistant.message.id : ''
    if (open !== null && (id === '' || open.id !== id)) close()
    const texts = content
      .filter(block => (block as { type?: string }).type === 'text')
      .map(block => (block as { text?: string }).text ?? '')
      .filter(part => part !== '')
    if (texts.length === 0) continue
    if (open === null) open = { id, parts: [] }
    open.parts.unshift(...texts)
    if (id === '') close()
  }
  close()
  return replies
}

export function fencedCodeBlocks(text: string): string[] {
  const tokens = marked.lexer(stripPromptXMLTags(text))
  const blocks: string[] = []
  for (const token of tokens) {
    if (token.type === 'code' && (token as { codeBlockStyle?: string }).codeBlockStyle !== 'indented') {
      blocks.push(token.text)
    }
  }
  return blocks
}

export function lastFencedCodeBlock(replies: readonly string[]): string | null {
  for (const reply of replies) {
    const blocks = fencedCodeBlocks(reply)
    if (blocks.length > 0) return blocks[blocks.length - 1]!
  }
  return null
}

export function copyResultLine(receipt: ClipboardReceipt, text: string): string {
  const characters = [...text].length
  if (receipt.settled.length > 0) return COPY_WORDS.copied(characters)
  if (receipt.noRoad) return COPY_WORDS.noRoad
  return COPY_WORDS.copiedThroughTerminal(characters)
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<null> {
  const replies = collectReplies(context.messages)
  const trimmed = args.trim()

  let text: string
  if (trimmed === 'code') {
    const block = lastFencedCodeBlock(replies)
    if (block === null) {
      onDone(replies.length === 0 ? COPY_WORDS.noReply : COPY_WORDS.noCode)
      return null
    }
    text = block
  } else {
    let offset = 0
    if (trimmed !== '') {
      const parsed = Number(trimmed)
      if (!Number.isInteger(parsed) || parsed < 1) {
        onDone(COPY_WORDS.usage(trimmed))
        return null
      }
      offset = parsed - 1
    }
    if (replies.length === 0) {
      onDone(COPY_WORDS.noReply)
      return null
    }
    if (offset >= replies.length) {
      onDone(replies.length === 1 ? COPY_WORDS.onlyOne : COPY_WORDS.onlyN(replies.length))
      return null
    }
    text = replies[offset]!
  }

  const receipt = await setClipboardWithReceipt(text)
  if (receipt.sequence) process.stdout.write(receipt.sequence)
  onDone(copyResultLine(receipt, text))
  return null
}
