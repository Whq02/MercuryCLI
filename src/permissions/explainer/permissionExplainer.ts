import { z } from 'zod/v4'
import { getGlobalConfig } from '../../platform/settings/config.js'
import { logError } from '../../platform/logs/errorLog.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { Message } from '../../engine/message-shapes/message.js'
import type { RiskLevel } from '../rules/permissions.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import { sideQuery } from '../../engine/requests/sideRequest.js'

export type { RiskLevel }

export type PermissionExplanation = {
  explanation: string
  reasoning: string
  risk: string
  riskLevel: RiskLevel
}

const PermissionExplanationSchema = z.object({
  explanation: z.string(),
  reasoning: z.string(),
  risk: z.string(),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
})

const EXPLAINER_SYSTEM_PROMPT =
  'Look at the shell command the agent wants to run and account for it on three axes: what it does, why the caller is running it, and how it could go wrong.'

const EXPLAIN_COMMAND_TOOL_NAME = 'explain_command'

const EXPLAIN_COMMAND_TOOL = {
  name: EXPLAIN_COMMAND_TOOL_NAME,
  description: 'Reports an explanation of a shell command.',
  input_schema: {
    type: 'object' as const,
    properties: {
      explanation: { type: 'string', description: 'What the command does, in 1-2 sentences.' },
      reasoning: { type: 'string', description: 'Why I am running it, in the first person ("I need to …").' },
      risk: { type: 'string', description: 'What could go wrong, under 15 words.' },
      riskLevel: {
        type: 'string',
        enum: ['LOW', 'MEDIUM', 'HIGH'],
        description: 'LOW: safe dev workflows. MEDIUM: recoverable changes. HIGH: dangerous or irreversible.',
      },
    },
    required: ['explanation', 'reasoning', 'risk', 'riskLevel'],
  },
}

export function isPermissionExplainerEnabled(): boolean {
  return getGlobalConfig().permissionExplainerEnabled !== false
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
  if (!isPermissionExplainerEnabled()) {
    return null
  }
  const sections: string[] = [`Tool: ${args.toolName}`]
  if (args.toolDescription) {
    sections.push(`Description: ${args.toolDescription}`)
  }
  let serializedInput: string
  if (typeof args.toolInput === 'string') {
    serializedInput = args.toolInput
  } else {
    try {
      serializedInput = JSON.stringify(args.toolInput, null, 2) ?? String(args.toolInput)
    } catch {
      serializedInput = String(args.toolInput)
    }
  }
  sections.push(`Input:\n${serializedInput}`)
  if (args.messages && args.messages.length > 0) {
    const context = extractConversationContext(args.messages)
    if (context) {
      sections.push(`Recent conversation context:\n${context}`)
    }
  }
  sections.push('Explain this command in context.')
  try {
    const response = await sideQuery({
      model: getEngineModel(),
      system: EXPLAINER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: sections.join('\n\n') }],
      signal: args.signal,
      querySource: 'permission_explainer',
      tools: [EXPLAIN_COMMAND_TOOL],
      tool_choice: { type: 'tool', name: EXPLAIN_COMMAND_TOOL_NAME },
    })
    const toolUse = response.content.find(block => block.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') {
      return null
    }
    const parsed = PermissionExplanationSchema.safeParse(toolUse.input)
    if (!parsed.success) {
      return null
    }
    logForDebugging(`permission explainer risk level: ${parsed.data.riskLevel}`)
    return parsed.data
  } catch (error) {
    if (args.signal.aborted) {
      logForDebugging('permission explainer aborted')
      return null
    }
    logForDebugging(
      `permission explainer failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    logError(error)
    return null
  }
}
