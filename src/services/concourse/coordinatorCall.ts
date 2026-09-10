
import type { AssistantMessage, Message } from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import { overflowSignalOf } from '../api/overflowSignal.js'
import { CoordinatorOverflowError } from './coordinatorOverflow.js'
import type { CoordinatorTurnInput, CoordinatorTurnProposal } from './coordinatorLane.js'
import { resolveCoordinatorEffort } from './coordinatorModels.js'
import {
  coordinatorToolSet,
  createCoordinatorToolContext,
  finishToolResult,
  toolApiDeclarations,
  type CoordinatorToolResult,
  type CoordinatorTurnRuntime,
} from './coordinatorTools.js'

export const COORDINATOR_TURN_MAX_TOOL_CALLS = 8
export const COORDINATOR_TURN_MAX_OUTPUT_TOKENS = 8192
export const COORDINATOR_TURN_WALL_MS = 120_000

export function coordinatorDeadlineExpired(signal: AbortSignal): boolean {
  return signal.aborted && (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
}

export function coordinatorDeadlineWords(signal: AbortSignal, budgetMs: number, what: string, err: unknown): string {
  if (coordinatorDeadlineExpired(signal)) return `${what} hit its ${Math.round(budgetMs / 1000)} s budget before the provider finished`
  return err instanceof Error ? err.message : String(err)
}

const MIN_ROUND_OUTPUT_TOKENS = 256

const joinParts = (parts: readonly string[]): string => parts.filter(p => p.length > 0).join('\n\n')

type StreamEventLike = {
  type?: string
  event?: { type?: string; delta?: { type?: string; text?: string } }
  message?: {
    content: unknown
    usage?: {
      output_tokens?: number
      input_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

function roundContextTokensOf(usage: NonNullable<StreamEventLike['message']>['usage']): number | undefined {
  if (usage === undefined) return undefined
  const { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output } = usage
  if (typeof input !== 'number' && typeof read !== 'number' && typeof write !== 'number') return undefined
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  return n(input) + n(read) + n(write) + n(output)
}

function textBlocksOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()
}

function toolUsesOf(content: unknown): Array<{ id: string; name: string; input: unknown }> {
  if (!Array.isArray(content)) return []
  return content.filter(
    (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
      !!b && (b as { type?: string }).type === 'tool_use' && typeof (b as { id?: unknown }).id === 'string' && typeof (b as { name?: unknown }).name === 'string',
  )
}

export async function liveCoordinatorCallModel(
  input: CoordinatorTurnInput,
  modelId: string,
  runtime: CoordinatorTurnRuntime = {},
): Promise<CoordinatorTurnProposal> {
  const [
    { routedCallModel },
    { asSystemPrompt },
    { createUserMessage, createAssistantMessage },
    { getEmptyToolPermissionContext },
    { getCwd },
    { MERCURY_COORDINATOR_FLOOR },
    { mercuryEngineIdentityLine },
  ] = await Promise.all([
    import('../providers/callModelRouter.js'),
    import('../../utils/systemPromptType.js'),
    import('../../utils/messages.js'),
    import('../../Tool.js'),
    import('../../utils/cwd.js'),
    import('../../prompt/mercuryContract.js'),
    import('../../prompt/engineIdentity.js'),
  ])
  const engineLine = mercuryEngineIdentityLine(modelId)
  const managerInput = (input as { manager?: true }).manager === true
  const managerCollector: import('./managerMode.js').ManagerTurnCollector = {}
  const managerBits = managerInput ? await import('./managerMode.js') : null
  const defs = managerBits !== null ? [...coordinatorToolSet(), ...managerBits.managerToolSet(managerCollector)] : coordinatorToolSet()
  const { resolveHarnessGround } = await import('./concourseSnapshot.js')
  const ground = await resolveHarnessGround().catch(() => getCwd())
  const ctx = createCoordinatorToolContext({
    workspaceRoot: ground,
    by: runtime.by ?? 'coordinator',
    ...(runtime.crewDir !== undefined ? { crewDir: runtime.crewDir } : {}),
  })
  const apiTools = toolApiDeclarations(defs) as unknown as Tools
  const signal = AbortSignal.timeout(COORDINATOR_TURN_WALL_MS)

  const messages: Message[] = []
  const tail = [...(input.conversation ?? [])]
  let current: string | undefined
  if (input.event.kind === 'operator-message') {
    current = input.event.text
    const last = tail[tail.length - 1]
    if (last !== undefined && last.role === 'operator') tail.pop()
  }
  for (const entry of tail) {
    if (entry.text.length === 0 && (entry.receipts === undefined || entry.receipts.length === 0)) continue
    const age = entry.age !== undefined ? `[${entry.age}] ` : ''
    if (entry.role === 'harness') {
      messages.push(
        createUserMessage({
          content: `[harness${entry.age !== undefined ? ` · ${entry.age}` : ''}] ${entry.text}`,
        }),
      )
      continue
    }
    if (entry.role === 'operator') {
      const settled = entry.settled === true ? ' [the harness settled this one — history, not an open ask]' : ''
      messages.push(createUserMessage({ content: `${age}${entry.text}${settled}` }))
      continue
    }
    const receiptLines =
      entry.receipts !== undefined && entry.receipts.length > 0
        ? `\n\n<receipts>\n${entry.receipts.map(r => `- ${r.label}`).join('\n')}\n</receipts>`
        : ''
    messages.push(createAssistantMessage({ content: `${age}${entry.text}${receiptLines}`, isVirtual: true }))
  }
  const boardBlock = `<switchboard${input.board.clock !== undefined ? ` clock="${input.board.clock}"` : ''}>\n${JSON.stringify(
    { event: input.event, board: input.board },
  )}\n</switchboard>`
  messages.push(
    createUserMessage({
      content:
        current !== undefined
          ? `${boardBlock}\n\n${current}`
          : `${boardBlock}\n\nReact to the event above under your standing instructions. If nothing needs doing, say so in one plain sentence.`,
    }),
  )

  let toolCallsUsed = 0
  let outputTokensUsed = 0
  let sawWork = false
  const finalParts: string[] = []
  let roundDelta = ''
  let maxContextTokens: number | undefined

  try {
    for (let round = 0; round <= COORDINATOR_TURN_MAX_TOOL_CALLS + 1; round++) {
      const remaining = COORDINATOR_TURN_MAX_OUTPUT_TOKENS - outputTokensUsed
      if (remaining < MIN_ROUND_OUTPUT_TOKENS) break
      roundDelta = ''
      const roundAssistants: AssistantMessage[] = []
      const stream = routedCallModel({
        messages,
        systemPrompt: asSystemPrompt([
          MERCURY_COORDINATOR_FLOOR,
          engineLine,
          input.contract,
          ...(managerBits !== null ? [managerBits.MANAGER_MODE_ADDENDUM] : []),
        ]),
        thinkingConfig: { type: 'disabled' },
        tools: apiTools,
        signal,
        options: {
          model: modelId,
          effortValue: resolveCoordinatorEffort(),
          querySource: 'concourse_coordinator',
          agents: [],
          isNonInteractiveSession: true,
          hasAppendSystemPrompt: false,
          mcpTools: [],
          maxOutputTokensOverride: remaining,
          enablePromptCaching: false,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        } as never,
      })
      for await (const ev of stream) {
        const e = ev as StreamEventLike
        if (
          e.type === 'stream_event' &&
          e.event?.type === 'content_block_delta' &&
          e.event.delta?.type === 'text_delta' &&
          typeof e.event.delta.text === 'string'
        ) {
          roundDelta += e.event.delta.text
          runtime.onDelta?.(joinParts([...finalParts, roundDelta]))
        } else if (e.type === 'assistant' && e.message) {
          roundAssistants.push(e as unknown as AssistantMessage)
        }
      }
      const lastAssistant = roundAssistants[roundAssistants.length - 1]
      if (lastAssistant === undefined) throw new Error('the provider returned no answer')
      const realAssistants = roundAssistants.filter(
        m => (m as { isApiErrorMessage?: boolean }).isApiErrorMessage !== true,
      )
      if (realAssistants.length === 0) {
        const failureText = textBlocksOf(lastAssistant.message.content)
        const overflow = roundAssistants.map(m => overflowSignalOf(m as never)).find(s => s !== null) ?? null
        if (overflow !== null) {
          throw new CoordinatorOverflowError(overflow, failureText.length > 0 ? failureText : 'the provider refused the request for not fitting the window')
        }
        throw new Error(failureText.length > 0 ? failureText : 'the provider call failed before any answer arrived')
      }
      const roundText = realAssistants
        .map(m => textBlocksOf(m.message.content))
        .filter(t => t.length > 0)
        .join('\n')
      if (roundText.length > 0) finalParts.push(roundText)
      roundDelta = ''
      runtime.onDelta?.(joinParts(finalParts))
      const usage = (lastAssistant as unknown as StreamEventLike).message?.usage
      const outUsage = usage?.output_tokens
      outputTokensUsed += typeof outUsage === 'number' && Number.isFinite(outUsage) ? outUsage : Math.ceil((roundText.length + 1) / 3)
      const roundContext = roundContextTokensOf(usage)
      if (roundContext !== undefined && (maxContextTokens === undefined || roundContext > maxContextTokens)) {
        maxContextTokens = roundContext
      }

      const toolUses = roundAssistants.flatMap(m => toolUsesOf(m.message.content))
      if (toolUses.length === 0) break
      const resultBlocks: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: true }> = []
      let budgetRefused = false
      for (const tu of toolUses) {
        let out: CoordinatorToolResult
        if (toolCallsUsed >= COORDINATOR_TURN_MAX_TOOL_CALLS) {
          budgetRefused = true
          out = {
            content: JSON.stringify({
              ok: false,
              refused: `this turn's tool budget (${COORDINATOR_TURN_MAX_TOOL_CALLS} calls) is spent`,
              next: 'answer the operator in plain words from what you already know; the next message starts a fresh budget',
            }),
          }
        } else {
          toolCallsUsed++
          const def = defs.find(d => d.name === tu.name)
          out =
            def === undefined
              ? { content: JSON.stringify({ ok: false, refused: `there is no tool named '${tu.name}'`, next: 'use one of the declared tools' }) }
              : await def.run(tu.input, ctx)
        }
        const finished = finishToolResult(tu.name, out)
        for (const receipt of finished.receipts ?? []) {
          sawWork = true
          runtime.onReceipt?.(receipt)
        }
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: finished.content,
          ...(finished.isError ? { is_error: true as const } : {}),
        })
      }
      messages.push(...roundAssistants)
      messages.push(
        createUserMessage({
          content: (budgetRefused
            ? [...resultBlocks, { type: 'text', text: 'Your tool budget for this turn is spent — answer the operator in plain words now.' }]
            : resultBlocks) as never,
        }),
      )
    }
    const reply = joinParts(finalParts)
    return {
      decisions: [],
      ...(reply.length > 0 ? { reply: reply.slice(0, 8000) } : {}),
      ...(maxContextTokens !== undefined ? { turnUsage: { contextTokens: maxContextTokens } } : {}),
      ...(managerCollector.ask !== undefined ? { ask: managerCollector.ask } : {}),
      ...(managerCollector.plan !== undefined ? { plan: managerCollector.plan } : {}),
    }
  } catch (err) {
    if (err instanceof CoordinatorOverflowError) throw err
    const soFar = joinParts([...finalParts, roundDelta])
    if (!sawWork && soFar.length === 0) {
      if (coordinatorDeadlineExpired(signal)) throw new Error(coordinatorDeadlineWords(signal, COORDINATOR_TURN_WALL_MS, 'the coordinator turn', err))
      throw err
    }
    const why = coordinatorDeadlineWords(signal, COORDINATOR_TURN_WALL_MS, 'the coordinator turn', err)
    const apology = `${soFar}${soFar.length > 0 ? '\n\n' : ''}Something broke mid-turn (${why}) — the receipt rows here are what actually happened; nothing else was changed.`
    return {
      decisions: [],
      reply: apology.slice(0, 8000),
      ...(maxContextTokens !== undefined ? { turnUsage: { contextTokens: maxContextTokens } } : {}),
      ...(managerCollector.ask !== undefined ? { ask: managerCollector.ask } : {}),
      ...(managerCollector.plan !== undefined ? { plan: managerCollector.plan } : {}),
    }
  }
}
