// ============================================================================
//  engine-connector/noSessionConnector — NO CHAT IS OPEN.
//
//  The focused slot's RESTING state under the one-door law (Law 9: the
//  session is the unit; every screen is a view). A fresh boot has no chat;
//  the slot holds this until a session is ENTERED — New Session births one,
//  a board row or a resume enters one — and rests here again when the last
//  chat closes. It is not a chat: it owns no session, creates nothing on
//  any door (looking, hopping, typing — nothing), and refuses every send
//  with the one sentence that names the door a chat starts through. The
//  face never fronts it — the root REPL yields to the boot menu while the
//  slot rests here — but every reader door still answers, honest and
//  empty, so the screen's chrome (the model chip, the mode readout, the
//  dir row) reads the SCREEN's own facts through the same doors it reads a
//  session's.
//
//  The reader doors answer STABLE identities (the uSES-snapshot law): a
//  getSnapshot that minted a fresh [] or {…} per call re-rendered forever
//  (React error 185). Every constant door shares one frozen value; the
//  value-dependent doors cache per input.
// ============================================================================
import type { Message } from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { getCwd } from '../../utils/cwd.js'
import { seatInitialPermissionMode } from '../../daemon/concourseSupervisor.js'
import type {
  AskReceiptV1,
  CheckpointFactsV1,
  EngineConnectorV1,
  KitDialReceiptV1,
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

/** The one sentence every mutating door answers while no chat is open —
 *  it names the door a chat starts through. */
export const NO_CHAT_OPEN = 'no chat is open — ↵ New Session on the boot menu starts one'

const REFUSED_NO_CHAT: SendReceiptV1 = Object.freeze({ state: 'refused', detail: NO_CHAT_OPEN })
const ASK_REFUSED_NO_CHAT: AskReceiptV1 = Object.freeze({ ok: false, detail: NO_CHAT_OPEN })
const KIT_REFUSED_NO_CHAT: KitDialReceiptV1 = Object.freeze({ outcome: 'refused' as const, detail: NO_CHAT_OPEN })

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
/** No session, no checkpoints: capture reads 'off' (never 'unknown' — there
 *  is no runner to be older than this build). */
const NO_CHECKPOINTS: CheckpointFactsV1 = Object.freeze({ capture: 'off' as const, restorable: Object.freeze(new Set<string>()) as ReadonlySet<string> })
const NOOP_UNSUBSCRIBE = (): void => {}

export class NoSessionConnector implements EngineConnectorV1 {
  /** The sessions this slot ever holds are daemon-hosted; the resting
   *  state reads the same carrier so no reader branches on a third kind. */
  readonly carrier = 'daemon' as const
  private cachedModelFacts: ModelFactsV1 | null = null
  private cachedWorkspace: WorkspaceFactsV1 | null = null

  /** No session — the empty id (no real id is ever empty). */
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
  /** The screen's own main model — what the boot menu's chip shows and
   *  what a birth from this screen runs on. */
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
  /** No chat, no kit to dial — the one refusal sentence. */
  async setKit(): Promise<KitDialReceiptV1> {
    return KIT_REFUSED_NO_CHAT
  }
  /** No chat, no checkpoints and nothing to rewind — the one sentence, typed. */
  checkpointFacts(): CheckpointFactsV1 {
    return NO_CHECKPOINTS
  }
  subscribeCheckpoints(): () => void {
    return NOOP_UNSUBSCRIBE
  }
  async rewind(req: RewindRequestV1): Promise<RewindReceiptV1> {
    return { outcome: 'refused', mode: req.mode, refusal: 'no-chat', detail: NO_CHAT_OPEN }
  }
  /** The posture a session born from this screen boots in — the seat's
   *  own resolution (the operator's saved default, else flow). */
  permissionMode(): PermissionMode {
    return seatInitialPermissionMode() as PermissionMode
  }
  subscribePermissionMode(): () => void {
    return NOOP_UNSUBSCRIBE
  }
  setPermissionMode(): void {}
  /** The screen's ground: the estate's cwd owner, read live (the ground
   *  law moves it; the snapshot identity follows the cwd, never a render). */
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
  /** No session runs nothing — the honest empty, stable by identity. */
  workRoster(): WorkRosterV1 {
    return EMPTY_WORK
  }
  subscribeWork(): () => void {
    return NOOP_UNSUBSCRIBE
  }
}

const EMPTY_ROOTS: readonly string[] = Object.freeze([])

let resting: NoSessionConnector | null = null

/** The one resting connector (process-lifetime; the slot hands it out
 *  whenever no session holds the slot). */
export function noSessionConnector(): NoSessionConnector {
  resting ??= new NoSessionConnector()
  return resting
}
