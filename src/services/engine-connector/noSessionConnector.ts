import type { Message } from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { getCwd } from '../../utils/cwd.js'
import { seatInitialPermissionMode } from '../../daemon/concourseSupervisor.js'
import type {
  AgentControlReceiptV1,
  AskReceiptV1,
  CheckpointFactsV1,
  EngineConnectorV1,
  KitDialReceiptV1,
  SpawnSwitchReceiptV1,
  McpRosterV1,
  ModelFactsV1,
  ModelSwitchReceiptV1,
  RewindReceiptV1,
  RewindRequestV1,
  SeatIdentityV1,
  SendReceiptV1,
  SessionAskV1,
  SkillsRosterV1,
  UsageFactsV1,
  WorkRosterV1,
  WorkspaceFactsV1,
} from './types.js'
import type { SpawnSwitchFacts } from '../switchboard/spawnSwitches.js'

export const NO_CHAT_OPEN = 'no chat is open — ↵ New Session on the boot menu starts one'

const REFUSED_NO_CHAT: SendReceiptV1 = Object.freeze({ state: 'refused', detail: NO_CHAT_OPEN })
const ASK_REFUSED_NO_CHAT: AskReceiptV1 = Object.freeze({ ok: false, detail: NO_CHAT_OPEN })
const KIT_REFUSED_NO_CHAT: KitDialReceiptV1 = Object.freeze({ outcome: 'refused' as const, detail: NO_CHAT_OPEN })
const NO_SPAWN_SWITCHES: SpawnSwitchFacts = Object.freeze({
  subagents: Object.freeze({ on: true, source: 'default' as const }),
  workflows: Object.freeze({ on: true, source: 'default' as const }),
})

const EMPTY_MESSAGES: readonly Message[] = Object.freeze([])
const EMPTY_ASKS: readonly SessionAskV1[] = Object.freeze([])
const EMPTY_WORK: WorkRosterV1 = Object.freeze({ rows: Object.freeze([]) as never, mission: Object.freeze([]) as never })
const ZERO_USAGE: UsageFactsV1 = Object.freeze({
  totalCostUSD: 0,
  totalAPIDurationMs: 0,
  totalDurationMs: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadInputTokens: 0,
  totalCacheCreationInputTokens: 0,
  hasUnknownModelCost: false,
})
const NO_IDENTITY: SeatIdentityV1 = Object.freeze({
  firstPartyApi: false,
  consoleBilling: false,
  claudeAiBilling: false,
  accountEmail: null,
})
const NO_SKILLS: SkillsRosterV1 = Object.freeze({ skills: Object.freeze([]) as never })
const NO_MCP: McpRosterV1 = Object.freeze({ clients: Object.freeze([]) as never })
const NO_CHECKPOINTS: CheckpointFactsV1 = Object.freeze({ capture: 'off' as const, restorable: Object.freeze(new Set<string>()) as ReadonlySet<string> })
const NOOP_UNSUBSCRIBE = (): void => {}

export class NoSessionConnector implements EngineConnectorV1 {
  readonly carrier = 'daemon' as const
  private cachedModelFacts: ModelFactsV1 | null = null
  private cachedWorkspace: WorkspaceFactsV1 | null = null

  sessionId(): string {
    return ''
  }

  async sendWords(): Promise<SendReceiptV1> {
    return REFUSED_NO_CHAT
  }
  async sendAgentNote(): Promise<SendReceiptV1> {
    return REFUSED_NO_CHAT
  }
  records(): readonly Message[] {
    return EMPTY_MESSAGES
  }
  subscribeRecords(): () => void {
    return NOOP_UNSUBSCRIBE
  }
  turnActive(): boolean {
    return false
  }
  asks(): readonly SessionAskV1[] {
    return EMPTY_ASKS
  }
  subscribeAsks(): () => void {
    return NOOP_UNSUBSCRIBE
  }
  async answerAsk(): Promise<AskReceiptV1> {
    return ASK_REFUSED_NO_CHAT
  }
  settleAsk(): void {}
  interrupt(): boolean {
    return false
  }
  async stopAgent(): Promise<AgentControlReceiptV1> {
    return { outcome: 'refused', detail: NO_CHAT_OPEN }
  }
  async resumeAgent(): Promise<AgentControlReceiptV1> {
    return { outcome: 'refused', detail: NO_CHAT_OPEN }
  }
  modelFacts(): ModelFactsV1 {
    const main = getMainLoopModel()
    if (this.cachedModelFacts === null || this.cachedModelFacts.main !== main) {
      this.cachedModelFacts = { effective: main, main, setting: null, sessionPin: null, pendingSwitch: null }
    }
    return this.cachedModelFacts
  }
  subscribeModel(): () => void {
    return NOOP_UNSUBSCRIBE
  }
  async setModel(): Promise<ModelSwitchReceiptV1> {
    return { state: 'refused', detail: NO_CHAT_OPEN }
  }
  async setEffort(): Promise<ModelSwitchReceiptV1> {
    return { state: 'refused', detail: NO_CHAT_OPEN }
  }
  usage(): UsageFactsV1 {
    return ZERO_USAGE
  }
  identity(): SeatIdentityV1 {
    return NO_IDENTITY
  }
  skillsRoster(): SkillsRosterV1 {
    return NO_SKILLS
  }
  mcpRoster(): McpRosterV1 {
    return NO_MCP
  }
  async setKit(): Promise<KitDialReceiptV1> {
    return KIT_REFUSED_NO_CHAT
  }
  spawnSwitches(): SpawnSwitchFacts {
    return NO_SPAWN_SWITCHES
  }
  async setSpawnSwitch(): Promise<SpawnSwitchReceiptV1> {
    return { outcome: 'refused', detail: NO_CHAT_OPEN }
  }
  checkpointFacts(): CheckpointFactsV1 {
    return NO_CHECKPOINTS
  }
  subscribeCheckpoints(): () => void {
    return NOOP_UNSUBSCRIBE
  }
  async rewind(req: RewindRequestV1): Promise<RewindReceiptV1> {
    return { outcome: 'refused', mode: req.mode, refusal: 'no-chat', detail: NO_CHAT_OPEN }
  }
  permissionMode(): PermissionMode {
    return seatInitialPermissionMode() as PermissionMode
  }
  subscribePermissionMode(): () => void {
    return NOOP_UNSUBSCRIBE
  }
  setPermissionMode(): void {}
  workspace(): WorkspaceFactsV1 {
    const cwd = getCwd()
    if (this.cachedWorkspace === null || this.cachedWorkspace.cwd !== cwd) {
      this.cachedWorkspace = { cwd, originalCwd: cwd, projectRoot: cwd, instructionRoots: EMPTY_ROOTS }
    }
    return this.cachedWorkspace
  }
  async dispatchSlash(): Promise<SendReceiptV1> {
    return REFUSED_NO_CHAT
  }
  workRoster(): WorkRosterV1 {
    return EMPTY_WORK
  }
  subscribeWork(): () => void {
    return NOOP_UNSUBSCRIBE
  }
}

const EMPTY_ROOTS: readonly string[] = Object.freeze([])

let resting: NoSessionConnector | null = null

export function noSessionConnector(): NoSessionConnector {
  resting ??= new NoSessionConnector()
  return resting
}
