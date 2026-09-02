// ============================================================================
// services/concourse/coordinatorCall — (sheet): the LIVE
//  provider binding for the coordinator lane's callModel seam — a REAL,
//  bounded agent turn (promotion, not costume). The 2048-token zero-tool
//  one-shot is retired: the turn declares the typed switchboard tools
//  (coordinatorTools), executes them in-process through the same daemon
//  doors the operator's own controls use, streams its visible text as
//  deltas (IP-5, through the runtime the lane threads in), and finishes
//  with plain prose. Caps: ≤8 tool calls · ≤8192 output tokens · 120s wall.
//
//  ROUTE HONESTY: every round
//  rides routedCallModel — the ONE provider-aware seam — so anthropic ids
//  ride the streaming core and gpt-*/glm-* ids ride their native runtimes,
//  which own their account-refusal honesty. No model id is
//  copied here (the composed registry owns availability).
//
//  FAIL-SOFT POSTURE: a fault before ANY visible work rethrows (the lane's
//  A4 catch refuses typed and un-remembers the trigger so the same ask may
//  retry); a fault after work degrades to a plain apology line carrying the
//  text so far — receipts already rowed stay true, and nothing crashes.
// ============================================================================

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

/** Below this remaining-output floor no further round starts — a round that
 *  cannot fit a sentence would only truncate mid-thought. */
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

/** The round's real context size in the canonical disjoint usage envelope
 *  (every provider runtime normalizes to it): uncached input + cache reads +
 *  cache writes + the round's OUTPUT — the four-field total the main chat's
 *  warning and compaction thresholds are calibrated on (tokens.ts); the
 *  stamped value feeds the same thresholds, so leaving output out made the
 *  coordinator's low-context warning fire later than the identical warning
 *  in the main chat and overstated the headroom by the last response's
 *  output share (FN-018 rank 21). undefined when the runtime reported no
 *  input usage — the gauge then honestly does not stamp, rather than
 *  estimating from a different source. */
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
  // THE SEAT'S ENGINE LINE: the harness supplies it, from the SAME resolved
  // id this turn dispatches on — so the seat answers "what model are you"
  // from its prompt instead of guessing. One owner (prompt/engineIdentity);
  // provider-neutral, whatever family the id belongs to.
  const engineLine = mercuryEngineIdentityLine(modelId)
  // MANAGER MODE (ledger T7+T8): a manager turn binds the manager addendum
  // BEHIND the persona and the two card tools BESIDE the closed set — the
  // cards land in the per-turn collector and ride the proposal out; the
  // chat mode's turn is byte-identical to before.
  const managerInput = (input as { manager?: true }).manager === true
  const managerCollector: import('./managerMode.js').ManagerTurnCollector = {}
  const managerBits = managerInput ? await import('./managerMode.js') : null
  const defs = managerBits !== null ? [...coordinatorToolSet(), ...managerBits.managerToolSet(managerCollector)] : coordinatorToolSet()
  // THE GROUND LAW: the coordinator's launch
  // root is the LIVE harness ground (the selected repo / Project chip),
  // never the folder the terminal happened to be opened from — resolved
  // fresh every turn so a chip change re-points the very next launch.
  const { resolveHarnessGround } = await import('./concourseSnapshot.js')
  const ground = await resolveHarnessGround().catch(() => getCwd())
  const ctx = createCoordinatorToolContext({
    workspaceRoot: ground,
    by: runtime.by ?? 'coordinator',
    ...(runtime.crewDir !== undefined ? { crewDir: runtime.crewDir } : {}),
  })
  //  leaf boundary: the tool declarations enter the provider seam
  // here — toolToAPISchema reads exactly name · prompt() · inputJSONSchema.
  const apiTools = toolApiDeclarations(defs) as unknown as Tools
  const signal = AbortSignal.timeout(COORDINATOR_TURN_WALL_MS)

  // messages = conversation tail as real turns + the board snapshot beside
  // the triggering text (the bounded input law: ids/titles/states,
  // never transcripts — the snapshot builder upstream owns that).
  const messages: Message[] = []
  const tail = [...(input.conversation ?? [])]
  let current: string | undefined
  if (input.event.kind === 'operator-message') {
    current = input.event.text
    const last = tail[tail.length - 1]
    // The just-appended operator entry IS the trigger — it rides below,
    // un-clipped, beside the board.
    if (last !== undefined && last.role === 'operator') tail.pop()
  }
  for (const entry of tail) {
    if (entry.text.length === 0 && (entry.receipts === undefined || entry.receipts.length === 0)) continue
    // THE AGE TAG: a replayed turn has no clock of its own, so a ten-hour-old
    // ask reads exactly like the live one. Rows past the freshness window say
    // how old they are (the shaper decides which).
    const age = entry.age !== undefined ? `[${entry.age}] ` : ''
    if (entry.role === 'harness') {
      // A HARNESS NOTICE — Mercury reporting on the lane. It enters as a
      // bracketed note in the history, never as an assistant turn: words the
      // model did not say can never come back to it as words it did say.
      messages.push(
        createUserMessage({
          content: `[harness${entry.age !== undefined ? ` · ${entry.age}` : ''}] ${entry.text}`,
        }),
      )
      continue
    }
    if (entry.role === 'operator') {
      // An operator turn the harness settled is history: it never ran, so it
      // is not an ask still waiting for this turn's answer.
      const settled = entry.settled === true ? ' [the harness settled this one — history, not an open ask]' : ''
      messages.push(createUserMessage({ content: `${age}${entry.text}${settled}` }))
      continue
    }
    // A prior coordinator turn re-enters with the receipts it executed —
    // what landed and what was refused, in the same words the operator saw.
    const receiptLines =
      entry.receipts !== undefined && entry.receipts.length > 0
        ? `\n\n<receipts>\n${entry.receipts.map(r => `- ${r.label}`).join('\n')}\n</receipts>`
        : ''
    messages.push(createAssistantMessage({ content: `${age}${entry.text}${receiptLines}`, isVirtual: true }))
  }
  // THE BOARD BLOCK — the whole world-state, fresh this turn: the operator's
  // own board (rows with state + what it means, brief, latest activity,
  // model/effort, folder, stamp branch/worktree/commits, questions with their
  // answerable refs), so the model answers from it instead of guessing or
  // querying piecemeal. Same-turn tool calls that change the board return
  // their own truth; list_sessions re-reads it.
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
  // THE CONTEXT GAUGE'S SOURCE: the largest round's real input envelope —
  // the turn's context as the provider actually processed it. undefined
  // until a round reports input usage.
  let maxContextTokens: number | undefined

  try {
    // Rounds: up to the tool budget PLUS one closing round, so a turn whose
    // last tool call was refused for budget still gets to answer in words —
    // it would otherwise settle with no reply at all, and the door then spoke for it.
    for (let round = 0; round <= COORDINATOR_TURN_MAX_TOOL_CALLS + 1; round++) {
      const remaining = COORDINATOR_TURN_MAX_OUTPUT_TOKENS - outputTokensUsed
      if (remaining < MIN_ROUND_OUTPUT_TOKENS) break
      roundDelta = ''
      // EVERY settlement of the round, in order: the runtimes mint ONE
      // assistant message PER content block (text and each tool_use its
      // own), so keeping only the last one drops every parallel tool call
      // but the final — the dropped calls never execute and never get a
      // tool_result, and the next round dies on the provider's unanswered-
      // function_call check (the live two-launch ask lost a session to
      // exactly this).
      const roundAssistants: AssistantMessage[] = []
      // The coordinator floor leads, the engine line follows it, the persona
      // closes: the coordinator is a conversational operator-facing seat, so
      // it carries the always-on attribution/honesty/safety floor like every
      // other seat, behind its OWN identity statement (one floor per seat —
      // the name is Mercury, "coordinator" the role, never a second name);
      // the engine line names what it runs on; the persona (the lane
      // contract) dominates style behind both.
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
          // THE COORDINATOR EFFORT DIAL: the persisted pick (the e doorway
          // in the coordinator-model picker) rides every coordinator turn —
          // resolveCoordinatorEffort validates at read, so the wire sees a
          // ladder word or nothing; absent, the model's default resolution
          // applies exactly as before.
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
      // A round settled ONLY by the runtime's own refusal (isApiErrorMessage
      // — no account, a 4xx, a usage window) is a FAULT, not a reply: its
      // prose must never paint as words the coordinator said. Throwing rides
      // the lane's fail-soft contract — before any visible work the A4 catch
      // refuses typed (and the ask may retry); after work the apology line
      // carries the same sentence beside the text so far.
      const realAssistants = roundAssistants.filter(
        m => (m as { isApiErrorMessage?: boolean }).isApiErrorMessage !== true,
      )
      if (realAssistants.length === 0) {
        const failureText = textBlocksOf(lastAssistant.message.content)
        // A round refused for not fitting the window is the TYPED overflow
        // (the runtime's stamp, never a prose sniff): the lane's governed
        // turn walks the ladder on it — fold the conversation, retry once.
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
      // Resync the streamed pane to the authoritative content (native
      // runtimes may deltas-then-final differently; the final text wins).
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
        // THE POST-TOOL SEAM: every result passes the refusal normalizer
        // once — refused/failed outcomes reach the model as full sentences
        // with the next move, flagged is_error so no runtime can read them
        // as success; receipts row live as each verb settles.
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
      // Replay the WHOLE round: every settled assistant message rides (the
      // request assemblers fold consecutive assistant messages exactly as
      // the main query loop's transcripts do), so every function_call the
      // provider emitted meets its function_call_output on the next round.
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
      // The lane's ONE visible clip owns the bound (clipCoordinatorReply);
      // this cap only mirrors the store's own entry ceiling.
      ...(reply.length > 0 ? { reply: reply.slice(0, 8000) } : {}),
      ...(maxContextTokens !== undefined ? { turnUsage: { contextTokens: maxContextTokens } } : {}),
      ...(managerCollector.ask !== undefined ? { ask: managerCollector.ask } : {}),
      ...(managerCollector.plan !== undefined ? { plan: managerCollector.plan } : {}),
    }
  } catch (err) {
    // THE TYPED OVERFLOW IS NEVER DEGRADED (FN-017 rank 3): the lane's
    // overflow ladder — fold once, rebuild the replay, retry once — is gated
    // entirely on this error surviving the call. The degrade below used to
    // swallow it whenever round 0 had spoken or settled a tool (the normal
    // multi-round shape), returning "Something broke mid-turn" as a
    // successful proposal: no fold, no retry, a conversation exactly as
    // large as before. Streamed text and settled receipts are not lost —
    // the runtime already flushed them into the partial entry, and the
    // retried turn writes the final entry over the same id.
    if (err instanceof CoordinatorOverflowError) throw err
    const soFar = joinParts([...finalParts, roundDelta])
    if (!sawWork && soFar.length === 0) throw err
    // Work already happened — degrade soft, keep the truth on the table.
    // A card already collected still lands: its tool result told the model
    // "the card is in front of the operator", and that must stay true.
    const why = err instanceof Error ? err.message : String(err)
    const apology = `${soFar}${soFar.length > 0 ? '\n\n' : ''}Something broke mid-turn (${why}) — the receipt rows here are what actually happened; nothing else was changed.`
    return {
      decisions: [],
      reply: apology.slice(0, 8000),
      // The rounds that DID settle still measured real context — the gauge
      // stays honest through a degraded turn.
      ...(maxContextTokens !== undefined ? { turnUsage: { contextTokens: maxContextTokens } } : {}),
      ...(managerCollector.ask !== undefined ? { ask: managerCollector.ask } : {}),
      ...(managerCollector.plan !== undefined ? { plan: managerCollector.plan } : {}),
    }
  }
}
