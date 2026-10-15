import type { Message } from '../types/message.js'
import { isOperatorTurn } from '../utils/messages/operatorTurns.js'

export interface PinIntent {
  messageId: string
  text: string
}

export function latestPinIntent(messages: readonly Message[], agentId?: string): PinIntent | undefined {
  if (agentId) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type !== 'user' || !isOperatorTurn(message) || message.isVirtual || (message.origin && message.origin.kind !== 'human')) continue
    const content = message.message.content
    const text = typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    return { messageId: message.uuid, text }
  }
  return undefined
}

export function pinIntentSpan(intent: PinIntent | undefined, content: string): { start: number; end: number } | null {
  if (!intent?.messageId || !content.trim()) return null
  const text = intent.text
  const words = text.trim()
  if (/^(?:do\s+not|don['’]t|never)\s+(?:remember|pin|save|keep|make)\b/i.test(words)) return null
  const prefix = /^(?:please\s+)?(?:remember(?:\s+this)?\b|(?:make|keep|save|pin)\s+(?:this|it)\s+(?:as\s+)?(?:a\s+)?(?:standing\s+)?(?:rule|preference)\b|from\s+now\s+on\b|always\b|never\b)/i.exec(words)
  const suffix = /(?:[.!;]\s*|\n)(?:please\s+)?(?:remember\s+(?:this|that)|(?:make|keep|save|pin)\s+(?:this|it)\s+(?:as\s+)?(?:a\s+)?(?:standing\s+)?(?:rule|preference))\s*[.!]?$/i.test(words)
  if (!prefix && !suffix) return null
  if (!/\b(?:standing rule|rule|preference|from now on|always|never|I (?:like|prefer))\b/i.test(words)) return null
  const start = text.indexOf(content.trim())
  if (start < 0) return null
  const before = text.slice(0, start)
  if (/```|~~~|^\s*>/m.test(before) || /<\/?[a-z][^>]*>/i.test(before)) return null
  if (prefix && /\b(?:example|quote|document|draft|says|said|not\s+(?:a\s+)?rule)\b/i.test(before.slice(prefix[0].length))) return null
  return { start, end: start + content.trim().length }
}
