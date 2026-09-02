// ============================================================================
//  compact/checkpointRewind — checkpoint/rewind as agent verbs (spec 07-C4),
//  on Mercury's append-only transcript law.
//
//  RECONCILIATION with the existing operator devices (the spec's first task;
//  never-reduce-scope):
//    · /rewind (alias /checkpoint) opens the MESSAGE SELECTOR — the
//      operator's device, restoring code, conversation, or both. It keeps
//      every behaviour it has; nothing here replaces it.
//    · /handoff stays a RESERVED name (the retired multiplayer's two-user
//      steering verb, answering typed) — the compaction "handoff" method
//      never takes its name.
//    · These verbs are the AGENT's device: context-only, report-carrying,
//      settle-guarded. Files and git are NEVER touched — the tool text says
//      so, and nothing here calls fileHistoryRewind.
//
//  Mechanics (the append-only law — nothing is ever deleted):
//    · A CHECKPOINT is the Checkpoint tool's settled tool_result in the
//      transcript. No side store: the ACTIVE checkpoint is reconstructed by
//      scanning messages, so resume rehydration is free and cannot drift.
//    · A REWIND appends one hidden RECORD message (user, isMeta) carrying
//      the report and a bounded summary of the abandoned exploration. The
//      record is the retained-report message the next turn sees.
//    · The PROJECTION (projectRewoundWindows) excludes the exploration —
//      everything between the checkpoint's result and its rewind record —
//      from provider-bound views only. Scrollback keeps everything.
//    · Root-fallback: a record whose checkpoint vanished from the live view
//      (compacted away, operator-rewound) carries fallback="root" and
//      excludes from the view start. Double-rewind refuses typed.
// ============================================================================
import type { Message, UserMessage } from '../../types/message.js'
// The factory directly — the utils/messages barrel transitively reaches
// tools.ts, and the tool files import THIS module's names (§DEPS-TDZ).
import { createUserMessage } from '../../utils/messages/factories.js'

export const CHECKPOINT_TOOL_NAME = 'Checkpoint'
export const REWIND_TOOL_NAME = 'Rewind'

/** The record message's opening tag — the projection and the scanners key on
 *  this exact prefix (a stable wire contract within Mercury). */
export const REWIND_RECORD_TAG = 'mercury-rewind-record'

export interface ActiveCheckpoint {
  /** The checkpoint tool_use id — the identity the record names. */
  id: string
  goal: string
  /** Index of the message carrying the settled tool_result (the boundary:
   *  exploration begins AFTER this index). */
  boundaryIndex: number
  /** How many messages existed when the checkpoint was taken. */
  messageCountAtCreation: number
}

type Blockish = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean }

function blocksOf(message: Message): Blockish[] {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? (content as Blockish[]) : []
}

function textOf(message: Message): string {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>)
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('\n')
}

/** Every rewind record in view: checkpointId → record index. */
function rewindRecordIndexes(messages: readonly Message[]): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if ((m as { type?: string }).type !== 'user') continue
    const text = textOf(m)
    if (!text.startsWith(`<${REWIND_RECORD_TAG}`)) continue
    const match = text.match(/checkpoint="([^"]+)"/)
    if (match?.[1]) out.set(match[1], i)
  }
  return out
}

/**
 * The active checkpoint, reconstructed from the transcript alone: the LAST
 * Checkpoint call with a settled non-error tool_result and no rewind record
 * naming it. Null when none. One active max is enforced at the tool
 * (a second Checkpoint refuses while one is active).
 */
export function findActiveCheckpoint(messages: readonly Message[]): ActiveCheckpoint | null {
  const records = rewindRecordIndexes(messages)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if ((m as { type?: string }).type !== 'assistant') continue
    for (const block of blocksOf(m)) {
      if (block.type !== 'tool_use' || block.name !== CHECKPOINT_TOOL_NAME || !block.id) continue
      if (records.has(block.id)) return null // the most recent checkpoint was rewound
      // The settled result lives in a FOLLOWING user message.
      for (let j = i + 1; j < messages.length; j++) {
        const candidate = messages[j]!
        if ((candidate as { type?: string }).type !== 'user') continue
        const result = blocksOf(candidate).find(
          b => b.type === 'tool_result' && b.tool_use_id === block.id,
        )
        if (result === undefined) continue
        if (result.is_error === true) return null // refused checkpoint — not active
        const goal = (block.input as { goal?: unknown } | undefined)?.goal
        return {
          id: block.id,
          goal: typeof goal === 'string' ? goal : '',
          boundaryIndex: j,
          messageCountAtCreation: j + 1,
        }
      }
      return null // tool_use without a settled result — not active
    }
  }
  return null
}

/**
 * Build the rewind RECORD message: the hidden retained-report the next turn
 * sees, plus the bounded summary of what was abandoned. isMeta — rides the
 * wire, never the display transcript.
 */
export function createRewindRecordMessage(args: {
  checkpointId: string
  goal: string
  report: string
  abandonedMessageCount: number
  rootFallback: boolean
}): UserMessage {
  const { checkpointId, goal, report, abandonedMessageCount, rootFallback } = args
  const lines = [
    `<${REWIND_RECORD_TAG} checkpoint="${checkpointId}"${rootFallback ? ' fallback="root"' : ''}>`,
    `The conversation was rewound to the checkpoint${goal ? ` (goal: ${goal})` : ''}.`,
    `${abandonedMessageCount} message(s) of abandoned exploration were removed from the model context (the operator's transcript keeps them).`,
    'Report carried back from the exploration:',
    report,
    `</${REWIND_RECORD_TAG}>`,
  ]
  return createUserMessage({ content: lines.join('\n'), isMeta: true })
}

// ── the OPERATOR's rewind (the /rewind surface's conversation restore) ──────
//  FN-015 rank 8: the operator picks a past user message and winds the
//  conversation back to before it. Keyed by that TURN's uuid, never by a
//  Checkpoint call. Both views exclude the window [turn, record] INCLUSIVE:
//  the model's next call sees the classic truncated conversation (no note
//  about what was abandoned), and the cockpit's chat paints the same
//  boundary — while the transcript keeps every row (the append-only law:
//  identity preserved, same session id, same file, resumable).

/** The operator rewind RECORD: hidden (isMeta), persisted, keyed by the turn. */
export function createOperatorRewindRecordMessage(args: { turnUuid: string; removed: number }): UserMessage {
  const lines = [
    `<${REWIND_RECORD_TAG} turn="${args.turnUuid}" by="operator">`,
    `The operator wound the conversation back to before this turn; ${args.removed} message(s) left the model's view (the transcript keeps them).`,
    `</${REWIND_RECORD_TAG}>`,
  ]
  return createUserMessage({ content: lines.join('\n'), isMeta: true })
}

/** Every operator rewind record in view: turn uuid → record index. */
function operatorRewindRecordIndexes(messages: readonly Message[]): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if ((m as { type?: string }).type !== 'user') continue
    const text = textOf(m)
    if (!text.startsWith(`<${REWIND_RECORD_TAG}`)) continue
    const match = text.match(/\bturn="([^"]+)"/)
    if (match?.[1]) out.set(match[1], i)
  }
  return out
}

/** The operator windows, [turnIndex, recordIndex] inclusive, folded into
 *  `excluded`. A record whose turn already left the view (a later
 *  compaction folded it) stands alone — nothing to exclude. */
function operatorRewindExclusions(messages: readonly Message[], excluded: Set<number>): void {
  const records = operatorRewindRecordIndexes(messages)
  if (records.size === 0) return
  for (const [turnUuid, recordIndex] of records) {
    const turnIndex = messages.findIndex(m => (m as { uuid?: string }).uuid === turnUuid)
    if (turnIndex === -1 || turnIndex > recordIndex) {
      excluded.add(recordIndex)
      continue
    }
    for (let i = turnIndex; i <= recordIndex; i++) excluded.add(i)
  }
}

/**
 * The cockpit's DISPLAY projection: only the operator's windows leave the
 * chat (an agent's rewound exploration stays in scrollback by design).
 * Identity-returns when nothing applies.
 */
export function projectOperatorRewinds<T extends Message>(messages: T[]): T[] {
  const excluded = new Set<number>()
  operatorRewindExclusions(messages, excluded)
  if (excluded.size === 0) return messages
  return messages.filter((_, i) => !excluded.has(i))
}

/**
 * The provider-bound projection: for every rewind record whose checkpoint
 * boundary is in view, exclude (boundaryIndex, recordIndex) EXCLUSIVE — the
 * exploration disappears from the next provider call; the checkpoint round
 * and the record itself stay. A record with fallback="root" whose boundary
 * is NOT in view excludes from the view start. The operator's windows
 * (above) leave the same view, inclusive. Identity-returns when nothing
 * applies (render layers bail on identity).
 *
 * Pairing safety: the excluded window opens right after a settled
 * tool_result row and closes before a user record — it never splits a
 * tool_use from its result.
 */
export function projectRewoundWindows<T extends Message>(messages: T[]): T[] {
  const excluded = new Set<number>()
  agentRewindExclusions(messages, excluded)
  operatorRewindExclusions(messages, excluded)
  if (excluded.size === 0) return messages
  return messages.filter((_, i) => !excluded.has(i))
}

function agentRewindExclusions(messages: readonly Message[], excluded: Set<number>): void {
  const records = rewindRecordIndexes(messages)
  if (records.size === 0) return

  // checkpoint id → boundary index (settled result rows only).
  const boundaries = new Map<string, number>()
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if ((m as { type?: string }).type !== 'assistant') continue
    for (const block of blocksOf(m)) {
      if (block.type !== 'tool_use' || block.name !== CHECKPOINT_TOOL_NAME || !block.id) continue
      if (!records.has(block.id)) continue
      for (let j = i + 1; j < messages.length; j++) {
        const candidate = messages[j]!
        if ((candidate as { type?: string }).type !== 'user') continue
        if (blocksOf(candidate).some(b => b.type === 'tool_result' && b.tool_use_id === block.id)) {
          boundaries.set(block.id, j)
          break
        }
      }
    }
  }

  for (const [checkpointId, recordIndex] of records) {
    const boundary = boundaries.get(checkpointId)
    if (boundary !== undefined && boundary < recordIndex) {
      for (let i = boundary + 1; i < recordIndex; i++) excluded.add(i)
    } else {
      const record = messages[recordIndex]!
      const isRootFallback = textOf(record).includes('fallback="root"')
      if (isRootFallback) {
        for (let i = 0; i < recordIndex; i++) excluded.add(i)
      }
      // No boundary and no root marker: the record stands alone (its
      // exploration already left the view) — nothing to exclude.
    }
  }
}

/**
 * Post-tool-round hook (the turn machine calls this once per round): when a
 * Rewind settled non-error in THIS round, mint the record message. Null
 * otherwise. The machine appends + emits it like any attachment.
 */
export function buildRewindRecordIfSettled(
  roundMessages: readonly Message[],
  toolUseBlocks: ReadonlyArray<{ name?: string; id?: string; input?: unknown }>,
  toolResults: readonly Message[],
): UserMessage | null {
  const rewindUse = toolUseBlocks.find(b => b.name === REWIND_TOOL_NAME && b.id)
  if (rewindUse === undefined) return null
  const settled = toolResults.some(m =>
    blocksOf(m).some(
      b => b.type === 'tool_result' && b.tool_use_id === rewindUse.id && b.is_error !== true,
    ),
  )
  if (!settled) return null
  const report = (rewindUse.input as { report?: unknown } | undefined)?.report
  const checkpoint = findActiveCheckpoint(roundMessages)
  if (checkpoint === null) {
    // The tool refused already (no active checkpoint) — nothing to record.
    return null
  }
  const abandoned = Math.max(0, roundMessages.length - (checkpoint.boundaryIndex + 1))
  return createRewindRecordMessage({
    checkpointId: checkpoint.id,
    goal: checkpoint.goal,
    report: typeof report === 'string' ? report.trim() : '',
    abandonedMessageCount: abandoned,
    rootFallback: false,
  })
}

/** The settle-guard warning (typed, isMeta): injected when a run tries to
 *  end while a checkpoint is active and un-rewound. The machine schedules
 *  one more turn with it; the guard warns ONCE per run (a wedged run is
 *  worse than an unrewound checkpoint — warn-rest). */
export function createSettleGuardWarning(checkpoint: ActiveCheckpoint): UserMessage {
  return createUserMessage({
    content:
      `<system-warning>A checkpoint is still active${checkpoint.goal ? ` (goal: ${checkpoint.goal})` : ''} and no Rewind has been issued. ` +
      `Call Rewind { report } to restore the pre-exploration context and carry your findings back, ` +
      `or state explicitly why the exploration should stand.</system-warning>`,
    isMeta: true,
  })
}
