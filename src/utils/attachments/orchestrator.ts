
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
    return getQueuedCommandAttachments(queuedCommands)
  }

  const abortController = createAbortController()
  const timeoutId = setTimeout(
    ac => ac.abort(),
    ATTACHMENT_SOFT_ABORT_MS,
    abortController,
  )
  const context = { ...toolUseContext, abortController }

  const isMainThread = !toolUseContext.agentId

  const collectionStart = pulseNow()
  const maybe = makeMaybe(
    isMainThread,
    collectionStart + ATTACHMENT_HARD_DEADLINE_MS,
  )
  if (isMainThread) {
    pulseStageStart('attachment_collection')
    setPulsePhase(getActivePulseTrace()?.generation ?? 0, 'preparing', {
      reason: 'workspace',
    })
  }

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
        ...pulseFixtureUserInputProducers(maybe),
      ]
    : []

  const userAttachmentResults = await Promise.all(userInputAttachments)

  const allThreadAttachments = [
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
    maybe('harness_map_delta', () =>
      Promise.resolve(
        (() => {
          if (!isMainThread) return []
          const d = getHarnessMapDelta(messages)
          return d ? [{ type: 'harness_map_delta' as const, ...d }] : []
        })(),
      ),
    ),
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
    maybe('dynamic_skill', () => getDynamicSkillAttachments(context)),
    maybe('skill_listing', () => getSkillListingAttachments(context)),
    maybe('plan_mode', () => getPlanModeAttachments(messages, toolUseContext)),
    maybe('plan_mode_exit', () => getPlanModeExitAttachment(toolUseContext)),
    maybe('repo_surface_map', () =>
      Promise.resolve(getRepoSurfaceMapAttachment(messages, toolUseContext)),
    ),
    maybe('context_capsule', () =>
      options?.localSubmission
        ? Promise.resolve([])
        : getContextCapsuleAttachment(input, messages, toolUseContext),
    ),
    maybe('ultra_effort', () =>
      Promise.resolve(getUltraEffortAttachments(messages, toolUseContext)),
    ),
    maybe('ultra_effort_exit', () =>
      Promise.resolve(getUltraEffortExitAttachment(messages, toolUseContext)),
    ),
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
    maybe('contract_reminder', () =>
      getContractReminderAttachments(messages, toolUseContext),
    ),
    ...(isAgentSwarmsEnabled()
      ? [
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
    maybe('user_context', () =>
      isMainThread ? getUserContextAttachment(messages ?? []) : Promise.resolve([]),
    ),
    maybe('critical_system_reminder', () =>
      Promise.resolve(
        getCriticalSystemReminderAttachment(toolUseContext, messages ?? []),
      ),
    ),
    maybe('taste_recall', () => getTasteRecallAttachment(toolUseContext, messages)),
    ...pulseFixtureProducers(abortController.signal, maybe),
  ]

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

  const [threadAttachmentResults, mainThreadAttachmentResults] =
    await Promise.all([
      Promise.all(allThreadAttachments),
      Promise.all(mainThreadAttachments),
    ])

  clearTimeout(timeoutId)
  if (isMainThread) pulseStageEnd('attachment_collection')
  return [
    ...userAttachmentResults.flat(),
    ...threadAttachmentResults.flat(),
    ...mainThreadAttachmentResults.flat(),
  ].filter(a => a !== undefined && a !== null) as Attachment[]
}

const ATTACHMENT_SOFT_ABORT_MS = 1_000
const ATTACHMENT_HARD_DEADLINE_MS = ATTACHMENT_SOFT_ABORT_MS * 2

type MaybeOpts = {
  priority?: boolean
  inputScoped?: boolean
}
type MaybeFn = <A>(
  label: string,
  f: () => Promise<A[]>,
  opts?: MaybeOpts,
) => Promise<A[]>

const producerInFlight = new Map<string, Promise<unknown>>()

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
      logAntError(`Attachment error in ${label}`, e)

      return []
    }
  }
}

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
