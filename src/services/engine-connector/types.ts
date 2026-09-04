import type { Message } from '../../types/message.js'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import type { PermissionMode, PermissionUpdate } from '../../types/permissions.js'
import type { ModelSetting } from '../../utils/model/model.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { PastedContent } from '../../utils/config/schema.js'
import type { MCPServerConnection } from '../mcp/types.js'
import type { ContentBlockParam } from '../../types/wire.js'
import type { SessionKitEditV1 } from '../../daemon/sessionKit.js'
import type { SpawnSwitchFacts, SpawnSwitchKind } from '../switchboard/spawnSwitches.js'
import type { SessionRewindMode, SessionRewindOutcomeV1 } from '../../daemon/protocol.js'

export type EngineCarrierKind = 'in-process' | 'daemon'


export type SendWordsOptions = {
  mode?: PromptInputMode
  pastedContents?: Record<number, PastedContent>
  fromKeybinding?: boolean
}

export type SendReceiptV1 =
  | { state: 'accepted' }
  | { state: 'refused'; detail: string }


export type SessionAskV1 = {
  id: string
  confirm: ToolUseConfirm
}

export type AskAnswerV1 =
  | {
      kind: 'allow'
      updatedInput?: Record<string, unknown>
      permissionUpdates?: PermissionUpdate[]
      feedback?: string
      contentBlocks?: ContentBlockParam[]
    }
  | { kind: 'deny'; feedback?: string; contentBlocks?: ContentBlockParam[] }
  | { kind: 'abort' }

export type AskReceiptV1 =
  | { ok: true }
  | { ok: false; detail: string }


export type ModelFactsV1 = {
  effective: string
  effectiveSource?: 'live' | 'record' | 'ambient'
  main: string
  setting: ModelSetting
  sessionPin: ModelSetting | null
  pendingSwitch: { setting: ModelSetting } | null
}

export type ModelSwitchReceiptV1 =
  | { state: 'applied' }
  | { state: 'queued' }
  | { state: 'no-op' }
  | { state: 'refused'; detail: string }


export type LimitWarningFactV1 = {
  provider: string
  text: string
}

export type UsageFactsV1 = {
  totalCostUSD: number
  totalAPIDurationMs: number
  totalDurationMs: number
  totalLinesAdded: number
  totalLinesRemoved: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadInputTokens: number
  totalCacheCreationInputTokens: number
  hasUnknownModelCost: boolean
  unpricedTurns?: number
  limitWarning?: LimitWarningFactV1 | null
  openaiObserved?: {
    primary?: OpenaiObservedBandV1
    secondary?: OpenaiObservedBandV1
  }
}

export type OpenaiObservedBandV1 = {
  usedPct?: number
  windowMinutes?: number
  resetsAtMs?: number
  observedAtMs: number
}

export type SeatIdentityV1 = {
  firstPartyApi: boolean
  consoleBilling: boolean
  claudeAiBilling: boolean
  accountEmail: string | null
}


export type SkillsRosterEntryV1 = {
  name: string
  description: string
  state?: 'invocable' | 'off'
}

export type SkillsRosterV1 = {
  skills: SkillsRosterEntryV1[]
}

export type McpRosterEntryV1 = {
  name: string
  type: MCPServerConnection['type']
  error?: string
}

export type McpRosterV1 = {
  clients: readonly McpRosterEntryV1[]
}


export type KitDialReceiptV1 = {
  outcome: 'applied' | 'queued' | 'noop' | 'refused'
  detail?: string
}


export type SpawnSwitchReceiptV1 = KitDialReceiptV1

export type WorkAgentV1 = {
  index: number
  label: string
  state: string
}

export type WorkPhaseV1 = {
  title: string
  planned: boolean
  agents: WorkAgentV1[]
}

export type WorkRowV1 = {
  id: string
  kind: 'workflow' | 'agent' | 'teammate' | 'shell' | 'monitor' | 'dream'
  name: string
  status: string
  startTime: number
  endTime?: number
  description?: string
  model?: string
  error?: string
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  contextTokens?: number
  costUSD?: number
  unpricedTurns?: number
  toolUses?: number
  activity?: string
  wait?: string
  toolUseId?: string
  workflowRunId?: string
  phases?: WorkPhaseV1[]
  agentCount?: number
  pendingAsks?: number
  agentType?: string
  team?: string
}

export type MissionRowV1 = {
  id: string
  subject: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type WorkRosterV1 = {
  rows: readonly WorkRowV1[]
  mission: readonly MissionRowV1[]
}


export type WorkspaceFactsV1 = {
  cwd: string
  originalCwd: string
  projectRoot: string
  instructionRoots: readonly string[]
}


export type CheckpointFactsV1 = {
  capture: 'on' | 'off' | 'unknown'
  restorable: ReadonlySet<string>
}

export type RewindRequestV1 = {
  userMessageId: string
  mode: SessionRewindMode
  dryRun?: boolean
}

export type RewindReceiptV1 = SessionRewindOutcomeV1


export interface EngineConnectorV1 {
  readonly carrier: EngineCarrierKind

  sessionId(): string

  sendWords(text: string, opts?: SendWordsOptions): Promise<SendReceiptV1>
  sendAgentNote(agentId: string, text: string): Promise<SendReceiptV1>

  records(): readonly Message[]
  subscribeRecords(listener: () => void): () => void
  turnActive(): boolean

  asks(): readonly SessionAskV1[]
  subscribeAsks(listener: () => void): () => void
  answerAsk(askId: string, answer: AskAnswerV1): Promise<AskReceiptV1>
  settleAsk(askId: string): void

  interrupt(): boolean

  modelFacts(): ModelFactsV1
  subscribeModel(listener: () => void): () => void
  setModel(setting: ModelSetting): Promise<ModelSwitchReceiptV1>

  usage(): UsageFactsV1
  identity(): SeatIdentityV1

  skillsRoster(): SkillsRosterV1
  mcpRoster(): McpRosterV1

  setKit(edit: SessionKitEditV1): Promise<KitDialReceiptV1>

  spawnSwitches(): SpawnSwitchFacts
  setSpawnSwitch(kind: SpawnSwitchKind, on: boolean): Promise<SpawnSwitchReceiptV1>

  checkpointFacts(): CheckpointFactsV1
  subscribeCheckpoints(listener: () => void): () => void
  rewind(req: RewindRequestV1): Promise<RewindReceiptV1>

  workRoster(): WorkRosterV1
  subscribeWork(listener: () => void): () => void

  permissionMode(): PermissionMode
  subscribePermissionMode(listener: () => void): () => void
  setPermissionMode(mode: PermissionMode): void

  workspace(): WorkspaceFactsV1

  dispatchSlash(line: string): Promise<SendReceiptV1>

}
