import type { Message, UserMessage } from '../../types/message.js'
import { isToolUseResultMessage } from './normalize.js'
import { textForResubmit } from './text.js'

export type AuthWallHold = { errorUuid: string; text: string; mode: 'prompt' | 'bash' }

export function promptBehindAuthWall(records: readonly Message[]): AuthWallHold | null {
  let i = records.length - 1
  while (i >= 0 && records[i]!.type !== 'assistant' && records[i]!.type !== 'user') i--
  const tail = records[i]
  if (tail === undefined || tail.type !== 'assistant' || tail.isApiErrorMessage !== true || tail.error !== 'authentication_failed') return null
  for (let j = i - 1; j >= 0; j--) {
    const row = records[j]!
    if (row.type === 'assistant') {
      if (row.isApiErrorMessage === true) continue
      return null
    }
    if (row.type !== 'user') continue
    if (row.isMeta === true) continue
    if (isToolUseResultMessage(row)) return null
    const words = textForResubmit(row as UserMessage)
    if (words === null || words.text.trim() === '') return null
    return { errorUuid: tail.uuid, text: words.text, mode: words.mode }
  }
  return null
}
