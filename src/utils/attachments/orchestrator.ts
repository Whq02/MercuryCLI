// The per-turn orchestrator — getAttachments fans every producer out through
// maybe() (isolation: one producer's throw never kills the turn; 5%-sampled
// timing telemetry), preserving the user-input → thread → main-thread
// ordering contract (nestedMemoryAttachmentTriggers must be populated before
// getNestedMemoryAttachments runs). getAttachmentMessages is the streaming
// wrapper; createAttachmentMessage the message factory. Owned Mercury module
//

import { randomUUID } from 'crypto'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { AttachmentMessage, Message } from 'src/types/message.js'
import type { QueuedCommand } from 'src/types/textInputTypes.js'
import type { ToolUseContext } from '../../Tool.js'
import { getHarnessMapDelta } from '../cockpit/harnessMap.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import { createAbortController } from '../abortController.js'
import {
  getActivePulseTrace,
  pulseNow,
  pulseStageEnd,
  pulseStageStart,
  recordPulseProducer,
  setPulsePhase,
} from '../pulse/index.js'
import { isAgentSwarmsEnabled } from '../agentSwarmsEnabled.js'
import { logAntError } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { logError } from '../log.js'
import { isTodoV2Enabled } from '../tasks.js'
import { getDiagnosticAttachments, getLSPDiagnosticAttachments } from './diagnostics.js'
import { getChangedFiles } from './fileAttachments.js'
import {
  getDateChangeAttachments,
  getPlanModeAttachments,
  getPlanModeExitAttachment,
  getRepoSurfaceMapAttachment,
} from './modeLifecycles.js'
import { getContextCapsuleAttachment } from './contextCapsule.js'
import {
  getUltraEffortAttachments,
  getUltraEffortExitAttachment,
  getSupercodeKeywordAttachment,
  getDeepthinkEffortAttachment,
} from './modeLifecycles.js'
import { getNestedMemoryAttachments } from './nestedMemory.js'
import {
  getOpenedFileFromIDE,
  getSelectedLinesFromIDE,
  processAgentMentions,
  processAtMentionedFiles,
  processMcpResourceAttachments,
} from './mentionResolvers.js'
import {
  getAgentPendingMessageAttachments,
  getQueuedCommandAttachments,
} from './queuedCommands.js'
import {
  getAgentListingDeltaAttachment,
  getDeferredToolsDeltaAttachment,
  getMcpInstructionsDeltaAttachment,
} from './deltas.js'
import {
  getContractReminderAttachments,
  getTaskReminderAttachments,
  getTodoReminderAttachments,
  getVerifyPlanReminderAttachment,
} from './reminders.js'
import {
  getCriticalSystemReminderAttachment,
  getMaxBudgetUsdAttachment,
  getOutputTokenUsageAttachment,
  getTasteRecallAttachment,
} from './sessionContext.js'
import {
  getDynamicSkillAttachments,
  getSkillListingAttachments,
} from './skillListing.js'
import {
  getAsyncHookResponseAttachments,
  getUnifiedTaskAttachments,
} from './taskStatus.js'
import {
  getTeamContextAttachment,
  getTeammateMailboxAttachments,
} from './teammates.js'
import type { Attachment } from './types.js'
import { getUserContextAttachment } from './userContext.js'

/**
 * The per-turn collection: every producer fans out through maybe() and the
 * results concatenate in contract order (user-input lane first, then the
 * thread lane, then main-thread-only). Ordering is behavior — the
 * user-input resolvers populate nestedMemoryAttachmentTriggers that the
 * thread lane's nested_memory producer drains.
 */
export async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean; localSubmission?: boolean },
): Promise<Attachment[]> {
  if (isEnvTruthy(process.env.MERCURY_SIMPLE)) {
    // Even simple mode must drain the queue: the caller dequeues these
    // unconditionally once this function has run, so a bare [] here would
    // vanish them — and bare-mode task runners live on task-notifications
    // arriving mid-tool-call.
    return getQueuedCommandAttachments(queuedCommands)
  }

  // Collection cost lands on the submission path; the soft/hard deadline
  // pair below is what keeps a slow producer from holding the send.
  const abortController = createAbortController()
  const timeoutId = setTimeout(
    ac => ac.abort(),
    ATTACHMENT_SOFT_ABORT_MS,
    abortController,
  )
  const context = { ...toolUseContext, abortController }

  const isMainThread = !toolUseContext.agentId

  // one fenced wrapper per collection — main-thread producers record
  // into the turn trace; every producer shares one hard deadline anchored at
  // collection start (see makeMaybe).
  const collectionStart = pulseNow()
  const maybe = makeMaybe(
    isMainThread,
    collectionStart + ATTACHMENT_HARD_DEADLINE_MS,
  )
  if (isMainThread) {
    pulseStageStart('attachment_collection')
    // Refine the preparing reason while collecting (mid-stream collections
    // are fenced out by the phase table — preparing isn't reachable from
    // responding, so a drain during streaming can't repaint the phase).
    setPulsePhase(getActivePulseTrace()?.generation ?? 0, 'preparing', {
      reason: 'workspace',
    })
  }

  // Lane 1 — producers keyed on the submitted text itself.
  const userInputAttachments = input
    ? [
        maybe(
          'at_mentioned_files',
          () => processAtMentionedFiles(input, context),
          { inputScoped: true },
        ),
        maybe(
          'mcp_resources',
          () => processMcpResourceAttachments(input, context),
          { inputScoped: true },
        ),
        maybe(
          'agent_mentions',
          () =>
            Promise.resolve(
              processAgentMentions(
                input,
                toolUseContext.options.agentDefinitions.activeAgents,
              ),
            ),
          { inputScoped: true },
        ),
        // (Turn-0 skill discovery is folded out here; inter-turn discovery
        // lives in query.ts's startSkillDiscoveryPrefetch. The
        // skipSkillDiscovery option stays honored by the keyword producers
        // below — expanded SKILL.md bodies are not user intent.)
        // phase-one fixture (test-only; unset ⇒ []).
        ...pulseFixtureUserInputProducers(maybe),
      ]
    : []

  // Lane 1 settles FIRST, alone: its @-mention resolvers seed
  // nestedMemoryAttachmentTriggers, and lane 2's nested_memory producer
  // must see the seeded set — constructing lane 2 before this await would
  // race the seam.
  const userAttachmentResults = await Promise.all(userInputAttachments)

  // Lane 2 — producers safe on any thread (subagents included).
  const allThreadAttachments = [
    // The drain gate upstream already scoped queuedCommands per agent
    // (undefined = main thread), so this producer belongs in the every-
    // thread lane: skipping it on subagents would dequeue their
    // notifications without ever attaching them.
    maybe('queued_commands', () => getQueuedCommandAttachments(queuedCommands), {
      priority: true,
    }),
    maybe('date_change', () =>
      Promise.resolve(getDateChangeAttachments(messages)),
    ),
    maybe('deepthink_effort', () =>
      Promise.resolve(
        getDeepthinkEffortAttachment(
          input,
          toolUseContext,
          options,
          queuedCommands,
        ),
      ),
    ),
    maybe('deferred_tools_delta', () =>
      Promise.resolve(
        getDeferredToolsDeltaAttachment(
          toolUseContext.options.tools,
          toolUseContext.options.mainLoopModel,
          messages,
          {
            callSite: isMainThread
              ? 'attachments_main'
              : 'attachments_subagent',
            querySource,
          },
        ),
      ),
    ),
    maybe('agent_listing_delta', () =>
      Promise.resolve(getAgentListingDeltaAttachment(toolUseContext, messages)),
    ),
    maybe('mcp_instructions_delta', () =>
      Promise.resolve(
        getMcpInstructionsDeltaAttachment(
          toolUseContext.options.mcpClients,
          toolUseContext.options.tools,
          toolUseContext.options.mainLoopModel,
          messages,
        ),
      ),
    ),
    // Mid-session Mercury capability flips (#182: /invite arm, a
    // THEMIS level change) — the memoized harness-map prompt block can't
    // reflect them; the delta announces once per change (harnessMap.ts).
    // MAIN THREAD ONLY (product-study r2): a subagent's getAttachments pass
    // must not inject the operator-facing announcement into ITS transcript.
    // The announce-once cursor is the thread's own message history (the
    // mcp_instructions_delta pattern) — an aborted turn's never-appended
    // attachment re-announces; nothing is consumed at collection time.
    maybe('harness_map_delta', () =>
      Promise.resolve(
        (() => {
          if (!isMainThread) return []
          const d = getHarnessMapDelta(messages)
          return d ? [{ type: 'harness_map_delta' as const, ...d }] : []
        })(),
      ),
    ),
    // Bounded side lanes: a lane CHILD session re-asserts
    // its boundary on EVERY request — compaction/context rebuilds can never
    // lose it by construction. Null (zero cost) on ordinary sessions.
    maybe('lane_boundary', () =>
      Promise.resolve(
        (() => {
          if (!isMainThread) return []
          try {
            const { laneBoundaryAttachmentFor } =
              require('../../services/contextLanes/lanes.js') as typeof import('../../services/contextLanes/lanes.js')
            const { getSessionId } =
              require('../../bootstrap/state.js') as typeof import('../../bootstrap/state.js')
            const a = laneBoundaryAttachmentFor(String(getSessionId()))
            return a ? [a] : []
          } catch {
            return []
          }
        })(),
      ),
    ),
    maybe('changed_files', () => getChangedFiles(context)),
    maybe('nested_memory', () => getNestedMemoryAttachments(context)),
    // (relevant_memories left this list for the prefetch handle —
    // startRelevantMemoryPrefetch — consumed at query.ts's collect point.)
    maybe('dynamic_skill', () => getDynamicSkillAttachments(context)),
    maybe('skill_listing', () => getSkillListingAttachments(context)),
    // (Inter-turn skill discovery left too, for query.ts's
    // startSkillDiscoveryPrefetch: the blocking assistant_turn probe that
    // sat here came back empty on the overwhelming majority of prod calls,
    // so it now races the turn instead of taxing it —
    // src/services/skillSearch/prefetch.ts.)
    maybe('plan_mode', () => getPlanModeAttachments(messages, toolUseContext)),
    maybe('plan_mode_exit', () => getPlanModeExitAttachment(toolUseContext)),
    // Fast onboarding: the once-per-session repo surface map for an unmapped
    // repo (stamp-gated inside the generator — MERCURY_ONBOARDING).
    maybe('repo_surface_map', () =>
      Promise.resolve(getRepoSurfaceMapAttachment(messages, toolUseContext)),
    ),
    // The task-scoped working-set capsule (MERCURY_PROJECT_INTEL;
    // transcript-scan dedup — unchanged capsules never re-attach). `input`
    // carries the CURRENT prompt (turn-1 has no user text in `messages`).
    // LOCAL submissions (bang shells, # captures) never mint a capsule:
    // there is no model-bound task — composing one both polluted history
    // with a capsule scoped to a shell command AND paid the cold snapshot
    // build on a purely local action.
    maybe('context_capsule', () =>
      options?.localSubmission
        ? Promise.resolve([])
        : getContextCapsuleAttachment(input, messages, toolUseContext),
    ),
    // Supercode standing reminder (stamp-gated inside the generators, NOT behind
    // a feature() flag — those DCE to false at build).
    maybe('ultra_effort', () =>
      Promise.resolve(getUltraEffortAttachments(messages, toolUseContext)),
    ),
    maybe('ultra_effort_exit', () =>
      Promise.resolve(getUltraEffortExitAttachment(messages, toolUseContext)),
    ),
    // Per-turn `supercode` keyword opt-in (fork; was a SEVERED loop — the
    // detector + gate + TUI hint existed with no model-facing injection).
    maybe('supercode_keyword', () =>
      Promise.resolve(
        getSupercodeKeywordAttachment(input, toolUseContext, options),
      ),
    ),
    maybe('todo_reminders', () =>
      isTodoV2Enabled()
        ? getTaskReminderAttachments(messages, toolUseContext)
        : getTodoReminderAttachments(messages, toolUseContext),
    ),
    // The session's advisory contract, warm at birth + periodic (T3's
    // no-agent-action mechanism; role-stamp-gated inside the producer).
    maybe('contract_reminder', () =>
      getContractReminderAttachments(messages, toolUseContext),
    ),
    ...(isAgentSwarmsEnabled()
      ? [
          // The session_memory fork never drains the mailbox: it borrows
          // the leader's AppState.teamContext, so isTeamLead reads true
          // there — and a drain from that seat would mark the leader's DMs
          // read while burying them as ephemeral attachments instead of
          // the permanent turns they're owed.
          ...(querySource === 'session_memory'
            ? []
            : [
                maybe(
                  'teammate_mailbox',
                  async () => getTeammateMailboxAttachments(toolUseContext),
                  { priority: true },
                ),
              ]),
          maybe('team_context', async () =>
            getTeamContextAttachment(messages ?? []),
          ),
        ]
      : []),
    maybe(
      'agent_pending_messages',
      async () => getAgentPendingMessageAttachments(toolUseContext),
      { priority: true },
    ),
    // The main conversation's user context as a PERSISTED row (the
    // append-only form of the per-request prepend; agent threads keep the
    // prepend). Once when the history carries none, again at the tail when
    // the rendered body changes; never a rewrite of an earlier row.
    maybe('user_context', () =>
      isMainThread ? getUserContextAttachment(messages ?? []) : Promise.resolve([]),
    ),
    maybe('critical_system_reminder', () =>
      Promise.resolve(
        getCriticalSystemReminderAttachment(toolUseContext, messages ?? []),
      ),
    ),
    maybe('taste_recall', () => getTasteRecallAttachment(toolUseContext, messages)),
    // deterministic fixtures (MERCURY_PULSE_FIXTURE, test-only; unset ⇒ []).
    ...pulseFixtureProducers(abortController.signal, maybe),
  ]

  // Lane 3 — main-conversation-only semantics (or producers with no
  // concurrency-safe implementation).
  const mainThreadAttachments = isMainThread
    ? [
        maybe('ide_selection', async () =>
          getSelectedLinesFromIDE(ideSelection, toolUseContext),
        ),
        maybe('ide_opened_file', async () =>
          getOpenedFileFromIDE(ideSelection, toolUseContext),
        ),
        maybe('diagnostics', async () =>
          getDiagnosticAttachments(toolUseContext),
        ),
        maybe('lsp_diagnostics', async () =>
          getLSPDiagnosticAttachments(toolUseContext),
        ),
        maybe('unified_tasks', async () =>
          getUnifiedTaskAttachments(toolUseContext),
        ),
        maybe('async_hook_responses', async () =>
          getAsyncHookResponseAttachments(),
        ),
        maybe('budget_usd', async () =>
          Promise.resolve(
            getMaxBudgetUsdAttachment(toolUseContext.options.maxBudgetUsd),
          ),
        ),
        maybe('output_token_usage', async () =>
          Promise.resolve(getOutputTokenUsageAttachment()),
        ),
        maybe('verify_plan_reminder', async () =>
          getVerifyPlanReminderAttachment(messages, toolUseContext),
        ),
      ]
    : []

  // Lanes 2 and 3 share no seams — they settle together.
  const [threadAttachmentResults, mainThreadAttachmentResults] =
    await Promise.all([
      Promise.all(allThreadAttachments),
      Promise.all(mainThreadAttachments),
    ])

  clearTimeout(timeoutId)
  if (isMainThread) pulseStageEnd('attachment_collection')
  // The filter is armor for downstream .map(a => a.type): by construction
  // every element is an Attachment (each maybe() yields Attachment[]), but
  // one historical getter degraded to {} inside message-pipeline
  // reconciliation and poisoned the spread — so nullish elements are
  // dropped here and the element type re-asserted on the survivors.
  return [
    ...userAttachmentResults.flat(),
    ...threadAttachmentResults.flat(),
    ...mainThreadAttachmentResults.flat(),
  ].filter(a => a !== undefined && a !== null) as Attachment[]
}

/** The producer isolation wrapper, built PER COLLECTION:
 *
 *  · one producer's throw never kills the turn (unchanged);
 *  · EVERY producer's duration + outcome lands in the turn trace — main-thread
 *    collections only (`record`), so a subagent's concurrent fan-out can never
 *    pollute the operator's trace (the old 5% sample survives only as the
 *    remote telemetry volume bound);
 *  · a REAL deadline (the explicit completion contract): the 1s AbortSignal
 *    (ATTACHMENT_SOFT_ABORT_MS) is the declared cooperation budget; a producer
 *    that IGNORES cancellation gets one more soft-budget of grace and is then
 *    raced out at the shared hard deadline (2× the soft budget, anchored at
 *    collection start), recorded LOUDLY as outcome 'timeout' — never a silent
 *    omission, never submission held at a stuck producer's leisure. The
 *    Slice-4 acceptance bar is mechanical:
 *    scripts/pulse/matrix/prove-producer-deadlines.ts.
 */
const ATTACHMENT_SOFT_ABORT_MS = 1_000
const ATTACHMENT_HARD_DEADLINE_MS = ATTACHMENT_SOFT_ABORT_MS * 2

type MaybeOpts = {
  /** Consume-once producers (queued notifications, mailboxes, drained chat):
   *  removeFromQueue dequeues unconditionally after collection, so a skip
   *  would DROP operator input. Priority work runs regardless of the clock
   *  (still raced + recorded); its inputs are per-collection, so it never
   *  single-flights. */
  priority?: boolean
  /** Producers whose closure captures THIS collection's input (the
   *  @-mention resolvers): a prior collection's in-flight instance answers a
   *  DIFFERENT submission — never reuse it. */
  inputScoped?: boolean
}
type MaybeFn = <A>(
  label: string,
  f: () => Promise<A[]>,
  opts?: MaybeOpts,
) => Promise<A[]>

// Single-flight registry (hot-path cadence C1): a producer that loses the
// deadline race KEEPS RUNNING — a race abandons work, it never stops it —
// so repeated collections would otherwise stack a fresh copy of the same slow
// producer each round. An in-flight prior instance is awaited instead
// (the buildInFlight / digestInFlight precedent); cleared on settle.
const producerInFlight = new Map<string, Promise<unknown>>()

// Exported for the production-seam prover (scripts/longrun-invariants/prove-hotpath-cadence.ts).
export function makeMaybe(record: boolean, deadlineAt: number): MaybeFn {
  return async function maybe<A>(
    label: string,
    f: () => Promise<A[]>,
    opts?: MaybeOpts,
  ): Promise<A[]> {
    const startTime = pulseNow()
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const remaining = deadlineAt - startTime
      // Expired OPTIONAL work never starts (C1): the deadline would otherwise gate
      // only the race arm, so a producer constructed after an earlier phase
      // consumed the shared budget ran to natural completion with no bound.
      if (remaining <= 0 && !opts?.priority) {
        if (record) recordPulseProducer(label, 0, 'skipped', 0)
        logError(
          new Error(
            `attachment producer '${label}' skipped — the shared ${ATTACHMENT_HARD_DEADLINE_MS}ms budget was spent before it could start (recorded, not silent)`,
          ),
        )
        return []
      }
      const reusable = !opts?.priority && !opts?.inputScoped
      const prior = reusable ? producerInFlight.get(label) : undefined
      const run: Promise<A[]> =
        prior !== undefined
          ? (prior as Promise<A[]>)
          : (() => {
              const p = f()
              if (reusable) {
                producerInFlight.set(label, p)
                void Promise.resolve(p)
                  .catch(() => {})
                  .finally(() => {
                    if (producerInFlight.get(label) === p) {
                      producerInFlight.delete(label)
                    }
                  })
              }
              return p
            })()
      const result = await (remaining > 0
        ? Promise.race([
            run,
            new Promise<'pulse_deadline'>(resolve => {
              timer = setTimeout(() => resolve('pulse_deadline'), remaining)
            }),
          ])
        : run)
      if (timer !== null) clearTimeout(timer)
      const duration = pulseNow() - startTime
      if (result === 'pulse_deadline') {
        if (record) recordPulseProducer(label, duration, 'timeout', 0)
        logError(
          new Error(
            `attachment producer '${label}' ignored cancellation past the ${ATTACHMENT_HARD_DEADLINE_MS}ms hard deadline — output dropped (recorded, not silent)`,
          ),
        )
        return []
      }
      if (record) {
        recordPulseProducer(
          label,
          duration,
          result.length > 0 ? 'ok' : 'empty',
          result.length,
        )
      }
      return result
    } catch (e) {
      if (timer !== null) clearTimeout(timer)
      const duration = pulseNow() - startTime
      if (record) recordPulseProducer(label, duration, 'error', 0)
      logError(e)
      // The verbose diagnostic channel gets the whole error object.
      logAntError(`Attachment error in ${label}`, e)

      return []
    }
  }
}

// ── deterministic fixtures (MERCURY_PULSE_FIXTURE, test-only) ──────────
// CSV of `key=ms`: `slow-producer=<ms>` resolves after ms but honors the
// collection abort signal (cooperative); `stuck-producer=<ms>` ignores
// cancellation entirely. Lets the scripts/pulse matrix prove per-producer
// timing and REAL deadline behavior against the live fan-out. Unset ⇒ [].
function pulseFixtureProducers(
  signal: AbortSignal,
  maybe: MaybeFn,
): Array<Promise<Attachment[]>> {
  const spec = flagEnv('MERCURY_PULSE_FIXTURE')
  if (!spec) return []
  const producers: Array<Promise<Attachment[]>> = []
  for (const entry of spec.split(',')) {
    const [key, msRaw] = entry.split('=')
    const ms = Number(msRaw)
    if (!Number.isFinite(ms) || ms <= 0) continue
    if (key === 'slow-producer') {
      producers.push(
        maybe(
          'pulse_fixture_slow',
          () =>
            new Promise<Attachment[]>(resolve => {
              const t = setTimeout(() => resolve([]), ms)
              signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(t)
                  resolve([])
                },
                { once: true },
              )
            }),
        ),
      )
    } else if (key === 'stuck-producer') {
      producers.push(
        maybe(
          'pulse_fixture_stuck',
          () =>
            new Promise<Attachment[]>(resolve => {
              setTimeout(() => resolve([]), ms)
            }),
        ),
      )
    }
  }
  return producers
}

/** Phase-ONE fixture (hot-path cadence C1): a user-input producer that
 *  ignores cancellation, so the deadline-exhaustion leg (phase one consumes
 *  the shared budget; later producers must SKIP, not run unbounded) is
 *  provable through the live fan-out. `stuck-user-input-producer=<ms>`. */
function pulseFixtureUserInputProducers(maybe: MaybeFn): Array<Promise<Attachment[]>> {
  const spec = flagEnv('MERCURY_PULSE_FIXTURE')
  if (!spec) return []
  const producers: Array<Promise<Attachment[]>> = []
  for (const entry of spec.split(',')) {
    const [key, msRaw] = entry.split('=')
    const ms = Number(msRaw)
    if (!Number.isFinite(ms) || ms <= 0) continue
    if (key === 'stuck-user-input-producer') {
      producers.push(
        maybe(
          'pulse_fixture_stuck_user_input',
          () =>
            new Promise<Attachment[]>(resolve => {
              setTimeout(() => resolve([]), ms)
            }),
          { inputScoped: true },
        ),
      )
    }
  }
  return producers
}

export async function* getAttachmentMessages(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean; localSubmission?: boolean },
): AsyncGenerator<AttachmentMessage, void> {
  const attachments = await getAttachments(
    input,
    toolUseContext,
    ideSelection,
    queuedCommands,
    messages,
    querySource,
    options,
  )

  if (attachments.length === 0) {
    return
  }


  for (const attachment of attachments) {
    yield createAttachmentMessage(attachment)
  }
}

export function createAttachmentMessage(
  attachment: Attachment,
): AttachmentMessage {
  return {
    attachment,
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}
