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
import { notBuilt, type Unbuilt } from '../../pi/holes.js'
export { createAttachmentMessage } from '../../utils/attachments/attachmentMessage.js'

export async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { localSubmission?: boolean; operatorPrompt?: boolean },
): Promise<Attachment[]> {
  return notBuilt('src/services/attachments/orchestrator.ts:68')
}

const ATTACHMENT_SOFT_ABORT_MS = 1_000
const ATTACHMENT_HARD_DEADLINE_MS = ATTACHMENT_SOFT_ABORT_MS * 2

type MaybeOpts = {
  priority?: boolean
  inputScoped?: boolean
}
type MaybeFn = (...args: Unbuilt[]) => Unbuilt

export function makeMaybe(deadlineAt: number): MaybeFn {
  return notBuilt('src/services/attachments/orchestrator.ts:266')
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
  return notBuilt('src/services/attachments/orchestrator.ts:390')
}
