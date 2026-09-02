/**
 * An optional model-generated "what does this command do / why / risk"
 * explanation shown in the permission dialog. Never throws — every failure
 * path returns null.
 */
import { z } from 'zod/v4'
import { getGlobalConfig } from '../config.js'
import { logError } from '../log.js'
import { logForDebugging } from '../debug.js'
import type { Message } from '../../types/message.js'
import { getMainLoopModel } from '../model/model.js'
import { sideQuery } from '../sideQuery.js'

/** The three risk bands. */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

/** The four explanation fields returned for the dialog. */
export type PermissionExplanation = {
  riskLevel: RiskLevel
  explanation: string
  reasoning: string
  risk: string
}

/** The explainer's forced tool name (contract data). */
const EXPLAIN_COMMAND_TOOL_NAME = 'explain_command'

/** On by default; only an exact `false` in the global config disables it. */
export function isPermissionExplainerEnabled(): boolean {
  const config = getGlobalConfig() as { permissionExplainerEnabled?: unknown }
  return config.permissionExplainerEnabled !== false
}

function explanationSchema() {
  return z.object({
    explanation: z.string(),
    reasoning: z.string(),
    risk: z.string(),
    riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  })
}

/** Take the last 3 assistant messages' text, budgeted to 1000 chars, oldest-first. */
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
  // Walk newest-first against the budget.
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

/**
 * Produce an explanation for a tool use. Returns null when disabled, on any
 * missing/invalid response, on an aborted signal, or on any thrown error.
 */
export async function generatePermissionExplanation(args: {
  toolName: string
  toolInput: unknown
  toolDescription?: string
  messages?: Message[]
  signal: AbortSignal
}): Promise<PermissionExplanation | null> {
  const { toolName, toolInput, toolDescription, messages, signal } = args
  if (!isPermissionExplainerEnabled()) return null

  const systemPrompt =
    'Look at the shell command the agent wants to run and account for it on three axes: what it does, why the caller is running it, and how it could go wrong.'

  const inputText =
    typeof toolInput === 'string'
      ? toolInput
      : (() => {
          try {
            return JSON.stringify(toolInput, null, 2)
          } catch {
            return String(toolInput)
          }
        })()

  const contextSection =
    messages && messages.length > 0 ? extractConversationContext(messages) : ''

  const userPrompt = [
    `Tool: ${toolName}`,
    toolDescription ? `Description: ${toolDescription}` : '',
    `Input:\n${inputText}`,
    contextSection ? `Recent conversation context:\n${contextSection}` : '',
    'Explain this command in context.',
  ]
    .filter(Boolean)
    .join('\n\n')

  const schema = explanationSchema()
  try {
    const response = await sideQuery({
      model: getMainLoopModel(),
      systemPrompt,
      userPrompt,
      signal,
      querySource: 'permission_explainer',
      tools: [
        {
          name: EXPLAIN_COMMAND_TOOL_NAME,
          description: 'Reports an explanation of a shell command.',
          inputSchema: {
            type: 'object',
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
        },
      ],
      forceToolChoice: EXPLAIN_COMMAND_TOOL_NAME,
    } as never)

    const content = (response as { content?: Array<{ type: string; input?: unknown; name?: string }> }).content
    const toolUse = content?.find(block => block.type === 'tool_use')
    if (!toolUse) return null
    const parsed = schema.safeParse(toolUse.input)
    if (!parsed.success) return null

    logForDebugging(`permission explainer risk level: ${parsed.data.riskLevel}`)
    return parsed.data
  } catch (error) {
    if (signal.aborted) {
      logForDebugging('permission explainer aborted')
      return null
    }
    logForDebugging(`permission explainer failed: ${error instanceof Error ? error.message : String(error)}`)
    logError(error)
    return null
  }
}
