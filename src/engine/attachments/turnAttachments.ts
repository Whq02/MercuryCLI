import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import type { AttachmentMessage, Message } from 'src/engine/message-shapes/message.js'
import type { QueuedCommand } from 'src/screen/composer/input-core/textInput.js'
import type { ToolUseContext } from '../../tools/kit/tool.js'
import { getHarnessMapDelta } from '../../screen/cockpit-gauges/harnessMap.js'
import type { QuerySource } from '../requests/querySource.js'
import { createAbortController } from '../../platform/async/abortController.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import { logError } from '../../platform/logs/errorLog.js'
import { getLSPDiagnosticAttachments } from './diagnostics.js'
import { getChangedFiles } from './fileAttachments.js'
import {
  getCapsuleDateChange,
  getModePackAttachments,
} from '../attachment-shapes/dateAndModeNotices.js'
import { foldAttachmentsIntoCapsule, getContextCapsuleAttachment } from './contextCapsule.js'
import { getNestedInstructionAttachments } from './nestedInstructions.js'
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
} from './toolAndServerDeltas.js'
import { getTaskReminderAttachments } from './reminders.js'
import { getToolSchemaDeltaAttachment } from './toolSchemaDelta.js'
import {
  getCriticalSystemReminderAttachment,
  getMaxBudgetUsdAttachment,
  getUsageLimitNoticeAttachment,
} from './sessionNotices.js'
import {
  getDynamicSkillAttachments,
  getSkillListingAttachments,
} from '../attachment-shapes/skillListing.js'
import {
  getBackgroundHookAttachments,
  getUnifiedTaskAttachments,
} from '../attachment-shapes/taskStatus.js'
import { getMissionStatusAttachment } from '../attachment-shapes/missionStatus.js'
import type { Attachment } from '../attachment-shapes/attachmentTypes.js'
import { rosterOwnerFromToolUseContext } from '../run-owner/resolveOwner.js'
import { getUserContextAttachment } from '../attachment-shapes/userContext.js'
import { firstTurnUserContext } from '../messages/apiSystemAndToolSchema.js'
import { getSystemContext, getUserContext } from '../requestContext.js'
import { getToolManualAttachments } from './toolManuals.js'
import { samplesRoadAttachment } from '../attachment-shapes/samplesRoad.js'
import { createAttachmentMessage } from '../attachment-shapes/attachmentMessage.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { withDeadline } from '../../platform/async/deadline.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'
import { remoteFilesNotice } from '../../platform/remote-file-target/notice.js'
export { createAttachmentMessage } from '../attachment-shapes/attachmentMessage.js'

export async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { localSubmission?: boolean; operatorPrompt?: boolean },
): Promise<Attachment[]> {
  const history = messages ?? toolUseContext.messages
  if (isEnvTruthy(flagEnv('MERCURY_BARE'))) {
    const queueRows = await getQueuedCommandAttachments(queuedCommands, {
      messages: history,
      model: toolUseContext.options.engineModel,
    })
    const manuals = await getToolManualAttachments({ ...toolUseContext, messages: history })
    return [...queueRows, ...manuals]
  }

  let mentionedFiles: Attachment[] = []
  if (input) {
    try {
      mentionedFiles = await processAtMentionedFiles(input, toolUseContext)
    } catch (error) {
      logError(error)
    }
  }

  const attachmentAbortController = createAbortController()
  const deadlineAt = performance.now() + ATTACHMENT_HARD_DEADLINE_MS
  const softTimer = startTimeout(() => {
    attachmentAbortController.abort()
  }, ATTACHMENT_SOFT_ABORT_MS)
  const maybe = makeMaybe(deadlineAt)
  const clonedContext: ToolUseContext = {
    ...toolUseContext,
    abortController: attachmentAbortController,
    messages: history,
  }
  const opening = !history.some(
    m => m.type === 'assistant' || (m.type === 'system' && m.subtype === 'compact_boundary'),
  )
  const isMain = !toolUseContext.agentId

  let inputResults: Attachment[][] = []
  let continuationResults: Attachment[][] = []
  try {
    if (input) {
      const inputProducers: Array<Promise<Attachment[]>> = [
        maybe('mcp_resources', () => processMcpResourceAttachments(input, clonedContext), {
          inputScoped: true,
        }),
        ...(options?.operatorPrompt
          ? [
              maybe('samples_road', () => samplesRoadAttachment(input, history), {
                inputScoped: true,
              }),
            ]
          : []),
        ...(input.includes('ssh://')
          ? [
              maybe('remote_files', () => remoteFilesNotice(input, history), {
                inputScoped: true,
              }),
            ]
          : []),
        maybe(
          'agent_mentions',
          () =>
            processAgentMentions(input, toolUseContext.options.agentDefinitions?.activeAgents ?? []),
          { inputScoped: true },
        ),
        ...pulseFixtureUserInputProducers(maybe),
      ]
      inputResults = await Promise.all(inputProducers)
    }

    const continuationProducers: Array<Promise<Attachment[]>> = [
      maybe(
        'queued_commands',
        () =>
          getQueuedCommandAttachments(queuedCommands, {
            messages: clonedContext.messages,
            model: clonedContext.options.engineModel,
          }),
        { priority: true },
      ),
      ...(opening ? [maybe('date_change', () => getCapsuleDateChange(clonedContext, history))] : []),
      maybe('deferred_tools_delta', () =>
        getPlannedDeferredToolsAttachment(toolUseContext, history, {
          callSite: isMain ? 'attachments_main' : 'attachments_subagent',
          querySource,
          hasPendingMcpServers:
            (toolUseContext.options.mcpClients ?? []).some(client => client.type === 'pending') ||
            (toolUseContext.getAppState().mcp?.clients ?? []).some(
              client => client.type === 'pending',
            ),
        }),
      ),
      maybe('held_tools', () =>
        getHeldToolsAttachment(String(rosterOwnerFromToolUseContext(toolUseContext)), history),
      ),
      maybe('tool_schema_delta', () => getToolSchemaDeltaAttachment(toolUseContext, history)),
      maybe('mcp_instructions_delta', () =>
        getMcpInstructionsDeltaAttachment(
          toolUseContext.options.mcpClients ?? [],
          toolUseContext.options.tools,
          toolUseContext.options.engineModel,
          history,
        ),
      ),
      maybe('mcp_servers_failed', () =>
        getMcpServersFailedAttachment(
          [
            ...(toolUseContext.options.mcpClients ?? []),
            ...(toolUseContext.getAppState().mcp?.clients ?? []),
          ],
          history,
        ),
      ),
      ...(isMain
        ? [
            maybe<Attachment>('harness_map_delta', () => {
              const delta = getHarnessMapDelta(history)
              return delta ? [{ type: 'harness_map_delta', ...delta }] : []
            }),
          ]
        : []),
      maybe('changed_files', () => getChangedFiles(clonedContext)),
      maybe('lsp_diagnostics', () => getLSPDiagnosticAttachments(toolUseContext), {
        inputScoped: true,
      }),
      maybe('nested_memory', () => getNestedInstructionAttachments(clonedContext)),
      maybe('dynamic_skill', () => getDynamicSkillAttachments(clonedContext)),
      maybe('skill_listing', () => getSkillListingAttachments(clonedContext)),
      maybe('mode_pack', () => getModePackAttachments(history, toolUseContext)),
      ...(opening && !options?.localSubmission
        ? [maybe('context_capsule', () => getContextCapsuleAttachment(input, history, toolUseContext))]
        : []),
      ...(opening
        ? [maybe('task_reminders', () => getTaskReminderAttachments(history, toolUseContext))]
        : []),
      maybe('agent_pending_messages', () => getAgentPendingMessageAttachments(toolUseContext), {
        priority: true,
      }),
      ...(!options?.localSubmission
        ? [
            maybe('crew_board', () => getSwarmAttachments(toolUseContext, history), {
              priority: true,
            }),
          ]
        : []),
      maybe(
        'advisor_notes',
        () =>
          getAdvisorNoteAttachments(toolUseContext, {
            ...(querySource !== undefined ? { querySource } : {}),
            ...(options?.localSubmission !== undefined
              ? { localSubmission: options.localSubmission }
              : {}),
          }),
        { priority: true },
      ),
      ...(isMain
        ? [
            maybe('user_context', async () => {
              const userContext = await firstTurnUserContext(
                await getUserContext(),
                getSystemContext,
                toolUseContext.options.engineModel,
                toolUseContext.agentId,
                history,
                options?.localSubmission ? null : input,
              )
              return getUserContextAttachment(history, userContext, opening)
            }),
          ]
        : []),
      maybe('tool_manuals', () => getToolManualAttachments(clonedContext), {
        priority: true,
        inputScoped: true,
      }),
      maybe('critical_system_reminder', () =>
        getCriticalSystemReminderAttachment(toolUseContext, history),
      ),
      ...pulseFixtureProducers(attachmentAbortController.signal, maybe),
    ]

    if (isMain) {
      continuationProducers.push(
        maybe('unified_tasks', () => getUnifiedTaskAttachments(toolUseContext)),
        maybe('background_hooks', () => getBackgroundHookAttachments()),
        maybe('budget_usd', () => getMaxBudgetUsdAttachment(toolUseContext.options.maxBudgetUsd)),
        maybe('usage_limit_notice', () => getUsageLimitNoticeAttachment(toolUseContext, history)),
        maybe('mission_status', () => getMissionStatusAttachment(history, input !== null), {
          priority: true,
        }),
      )
    }

    continuationResults = await Promise.all(continuationProducers)
  } finally {
    stopTimeout(softTimer)
  }

  const collected = [
    ...mentionedFiles,
    ...inputResults.flat(),
    ...continuationResults.flat(),
  ].filter(row => row !== null && row !== undefined)

  if (options?.localSubmission) return collected
  return foldAttachmentsIntoCapsule(collected, history, input, clonedContext)
}

const ATTACHMENT_SOFT_ABORT_MS = 1_000
const ATTACHMENT_HARD_DEADLINE_MS = ATTACHMENT_SOFT_ABORT_MS * 2

type MaybeOpts = {
  priority?: boolean
  inputScoped?: boolean
}
type MaybeFn = <T>(
  label: string,
  fn: () => Promise<T[]> | T[],
  opts?: MaybeOpts,
) => Promise<T[]>

const producerInFlight = new Map<string, Promise<unknown[]>>()

export function makeMaybe(deadlineAt: number): MaybeFn {
  return async <T>(
    label: string,
    fn: () => Promise<T[]> | T[],
    opts?: MaybeOpts,
  ): Promise<T[]> => {
    const remaining = deadlineAt - performance.now()
    const priority = opts?.priority === true
    if (remaining <= 0 && !priority) {
      logError(
        new Error(
          `attachment producer '${label}' skipped — the shared ${ATTACHMENT_HARD_DEADLINE_MS}ms budget was spent before it could start (recorded, not silent)`,
        ),
      )
      return []
    }
    const reusable = !priority && !opts?.inputScoped
    let run: Promise<T[]>
    const existing = reusable ? producerInFlight.get(label) : undefined
    if (existing !== undefined) {
      run = existing as Promise<T[]>
    } else {
      try {
        run = Promise.resolve(fn())
      } catch (error) {
        logError(error)
        return []
      }
      if (reusable) {
        producerInFlight.set(label, run)
        run
          .finally(() => {
            if (producerInFlight.get(label) === run) {
              producerInFlight.delete(label)
            }
          })
          .catch(passedOver)
      }
    }
    try {
      if (remaining > 0) {
        const result = await withDeadline(run, remaining, () => 'pulse_deadline' as const)
        if (result === 'pulse_deadline') {
          logError(
            new Error(
              `attachment producer '${label}' ignored cancellation past the ${ATTACHMENT_HARD_DEADLINE_MS}ms hard deadline — output dropped (recorded, not silent)`,
            ),
          )
          return []
        }
        return result
      }
      return await run
    } catch (error) {
      logError(error)
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
  for (const attachment of attachments) {
    yield createAttachmentMessage(attachment)
  }
}
