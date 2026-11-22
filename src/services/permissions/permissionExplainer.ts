import { z } from 'zod/v4'
import { getGlobalConfig } from '../../utils/config.js'
import { logError } from '../../utils/log.js'
import { logForDebugging } from '../../utils/debug.js'
import type { Message } from '../../types/message.js'
import { getEngineModel } from '../model/model.js'
import { sideQuery } from '../api/sideQuery.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type RiskLevel = Unbuilt

export type PermissionExplanation = Unbuilt

export function isPermissionExplainerEnabled(): boolean {
  return notBuilt('src/services/permissions/permissionExplainer.ts:20')
}

function extractConversationContext(messages: Message[]): string {
  const assistantTexts: string[] = []
  for (const message of messages) {
    if ((message as { type?: string }).type !== 'assistant') continue
    const content = (message as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block: { type?: string }) => block.type === 'text')
      .map((block: { text?: string }) => block.text ?? '')
      .join(' ')
    assistantTexts.push(text)
  }

  const lastThree = assistantTexts.slice(-3)
  let budget = 1000
  const keptNewestFirst: string[] = []
  for (let i = lastThree.length - 1; i >= 0; i--) {
    const piece = lastThree[i] as string
    if (piece === '') continue
    if (budget <= 0) continue
    if (piece.length > budget) {
      keptNewestFirst.push(piece.slice(0, budget - 1) + '…')
      budget = 0
    } else {
      keptNewestFirst.push(piece)
      budget -= piece.length
    }
  }
  return keptNewestFirst.reverse().join('\n\n')
}

export async function generatePermissionExplanation(args: {
  toolName: string
  toolInput: unknown
  toolDescription?: string
  messages?: Message[]
  signal: AbortSignal
}): Promise<PermissionExplanation | null> {
  return notBuilt('src/services/permissions/permissionExplainer.ts:65')
}
