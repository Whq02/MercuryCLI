import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { expandPath } from '../../utils/path.js'
import { getCwd } from '../../utils/cwd.js'
import { z } from 'zod/v4'
import type { CanUseToolFn, ToolUseContext } from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import type { AssistantMessage, Message, NormalizedUserMessage, UserMessage } from '../../types/message.js'
import { shellCallValue, type ShellRunFact } from '../../utils/errors.js'
import { createAssistantMessage, createUserMessage } from '../messages.js'
import { unwrapToolUseError } from '../../utils/messages/rejectionText.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { utilityCallFor } from '../model/utilityModel.js'
import type { EffortValue } from '../../utils/effort.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { runToolUse } from '../tools/toolExecution.js'
import { routedCallModel } from '../providers/callModelRouter.js'
import { governorCeilings } from '../capacity/governor.js'
import { AGENT_TOOL_NAME } from '../../constants/tools/agent.js'
import { EVAL_TOOL_NAME } from '../../tools/EvalTool/constants.js'
import { compileJsonSchema, formatSchemaIssues } from '../schema/jsonSchemaEngine.js'
import { extractJsonValue } from './jsonExtract.js'
import type { BridgeServer, CellBudgetHooks } from './kernelManager.js'
import type { BridgeRequestFrame } from './protocol.js'
import { logForDebugging } from '../../utils/debug.js'
import { ownerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import type { OwnerKey } from '../../utils/run/ownerKey.js'
import { handleSampleCall } from '../samples/bridge.js'
import { rekeyScreenshot } from '../desktop/desktopSession.js'
import { COMPUTER_TOOL_NAME } from '../desktop/toolName.js'
import { PERSISTED_OUTPUT_CLOSING_TAG, PERSISTED_OUTPUT_TAG, readPersistedToolResult } from '../../utils/toolResultStorage.js'
import { notBuilt } from '../../pi/holes.js'

const toolPayload = z.object({ name: z.string(), input: z.record(z.string(), z.unknown()).default({}) })
const agentPayload = z.object({
  prompt: z.string().min(1),
  agentType: z.string().nullish(),
  label: z.string().nullish(),
  schema: z.unknown().nullish(),
  strict: z.boolean().default(true),
  worktree: z.boolean().default(false),
})
const completionPayload = z.object({
  prompt: z.string().min(1),
  system: z.string().nullish(),
  model: z.string().nullish(),
  tier: z.enum(['main', 'fast']).nullish(),
  schema: z.unknown().nullish(),
})

interface EvalBridgeDeps {
  owner?: OwnerKey
  context: ToolUseContext
  canUseTool: CanUseToolFn
  cellAbort: AbortController
  onNested?: (message: AssistantMessage | NormalizedUserMessage) => void
  onScreenshot?: (screenshot: BridgeScreenshot) => void
}

export interface BridgeScreenshot {
  imagePath: string
  inlinePath?: string
  inlineMediaType?: string
}

interface BridgeAnswer {
  ok: boolean
  value?: unknown
  error?: string
  errorKind?: 'permission' | 'cancelled' | 'error'
  code?: number | null
}

const IMAGE_NOTE = '[image result — view it in the transcript; binary does not cross the bridge]'
const SCREENSHOT_NOTE = "[screenshot attached to this cell's result]"

function extractToolResult(
  message: UserMessage,
  toolUseId: string,
  imageNote: string,
): { text: string; isError: boolean } | null {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
    if (b.type !== 'tool_result' || b.tool_use_id !== toolUseId) continue
    let text: string
    if (typeof b.content === 'string') text = b.content
    else if (Array.isArray(b.content)) {
      text = b.content
        .map(part => {
          const p = part as { type?: string; text?: string }
          if (p.type === 'text' && typeof p.text === 'string') return p.text
          if (p.type === 'image') return imageNote
          return ''
        })
        .filter(Boolean)
        .join('\n')
    } else text = ''
    return { text, isError: b.is_error === true }
  }
  return null
}

async function withPersistedValue(text: string, toolUseId: string): Promise<string> {
  const start = text.indexOf(PERSISTED_OUTPUT_TAG)
  if (start === -1) return text
  const end = text.indexOf(PERSISTED_OUTPUT_CLOSING_TAG, start)
  if (end === -1) return text
  const full = await readPersistedToolResult(toolUseId)
  if (full === null) return text
  return text.slice(0, start) + full + text.slice(end + PERSISTED_OUTPUT_CLOSING_TAG.length)
}

function screenshotOf(message: UserMessage): BridgeScreenshot | null {
  const output = (message as { toolUseResult?: unknown }).toolUseResult as { imagePath?: unknown; inlinePath?: unknown; inlineMediaType?: unknown } | undefined
  if (typeof output?.imagePath !== 'string' || output.imagePath === '') return null
  return {
    imagePath: output.imagePath,
    ...(typeof output.inlinePath === 'string' ? { inlinePath: output.inlinePath } : {}),
    ...(typeof output.inlineMediaType === 'string' ? { inlineMediaType: output.inlineMediaType } : {}),
  }
}

function toNormalizedUser(message: UserMessage): NormalizedUserMessage {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return {
    ...(message as object),
    message: { role: 'user', content: Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }] },
  } as NormalizedUserMessage
}

export function applySchemaToReply(text: string, schema: unknown, strict: boolean): BridgeAnswer {
  if (schema === null || schema === undefined) return { ok: true, value: text }
  const compiled = compileJsonSchema(schema)
  if (!compiled.ok) {
    if (strict) {
      return { ok: false, error: `the requested schema was refused by the validation engine — ${compiled.error}` }
    }
    const tolerated = extractJsonValue(text)
    return { ok: true, value: tolerated.ok ? tolerated.value : text }
  }
  const parsed = extractJsonValue(text)
  if (!parsed.ok) {
    return strict
      ? { ok: false, error: `schema requested but ${parsed.error}` }
      : { ok: true, value: text }
  }
  const issues = compiled.check(parsed.value)
  if (issues.length > 0) {
    const detail = formatSchemaIssues(issues.slice(0, 5))
    return strict
      ? { ok: false, error: `the reply failed schema validation — ${detail}` }
      : { ok: true, value: parsed.value }
  }
  return { ok: true, value: parsed.value }
}

function refuseUncompilableSchema(schema: unknown, strict: boolean): BridgeAnswer | null {
  if (schema === null || schema === undefined || !strict) return null
  const compiled = compileJsonSchema(schema)
  if (compiled.ok) return null
  return { ok: false, error: `the requested schema was refused by the validation engine — ${compiled.error}` }
}

export function makeEvalBridgeServer(deps: EvalBridgeDeps): BridgeServer {
  return notBuilt('src/services/eval/evalBridge.ts:166')
}

type CompletionCall = {
  model: string
  effortValue?: EffortValue
  effortPinned?: boolean
  thinkingConfig?: ThinkingConfig
}

export async function oneShotCompletion(args: CompletionCall & {
  prompt: string
  system?: string
  signal: AbortSignal
}): Promise<string> {
  const messages: Message[] = [createUserMessage({ content: args.prompt })]
  const stream = routedCallModel({
    messages,
    systemPrompt: asSystemPrompt(args.system ? [args.system] : []),
    thinkingConfig: args.thinkingConfig ?? { type: 'disabled' },
    tools: [],
    signal: args.signal,
    options: {
      model: args.model,
      effortValue: args.effortValue,
      effortPinned: args.effortPinned,
      querySource: 'eval_completion',
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
      enablePromptCaching: false,
      async getToolPermissionContext() {
        const { getEmptyToolPermissionContext } = await import('../../Tool.js')
        return getEmptyToolPermissionContext()
      },
    },
  })
  let final: string | null = null
  let apiError: string | null = null
  for await (const event of stream) {
    const e = event as {
      type?: string
      isApiErrorMessage?: boolean
      message?: { content?: unknown }
    }
    if (e.type === 'assistant' && e.message) {
      const content = e.message.content
      let text: string | null = null
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        text = content
          .map(b => ((b as { type?: string; text?: string }).type === 'text' ? (b as { text?: string }).text ?? '' : ''))
          .join('')
      }
      if (e.isApiErrorMessage) apiError = text ?? 'provider error'
      else if (text !== null && text !== '') final = (final ?? '') + text
    }
  }
  if (apiError !== null && (final === null || final.trim() === '')) {
    throw new Error(apiError.trim() || 'the provider refused the completion')
  }
  if (final === null || final.trim() === '') {
    throw new Error('the completion returned no text (is a provider signed in for this model?)')
  }
  return final.trim()
}
