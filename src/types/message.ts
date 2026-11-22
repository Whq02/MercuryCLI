import type { ContentBlock, ApiMessage, ApiStreamEvent, ToolUseBlock, ContentBlockParam } from './wire.js'
import type { APIError } from '../utils/api/sdkErrors.js'
import type { OverflowSignal } from '../services/api/overflowSignal.js'
import type { MediaRefusal } from '../utils/api/mediaRefusal.js'
import type { StreamEndV1 } from '../services/providers/streamIdleBudget.js'
import type { EffortAdjustedV1, EffortLevel } from '../utils/effort.js'
import type { EffortStampV1 } from '../fabric/record.js'
import type { AdvisorOrigin, SaturnOrigin, ScreenCommandOrigin } from '../utils/messages/noticeRows.js'
import type { UUID } from 'crypto'
import type {
  BranchAction,
  CommitKind,
  PrAction,
} from '../tools/shared/gitOperationTracking.js'
import type { Progress } from '../Tool.js'
import type { Attachment } from '../services/attachments.js'
import { unbuilt, type Unbuilt } from '../pi/holes.js'


export type SystemMessageLevel = Unbuilt

export const ASSISTANT_MESSAGE_ERRORS: Unbuilt = unbuilt('src/types/message.ts:27')
export type AssistantMessageError = Unbuilt

export type FailoverCause = Unbuilt

export type RefusedToolCall = Unbuilt

export type PartialCompactDirection = Unbuilt

export type MessageOrigin = Unbuilt

export type CompactMetadata = Unbuilt

export type AssistantMessage = Unbuilt

export type ReplyMark = Unbuilt


export type UserMessage = Unbuilt


export type ProgressMessage<P extends Progress = Progress> = Unbuilt


export type AttachmentMessage<A extends Attachment = Attachment> = Unbuilt

export type HookResultMessage = Unbuilt


export type SystemInformationalMessage = Unbuilt

export type SystemSeatReceiptMessage = Unbuilt

export type SystemRosterTransitionMessage = Unbuilt

export type SystemAdvisorQuietMessage = Unbuilt

export type SystemStreamCutMessage = Unbuilt

export type BusyRefusalV1 = Unbuilt

export type SystemBusyRecoveryMessage = Unbuilt

export type SystemThinkingNoteMessage = Unbuilt

export type DeadThinkingMark = Unbuilt

export type SystemThinkingDeadMessage = Unbuilt

export type BoundPrefixToolMark = Unbuilt

export type BoundPrefixSection = Unbuilt

export type SystemScheduledTaskFireMessage = Unbuilt


export type SystemTurnDurationMessage = Unbuilt

export type SystemModelTransitionMessage = Unbuilt

export type AwayRecapMetadata = Unbuilt

export type LaunchWonV1 = Unbuilt

export type SystemAwaySummaryMessage = Unbuilt

export type SystemMemorySavedMessage = Unbuilt

export type SystemAgentsKilledMessage = Unbuilt

export type SystemApiMetricsMessage = Unbuilt

export type SystemCloseUsageMessage = Unbuilt

export type SystemLocalCommandMessage = Unbuilt

export type CrewChatKind = Unbuilt
export type CrewChatRole = Unbuilt
export type CrewChatChannel = Unbuilt
export type CrewChatLifecycle = Unbuilt

export type SystemCrewChatMessage = Unbuilt

export type SystemCompactBoundaryMessage = Unbuilt

export type SystemMicrocompactBoundaryMessage = Unbuilt

export type SystemAPIErrorMessage = Unbuilt

export type SystemMessage = Unbuilt


export type Message = Unbuilt


export type NormalizedAssistantMessage<
  C extends ContentBlock = ContentBlock,
> = Unbuilt

export type NormalizedUserMessage = Unbuilt

export type NormalizedMessage = Unbuilt


export type GroupedToolUseMessage = Unbuilt

export type CollapsedReadSearchGroup = Unbuilt

export type CollapsibleMessage = Unbuilt

export type TurnReceiptMessage = Unbuilt

export type RenderableMessage = Unbuilt


export type StreamEvent = Unbuilt

export type RequestStartEvent = Unbuilt

export type TombstoneMessage = Unbuilt

export interface ModelTransitionReceipt {
  previous: string | null
  requested: string | null
  applied: string | null
  resolution: 'applied' | 'cancelled-pending'
  boundary: 'idle' | 'turn-boundary'
  crossProvider: boolean
  cacheDisposition: 'keyed-sections-recompute-once' | 'none'
}
