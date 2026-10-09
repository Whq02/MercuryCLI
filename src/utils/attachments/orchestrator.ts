
import { randomUUID } from 'crypto'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { AttachmentMessage, Message } from 'src/types/message.js'
import type { QueuedCommand } from 'src/types/textInputTypes.js'
import type { ToolUseContext } from '../../Tool.js'
import { getHarnessMapDelta } from '../cockpit/harnessMap.js'
import { getRunProtocolDelta } from '../cockpit/runProtocol.js'
import type { QuerySource } from '../../constants/querySource.js'
import { createAbortController } from '../abortController.js'
import { isEnvTruthy } from '../envUtils.js'
import { logError } from '../log.js'
import { getLSPDiagnosticAttachments } from './diagnostics.js'
import { getChangedFiles } from './fileAttachments.js'
import {
  getCapsuleDateChange,
  getModePackAttachments,
} from './modeLifecycles.js'
import { foldAttachmentsIntoCapsule, getContextCapsuleAttachment } from './contextCapsule.js'
import { getNestedMemoryAttachments } from './nestedMemory.js'
import {
  processAgentMentions,
  processAtMentionedFiles,
  processMcpResourceAttachments,
} from './mentionResolvers.js'
import {
  getAdvisorNoteAttachments,
  getAgentPendingMessageAttachments,
  getQueuedCommandAttachments,
} from './queuedCommands.js'
import {
  getDeferredToolsDeltaAttachment,
  getHeldToolsAttachment,
  getMcpInstructionsDeltaAttachment,
} from './deltas.js'
import {
  getContractReminderAttachments,
  getTaskReminderAttachments,
} from './reminders.js'
import {
  getCriticalSystemReminderAttachment,
  getMaxBudgetUsdAttachment,
  getOutputTokenUsageAttachment,
  getUsageLimitNoticeAttachment,
} from './sessionContext.js'
import { getRelevantMemoryAttachments } from './memorySurfacing.js'
import {
  getDynamicSkillAttachments,
  getSkillListingAttachments,
} from './skillListing.js'
import {
  getBackgroundHookAttachments,
  getUnifiedTaskAttachments,
} from './taskStatus.js'
import type { Attachment } from './types.js'
import { rosterOwnerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { getUserContextAttachment } from './userContext.js'

export async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { localSubmission?: boolean },
): Promise<Attachment[]> {
  if (isEnvTruthy(process.env.MERCURY_BARE)) {
    return getQueuedCommandAttachments(queuedCommands)
  }

  const abortController = createAbortController()
  const timeoutId = setTimeout(
    ac => ac.abort(),
    ATTACHMENT_SOFT_ABORT_MS,
    abortController,
  )
  const context = { ...toolUseContext, abortController, messages: messages ?? toolUseContext.messages }

  const isMainThread = !toolUseContext.agentId

  const collectionStart = performance.now()
  const maybe = makeMaybe(collectionStart + ATTACHMENT_HARD_DEADLINE_MS)

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
        maybe(
          'relevant_memories',
          () =>
            Promise.resolve(
              options?.localSubmission ? [] : getRelevantMemoryAttachments(input, messages, toolUseContext),
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
      Promise.resolve(getCapsuleDateChange(context, messages)),
    ),
    maybe('deferred_tools_delta', () =>
      Promise.resolve(
        getDeferredToolsDeltaAttachment(
          toolUseContext.options.tools,
          toolUseContext.options.engineModel,
          messages,
          {
            callSite: isMainThread
              ? 'attachments_main'
              : 'attachments_subagent',
            querySource,
            hasPendingMcpServers: [
              ...toolUseContext.options.mcpClients,
              ...(toolUseContext.getAppState?.().mcp?.clients ?? []),
            ].some(client => client.type === 'pending'),
          },
        ),
      ),
    ),
    maybe('held_tools', () =>
      Promise.resolve(
        getHeldToolsAttachment(String(rosterOwnerFromToolUseContext(toolUseContext)), messages ?? []),
      ),
    ),
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
    maybe('run_protocol_delta', () => Promise.resolve((() => {
      if (!isMainThread) return []
      const delta = getRunProtocolDelta(toolUseContext.options.tools, messages ?? [])
      return delta ? [{ type: 'run_protocol_delta' as const, ...delta }] : []
    })())),
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
    maybe('nested_memory', () => getNestedMemoryAttachments(context)),
    maybe('dynamic_skill', () => getDynamicSkillAttachments(context)),
    maybe('skill_listing', () => getSkillListingAttachments(context)),
    maybe('mode_pack', () => Promise.resolve(getModePackAttachments(messages, toolUseContext))),
    maybe('context_capsule', () =>
      options?.localSubmission
        ? Promise.resolve([])
        : getContextCapsuleAttachment(input, messages, toolUseContext),
    ),
    maybe('task_reminders', () => getTaskReminderAttachments(messages, toolUseContext)),
    maybe('contract_reminder', () =>
      getContractReminderAttachments(messages, toolUseContext),
    ),
    maybe(
      'agent_pending_messages',
      async () => getAgentPendingMessageAttachments(toolUseContext),
      { priority: true },
    ),
    maybe(
      'advisor_notes',
      async () =>
        getAdvisorNoteAttachments(toolUseContext, {
          ...(querySource !== undefined ? { querySource } : {}),
          ...(options?.localSubmission !== undefined ? { localSubmission: options.localSubmission } : {}),
        }),
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
    ...pulseFixtureProducers(abortController.signal, maybe),
  ]

  const mainThreadAttachments = isMainThread
    ? [
        maybe('lsp_diagnostics', async () =>
          getLSPDiagnosticAttachments(toolUseContext),
        ),
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
        maybe('output_token_usage', async () =>
          Promise.resolve(getOutputTokenUsageAttachment()),
        ),
        maybe('usage_limit_notice', async () =>
          Promise.resolve(getUsageLimitNoticeAttachment(toolUseContext, messages ?? [])),
        ),
      ]
    : []

  const continuationResults = await Promise.all([
    ...allThreadAttachments,
    ...mainThreadAttachments,
  ])

  clearTimeout(timeoutId)
  const collected = [
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
    let timer: ReturnType<typeof setTimeout> | null = null
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
      if (timer !== null) clearTimeout(timer)
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
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { localSubmission?: boolean },
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

export function createAttachmentMessage(
  attachment: Attachment,
): AttachmentMessage {
  return {
    attachment: withDeliveryClock(attachment),
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: sentClockOf(attachment) ?? new Date().toISOString(),
  }
}

function sentClockOf(attachment: Attachment): string | null {
  if (attachment.type !== 'queued_command' || attachment.sentAt === undefined) return null
  return Number.isFinite(Date.parse(attachment.sentAt)) ? attachment.sentAt : null
}

function withDeliveryClock(attachment: Attachment): Attachment {
  if (attachment.type !== 'queued_command' || sentClockOf(attachment) === null) return attachment
  return { ...attachment, deliveredAt: new Date().toISOString() }
}
