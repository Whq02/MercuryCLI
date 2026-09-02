import { dirname } from 'node:path'

import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import type { AssistantMessage, Message, SystemMessage } from '../../types/message.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import {
  addDreamTurn,
  completeDreamTask,
  failDreamTask,
  registerDreamTask,
} from '../../tasks/DreamTask/DreamTask.js'
import { logForDebugging } from '../../utils/debug.js'
import { createCacheSafeParams, runForkedAgent } from '../../utils/forkedAgent.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import { logError } from '../../utils/log.js'
import { createMemorySavedMessage, createUserMessage } from '../../utils/messages.js'
import { getTranscriptPath } from '../../utils/sessionStorage/paths.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { getDynamicConfig_CACHED_MAY_BE_STALE } from '../analytics/featureGates.js'
import { createAutoMemCanUseTool } from './autoMemCanUseTool.js'
import { isAutoDreamEnabled } from './config.js'
import {
  listSessionsTouchedSince,
  readLastConsolidatedAt,
  rollbackConsolidationLock,
  tryAcquireConsolidationLock,
} from './consolidationLock.js'
import { buildConsolidationPrompt } from './consolidationPrompt.js'

/**
 * Background memory-consolidation trigger: gates, lock, forked agent run,
 * progress watcher. The runner is closure-scoped (state lives in the
 * closure, not at module level) so a fresh runner can be created per test.
 * Per-turn cost when enabled: one cached remote-config read and one stat.
 */

const DEFAULT_MIN_HOURS = 24
const DEFAULT_MIN_SESSIONS = 5
const SCAN_THROTTLE_MS = 10 * 60 * 1000

type SchedulingKnobs = { minHours: number; minSessions: number }

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Both knobs come from the same gate key as the enabled field. */
function readSchedulingKnobs(): SchedulingKnobs {
  const remote = getDynamicConfig_CACHED_MAY_BE_STALE<{ minHours?: unknown; minSessions?: unknown }>(
    'mercury_onyx_plover',
    {},
  )
  return {
    minHours: positive(remote?.minHours, DEFAULT_MIN_HOURS),
    minSessions: positive(remote?.minSessions, DEFAULT_MIN_SESSIONS),
  }
}

/** A build-time forced-run override — permanently false. */
function isForcedRun(): boolean {
  return false
}

function isRemoteMode(): boolean {
  return false
}

function isDiskSkillDreamModeActive(): boolean {
  return false
}

type AppendSystemMessage = (msg: Exclude<SystemMessage, { subtype: 'local_command' }>) => void

type Runner = (context: REPLHookContext, appendSystemMessage?: AppendSystemMessage) => Promise<void>

let runner: Runner | null = null

function createRunner(): Runner {
  let lastScanAt = 0

  return async function run(context, appendSystemMessage) {
    const knobs = readSchedulingKnobs()

    // Gate 1 — enabled.
    if (isDiskSkillDreamModeActive()) return
    if (isRemoteMode()) return
    if (!isAutoMemoryEnabled()) return
    const forced = isForcedRun()
    if (!forced && !isAutoDreamEnabled()) return

    // Gate 2 — time.
    let lastConsolidatedAt: number
    try {
      lastConsolidatedAt = await readLastConsolidatedAt()
    } catch (err) {
      logForDebugging(`autoDream: could not read the last consolidation time: ${String(err)}`)
      return
    }
    const hoursSince = (Date.now() - lastConsolidatedAt) / (60 * 60 * 1000)
    if (!forced && hoursSince < knobs.minHours) return

    // Gate 3 — scan throttle: when the time gate passes but the session
    // gate does not, the lock mtime never advances and the time gate keeps
    // passing every turn.
    const sinceScan = Date.now() - lastScanAt
    if (lastScanAt !== 0 && sinceScan < SCAN_THROTTLE_MS) {
      logForDebugging(`autoDream: session scan throttled (${Math.round(sinceScan / 1000)}s since last scan)`)
      return
    }
    lastScanAt = Date.now()

    // Gate 4 — sessions. The current session is filtered out HERE: its
    // transcript is always freshly touched.
    let sessions: string[]
    try {
      const touched = await listSessionsTouchedSince(lastConsolidatedAt)
      const current = getSessionId()
      sessions = touched.filter(id => id !== current)
    } catch (err) {
      logForDebugging(`autoDream: session scan failed: ${String(err)}`)
      return
    }
    if (!forced && sessions.length < knobs.minSessions) {
      logForDebugging(`autoDream: ${sessions.length} sessions since last consolidation (< ${knobs.minSessions})`)
      return
    }

    // Gate 5 — lock (a forced run reuses the last-consolidation time so a
    // later rollback is a no-op).
    let priorMtime: number
    if (forced) {
      priorMtime = lastConsolidatedAt
    } else {
      const acquired = await tryAcquireConsolidationLock()
      if (acquired === null) return
      priorMtime = acquired
    }

    // The run.
    const abortController = new AbortController()
    const setAppState =
      context.toolUseContext.setAppStateForTasks ?? context.toolUseContext.setAppState
    const taskId = registerDreamTask(setAppState, {
      sessionsReviewing: sessions.length,
      priorMtime,
      abortController,
    })

    const memoryRoot = getAutoMemPath()
    const transcriptDir = dirname(getTranscriptPath())
    // The curation engine sweeps FIRST and its proposals ride the brief —
    // the mechanism proposes, the agent judges; the persisted sweep also
    // feeds the Memory Centre's consent surface. A failed sweep costs the
    // section, never the run.
    let proposalsSection = ''
    try {
      const { proposeCuration, writeCurationSweep, renderProposalsForBrief } = await import(
        '../../memdir/curationLoop.js'
      )
      const sweep = await proposeCuration(memoryRoot, { projectRoot: getProjectRoot() })
      await writeCurationSweep(memoryRoot, sweep)
      proposalsSection = renderProposalsForBrief(sweep)
    } catch (err) {
      logForDebugging(`autoDream: curation sweep failed: ${String(err)}`)
    }
    const extra = [
      'Shell access is restricted to read-only commands for this run (ls, cat, grep, rg, find, head, tail, wc, git log/show/diff and similar). Anything that writes, redirects to a file, or modifies state will be denied — plan your exploration accordingly and do not probe.',
      '',
      ...(proposalsSection !== '' ? [proposalsSection, ''] : []),
      `Sessions since the last consolidation (${sessions.length}):`,
      ...sessions.map(id => `- ${id}`),
    ].join('\n')
    const prompt = buildConsolidationPrompt(memoryRoot, transcriptDir, extra)

    try {
      const result = await runForkedAgent({
        promptMessages: [createUserMessage({ content: prompt })],
        cacheSafeParams: createCacheSafeParams(context),
        canUseTool: createAutoMemCanUseTool(memoryRoot),
        querySource: 'auto_dream' as never,
        forkLabel: 'auto_dream',
        skipTranscript: true,
        overrides: { abortController },
        onMessage: (message: Message) => {
          if (message.type !== 'assistant') return
          const content = (message as AssistantMessage).message.content
          if (!Array.isArray(content)) return
          const texts: string[] = []
          let toolUseCount = 0
          const touched: string[] = []
          for (const block of content) {
            const record = block as { type?: string; text?: string; name?: string; input?: { file_path?: unknown } }
            if (record.type === 'text' && typeof record.text === 'string') texts.push(record.text)
            if (record.type === 'tool_use') {
              toolUseCount++
              if (
                (record.name === FILE_EDIT_TOOL_NAME || record.name === FILE_WRITE_TOOL_NAME) &&
                typeof record.input?.file_path === 'string'
              ) {
                touched.push(record.input.file_path)
              }
            }
          }
          addDreamTurn(taskId, { text: texts.join('').trim(), toolUseCount }, touched, setAppState)
        },
      })
      completeDreamTask(taskId, setAppState)
      const filesTouched = touchedFilesOfTask(context, taskId)
      if (filesTouched.length > 0 && appendSystemMessage !== undefined) {
        appendSystemMessage({ ...createMemorySavedMessage(filesTouched), verb: 'Improved' } as never)
      }
      logForDebugging(
        `autoDream: complete (cache read ${result.totalUsage.cache_read_input_tokens}, cache creation ${result.totalUsage.cache_creation_input_tokens})`,
      )
    } catch (err) {
      if (abortController.signal.aborted) {
        // Killed from the background-tasks dialog: that path already
        // aborted, rolled back the lock and set the killed status.
        logForDebugging('autoDream: run aborted by the operator')
        return
      }
      logError(err)
      failDreamTask(taskId, setAppState)
      // Roll the time gate back; the scan throttle is the backoff.
      await rollbackConsolidationLock(priorMtime)
    }
  }
}

function touchedFilesOfTask(context: REPLHookContext, taskId: string): string[] {
  try {
    const task = context.toolUseContext.getAppState().tasks?.[taskId] as { filesTouched?: string[] } | undefined
    return task?.filesTouched ?? []
  } catch {
    return []
  }
}

/** Installs the closure-scoped runner. */
export function initAutoDream(): void {
  runner = createRunner()
}

/** The thin entry point invoked from the stop hooks. */
export async function executeAutoDream(
  context: REPLHookContext,
  appendSystemMessage?: AppendSystemMessage,
): Promise<void> {
  if (runner === null) return
  await runner(context, appendSystemMessage)
}
