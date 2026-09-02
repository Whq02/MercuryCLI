// sessionStorage/chain — the parentUuid graph brought back to a usable
// transcript: leaf→root walks with orphan recovery, compact/snip relinking,
// round-trip drift detection, loggability filtering, and first-prompt
// extraction for session labels. The parity oracle's chain goldens pin the
// walk semantics.

import type { UUID } from 'crypto'
import { builtInCommandNames } from '../../commands.js'
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import { REPL_TOOL_NAME } from '../../tools/REPLTool/constants.js'
import type {
  AttributionSnapshotMessage,
  FileHistorySnapshotMessage,
  SerializedMessage,
  TranscriptMessage,
} from '../../types/logs.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemCompactBoundaryMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import { logForDebugging } from '../debug.js'
import type { FileHistorySnapshot } from '../fileHistory.js'
import { logError } from '../log.js'
import { extractTag, isCompactBoundaryMessage, normalizeAttachmentForAPI } from '../messages.js'
import { getUserType } from './paths.js'

// Shared skip grammar with sessionStoragePortable.ts: any lowercase XML-ish
// opening tag, or the synthetic interrupt marker — the generic shape keeps
// new notification kinds from needing allowlist updates.
const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

export function extractFirstPrompt(transcript: TranscriptMessage[]): string {
  const textContent = getFirstMeaningfulUserMessageTextContent(transcript)
  if (textContent) {
    let result = textContent.replace(/\n/g, ' ').trim()

    // Keep a generous slice; the renderer truncates to the live terminal
    // width at display time.
    if (result.length > 200) {
      result = result.slice(0, 200).trim() + '…'
    }

    return result
  }

  return 'No prompt'
}

/**
 * The first user message that carries real operator intent — the text a
 * session label should be built from. Skips meta/compact-summary messages,
 * built-in slash commands, argument-less custom commands, and anything
 * matching the notification-tag grammar.
 */
export function getFirstMeaningfulUserMessageTextContent<T extends Message>(
  transcript: T[],
): string | undefined {
  for (const msg of transcript) {
    if (msg.type !== 'user' || msg.isMeta) continue
    // A compact summary opens many resumed sessions; it is derived text,
    // never the operator's own prompt.
    if ('isCompactSummary' in msg && msg.isCompactSummary) continue

    const content = msg.message?.content
    if (!content) continue

    // Walk EVERY text block, not just the first: IDE-integrated sessions
    // put <ide_selection>-style metadata blocks ahead of the block holding
    // the real prompt.
    const texts: string[] = []
    if (typeof content === 'string') {
      texts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          texts.push(block.text)
        }
      }
    }

    for (const textContent of texts) {
      if (!textContent) continue

      const commandNameTag = extractTag(textContent, COMMAND_NAME_TAG)
      if (commandNameTag) {
        const commandName = commandNameTag.replace(/^\//, '')

        // A built-in command invocation (`/model sonnet`) says nothing
        // about what the session is for.
        if (builtInCommandNames().has(commandName)) {
          continue
        } else {
          // A custom command titles the session only when it carried
          // arguments — and then as clean text, not raw markup.
          const commandArgs = extractTag(textContent, 'command-args')?.trim()
          if (!commandArgs) {
            continue
          }
          return `${commandNameTag} ${commandArgs}`
        }
      }

      // Bash-mode input labels as the operator typed it. Must run before
      // the generic tag skip, which would otherwise eat the whole session.
      const bashInput = extractTag(textContent, 'bash-input')
      if (bashInput) {
        return `! ${bashInput}`
      }

      // Notification-shaped text (hook output, tick prompts, IDE metadata,
      // channel traffic) is machine-written; keep looking.
      if (SKIP_FIRST_PROMPT_PATTERN.test(textContent)) {
        continue
      }

      return textContent
    }
  }
  return undefined
}

export function removeExtraFields(
  transcript: TranscriptMessage[],
): SerializedMessage[] {
  return transcript.map(m => {
    const { isSidechain, parentUuid, ...serializedMessage } = m
    return serializedMessage
  })
}

/**
 * Re-attach a compaction's preserved segment to the live chain.
 *
 * The preserved messages sit on disk with their PRE-compact parentUuids —
 * recordTranscript dedup-skipped them, so their bytes were never rewritten.
 * Their internal links are intact; only the two endpoints need patching:
 * the segment head is re-parented onto the boundary's anchor, and any other
 * child of the anchor is moved onto the segment tail. The anchor is the
 * final summary for suffix-preserving compaction, the boundary itself for
 * prefix-preserving.
 *
 * Only the LAST boundary that carries a segment is honored — earlier
 * segments were folded into later summaries. Everything physically before
 * the absolute-last boundary dies except preserved uuids; that one prune
 * rule covers every multi-boundary shape without special cases.
 *
 * Mutates the Map in place.
 */
export function applyPreservedSegmentRelinks(
  messages: Map<UUID, TranscriptMessage>,
): void {
  type Seg = NonNullable<
    SystemCompactBoundaryMessage['compactMetadata']['preservedSegment']
  >

  // One pass: index positions, find the absolute-last boundary and the last
  // boundary that carries a segment. They differ when a manual /compact
  // follows a reactive one — the older segment is then stale.
  let lastSeg: Seg | undefined
  let lastSegBoundaryIdx = -1
  let absoluteLastBoundaryIdx = -1
  const entryIndex = new Map<UUID, number>()
  let i = 0
  for (const entry of messages.values()) {
    entryIndex.set(entry.uuid, i)
    if (isCompactBoundaryMessage(entry)) {
      absoluteLastBoundaryIdx = i
      const seg = entry.compactMetadata?.preservedSegment
      if (seg) {
        lastSeg = seg
        lastSegBoundaryIdx = i
      }
    }
    i++
  }
  // No segment anywhere ⇒ nothing to do, and the map must stay whole —
  // full-map readers (findUnresolvedToolUse) depend on that.
  if (!lastSeg) return

  // A newer segment-less boundary supersedes the segment: skip the relink
  // but STILL prune at the absolute boundary, or the stale preserved chain
  // would surface as a phantom resume leaf.
  const segIsLive = lastSegBoundaryIdx === absoluteLastBoundaryIdx

  // Prove tail→head connectivity BEFORE any mutation, so malformed segment
  // metadata degrades to a true no-op (full pre-compact history loads).
  const preservedUuids = new Set<UUID>()
  if (segIsLive) {
    const walkSeen = new Set<UUID>()
    let cur = messages.get(lastSeg.tailUuid)
    let reachedHead = false
    while (cur && !walkSeen.has(cur.uuid)) {
      walkSeen.add(cur.uuid)
      preservedUuids.add(cur.uuid)
      if (cur.uuid === lastSeg.headUuid) {
        reachedHead = true
        break
      }
      cur = cur.parentUuid ? messages.get(cur.parentUuid) : undefined
    }
    if (!reachedHead) {
      // A uuid the segment references never made the transcript. Known
      // producer: a mid-turn-yielded attachment pushed to mutableMessages
      // whose flush was lost to an SDK subprocess restart. Bailing here
      // also skips the prune, so resume sees the full pre-compact history
      // rather than a chain with a hole.
      return
    }
  }

  if (segIsLive) {
    const head = messages.get(lastSeg.headUuid)
    if (head) {
      messages.set(lastSeg.headUuid, {
        ...head,
        parentUuid: lastSeg.anchorUuid,
      })
    }
    // Anchor's other children move onto the tail; already-correct links
    // (the useLogMessages race shape) pass through unchanged.
    for (const [uuid, msg] of messages) {
      if (msg.parentUuid === lastSeg.anchorUuid && uuid !== lastSeg.headUuid) {
        messages.set(uuid, { ...msg, parentUuid: lastSeg.tailUuid })
      }
    }
    // The preserved assistants' on-disk usage still describes the
    // pre-compact context (stripStaleUsage only fixed the in-memory copies
    // the dedup skipped). Left standing, resume reads ~190K input tokens
    // and immediately spirals into another autocompact — so zero it.
    for (const uuid of preservedUuids) {
      const msg = messages.get(uuid)
      if (msg?.type !== 'assistant') continue
      messages.set(uuid, {
        ...msg,
        message: {
          ...msg.message,
          usage: {
            ...msg.message.usage,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      })
    }
  }

  // The prune: everything positioned before the absolute-last boundary and
  // not preserved. With a stale segment preservedUuids is empty ⇒ full prune.
  const toDelete: UUID[] = []
  for (const [uuid] of messages) {
    const idx = entryIndex.get(uuid)
    if (
      idx !== undefined &&
      idx < absoluteLastBoundaryIdx &&
      !preservedUuids.has(uuid)
    ) {
      toDelete.push(uuid)
    }
  }
  for (const uuid of toDelete) messages.delete(uuid)
}

/**
 * Replay Snip removals against the loaded map and heal the chain across
 * the holes.
 *
 * Snip cuts MIDDLE ranges (compact truncates a prefix), and the JSONL is
 * append-only — so snipped messages stay on disk and survivors' parentUuid
 * links still run through them. Loading without this replay resurrects the
 * full unsnipped history, and resume promptly exceeds the context window
 * (observed: 397K shown vs 1.65M actual).
 *
 * Deletion alone would strand every survivor whose parent fell in a removed
 * range — buildConversationChain stops at the first missing parent. So each
 * dangling survivor is re-linked to its nearest surviving ancestor by
 * walking the removed region's own recorded parent links.
 *
 * The snip boundary records removedUuids at execution time; boundaries from
 * before that field are skipped, which loads their pre-snip history — the
 * old behavior, degraded to knowingly.
 *
 * Mutates the Map in place.
 */
export function applySnipRemovals(messages: Map<UUID, TranscriptMessage>): void {
  // Structural sniff for the boundary subtype — the subtype's literal name
  // is on the excluded-strings list for external builds, so the check reads
  // the metadata field instead of the type tag.
  type WithSnipMeta = { snipMetadata?: { removedUuids?: UUID[] } }
  const toDelete = new Set<UUID>()
  for (const entry of messages.values()) {
    const removedUuids = (entry as WithSnipMeta).snipMetadata?.removedUuids
    if (!removedUuids) continue
    for (const uuid of removedUuids) toDelete.add(uuid)
  }
  if (toDelete.size === 0) return

  // Record each victim's own parent link BEFORE deleting — that map is what
  // lets the relink walk cross contiguous removed ranges. A victim already
  // absent from the map (a prior compact prune took it) contributes no
  // link; the walk then terminates into null, i.e. chain root — exactly
  // what a compact truncation at that point would have produced.
  const deletedParent = new Map<UUID, UUID | null>()
  let removedCount = 0
  for (const uuid of toDelete) {
    const entry = messages.get(uuid)
    if (!entry) continue
    deletedParent.set(uuid, entry.parentUuid)
    messages.delete(uuid)
    removedCount++
  }

  // Re-link each dangling survivor through the removed region, with path
  // compression: once a chain segment resolves, seed every hop with the
  // answer so shared segments never re-walk.
  const resolve = (start: UUID): UUID | null => {
    const path: UUID[] = []
    let cur: UUID | null | undefined = start
    while (cur && toDelete.has(cur)) {
      path.push(cur)
      cur = deletedParent.get(cur)
      if (cur === undefined) {
        cur = null
        break
      }
    }
    for (const p of path) deletedParent.set(p, cur)
    return cur
  }
  let relinkedCount = 0
  for (const [uuid, msg] of messages) {
    if (!msg.parentUuid || !toDelete.has(msg.parentUuid)) continue
    messages.set(uuid, { ...msg, parentUuid: resolve(msg.parentUuid) })
    relinkedCount++
  }

  // Surface the replay so a snip-heavy resume is explainable from the debug
  // log alone (these counters existed before but fed nothing).
  if (removedCount > 0 || relinkedCount > 0) {
    logForDebugging(
      `snip replay on load: ${removedCount} message(s) removed, ${relinkedCount} survivor(s) re-linked`,
    )
  }
}

/**
 * Single pass max-by-timestamp under a predicate. The naive
 * filter+sort+first spelling costs O(n log n) and two Date allocations per
 * element; sessions hit this with tens of thousands of messages.
 */
export function findLatestMessage<T extends { timestamp: string }>(
  messages: Iterable<T>,
  predicate: (m: T) => boolean,
): T | undefined {
  let latest: T | undefined
  let maxTime = -Infinity
  for (const m of messages) {
    if (!predicate(m)) continue
    const t = Date.parse(m.timestamp)
    if (t > maxTime) {
      maxTime = t
      latest = m
    }
  }
  return latest
}

/**
 * Walk leaf→root along parentUuid, reverse into chronological order, then
 * run the orphan-recovery post-pass. A cycle logs and returns the partial
 * chain rather than hanging the load.
 */
export function buildConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage,
): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = []
  const seen = new Set<UUID>()
  let currentMsg: TranscriptMessage | undefined = leafMessage
  while (currentMsg) {
    if (seen.has(currentMsg.uuid)) {
      logError(
        new Error(
          `Cycle detected in parentUuid chain at message ${currentMsg.uuid}. Returning partial transcript.`,
        ),
      )
      break
    }
    seen.add(currentMsg.uuid)
    transcript.push(currentMsg)
    currentMsg = currentMsg.parentUuid
      ? messages.get(currentMsg.parentUuid)
      : undefined
  }
  transcript.reverse()
  return recoverChainAttachedNotes(messages, recoverOrphanedParallelToolResults(messages, transcript, seen), seen)
}

/**
 * Recovery pass for the session's own NOTES: a local command's receipt, a
 * turn-duration line, a model transition, an away recap — system rows the
 * session writes as children of a chain member that nothing ever parents
 * onto. The single-parent walk from the leaf never visits them, so a chat
 * that paints from its file (every chat does — the session runs in its own
 * process) would show `❯ /cost` and never its answer. The topology is on
 * disk: each note keys by parentUuid, so the heal is read-side — every
 * off-chain note whose parent is on the chain splices directly after that
 * parent (file order among siblings). The compaction boundaries are
 * structural, never notes: they stay exactly where the walk found them.
 */
function recoverChainAttachedNotes(
  messages: Map<UUID, TranscriptMessage>,
  chain: TranscriptMessage[],
  seen: Set<UUID>,
): TranscriptMessage[] {
  const notesByParent = new Map<UUID, TranscriptMessage[]>()
  for (const m of messages.values()) {
    if (m.type !== 'system' || seen.has(m.uuid) || !m.parentUuid || !seen.has(m.parentUuid)) continue
    const subtype = (m as { subtype?: string }).subtype
    if (subtype === 'compact_boundary' || subtype === 'microcompact_boundary') continue
    const group = notesByParent.get(m.parentUuid)
    if (group) group.push(m)
    else notesByParent.set(m.parentUuid, [m])
  }
  if (notesByParent.size === 0) return chain
  const out: TranscriptMessage[] = []
  for (const m of chain) {
    out.push(m)
    const notes = notesByParent.get(m.uuid)
    if (notes) {
      for (const note of notes) {
        seen.add(note.uuid)
        out.push(note)
      }
    }
  }
  return out
}

/**
 * Recovery pass for what the single-parent walk cannot see: parallel
 * tool_use turns are a DAG on disk, and a linked-list walk keeps one branch.
 *
 * The stream emits one AssistantMessage per content_block_stop — N parallel
 * tool_uses become N messages sharing message.id under distinct uuids, and
 * each tool_result chains to ITS OWN one-block assistant. Two loss shapes
 * ship in real transcripts:
 *   1. sibling drop — the walk threads prev→asstA→TR_A→next and never
 *      visits asstB (chained off asstA) or TR_B;
 *   2. progress-fork (a shape earlier builds wrote) — each tool_use
 *      assistant had both a progress
 *      child (which continued the write chain) and a TR child; the walk
 *      followed progress and every TR fell off. No longer written, but the
 *      shape is permanent in old files.
 *
 * The topology is already on disk, so the heal is read-side: for each
 * message.id group touching the chain, gather off-chain siblings and their
 * off-chain tool_results, sort by timestamp (stable ⇒ write order on ties),
 * and splice them directly after the group's last on-chain member — keeping
 * the group contiguous for normalizeMessagesForAPI's merge, with every TR
 * after its tool_use.
 */
function recoverOrphanedParallelToolResults(
  messages: Map<UUID, TranscriptMessage>,
  chain: TranscriptMessage[],
  seen: Set<UUID>,
): TranscriptMessage[] {
  type ChainAssistant = Extract<TranscriptMessage, { type: 'assistant' }>
  const chainAssistants = chain.filter(
    (m): m is ChainAssistant => m.type === 'assistant',
  )
  if (chainAssistants.length === 0) return chain

  // Splice anchor per group = LAST on-chain member (chain order in,
  // later writes win).
  const anchorByMsgId = new Map<string, ChainAssistant>()
  for (const a of chainAssistants) {
    if (a.message.id) anchorByMsgId.set(a.message.id, a)
  }

  // One O(n) sweep builds both indexes. TRs key by parentUuid — the writer
  // stamped it from sourceToolAssistantUUID, and --fork-session keeps
  // parentUuid while stripping the source field.
  const siblingsByMsgId = new Map<string, TranscriptMessage[]>()
  const toolResultsByAsst = new Map<UUID, TranscriptMessage[]>()
  for (const m of messages.values()) {
    if (m.type === 'assistant' && m.message.id) {
      const group = siblingsByMsgId.get(m.message.id)
      if (group) group.push(m)
      else siblingsByMsgId.set(m.message.id, [m])
    } else if (
      m.type === 'user' &&
      m.parentUuid &&
      Array.isArray(m.message.content) &&
      m.message.content.some(b => b.type === 'tool_result')
    ) {
      const group = toolResultsByAsst.get(m.parentUuid)
      if (group) group.push(m)
      else toolResultsByAsst.set(m.parentUuid, [m])
    }
  }

  const processedGroups = new Set<string>()
  const inserts = new Map<UUID, TranscriptMessage[]>()
  let recoveredCount = 0
  for (const asst of chainAssistants) {
    const msgId = asst.message.id
    if (!msgId || processedGroups.has(msgId)) continue
    processedGroups.add(msgId)

    const group = siblingsByMsgId.get(msgId) ?? [asst]
    const orphanedSiblings = group.filter(s => !seen.has(s.uuid))
    const orphanedTRs: TranscriptMessage[] = []
    for (const member of group) {
      const trs = toolResultsByAsst.get(member.uuid)
      if (!trs) continue
      for (const tr of trs) {
        if (!seen.has(tr.uuid)) orphanedTRs.push(tr)
      }
    }
    if (orphanedSiblings.length === 0 && orphanedTRs.length === 0) continue

    orphanedSiblings.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    orphanedTRs.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    const anchor = anchorByMsgId.get(msgId)!
    const recovered = [...orphanedSiblings, ...orphanedTRs]
    for (const r of recovered) seen.add(r.uuid)
    recoveredCount += recovered.length
    inserts.set(anchor.uuid, recovered)
  }

  if (recoveredCount === 0) return chain

  const result: TranscriptMessage[] = []
  for (const m of chain) {
    result.push(m)
    const toInsert = inserts.get(m.uuid)
    if (toInsert) result.push(...toInsert)
  }
  return result
}

/**
 * Round-trip drift probe, fired once per resume: the newest turn_duration
 * checkpoint recorded how many messages preceded it at write time; its
 * index in the RECONSTRUCTED chain says how many precede it now.
 *
 *   drift > 0 — resume loaded more than the session held (snip/compact/
 *               parallel-TR mutations that the disk walk resurrected);
 *   drift < 0 — resume lost messages (chain truncation);
 *   drift = 0 — the write→load round trip is faithful.
 *
 * Detection only — the mismatch is logged, never "fixed" here, because the
 * probe cannot know which side is right.
 */
export function checkResumeConsistency(chain: Message[]): void {
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i]!
    if (m.type !== 'system' || m.subtype !== 'turn_duration') continue
    const expected = m.messageCount
    if (expected === undefined) return
    // The checkpoint was appended after `expected` messages, so its own
    // chain index should equal that count.
    const drift = i - expected
    if (drift !== 0) {
      logForDebugging(
        `resume round-trip drift: turn_duration checkpoint expected ${expected} prior message(s), chain has ${i} (drift ${drift > 0 ? '+' : ''}${drift})`,
        { level: 'warn' },
      )
    }
    return
  }
}

/** Project file-history snapshots onto a chain: latest-per-messageId, with
 *  updates replacing in place so restore order matches snapshot order. */
export function buildFileHistorySnapshotChain(
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>,
  conversation: TranscriptMessage[],
): FileHistorySnapshot[] {
  const snapshots: FileHistorySnapshot[] = []
  const indexByMessageId = new Map<string, number>()
  for (const message of conversation) {
    const snapshotMessage = fileHistorySnapshots.get(message.uuid)
    if (!snapshotMessage) {
      continue
    }
    const { snapshot, isSnapshotUpdate } = snapshotMessage
    const existingIndex = isSnapshotUpdate
      ? indexByMessageId.get(snapshot.messageId)
      : undefined
    if (existingIndex === undefined) {
      indexByMessageId.set(snapshot.messageId, snapshots.length)
      snapshots.push(snapshot)
    } else {
      snapshots[existingIndex] = snapshot
    }
  }
  return snapshots
}

/**
 * Attribution snapshots restore in FULL, not per-chain: they carry their
 * own generated uuids (not message uuids) and represent cumulative state
 * the restore path merges, so filtering by conversation would drop data.
 */
export function buildAttributionSnapshotChain(
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>,
  _conversation: TranscriptMessage[],
): AttributionSnapshotMessage[] {
  return Array.from(attributionSnapshots.values())
}

export function cleanMessagesForLogging(
  messages: Message[],
  allMessages: readonly Message[] = messages,
  /** Pre-maintained REPL-id set (hot-path cadence C3c): append-only, so the
   *  incremental path extends it per slice instead of re-walking the whole
   *  transcript on every appended message — which went quadratic over long
   *  tool loops. Absent ⇒ full collection (compaction, /clear, first
   *  render, every other caller). */
  replIds?: Set<string>,
): Transcript {
  const filtered = messages.filter(isLoggableMessage) as Transcript
  return getUserType() !== 'ant'
    ? transformMessagesForExternalTranscript(
        filtered,
        replIds ?? collectReplIds(allMessages),
      )
    : filtered
}

export type Transcript = (
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | SystemMessage
)[]

// Exported so useLogMessages can compute the last loggable uuid
// synchronously instead of awaiting recordTranscript (race-free hints).
export function isLoggableMessage(m: Message): boolean {
  if (m.type === 'progress') return false
  if (m.type === 'attachment' && getUserType() !== 'ant') {
    const att = m.attachment
    // THE OPERATOR'S RECORD (TASK-018 wave 5, FC-083): a hook's FAILURE
    // report persists though the model never reads it — the daemon-hosted
    // chat paints it from this file, and the /hooks browser promises that a
    // non-zero exit "shows stderr to the user".
    if (att.type === 'hook_non_blocking_error' || att.type === 'hook_error_during_execution') return true
    // THE BINDING LAW (Claude Fable 5.1 preserved thinking, the TRANSCRIPT
    // lane): every row the REQUEST renders is part of the prefix the model's
    // thinking blocks are bound to, so it persists and a resumed session
    // replays exactly what was sent — the wire capture showed the first turn
    // losing its MCP-instructions reminder on the first resumed request. A
    // row that renders nothing for the model stays out: the file is the
    // operator's record, not a context dump. One owner decides "renders" —
    // the projection itself. Wire-bound, therefore: every context kind (the
    // deltas, the user-context row, memory and file rows, reminders, the
    // operator's queued prompt) and the hook kinds only when they carry
    // text the model reads (a success on SessionStart/UserPromptSubmit
    // with content, additional context with content, a blocking error, a
    // stopped continuation); hook_cancelled, hook_system_message,
    // hook_permission_decision, structured_output, context_efficiency,
    // dynamic_skill, verify_plan_reminder and an empty success render
    // nothing and stay out.
    return normalizeAttachmentForAPI(att).length > 0
  }
  return true
}

export function collectReplIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>()
  collectReplIdsInto(ids, messages)
  return ids
}

/** Extend a REPL-id set with one slice — the incremental leg of the C3c
 *  cadence; cost O(slice), never O(transcript). */
export function collectReplIdsInto(
  ids: Set<string>,
  messages: readonly Message[],
): void {
  for (const m of messages) {
    if (m.type === 'assistant' && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type === 'tool_use' && b.name === REPL_TOOL_NAME) {
          ids.add(b.id)
        }
      }
    }
  }
}

/**
 * External-transcript REPL erasure: drop REPL tool_use/tool_result pairs
 * and promote isVirtual messages to real ones. A resumed external session
 * then replays as a coherent native-tool history (Bash call, result, Read
 * call, result) with no wrapper tool the model never actually has. Ant
 * transcripts keep the wrapper.
 *
 * replIds MUST come from the full session array, not the slice in hand:
 * recordTranscript receives incremental slices, and a REPL tool_use (early
 * render) routinely lands in a different slice from its tool_result (after
 * async execution). A per-call set would miss the pairing and strand a
 * wrapperless tool_result on disk.
 */
export function transformMessagesForExternalTranscript(
  messages: Transcript,
  replIds: Set<string>,
): Transcript {
  return messages.flatMap((m): Transcript[number] | Transcript => {
    if (m.type === 'assistant' && Array.isArray(m.message.content)) {
      const content = m.message.content
      const hasRepl = content.some(
        b => b.type === 'tool_use' && b.name === REPL_TOOL_NAME,
      )
      const filtered = hasRepl
        ? content.filter(
            b => !(b.type === 'tool_use' && b.name === REPL_TOOL_NAME),
          )
        : content
      if (filtered.length === 0) return []
      if (m.isVirtual) {
        const { isVirtual: _omit, ...rest } = m
        return [{ ...rest, message: { ...m.message, content: filtered } }]
      }
      if (filtered !== content) {
        return [{ ...m, message: { ...m.message, content: filtered } }]
      }
      return [m]
    }
    if (m.type === 'user' && Array.isArray(m.message.content)) {
      const content = m.message.content
      const hasRepl = content.some(
        b => b.type === 'tool_result' && replIds.has(b.tool_use_id),
      )
      const filtered = hasRepl
        ? content.filter(
            b => !(b.type === 'tool_result' && replIds.has(b.tool_use_id)),
          )
        : content
      if (filtered.length === 0) return []
      if (m.isVirtual) {
        const { isVirtual: _omit, ...rest } = m
        return [{ ...rest, message: { ...m.message, content: filtered } }]
      }
      if (filtered !== content) {
        return [{ ...m, message: { ...m.message, content: filtered } }]
      }
      return [m]
    }
    // Remaining shapes (string-content user, system, attachment) only need
    // the isVirtual promotion.
    if ('isVirtual' in m && m.isVirtual) {
      const { isVirtual: _omit, ...rest } = m
      return [rest]
    }
    return [m]
  }) as Transcript
}
