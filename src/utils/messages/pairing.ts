// tool_use / tool_result pairing repair + SDK summary + advisor strip — the
// defensive validation layer between normalizeMessagesForAPI and the wire.
// Owned Mercury module;
// originals lived inline in utils/messages.ts. The parity oracle
// (scripts/messages) pins the repair behavior.

import type { ContentBlock, ContentBlockParam, ToolResultBlockParam, ToolUseBlock, ToolUseBlockParam } from '../../types/wire.js'
import { randomUUID } from 'crypto'
import { getStrictToolResultPairing } from '../../bootstrap/state.js'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  SystemLocalCommandMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from '../../types/message.js'
import { isAdvisorBlock } from '../advisor.js'
import { logError } from '../log.js'
import { normalizeAttachmentForAPI } from './attachmentText.js'
import { contentBlocksOf } from './normalize.js'
import { createUserMessage } from './factories.js'
import { SYNTHETIC_TOOL_RESULT_PLACEHOLDER } from './rejectionText.js'

/** Human-readable post-batch progress summaries, SDK-only. */
export function createToolUseSummaryMessage(
  summary: string,
  precedingToolUseIds: string[],
): ToolUseSummaryMessage {
  return {
    type: 'tool_use_summary',
    summary,
    precedingToolUseIds,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

/**
 * Defensive tool_use/tool_result pairing repair, both directions:
 * forward — synthetic error tool_results for uses missing results;
 * reverse — orphaned/duplicate tool_results stripped (incl. the cross-message
 * duplicate-tool_use class). Logs on activation.
 *
 * Strict mode (getStrictToolResultPairing, HFI opt-in): any mismatch THROWS
 * instead of repairing — a response conditioned on synthetic placeholders is
 * tainted training data.
 */
export function ensureToolResultPairing(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  const result: (UserMessage | AssistantMessage)[] = []
  let repaired = false

  // Cross-message duplicate tracking: a same-id tool_use in a LATER assistant
  // (different message.id — orphan-handler re-push or a broken backward walk)
  // must strip too, or the API rejects with "tool_use ids must be unique".
  const allSeenToolUseIds = new Set<string>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!

    if (msg.type !== 'assistant') {
      // A tool_result-bearing user message with NO assistant directly before
      // it in the output is orphaned (resume can start mid-turn after
      // compaction dropped the pair) — strip those blocks.
      if (
        msg.type === 'user' &&
        Array.isArray(msg.message.content) &&
        result.at(-1)?.type !== 'assistant'
      ) {
        const stripped = msg.message.content.filter(
          block =>
            !(
              typeof block === 'object' &&
              'type' in block &&
              block.type === 'tool_result'
            ),
        )
        if (stripped.length !== msg.message.content.length) {
          repaired = true
          // Keep a placeholder if stripping emptied the FIRST message — the
          // payload must still start with a user message.
          const content =
            stripped.length > 0
              ? stripped
              : result.length === 0
                ? [
                    {
                      type: 'text' as const,
                      text: '[Orphaned tool result removed due to conversation resume]',
                    },
                  ]
                : null
          if (content !== null) {
            result.push({
              ...msg,
              message: { ...msg.message, content },
            })
          }
          continue
        }
      }
      result.push(msg)
      continue
    }

    // The shape owner: a resumed/foreign assistant turn can carry a string
    // content — coerced once here; a coerced shape counts as repaired below
    // so the rebuilt (array-shaped) message is what lands on the wire.
    const msgContent = contentBlocksOf(msg.message.content) as ContentBlock[]

    // Server-side result ids within this assistant (*_tool_result blocks).
    const serverResultIds = new Set<string>()
    for (const c of msgContent) {
      if ('tool_use_id' in c && typeof c.tool_use_id === 'string') {
        serverResultIds.add(c.tool_use_id)
      }
    }

    // Dedupe tool_use ids (cross-message) + strip orphaned same-message
    // server-side uses (interrupted stream: use block, no result block).
    const seenToolUseIds = new Set<string>()
    const finalContent = msgContent.filter(block => {
      if (block.type === 'tool_use') {
        if (allSeenToolUseIds.has(block.id)) {
          repaired = true
          return false
        }
        allSeenToolUseIds.add(block.id)
        seenToolUseIds.add(block.id)
      }
      if (
        (block.type === 'server_tool_use' || block.type === 'mcp_tool_use') &&
        !serverResultIds.has((block as { id: string }).id)
      ) {
        repaired = true
        return false
      }
      return true
    })

    const assistantContentChanged =
      finalContent.length !== msgContent.length ||
      msgContent !== msg.message.content

    if (finalContent.length === 0) {
      finalContent.push({
        type: 'text' as const,
        text: '[Tool use interrupted]',
        citations: [],
      })
    }

    result.push(
      assistantContentChanged
        ? { ...msg, message: { ...msg.message, content: finalContent } }
        : msg,
    )

    const toolUseIds = [...seenToolUseIds]

    // Inspect the following user message for results — including duplicate
    // tool_result ids (legacy corrupted transcripts: [asst(X), user(tr_X)] ×2
    // merges to [asst([X,X]), user([tr_X,tr_X])]; the use-dedup above strips
    // the second X, this strips the second tr_X).
    const nextMsg = messages[i + 1]
    const existingToolResultIds = new Set<string>()
    let hasDuplicateToolResults = false

    if (nextMsg?.type === 'user') {
      const content = nextMsg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === 'object' &&
            'type' in block &&
            block.type === 'tool_result'
          ) {
            const trId = (block as ToolResultBlockParam).tool_use_id
            if (existingToolResultIds.has(trId)) {
              hasDuplicateToolResults = true
            }
            existingToolResultIds.add(trId)
          }
        }
      }
    }

    const toolUseIdSet = new Set(toolUseIds)
    const missingIds = toolUseIds.filter(id => !existingToolResultIds.has(id))
    const orphanedIds = [...existingToolResultIds].filter(
      id => !toolUseIdSet.has(id),
    )

    if (
      missingIds.length === 0 &&
      orphanedIds.length === 0 &&
      !hasDuplicateToolResults
    ) {
      continue
    }

    repaired = true

    const syntheticBlocks: ToolResultBlockParam[] = missingIds.map(id => ({
      type: 'tool_result' as const,
      tool_use_id: id,
      content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
      is_error: true,
    }))

    if (nextMsg?.type === 'user') {
      let content: (ContentBlockParam | ContentBlock)[] = Array.isArray(
        nextMsg.message.content,
      )
        ? nextMsg.message.content
        : [{ type: 'text' as const, text: nextMsg.message.content }]

      if (orphanedIds.length > 0 || hasDuplicateToolResults) {
        const orphanedSet = new Set(orphanedIds)
        const seenTrIds = new Set<string>()
        content = content.filter(block => {
          if (
            typeof block === 'object' &&
            'type' in block &&
            block.type === 'tool_result'
          ) {
            const trId = (block as ToolResultBlockParam).tool_use_id
            if (orphanedSet.has(trId)) return false
            if (seenTrIds.has(trId)) return false
            seenTrIds.add(trId)
          }
          return true
        })
      }

      const patchedContent = [...syntheticBlocks, ...content]

      if (patchedContent.length > 0) {
        const patchedNext: UserMessage = {
          ...nextMsg,
          message: { ...nextMsg.message, content: patchedContent },
        }
        i++
        // (The gated post-repair re-smoosh was deleted in the cut —
        // production-dead behind mercury_chair_sermon; see the deletion record
        // on mergeUserContentBlocks in merge.ts.)
        result.push(patchedNext)
      } else {
        // Everything stripped: keep a user placeholder for role alternation
        // (assistant→assistant is its own 400).
        i++
        result.push(
          createUserMessage({
            content: NO_CONTENT_MESSAGE,
            isMeta: true,
          }),
        )
      }
    } else {
      if (syntheticBlocks.length > 0) {
        result.push(
          createUserMessage({
            content: syntheticBlocks,
            isMeta: true,
          }),
        )
      }
    }
  }

  if (repaired) {
    // Diagnostic structure map for root-causing the repair trigger.
    const messageTypes = messages.map((m, idx) => {
      if (m.type === 'assistant') {
        const toolUses = contentBlocksOf(m.message.content)
          .filter(b => b.type === 'tool_use')
          .map(b => (b as ToolUseBlock | ToolUseBlockParam).id)
        const serverToolUses = contentBlocksOf(m.message.content)
          .filter(
            b => b.type === 'server_tool_use' || b.type === 'mcp_tool_use',
          )
          .map(b => (b as { id: string }).id)
        const parts = [
          `id=${m.message.id}`,
          `tool_uses=[${toolUses.join(',')}]`,
        ]
        if (serverToolUses.length > 0) {
          parts.push(`server_tool_uses=[${serverToolUses.join(',')}]`)
        }
        return `[${idx}] assistant(${parts.join(', ')})`
      }
      if (m.type === 'user' && Array.isArray(m.message.content)) {
        const toolResults = m.message.content
          .filter(
            b =>
              typeof b === 'object' && 'type' in b && b.type === 'tool_result',
          )
          .map(b => (b as ToolResultBlockParam).tool_use_id)
        if (toolResults.length > 0) {
          return `[${idx}] user(tool_results=[${toolResults.join(',')}])`
        }
      }
      return `[${idx}] ${m.type}`
    })

    if (getStrictToolResultPairing()) {
      throw new Error(
        `ensureToolResultPairing: tool_use/tool_result pairing mismatch detected (strict mode). ` +
          `Refusing to repair — would inject synthetic placeholders into model context. ` +
          `Message structure: ${messageTypes.join('; ')}. See inc-4977.`,
      )
    }

    logError(
      new Error(
        `ensureToolResultPairing: repaired missing tool_result blocks (${messages.length} -> ${result.length} messages). Message structure: ${messageTypes.join('; ')}`,
      ),
    )
  }

  return result
}

/**
 * Fold SPLIT TURNS to the canonical wire shape before pairing: every model
 * lane mints ONE AssistantMessage per settled content block, so a grouped
 * (parallel) tool round arrives here as N assistant rows sharing one
 * provider message id, followed by one user row PER tool_result. The
 * pairing walk below reads turn-by-turn (an assistant message, then THE
 * next user message) — fed the split shape it declared the first row's
 * tool_use unanswered, injected the synthetic "[Tool result missing due to
 * internal error]", and then DROPPED the real result as an orphan: the
 * model was told its grouped reads failed while their content never
 * reached the wire (the flow-mode dead-turn incident, driven
 * and reproduced on the live binary). The Anthropic lane merges at its own
 * request layer; this fold gives the non-Anthropic seams the same
 * canonical [assistant(blocks…), user(results…)] rows.
 *
 *  · consecutive ASSISTANT rows sharing a defined message.id merge into
 *    one row — contents concatenated; the LAST row's settled facts
 *    (stop_reason, usage, the provider turn record) win;
 *  · consecutive USER rows whose EVERY block is a tool_result merge into
 *    one row (one round's results; a text-bearing user row never merges).
 */
export function foldSplitTurnsForWire(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  const out: (UserMessage | AssistantMessage)[] = []
  const isAllToolResults = (m: UserMessage): boolean =>
    Array.isArray(m.message.content) &&
    m.message.content.length > 0 &&
    m.message.content.every(
      block =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_result',
    )
  for (const msg of messages) {
    const prev = out.at(-1)
    if (
      msg.type === 'assistant' &&
      prev?.type === 'assistant' &&
      typeof msg.message.id === 'string' &&
      msg.message.id !== '' &&
      prev.message.id === msg.message.id
    ) {
      out[out.length - 1] = {
        ...prev,
        // The later row settles the turn-level facts (the lanes write
        // usage/stop_reason back onto the LAST minted message; the replay
        // record rides it too).
        ...('apexProviderTurn' in msg && msg.apexProviderTurn !== undefined
          ? { apexProviderTurn: msg.apexProviderTurn }
          : {}),
        message: {
          ...prev.message,
          content: [...prev.message.content, ...msg.message.content],
          stop_reason: msg.message.stop_reason ?? prev.message.stop_reason,
          usage: msg.message.usage ?? prev.message.usage,
        },
      }
      continue
    }
    if (
      msg.type === 'user' &&
      prev?.type === 'user' &&
      isAllToolResults(msg) &&
      isAllToolResults(prev)
    ) {
      out[out.length - 1] = {
        ...prev,
        message: {
          ...prev.message,
          content: [
            ...(prev.message.content as ContentBlockParam[]),
            ...(msg.message.content as ContentBlockParam[]),
          ],
        },
      }
      continue
    }
    out.push(msg)
  }
  return out
}

/**
 * Project the parent-side rows the Anthropic wire also delivers: attachment
 * rows (plan/flow-mode instructions, @-mention file bodies, todo and task
 * reminders, queued `!`-command output, skills, diagnostics, teammate mail)
 * become user rows through the SAME projection normalizeMessagesForAPI runs,
 * and a local_command system row becomes a user row so earlier command
 * output stays referenceable. Before this pass the family lanes filtered
 * these rows out wholesale — content the transcript showed as delivered
 * never reached any non-Anthropic model (the IV probe's A class: a GPT/GLM/
 * compat session in plan mode never received the plan-mode instruction).
 * progress / tool_use_summary / other system rows stay parent-side on every
 * wire — the Anthropic planner drops them too.
 */
function projectEnvelopeRowsForWire(
  messages: readonly { type: string }[],
): (UserMessage | AssistantMessage)[] {
  const out: (UserMessage | AssistantMessage)[] = []
  for (const m of messages) {
    if (m.type === 'user' || m.type === 'assistant') {
      out.push(m as UserMessage | AssistantMessage)
      continue
    }
    if (m.type === 'attachment' && 'attachment' in m) {
      out.push(...normalizeAttachmentForAPI((m as AttachmentMessage).attachment))
      continue
    }
    if (
      m.type === 'system' &&
      (m as { subtype?: string }).subtype === 'local_command'
    ) {
      const sys = m as SystemLocalCommandMessage
      out.push(
        createUserMessage({
          content: sys.content,
          uuid: sys.uuid,
          timestamp: sys.timestamp,
        }),
      )
      continue
    }
  }
  return out
}

/**
 * Relocate each tool_use's REAL tool_result into the round-adjacent user row
 * before the pairing walk. The walk reads exactly ONE user row per assistant
 * — a result stranded past an intervening row (a steer/interrupt text row, a
 * projected attachment, an interleaved sibling round's rows) was declared
 * missing, a synthetic error injected, and the REAL content then stripped as
 * an orphan: the delivery lie (lane M's class, on the IV interleave/abort
 * geometries). Tool_use ids are globally unique, so the downstream search
 * can never steal another round's result. Uses with no downstream result
 * anywhere still get the walk's honest synthetic; a result appearing BEFORE
 * its use stays the walk's orphan (out-of-order persistence is not a shape
 * this repairs). Pure — input rows are never mutated.
 */
function repairResultAdjacency(
  rows: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  const isToolResultBlock = (b: unknown): b is ToolResultBlockParam =>
    typeof b === 'object' &&
    b !== null &&
    'type' in b &&
    (b as { type: string }).type === 'tool_result'

  // First-occurrence tool_result location index over user rows.
  const loc = new Map<string, { row: number; block: number }>()
  rows.forEach((m, ri) => {
    if (m.type !== 'user' || !Array.isArray(m.message.content)) return
    m.message.content.forEach((b, bi) => {
      if (isToolResultBlock(b) && !loc.has(b.tool_use_id)) {
        loc.set(b.tool_use_id, { row: ri, block: bi })
      }
    })
  })

  const moved = new Set<string>() // donor marks, `${row}:${block}`
  const prepends = new Map<number, ToolResultBlockParam[]>() // user row → blocks
  const inserts = new Map<number, ToolResultBlockParam[]>() // after assistant row → blocks
  rows.forEach((m, ri) => {
    if (m.type !== 'assistant') return
    const useIds = contentBlocksOf(m.message.content)
      .filter(b => b.type === 'tool_use')
      .map(b => (b as ToolUseBlock | ToolUseBlockParam).id)
    if (useIds.length === 0) return
    const next = rows[ri + 1]
    const nextIsUser = next?.type === 'user' && Array.isArray(next.message.content)
    const inNext = new Set<string>()
    if (nextIsUser) {
      for (const b of next.message.content as ContentBlockParam[]) {
        if (isToolResultBlock(b)) inNext.add(b.tool_use_id)
      }
    }
    for (const id of useIds) {
      if (inNext.has(id)) continue
      const found = loc.get(id)
      // Absent, upstream, or already adjacent → nothing to relocate.
      if (!found || found.row <= ri + 1) continue
      const key = `${found.row}:${found.block}`
      if (moved.has(key)) continue
      moved.add(key)
      const donor = rows[found.row] as UserMessage
      const block = (donor.message.content as ContentBlockParam[])[
        found.block
      ] as ToolResultBlockParam
      if (nextIsUser) {
        const list = prepends.get(ri + 1) ?? []
        list.push(block)
        prepends.set(ri + 1, list)
      } else {
        const list = inserts.get(ri) ?? []
        list.push(block)
        inserts.set(ri, list)
      }
    }
  })
  if (moved.size === 0) return rows

  const out: (UserMessage | AssistantMessage)[] = []
  rows.forEach((m, ri) => {
    if (m.type === 'user' && Array.isArray(m.message.content)) {
      const kept = m.message.content.filter(
        (_, bi) => !moved.has(`${ri}:${bi}`),
      )
      const pre = prepends.get(ri) ?? []
      const content = [...pre, ...kept]
      if (content.length > 0) {
        out.push({ ...m, message: { ...m.message, content } })
      }
      return
    }
    out.push(m)
    if (m.type === 'assistant') {
      const pulled = inserts.get(ri)
      if (pulled && pulled.length > 0) {
        out.push(createUserMessage({ content: pulled, isMeta: true }))
      }
    }
  })
  return out
}

/**
 * The wire-side pairing heal for the non-Anthropic dispatch seams: project
 * the envelope rows every wire must deliver (projectEnvelopeRowsForWire —
 * attachments and local_command output become user rows, exactly as the
 * Anthropic planner projects them), fold split turns to the canonical shape
 * (foldSplitTurnsForWire — per-block assistant rows and per-result user rows
 * are ONE turn, never a pairing violation), relocate stranded real results
 * next to their round (repairResultAdjacency), and repair tool_use/
 * tool_result pairing over the canonical rows. A transcript stopped mid-turn
 * carries an ORPHANED tool_use; the Anthropic lane heals it at its own wire
 * layer, and every other dialect rejects it server-side ("No tool output
 * found for function call …" / strict chat 400s) — so the heal must run
 * BEFORE dialect encoding on every lane. Wire-only: callers pass the
 * request copy, never the persisted history.
 */
export function healWalkableForWire(
  messages: readonly { type: string }[],
): (UserMessage | AssistantMessage)[] {
  const projected = projectEnvelopeRowsForWire(messages)
  return orderToolResultsByUse(
    ensureToolResultPairing(
      repairResultAdjacency(foldSplitTurnsForWire(projected)),
    ),
  )
}

/**
 * Every round replays in the assistant's own order: the user row answering
 * an assistant tool round carries its tool_result blocks in the order of
 * that assistant's tool_use blocks, and every other block of the row —
 * feedback beside a result, rejection images, the tool_reference boundary —
 * after them, in their own order. A concurrent batch settles in ARRIVAL
 * order and the adjacency repair prepends relocated results, so without
 * this pass the same round replays in a different order on every request
 * (a chat-completions `tool` row sequence that no longer mirrors the
 * tool_calls it answers; a cache prefix that never repeats). Results for
 * ids the assistant does not carry keep their arrival order after the known
 * ones (the pairing walk owns their fate). Pure — rows are never mutated.
 */
export function orderToolResultsByUse(
  rows: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  const isToolResultBlock = (b: unknown): b is ToolResultBlockParam =>
    typeof b === 'object' &&
    b !== null &&
    'type' in b &&
    (b as { type: string }).type === 'tool_result'
  let changed = false
  const out = rows.map((row, i) => {
    if (row.type !== 'user' || !Array.isArray(row.message.content)) return row
    const prev = rows[i - 1]
    if (!prev || prev.type !== 'assistant') return row
    const useOrder = new Map<string, number>()
    for (const b of contentBlocksOf(prev.message.content)) {
      if (b.type === 'tool_use') useOrder.set((b as ToolUseBlock | ToolUseBlockParam).id, useOrder.size)
    }
    if (useOrder.size === 0) return row
    const content = row.message.content as ContentBlockParam[]
    const results = content
      .map((b, idx) => ({ b, idx }))
      .filter(({ b }) => isToolResultBlock(b))
    if (results.length === 0) return row
    const sorted = results
      .map(({ b, idx }) => ({
        b,
        idx,
        rank: useOrder.get((b as ToolResultBlockParam).tool_use_id) ?? Number.MAX_SAFE_INTEGER,
      }))
      .sort((x, y) => x.rank - y.rank || x.idx - y.idx)
      .map(({ b }) => b)
    const others = content.filter(b => !isToolResultBlock(b))
    const next = [...sorted, ...others]
    if (next.length === content.length && next.every((b, k) => b === content[k])) return row
    changed = true
    return { ...row, message: { ...row.message, content: next } }
  })
  return changed ? out : rows
}

/**
 * Strip UNSIGNED thinking blocks before an Anthropic request (
 * live-proved on the Sol→Opus mid-conversation switch): thinking
 * blocks minted by a non-Anthropic runtime (GPT reasoning summaries, GLM
 * thinking) carry `signature: ''` and the Anthropic API rejects them with
 * "Invalid `signature` in `thinking` block". Reasoning is provider-private
 * and never round-trips cross-provider (brief) — drop them; Anthropic
 * turns' own signed thinking replays untouched. A turn left with zero
 * renderable blocks keeps a placeholder so the row stays valid.
 */
/** A thinking block with no (or an empty) signature — minted by a
 *  non-Anthropic runtime. The strip below and the transition planner share
 *  THIS predicate, so the preview's loss counts always match the wire. */
export function isUnsignedThinkingBlock(b: { type?: string }): boolean {
  if (b.type !== 'thinking') return false
  const signature = (b as { signature?: unknown }).signature
  return !(typeof signature === 'string' && signature.length > 0)
}

export function stripUnsignedThinkingBlocks(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  let changed = false
  const result = messages.map(msg => {
    if (msg.type !== 'assistant') return msg
    const content = msg.message.content
    const filtered = content.filter(b => !isUnsignedThinkingBlock(b))
    if (filtered.length === content.length) return msg
    changed = true
    if (filtered.length === 0) {
      filtered.push({
        type: 'text' as const,
        text: '[reasoning from another model provider — not transferable]',
        citations: [],
      })
    }
    return { ...msg, message: { ...msg.message, content: filtered } }
  })
  return changed ? result : messages
}

/**
 * Strip advisor blocks — the API rejects server_tool_use name:"advisor"
 * without the advisor beta header. If stripping leaves nothing renderable,
 * substitute the placeholder text block.
 */
export function stripAdvisorBlocks(
  messages: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  let changed = false
  const result = messages.map(msg => {
    if (msg.type !== 'assistant') return msg
    const content = msg.message.content
    const filtered = content.filter(b => !isAdvisorBlock(b))
    if (filtered.length === content.length) return msg
    changed = true
    if (
      filtered.length === 0 ||
      filtered.every(
        b =>
          b.type === 'thinking' ||
          b.type === 'redacted_thinking' ||
          (b.type === 'text' && (!b.text || !b.text.trim())),
      )
    ) {
      filtered.push({
        type: 'text' as const,
        text: '[Advisor response]',
        citations: [],
      })
    }
    return { ...msg, message: { ...msg.message, content: filtered } }
  })
  return changed ? result : messages
}
