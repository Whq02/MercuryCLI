import { createHash } from 'node:crypto'

import { MERCURY_VERSION } from '../constants/product.js'
import type { Message } from '../types/message.js'


export const FINGERPRINT_SALT = '59cf53e54c78'

const CHARACTER_INDICES = [4, 7, 20]
const SUBSTITUTE_CHARACTER = '0'

const SYSTEM_REMINDER_OPEN = '<system-reminder>'

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

export function computeFingerprint(messageText: string, version: string): string {
  const picked = CHARACTER_INDICES.map(index =>
    index < messageText.length ? messageText.charAt(index) : SUBSTITUTE_CHARACTER,
  ).join('')
  return createHash('sha256').update(`${FINGERPRINT_SALT}${picked}${version}`).digest('hex').slice(0, 3)
}

export function computeFingerprintFromMessages(messages: readonly Message[]): string {
  return computeFingerprint(extractFirstMessageText(messages), MERCURY_VERSION)
}
