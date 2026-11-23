import { z } from 'zod/v4'
import { getGlobalConfig } from '../../utils/config.js'
import { logError } from '../../utils/log.js'
import { logForDebugging } from '../../utils/debug.js'
import type { Message } from '../../types/message.js'
import type { RiskLevel } from '../../types/permissions.js'
import { getEngineModel } from '../model/model.js'
import { sideQuery } from '../api/sideQuery.js'

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
  'Look at the shell command the agent wants to run and explain it clearly and concisely for a user deciding whether to approve it. Use the explain_command tool to provide what the command does (explanation), why the agent wants to run it (reasoning), any risks or side effects (risk), and the overall risk level (LOW, MEDIUM, or HIGH).'

const EXPLAIN_COMMAND_TOOL = {
  name: 'explain_command',
  description: 'Return a structured explanation and risk assessment for the pending tool call.',
  input_schema: {
    type: 'object' as const,
    properties: {
      explanation: { type: 'string', description: 'What the command does.' },
      reasoning: { type: 'string', description: 'Why the agent wants to run it.' },
      risk: { type: 'string', description: 'Potential risks or side effects.' },
      riskLevel: {
        type: 'string',
        enum: ['LOW', 'MEDIUM', 'HIGH'],
        description: 'Overall risk level.',
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
    if (message.type !== 'assistant') continue
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    const parts: string[] = []
    for (const block of content) {
      if (block.type === 'text') {
        parts.push(block.text)
      }
    }
    assistantTexts.push(parts.join(' '))
  }

  const lastThree = assistantTexts.slice(-3)
  let budget = 1000
  const keptNewestFirst: string[] = []
  for (let i = lastThree.length - 1; i >= 0; i--) {
    const piece = lastThree[i]
    if (!piece) continue
    if (budget <= 0) break
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
  if (args.signal.aborted) {
    logForDebugging('permissionExplainer: aborted before request')
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
      sections.push(`Recent context:\n${context}`)
    }
  }
  try {
    const response = await sideQuery({
      model: getEngineModel(),
      system: EXPLAINER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: sections.join('\n\n') }],
      tools: [EXPLAIN_COMMAND_TOOL],
      tool_choice: { type: 'tool', name: 'explain_command' },
      max_tokens: 512,
      thinking: false,
      signal: args.signal,
      querySource: 'permission_explainer',
      source: 'permission_explainer',
    })
    if (args.signal.aborted) {
      logForDebugging('permissionExplainer: aborted')
      return null
    }
    const toolUse = response.content.find(block => block.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') {
      logForDebugging('permissionExplainer: response did not contain a tool_use block')
      return null
    }
    const parsed = PermissionExplanationSchema.safeParse(toolUse.input)
    if (!parsed.success) {
      logForDebugging(`permissionExplainer: invalid explanation payload: ${parsed.error.message}`)
      return null
    }
    logForDebugging(`permissionExplainer: riskLevel=${parsed.data.riskLevel}`)
    return parsed.data
  } catch (error) {
    if (args.signal.aborted) {
      logForDebugging('permissionExplainer: aborted')
      return null
    }
    logForDebugging(`permissionExplainer: failed: ${String(error)}`)
    logError(error)
    return null
  }
}
