import { createHash } from 'node:crypto'

import { MERCURY_VERSION } from '../constants/product.js'
import type { Message } from '../types/message.js'

/**
 * A 3-character attribution fingerprint derived from the first user
 * message. The salt, the character indices, the substitution character, the
 * concatenation order, the SHA-256 and the 3-character truncation are all a
 * cross-service contract validated by the provider gateways — none of it
 * may change without coordinating with every gateway.
 */

/** Must match the backend validators exactly. */
export const FINGERPRINT_SALT = '59cf53e54c78'

const CHARACTER_INDICES = [4, 7, 20]
const SUBSTITUTE_CHARACTER = '0'

const SYSTEM_REMINDER_OPEN = '<system-reminder>'

/**
 * The operator's first message text: the first NON-meta user message's first
 * text block that is not a system-reminder envelope (a string content
 * directly), else empty. Meta rows and reminder blocks are the harness's
 * own context — a per-turn reminder, the user-context row, an announcement
 * — and they move (a reminder re-emitted on resume, a context row rebuilt
 * on a new day) while the operator's prompt persists byte-identical; the
 * attribution line rides the top-level system prompt, which every thinking
 * block in the conversation is bound to, so the fingerprint must be stable
 * for the life of the conversation.
 */
export function extractFirstMessageText(messages: readonly Message[]): string {
  for (const message of messages) {
    if (message.type !== 'user' || message.isMeta === true) continue
    const content = message.message.content
    if (typeof content === 'string') {
      if (content.startsWith(SYSTEM_REMINDER_OPEN)) continue
      return content
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text') {
        const text = (block as { text?: unknown }).text
        if (typeof text !== 'string') return ''
        if (text.startsWith(SYSTEM_REMINDER_OPEN)) continue
        return text
      }
    }
  }
  return ''
}

/**
 * The characters at UTF-16 code-unit indices 4, 7 and 20 (a surrogate half
 * counts as a character; past-the-end indices substitute `0`), concatenated
 * after the salt and before the version, SHA-256'd, first 3 hex characters.
 */
export function computeFingerprint(messageText: string, version: string): string {
  const picked = CHARACTER_INDICES.map(index =>
    index < messageText.length ? messageText.charAt(index) : SUBSTITUTE_CHARACTER,
  ).join('')
  return createHash('sha256').update(`${FINGERPRINT_SALT}${picked}${version}`).digest('hex').slice(0, 3)
}

export function computeFingerprintFromMessages(messages: readonly Message[]): string {
  return computeFingerprint(extractFirstMessageText(messages), MERCURY_VERSION)
}
