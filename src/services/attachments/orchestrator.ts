
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { AttachmentMessage, Message } from 'src/types/message.js'
import type { QueuedCommand } from 'src/types/textInputTypes.js'
import type { ToolUseContext } from '../../Tool.js'
import { getHarnessMapDelta } from '../cockpit/harnessMap.js'
import type { QuerySource } from '../../constants/querySource.js'
import { createAbortController } from '../../utils/abortController.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { getLSPDiagnosticAttachments } from './diagnostics.js'
import { getChangedFiles } from './fileAttachments.js'
import {
  getCapsuleDateChange,
  getModePackAttachments,
} from '../../utils/attachments/modeLifecycles.js'
import { foldAttachmentsIntoCapsule, getContextCapsuleAttachment } from './contextCapsule.js'
import { getNestedMemoryAttachments } from './nestedMemory.js'
import {
  processAgentMentions,
  processAtMentionedFiles,
  processMcpResourceAttachments,
} from './mentionResolvers.js'
import {
  getAdvisorNoteAttachments,
  getSwarmAttachments,
  getAgentPendingMessageAttachments,
  getQueuedCommandAttachments,
} from './queuedCommands.js'
import {
  getPlannedDeferredToolsAttachment,
  getHeldToolsAttachment,
  getMcpInstructionsDeltaAttachment,
  getMcpServersFailedAttachment,
} from './deltas.js'
import {
  getContractReminderAttachments,
  getTaskReminderAttachments,
} from './reminders.js'
import { getToolSchemaDeltaAttachment } from './toolSchemaDelta.js'
import {
  getCriticalSystemReminderAttachment,
  getMaxBudgetUsdAttachment,
  getUsageLimitNoticeAttachment,
} from './sessionContext.js'
import {
  getDynamicSkillAttachments,
  getSkillListingAttachments,
} from '../../utils/attachments/skillListing.js'
import {
  getBackgroundHookAttachments,
  getUnifiedTaskAttachments,
} from '../../utils/attachments/taskStatus.js'
import { getMissionStatusAttachment } from '../../utils/attachments/missionStatus.js'
import type { Attachment } from '../../utils/attachments/types.js'
import { rosterOwnerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { getUserContextAttachment } from '../../utils/attachments/userContext.js'
import { firstTurnUserContext } from '../messages/api.js'
import { getSystemContext, getUserContext } from '../../context.js'
import { getToolManualAttachments } from './toolManuals.js'
import { samplesRoadAttachment } from '../../utils/attachments/samplesRoad.js'
import { createAttachmentMessage } from '../../utils/attachments/attachmentMessage.js'
import { passedOver } from '../../utils/passedOver.js'
import { withDeadline } from '../../utils/deadline.js'
import { startTimeout, stopTimeout } from '../../utils/timers.js'
export { createAttachmentMessage } from '../../utils/attachments/attachmentMessage.js'

export async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { localSubmission?: boolean; operatorPrompt?: boolean },
): Promise<Attachment[]> {
  messages ??= toolUseContext.messages
  if (isEnvTruthy(flagEnv('MERCURY_BARE'))) {
    return [
      ...await getQueuedCommandAttachments(queuedCommands, { messages, model: toolUseContext.options.engineModel }),
      ...await getToolManualAttachments({ ...toolUseContext, messages }),
    ]
  }

  const mentionedFiles = input ? await processAtMentionedFiles(input, { ...toolUseContext, messages }).catch((error: unknown) => (logError(error), [] as Attachment[])) : []

  const abortController = createAbortController()
  const timeoutId = startTimeout(
    ac => ac.abort(),
    ATTACHMENT_SOFT_ABORT_MS,
    abortController,
  )
  const context = { ...toolUseContext, abortController, messages: messages ?? toolUseContext.messages }

  const isMainThread = !toolUseContext.agentId
  const opening = !messages.some(message => message.type === 'assistant' || (message.type === 'system' && message.subtype === 'compact_boundary'))
  const collectionStart = performance.now()
  const maybe = makeMaybe(collectionStart + ATTACHMENT_HARD_DEADLINE_MS)

  const userInputAttachments = input
    ? [
        maybe(
          'mcp_resources',
          () => processMcpResourceAttachments(input, context),
          { inputScoped: true },
        ),
        maybe('samples_road', () => Promise.resolve(options?.operatorPrompt ? samplesRoadAttachment(input, messages) : []), { inputScoped: true }),
        maybe('remote_files', async () => (input.includes('ssh://') ? (await import('../../utils/remoteFiles/notice.js')).remoteFilesNotice(input, messages) : []), { inputScoped: true }),
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
    maybe('queued_commands', () => getQueuedCommandAttachments(queuedCommands, { messages: context.messages, model: context.options.engineModel }), {
      priority: true,
    }),
    maybe('date_change', () =>
      Promise.resolve(opening ? getCapsuleDateChange(context, messages) : []),
    ),
    maybe('deferred_tools_delta', () =>
      getPlannedDeferredToolsAttachment(toolUseContext, messages, {
        callSite: isMainThread ? 'attachments_main' : 'attachments_subagent',
        querySource,
        hasPendingMcpServers: [
          ...toolUseContext.options.mcpClients,
          ...(toolUseContext.getAppState?.().mcp?.clients ?? []),
        ].some(client => client.type === 'pending'),
      }),
    ),
    maybe('held_tools', () =>
      Promise.resolve(
        getHeldToolsAttachment(String(rosterOwnerFromToolUseContext(toolUseContext)), messages ?? []),
      ),
    ),
    maybe('tool_schema_delta', () => getToolSchemaDeltaAttachment(toolUseContext, messages ?? [])),
    maybe('mcp_instructions_delta', () =>
      Promise.resolve(
        getMcpInstructionsDeltaAttachment(
          toolUseContext.options.mcpClients,
          toolUseContext.options.tools,
          toolUseContext.options.engineModel,
          messages,
        ),
      ),
    ),
    maybe('mcp_servers_failed', () =>
      Promise.resolve(
        getMcpServersFailedAttachment(
          [...toolUseContext.options.mcpClients, ...(toolUseContext.getAppState?.().mcp?.clients ?? [])],
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
    maybe('changed_files', () => getChangedFiles(context)),
    maybe('lsp_diagnostics', () => getLSPDiagnosticAttachments(toolUseContext), { inputScoped: true }),
    maybe('nested_memory', () => getNestedMemoryAttachments(context)),
    maybe('dynamic_skill', () => getDynamicSkillAttachments(context)),
    maybe('skill_listing', () => getSkillListingAttachments(context)),
    maybe('mode_pack', () => Promise.resolve(getModePackAttachments(messages, toolUseContext))),
    maybe('context_capsule', () =>
      options?.localSubmission || !opening
        ? Promise.resolve([])
        : getContextCapsuleAttachment(input, messages, toolUseContext),
    ),
    maybe('task_reminders', () => opening ? getTaskReminderAttachments(messages, toolUseContext) : Promise.resolve([])),
    maybe('contract_reminder', () =>
      opening ? getContractReminderAttachments(messages, toolUseContext) : Promise.resolve([]),
    ),
    maybe(
      'agent_pending_messages',
      async () => getAgentPendingMessageAttachments(toolUseContext),
      { priority: true },
    ),
    maybe('crew_board', async () => options?.localSubmission ? [] : getSwarmAttachments(toolUseContext, messages), { priority: true }),
    maybe(
      'advisor_notes',
      async () =>
        getAdvisorNoteAttachments(toolUseContext, {
          ...(querySource !== undefined ? { querySource } : {}),
          ...(options?.localSubmission !== undefined ? { localSubmission: options.localSubmission } : {}),
        }),
      { priority: true },
    ),
    maybe('user_context', async () =>
      isMainThread ? getUserContextAttachment(messages, await firstTurnUserContext(await getUserContext(), getSystemContext, toolUseContext.options.engineModel, undefined, messages, options?.localSubmission ? null : input), opening) : [],
    ),
    maybe('tool_manuals', () => getToolManualAttachments(context), { priority: true, inputScoped: true }),
    maybe('critical_system_reminder', () =>
      Promise.resolve(
        getCriticalSystemReminderAttachment(toolUseContext, messages ?? []),
      ),
    ),
    ...pulseFixtureProducers(abortController.signal, maybe),
  ]

  const mainThreadAttachments = isMainThread
    ? [
        maybe('unified_tasks', async () =>
          getUnifiedTaskAttachments(toolUseContext),
        ),
        maybe('background_hooks', async () =>
          Promise.resolve(getBackgroundHookAttachments()),
        ),
        maybe('budget_usd', async () =>
          Promise.resolve(
            getMaxBudgetUsdAttachment(toolUseContext.options.maxBudgetUsd),
          ),
        ),
        maybe('usage_limit_notice', async () =>
          Promise.resolve(getUsageLimitNoticeAttachment(toolUseContext, messages ?? [])),
        ),
        maybe('mission_status', async () => Promise.resolve(getMissionStatusAttachment(messages ?? [], input !== null)), { priority: true }),
      ]
    : []

  const continuationResults = await Promise.all([
    ...allThreadAttachments,
    ...mainThreadAttachments,
  ])

  stopTimeout(timeoutId)
  const collected = [
    ...mentionedFiles,
    ...userAttachmentResults.flat(),
    ...continuationResults.flat(),
  ].filter(a => a !== undefined && a !== null) as Attachment[]
  return options?.localSubmission ? collected : foldAttachmentsIntoCapsule(collected, messages, input, context)
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

export function makeMaybe(deadlineAt: number): MaybeFn {
  return async function maybe<A>(
    label: string,
    f: () => Promise<A[]>,
    opts?: MaybeOpts,
  ): Promise<A[]> {
    const startTime = performance.now()
    try {
      const remaining = deadlineAt - startTime
      if (remaining <= 0 && !opts?.priority) {
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
                  .catch(passedOver)
                  .finally(() => {
                    if (producerInFlight.get(label) === p) {
                      producerInFlight.delete(label)
                    }
                  })
              }
              return p
            })()
      const result = await (remaining > 0
        ? withDeadline(run, remaining, () => 'pulse_deadline' as const)
        : run)
      if (result === 'pulse_deadline') {
        logError(
          new Error(
            `attachment producer '${label}' ignored cancellation past the ${ATTACHMENT_HARD_DEADLINE_MS}ms hard deadline — output dropped (recorded, not silent)`,
          ),
        )
        return []
      }
      return result
    } catch (e) {
      logError(e)

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
              const t = startTimeout(() => resolve([]), ms)
              signal.addEventListener(
                'abort',
                () => {
                  stopTimeout(t)
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
              startTimeout(() => resolve([]), ms)
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
              startTimeout(() => resolve([]), ms)
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
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { localSubmission?: boolean; operatorPrompt?: boolean },
): AsyncGenerator<AttachmentMessage, void> {
  const attachments = await getAttachments(
    input,
    toolUseContext,
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
