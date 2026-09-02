import { existsSync } from 'node:fs'
import { resolve } from 'path'
import {
  claimContinuation,
  turnBoundaryIndex,
} from '../../services/run/continuationLatch.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../debug.js'
import type { SetAppState } from '../messageQueueManager.js'
import { addFunctionHook } from './sessionHooks.js'

// Tool names whose successful use counts as "this file is now read into context"
// (mirrors the readFileState writers — Read, and the notebook reader).
const READ_TOOL_NAMES = new Set(['Read', 'NotebookRead'])

/**
 * Fixed hook id so re-registration replaces-by-identity rather than appending a
 * fresh auto-id'd Stop hook each turn, and so the hook can be removed cleanly.
 * The fixed-id idempotency contract every keep-working / forced-read hook shares.
 */
export const FORCED_READ_STOP_HOOK_ID = 'forced-read-stop'

// PER-SESSION engage guard: the registration lives INSIDE the per-turn submitMessage
// body, so without a guard the '' -matcher Stop hook accumulates every turn and the
// maxBlocks loop-brake inflates to N×maxBlocks. Keyed by sessionId — a module-global
// boolean was process-global: once ONE session armed it, every LATER session in the
// same process (SDK multi-conversation, /clear→regenerateSessionId, /resume, the daemon
// firing many headless turns) hit the early return and NEVER installed its own hook,
// silently defeating forced-read for session 2+. The Set re-arms per session.
const forcedReadEngagedSessions = new Set<string>()

/**
 * Collect the absolute paths the agent has Read in the current transcript, by
 * scanning assistant `tool_use` blocks for a Read tool with a `file_path`. This
 * is the same source `hasSuccessfulToolCall` uses (the full `messages` array the
 * Stop hook receives), so it survives LRU eviction of readFileState. Paths are
 * resolved to absolute so a relative Read matches an absolute target.
 */
export function collectReadFilePaths(messages: Message[]): Set<string> {
  const read = new Set<string>()
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    const content = m.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        block?.type === 'tool_use' &&
        typeof block.name === 'string' &&
        READ_TOOL_NAMES.has(block.name)
      ) {
        const fp = (block.input as { file_path?: unknown } | null)?.file_path
        if (typeof fp === 'string' && fp.length > 0) {
          read.add(resolve(fp))
        }
      }
    }
  }
  return read
}

/**
 * Register a session-scoped Stop hook that BLOCKS the agent from stopping until
 * it has Read every file in `targetFiles` in the current context.
 *
 * Mirrors `registerStructuredOutputEnforcement` (hookHelpers.ts): the callback
 * returns `false` to block, and `errorMessage` is appended as a meta user
 * message that re-enters the query loop, so the agent is re-prompted instead of
 * stopping. Once it actually Reads the targets the callback returns `true` and
 * the stop is allowed.
 *
 * Safety: `FunctionHookCallback` doesn't receive `stop_hook_active`, so we can't
 * see the base loop guard — instead a per-session attempt cap (`maxBlocks`)
 * gives up after N blocks so a refusing agent is never permanently wedged.
 */
export function registerForcedReadHook(
  setAppState: SetAppState,
  sessionId: string,
  targetFiles: string[],
  options?: { maxBlocks?: number },
): void {
  const targets = targetFiles.map(p => resolve(p))
  if (targets.length === 0) return
  // Idempotent: the registration block runs per-turn (inside submitMessage), so
  // re-arming after the first install must be a no-op — otherwise a new Stop hook
  // is appended every turn and the loop-brake inflates to N×maxBlocks.
  if (forcedReadEngagedSessions.has(sessionId)) return
  const maxBlocks = options?.maxBlocks ?? 3
  let blocks = 0
  // Surface a typo'd / non-existent target at registration: a path that can never
  // be Read would otherwise silently burn the block budget (blocks up to maxBlocks
  // then gives up) with no clue why. logForDebugging it AND annotate it in the
  // re-prompt so the operator sees the bad path instead of an unsatisfiable hook.
  const missing = new Set(targets.filter(p => !existsSync(p)))
  if (missing.size > 0) {
    logForDebugging(
      `[forced-read] MERCURY_FORCE_READ_FILES target(s) do not exist and can never be satisfied: ${[
        ...missing,
      ].join(', ')}`,
    )
  }
  const describe = (p: string): string =>
    missing.has(p) ? `${p} (not found)` : p
  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '', // no matcher — applies to every stop
    messages => {
      if (blocks >= maxBlocks) return true // give up — don't wedge the agent
      const read = collectReadFilePaths(messages)
      const unread = targets.filter(p => !read.has(p))
      if (unread.length === 0) return true
      // one continuation per stop attempt across EVERY hook
      // family — claim through the shared latch; if another hook already
      // claimed this attempt, defer one round (the targets stay armed).
      if (!claimContinuation(processMainOwner(), turnBoundaryIndex(messages), messages.length)) {
        return true
      }
      blocks++
      return false // block the stop, surface errorMessage, re-enter the loop
    },
    `You have not yet read a required file in this session. Before you can stop, use the Read tool on each of these files you have not read yet: ${targets
      .map(describe)
      .join(', ')}.`,
    { timeout: 5000, id: FORCED_READ_STOP_HOOK_ID },
  )
  forcedReadEngagedSessions.add(sessionId)
}
