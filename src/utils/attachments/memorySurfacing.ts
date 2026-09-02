// Memory surfacing — the relevant-memory recall pipeline: prefetch handle
// (Disposable, bound with `using` in query.ts), selector fan-out, bounded
// reads with the experience-card secret-scan, the
// session-byte throttle, and the post-filter dedup that marks survivors in
// readFileState (mark-AFTER-filter is load-bearing — see the function doc).
// Owned Mercury module.
// PRESERVE-CONTRACT: header strings are prompt-cache-stable (computed once at
// attachment creation); the substrate cache-stability suite pins this.

import type { Message } from 'src/types/message.js'
import {
  experienceCardsEnabled,
  fullScanSecretRefusal,
  isExperienceCardMarkdown,
  renderExperienceCardForRecall,
} from '../../memdir/experienceCards.js'
import { findRelevantMemories } from '../../memdir/findRelevantMemories.js'
import { memoryAge, memoryFreshnessText } from '../../memdir/memoryAge.js'
import { referentNote, verifyMemoryReferents } from '../../memdir/memoryReferents.js'
import { getProjectRoot } from '../../bootstrap/state.js'
import {
  getAutoMemPath,
  isAutoMemoryEnabled,
  relevantMemoryRecallEnabled,
} from '../../memdir/paths.js'
import type { ToolUseContext } from '../../Tool.js'
import { getAgentMemoryDir } from '../../tools/AgentTool/agentMemory.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { createChildAbortController } from '../abortController.js'
import { isAbortError } from '../errors.js'
import { cacheKeys, type FileStateCache } from '../fileStateCache.js'
import { logError } from '../log.js'
import { getUserMessageText } from '../messages.js'
import { isHumanTurn } from '../messagePredicates.js'
import { readFileInRange } from '../readFileInRange.js'
import { isToolResultBlock } from './shared.js'
import { RELEVANT_MEMORIES_CONFIG, type Attachment } from './types.js'
import { extractAgentMentions } from './mentions.js'

const MAX_MEMORY_LINES = 200
// A line cap alone is no size bound — 200 lines of 500 chars is 100KB, and
// the surfacer's five files a turn ride a <system-reminder> lane the
// per-message tool-result budget never sees. The byte cap (via
// readFileInRange's truncateOnByteLimit) pins the worst turn at 5 × 4KB.
// Truncated is still surfaced: for the file the ranker liked best, the
// frontmatter and opening lines carry most of the value anyway.
const MAX_MEMORY_BYTES = 4096

// bounds for the FULL-file secret scan of a TRUNCATED card. A legit
// experience card is small; a card larger than this is anomalous, so failing to
// fully scan it (⇒ withhold, fail-closed) is the correct outcome, not a leak.
const SECRET_SCAN_MAX_LINES = 50_000
const SECRET_SCAN_MAX_BYTES = 5_000_000


async function getRelevantMemoryAttachments(
  input: string,
  agents: AgentDefinition[],
  readFileState: FileStateCache,
  recentTools: readonly string[],
  signal: AbortSignal,
  alreadySurfaced: ReadonlySet<string>,
): Promise<Attachment[]> {
  // Memory isolation follows the @-mention: naming an agent searches THAT
  // agent's memory home and nothing else; no mention searches the session's
  // auto-memory home.
  const memoryDirs = extractAgentMentions(input).flatMap(mention => {
    const agentType = mention.replace('agent-', '')
    const agentDef = agents.find(def => def.agentType === agentType)
    return agentDef?.memory
      ? [getAgentMemoryDir(agentType, agentDef.memory)]
      : []
  })
  const dirs = memoryDirs.length > 0 ? memoryDirs : [getAutoMemPath()]

  const allResults = await Promise.all(
    dirs.map(dir =>
      findRelevantMemories(
        input,
        dir,
        signal,
        recentTools,
        alreadySurfaced,
      ).catch(() => []),
    ),
  )
  // The selector already filtered alreadySurfaced (its 5-slot budget goes
  // to fresh candidates) and readFileState covers files the model read
  // itself; the re-check here guards the multi-dir merge, where one dir's
  // results can re-introduce a path another dir's selection filtered.
  const selected = allResults
    .flat()
    .filter(m => !readFileState.has(m.path) && !alreadySurfaced.has(m.path))
    .slice(0, 5)

  const memories = await readMemoriesForSurfacing(selected, signal)

  if (memories.length === 0) {
    return []
  }
  return [{ type: 'relevant_memories' as const, memories }]
}

/**
 * What this conversation has already been shown: every prior
 * relevant_memories attachment, folded into the surfaced-path set (selector
 * dedup) and the cumulative byte count (the session throttle). The
 * transcript IS the ledger on purpose — compaction erases old attachments,
 * so both counters reset exactly when re-surfacing becomes legitimate.
 */
export function collectSurfacedMemories(messages: ReadonlyArray<Message>): {
  paths: Set<string>
  totalBytes: number
} {
  const paths = new Set<string>()
  let totalBytes = 0
  for (const m of messages) {
    if (m.type === 'attachment' && m.attachment.type === 'relevant_memories') {
      for (const mem of m.attachment.memories) {
        paths.add(mem.path)
        totalBytes += mem.content.length
      }
    }
  }
  return { paths, totalBytes }
}

/**
 * Bounded reads for the ranked selection: each file comes back inside the
 * line + byte caps, and an over-cap file surfaces its head with a
 * read-the-rest note instead of vanishing — the ranker chose it, so its
 * opening context is worth having even clipped.
 *
 * Exported for direct testing without mocking the ranker + gates.
 */
export async function readMemoriesForSurfacing(
  selected: ReadonlyArray<{ path: string; mtimeMs: number }>,
  signal?: AbortSignal,
): Promise<
  Array<{
    path: string
    content: string
    mtimeMs: number
    header: string
    limit?: number
  }>
> {
  const results = await Promise.all(
    selected.map(async ({ path: filePath, mtimeMs }) => {
      try {
        const result = await readFileInRange(
          filePath,
          0,
          MAX_MEMORY_LINES,
          MAX_MEMORY_BYTES,
          signal,
          { truncateOnByteLimit: true },
        )
        const truncated =
          result.totalLines > MAX_MEMORY_LINES || result.truncatedByBytes
        const content = truncated
          ? result.content +
            `\n\n> This memory file was truncated (${result.truncatedByBytes ? `${MAX_MEMORY_BYTES} byte limit` : `first ${MAX_MEMORY_LINES} lines`}). Use the ${FILE_READ_TOOL_NAME} tool to view the complete file at: ${filePath}`
          : result.content
        // Fork+MERCURY_EXPERIENCE_CARDS-gated lifecycle framing: an unapproved
        // experience card is surfaced as a "candidate lesson, unverified"
        // (never a trusted instruction); secret-bearing cards are withheld.
        // OFF (or non-card content) ⇒ identity ⇒ byte-identical.
        let rendered: string
        if (!experienceCardsEnabled()) {
          rendered = content
        } else if (truncated) {
          // the renderer's own detectSecrets — and the
          // isExperienceCardMarkdown card-detection — both see only the truncated
          // PREFIX (MAX_MEMORY_BYTES/LINES). So a secret PAST the cap slips past the
          // per-prefix scan, AND a card whose `metadata.type` marker sits past the
          // cap reads as a non-card in the prefix (→ the old branch was skipped and
          // the prefix surfaced without a full scan). FIX: for ANY truncated file in
          // this gated path, do the bounded FULL read + full-scan secret refusal
          // FIRST. Withhold (fail-closed) if it bears a secret anywhere OR is too big
          // to fully scan; otherwise render with card framing if it is one (decided
          // on the FULL text, not the prefix), else as plain content. Rare path
          // (most cards < 4KB). OFF ⇒ unreachable ⇒ byte-identical.
          let full: string | null
          try {
            const fullRes = await readFileInRange(
              filePath,
              0,
              SECRET_SCAN_MAX_LINES,
              SECRET_SCAN_MAX_BYTES,
              signal,
              { truncateOnByteLimit: true },
            )
            full =
              fullRes.truncatedByBytes || fullRes.totalLines > SECRET_SCAN_MAX_LINES
                ? null // couldn't fully scan ⇒ fail-closed
                : fullRes.content
          } catch {
            full = null
          }
          const refusal = fullScanSecretRefusal(full)
          rendered = refusal
            ? refusal
            : full !== null && isExperienceCardMarkdown(full)
              ? // #12: render the banner/metadata from the FULL card (frontmatter may sit
                // past the truncation cap) while surfacing the truncated `content` body.
                renderExperienceCardForRecall(content, full, mtimeMs)
              : content
        } else {
          rendered = renderExperienceCardForRecall(content, undefined, mtimeMs)
        }
        // Provenance: a surfaced memory naming a file/flag that no longer
        // exists says so right under its body. Computed once here, at
        // attachment creation, over the same prefix the model sees; the
        // attachment HEADER stays a frozen cache contract, so the note
        // rides the content.
        const referents = verifyMemoryReferents(result.content, { projectRoot: getProjectRoot() })
        if (referents.missing.length > 0) rendered += referentNote(referents)
        return {
          path: filePath,
          content: rendered,
          // Read-time mtime (the fresh stat from this read), not the scan-time stat:
          // the freshness signal + diff baseline should reflect the bytes just read.
          mtimeMs: result.mtimeMs,
          header: memoryHeader(filePath, result.mtimeMs),
          limit: truncated ? result.lineCount : undefined,
          // Raw disk bytes when the surfaced content is a FRAMED card view — so the
          // readFileState diff baseline is the real file, not the banner-wrapped text.
          rawContent: rendered !== result.content ? result.content : undefined,
        }
      } catch {
        return null
      }
    }),
  )
  return results.filter(r => r !== null)
}

/**
 * The one-line header a surfaced memory renders under (freshness + path).
 * Exported as the fallback for resumed sessions whose stored attachments
 * predate precomputed headers.
 */
export function memoryHeader(path: string, mtimeMs: number): string {
  const staleness = memoryFreshnessText(mtimeMs)
  return staleness
    ? `${staleness}\n\nMemory: ${path}:`
    : `Memory (saved ${memoryAge(mtimeMs)}): ${path}:`
}

/**
 * The handle for one turn's relevance-selector prefetch. Minted once per
 * user turn; the search runs while the model streams and tools execute,
 * and the post-tools collect point polls settledAt — ready is consumed,
 * not-ready is skipped and re-polled next iteration. The turn never waits
 * on it.
 *
 * It is Disposable so query.ts can bind it with `using`: whatever way the
 * query generator exits (return, throw, external .return()),
 * [Symbol.dispose] aborts an in-flight search and emits the terminal
 * telemetry — one binding instead of instrumentation at every one of the
 * loop's many return sites.
 */
export type MemoryPrefetch = {
  promise: Promise<Attachment[]>
  /** Settlement clock — null while in flight; stamped by promise.finally(). */
  settledAt: number | null
  /** Which loop iteration consumed the result; -1 while unconsumed. */
  consumedOnIteration: number
  [Symbol.dispose](): void
}

/**
 * Kick off the relevance search the moment a real user prompt exists —
 * non-blocking, racing the main stream. The last non-isMeta user message
 * is the query; the return is the Disposable handle above, bound with
 * `using` in query.ts. undefined = no prefetch this turn (gates off, no
 * prompt, single word, or session byte budget spent).
 */
export function startRelevantMemoryPrefetch(
  messages: ReadonlyArray<Message>,
  toolUseContext: ToolUseContext,
): MemoryPrefetch | undefined {
  // relevantMemoryRecallEnabled() folds in the mercury_moth_copse gate AND the
  // fork's DEFAULT-OFF MERCURY_RELEVANT_RECALL=1 opt-in; OFF ⇒ no prefetch ⇒
  // byte-identical.
  if (!isAutoMemoryEnabled() || !relevantMemoryRecallEnabled()) {
    return undefined
  }

  const lastUserMessage = messages.findLast((m: Message) => m.type === 'user' && !m.isMeta)
  if (!lastUserMessage) {
    return undefined
  }

  const input = getUserMessageText(lastUserMessage)
  // One word gives the term extractor nothing to chew on.
  if (!input || !/\s/.test(input.trim())) {
    return undefined
  }

  const surfaced = collectSurfacedMemories(messages)
  if (surfaced.totalBytes >= RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES) {
    return undefined
  }

  // A child of the turn's own abort: the operator's Escape kills the side
  // search the moment it kills the turn — not later, when disposal runs.
  const controller = createChildAbortController(toolUseContext.abortController)
  const firedAt = Date.now()
  const promise = getRelevantMemoryAttachments(
    input,
    toolUseContext.options.agentDefinitions.activeAgents,
    toolUseContext.readFileState,
    collectRecentSuccessfulTools(messages, lastUserMessage),
    controller.signal,
    surfaced.paths,
  ).catch(e => {
    if (!isAbortError(e)) {
      logError(e)
    }
    return []
  })

  const handle: MemoryPrefetch = {
    promise,
    settledAt: null,
    consumedOnIteration: -1,
    [Symbol.dispose]() {
      controller.abort()
    },
  }
  void promise.finally(() => {
    handle.settledAt = Date.now()
  })
  return handle
}


/**
 * The this-turn success roster: tools that ran clean (no errors at all)
 * since the last real turn boundary. The selector suppresses reference
 * material for these — a tool the model is already wielding well needs no
 * documentation surfaced.
 *
 * Strictness is deliberate: one error keeps a tool OFF the roster (the
 * model is struggling — leave its docs eligible), and a use with no result
 * yet stays off too (outcome unknown).
 *
 * Mechanics: tool_use blocks live in assistant content, tool_result blocks
 * in user content; the backward scan meets results before their uses, so
 * both collect by id and resolve at the end.
 */
export function collectRecentSuccessfulTools(
  messages: ReadonlyArray<Message>,
  lastUserMessage: Message,
): readonly string[] {
  const useIdToName = new Map<string, string>()
  const resultByUseId = new Map<string, boolean>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    if (isHumanTurn(m) && m !== lastUserMessage) break
    if (m.type === 'assistant' && typeof m.message.content !== 'string') {
      for (const block of m.message.content) {
        if (block.type === 'tool_use') useIdToName.set(block.id, block.name)
      }
    } else if (
      m.type === 'user' &&
      'message' in m &&
      Array.isArray(m.message.content)
    ) {
      for (const block of m.message.content) {
        if (isToolResultBlock(block)) {
          resultByUseId.set(block.tool_use_id, block.is_error === true)
        }
      }
    }
  }
  const failed = new Set<string>()
  const succeeded = new Set<string>()
  for (const [id, name] of useIdToName) {
    const errored = resultByUseId.get(id)
    if (errored === undefined) continue
    if (errored) {
      failed.add(name)
    } else {
      succeeded.add(name)
    }
  }
  return [...succeeded].filter(t => !failed.has(t))
}


/**
 * The collect-point dedup: drop every prefetched memory the context already
 * holds (a file tool touched it some iteration this turn, or an earlier
 * turn surfaced it — readFileState tracks both), then mark the survivors so
 * later turns skip them.
 *
 * Mark AFTER filter, never during the prefetch — this ordering is load-
 * bearing. When the prefetch itself wrote readFileState, the filter then
 * saw its own selections as "already in context" and dropped every one of
 * them: a self-cancelling pipeline. Writing only here, post-filter, breaks
 * the cycle and still dedups against tool reads from any iteration.
 */
export function filterDuplicateMemoryAttachments(
  attachments: Attachment[],
  readFileState: FileStateCache,
): Attachment[] {
  return attachments
    .map(attachment => {
      if (attachment.type !== 'relevant_memories') return attachment
      const filtered = attachment.memories.filter(
        m => !readFileState.has(m.path),
      )
      for (const m of filtered) {
        readFileState.set(m.path, {
          // When the surfaced content is a framed card view, cache the RAW disk
          // bytes + isPartialView (mirror the nested-memory store at ~1918) so
          // getChangedFiles compares raw-vs-disk (no spurious diff) and Edit/Write
          // require a real Read first.
          content: m.rawContent ?? m.content,
          timestamp: m.mtimeMs,
          offset: undefined,
          limit: m.limit,
          isPartialView: m.rawContent !== undefined,
        })
      }
      return filtered.length > 0 ? { ...attachment, memories: filtered } : null
    })
    .filter((a): a is Attachment => a !== null)
}

