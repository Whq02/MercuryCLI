// ============================================================================
//  engine-connector/types — THE ENGINE CONNECTOR contract (V1).
//
//  Every session is a full chat; the one on screen is THE FOCUSED CHAT. The
//  cockpit's face — the chat, the composer, the consent card and permission
//  flow, the tool surfaces and worker cards, the readouts, the slash-command
//  dispatch, attachments, esc/interrupt — talks to ONE connector
//  per session and never to an engine or a process global directly. The
//  connector is the whole doorway between the face and a session's engine:
//  a session inside the concourse is a full Mercury instance (parity 1:1 —
//  its own skills roster, its own MCP servers, its own provider/account/
//  model when chosen), so every door here answers PER SESSION.
//
//  Implementations: the daemon-hosted session (daemonConnector.ts) stands
//  behind the doors; while no chat is open the focused slot RESTS on the
//  no-session connector (noSessionConnector.ts — not a chat, never a
//  session: every reader door honest and empty, every send refused with
//  the door a chat starts through). The face renders whatever connector
//  fronts the focused chat and never knows which process carries it.
//
//  Doors (the closed V1 set): send words · the record stream (the engine
//  lane) · the asks (full payload) and their answers · interrupt · get/set
//  the model · usage/cost/context readouts · the account/provider identity ·
//  the skills roster · the MCP roster · the permission mode · the
//  workspace/cwd · dispatch a slash command. (The queue doors died with
//  the operator-facing pen — the steer-removal ruling.)
//
//  Locked by scripts/engine-connector/prove-connector-contract.ts: the door
//  census below is mechanical — adding or removing a door is a deliberate,
//  prover-updating act.
// ============================================================================
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

/** Which engine carries the session behind this connector. */
export type EngineCarrierKind = 'in-process' | 'daemon'

// ── words ───────────────────────────────────────────────────────────────────

export type SendWordsOptions = {
  /** The composer mode the words were typed in ('prompt' | 'bash' | …). */
  mode?: PromptInputMode
  /** Pastes riding the submission (the composer's paste ledger for it). */
  pastedContents?: Record<number, PastedContent>
  /** A keybinding/funnel dispatch, not a typed submission. */
  fromKeybinding?: boolean
}

/** What became of the words: delivered (the session reads them at its next
 *  readable moment — the delivery law), or refused (detail says why in the
 *  door's own sentence). */
export type SendReceiptV1 =
  | { state: 'accepted' }
  | { state: 'refused'; detail: string }

// ── asks ────────────────────────────────────────────────────────────────────

/** A pending ask, FULL payload — everything the consent card renders (the
 *  tool, the description, the input, the offered rules) and the verbs that
 *  settle it. The payload's own verbs (confirm.onAllow/onReject/onAbort) and
 *  the imperative door (answerAsk) settle the SAME entry — one settlement,
 *  whichever hand reaches it. */
export type SessionAskV1 = {
  /** The ask's identity: the asking tool use. */
  id: string
  confirm: ToolUseConfirm
}

/** The full answer an ask takes — never a bare y/n. */
export type AskAnswerV1 =
  | {
      kind: 'allow'
      /** The input as (possibly) edited on the card. */
      updatedInput?: Record<string, unknown>
      /** Always-allow rules the answer carries (the card's offered rule). */
      permissionUpdates?: PermissionUpdate[]
      feedback?: string
      contentBlocks?: ContentBlockParam[]
    }
  | { kind: 'deny'; feedback?: string; contentBlocks?: ContentBlockParam[] }
  | { kind: 'abort' }

export type AskReceiptV1 =
  | { ok: true }
  | { ok: false; detail: string }

// ── model ───────────────────────────────────────────────────────────────────

/** The session's model facts — the wire truth plus what is parked. */
export type ModelFactsV1 = {
  /** The model the session's next call runs (session pin ?? main). */
  effective: string
  /** Where `effective` came from (FN-013 MODEL-02): 'live' — the session's
   *  own read facts; 'record' — its durable admission record (facts not
   *  yet readable); 'ambient' — NEITHER resolved and the value fell back
   *  to THIS process's own model state, which is not the executing
   *  session's fact. Absent reads as 'live' (an in-process session's facts
   *  are its own by construction). A gate that must never act on another
   *  session's state — the transition preview — refuses on 'ambient'. */
  effectiveSource?: 'live' | 'record' | 'ambient'
  /** The configured→default resolution WITHOUT the session pin (quota and
   *  billing lanes read this one). */
  main: string
  /** The stored setting (null = the default rung). */
  setting: ModelSetting
  /** The session pin (/model inside the session), null when none. */
  sessionPin: ModelSetting | null
  /** A parked mid-turn switch (applies at the turn boundary); null when
   *  none is parked. A parked switch TO the default rung carries
   *  `{ setting: null }` — never conflated with "no switch parked". */
  pendingSwitch: { setting: ModelSetting } | null
}

export type ModelSwitchReceiptV1 =
  | { state: 'applied' }
  | { state: 'queued' }
  | { state: 'no-op' }
  | { state: 'refused'; detail: string }

// ── readouts ────────────────────────────────────────────────────────────────

/** The approaching-limit line the session's OWN process derived for the
 *  provider it runs on (services/providers/limitWarning — one grammar,
 *  every family): the runner observes the wire the screen never sees. */
export type LimitWarningFactV1 = {
  provider: string
  text: string
}

/** The session's own numbers — never another session's. */
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
  /** True when any spend crossed a model without a price sheet. */
  hasUnknownModelCost: boolean
  /** Settled turns the session's ledger could not price (no rate on file,
   *  no wire-stated cost) — their tokens are in the totals, their USD is
   *  not in totalCostUSD; a cost readout prints them beside the figure
   *  ("+ 3 unpriced turns") and never a $0.00 that reads as free. ADDITIVE
   *  on the payload: ABSENT = an older runner (the count is unknown). */
  unpricedTurns?: number
  /** The runner's own approaching-limit warning — ADDITIVE on the payload
   *  (no verb, no door): the response headers, the x-codex bands and the
   *  probe refreshes are observed in the SESSION'S process, so only it can
   *  answer; `null` = it sees no warning; ABSENT = an older runner (or the
   *  resting slot), and the screen falls to its own derivation. */
  limitWarning?: LimitWarningFactV1 | null
  /** The OpenAI lane's last-observed usage bands as the SESSION'S process
   *  recorded them from its own response headers (openaiLimitState — this
   *  lane has no polled endpoint, so the runner is the only observer; the
   *  Anthropic windows by contrast are cockpit-polled and need no ride).
   *  ADDITIVE: absent = an older runner or a lane that never spoke; the
   *  screen adopts stated bands by recency and paints nothing otherwise
   *  (the do-not-fake rule — an account whose responses carry no usage
   *  headers renders an honest labeled absence). */
  openaiObserved?: {
    primary?: OpenaiObservedBandV1
    secondary?: OpenaiObservedBandV1
  }
}

/** One provider-stated OpenAI usage band on the facts wire — only what the
 *  source STATED rides (absent ≠ zero, ever); the observation stamp orders
 *  adoptions. */
export type OpenaiObservedBandV1 = {
  usedPct?: number
  windowMinutes?: number
  resetsAtMs?: number
  observedAtMs: number
}

/** The seat's account/provider identity as the face states it. */
export type SeatIdentityV1 = {
  /** First-party API customer (console billing prints the exit cost line). */
  firstPartyApi: boolean
  consoleBilling: boolean
  claudeAiBilling: boolean
  /** The signed-in account's email, null when none is on record. */
  accountEmail: string | null
}

// ── rosters ─────────────────────────────────────────────────────────────────

/** One skill as the session's roster lists it. */
export type SkillsRosterEntryV1 = {
  name: string
  description: string
  /** The tri-state's non-ambient words: 'invocable' — listed and loadable
   *  by /name but excluded from every model-facing listing (the author's
   *  disable-model-invocation, or the session kit's — L24(5)); 'off' — the
   *  kit excluded it from the table entirely (the roster lists
   *  off rows so the session dial has both directions — an off skill can be
   *  dialed back on in THIS session). Absent = ambient. Additive: an older
   *  runner's answer simply lacks it. */
  state?: 'invocable' | 'off'
}

export type SkillsRosterV1 = {
  skills: SkillsRosterEntryV1[]
}

/** One MCP server as the session's roster lists it — a name and its
 *  connection state (the row a session inside the concourse answers from
 *  its own process; no live client object crosses the doorway). */
export type McpRosterEntryV1 = {
  name: string
  type: MCPServerConnection['type']
  /** A failed row's honest reason — the connect deadline's own sentence,
   *  the one the panel's server menu prints; absent on every other state. */
  error?: string
}

export type McpRosterV1 = {
  /** The session's OWN MCP servers (startup + dynamic, deduplicated). */
  clients: readonly McpRosterEntryV1[]
}

// ── the kit dial (ledger L24(3)) ────────────────────────────────────────────

/** The dial's typed receipt — the daemon's adjudication verbatim: applied
 *  (record + live runner, one beat) · queued (mid-turn — "the dials apply
 *  when this turn ends") · noop (the kit already reads so) · refused
 *  (typed detail). */
export type KitDialReceiptV1 = {
  outcome: 'applied' | 'queued' | 'noop' | 'refused'
  detail?: string
}

// ── the spawn switches (services/switchboard/spawnSwitches.ts) ──────────────

/** The toggle's typed receipt — the daemon's adjudication verbatim (the
 *  kit dial's vocabulary): applied (the record and the live runner, at this
 *  boundary) · queued (mid-turn — lands when the turn ends) · noop (already
 *  so) · refused (typed detail). The detail carries the operator's sentence. */
export type SpawnSwitchReceiptV1 = KitDialReceiptV1

/** One agent inside a workflow row — the strip/rail's need (index keeps the
 *  stable per-agent identity hue; state is the runner's own word). */
export type WorkAgentV1 = {
  index: number
  label: string
  state: string
}

/** One phase of a workflow row, grouped by the runner's own projector. */
export type WorkPhaseV1 = {
  title: string
  planned: boolean
  agents: WorkAgentV1[]
}

/** One unit of work as the session's RUNNER tracks it in its own task
 *  store — a workflow run, a dispatched agent, a teammate, a shell, a
 *  monitor, a dream. The row carries render facts only: the recovery
 *  artifacts (script, args) stay on disk in the run's own dir, and the
 *  controllers stay in the runner's process. */
export type WorkRowV1 = {
  id: string
  kind: 'workflow' | 'agent' | 'teammate' | 'shell' | 'monitor' | 'dream'
  name: string
  /** The kind's own status word (running/pending/completed/failed/…,
   *  'paused' for workflows) — the screen words it, never re-derives it. */
  status: string
  startTime: number
  endTime?: number
  description?: string
  /** The model the row runs — for agent rows the SERVED id once a response
   *  landed, the launch's resolved id before. */
  model?: string
  error?: string
  totalTokens?: number
  /** Agent and named-agent rows: the row's own settled responses in the
   *  session ledger's spelling — input counts the cached prefix read and
   *  written; `costUSD` is the USD the pricing owner could price and
   *  `unpricedTurns` the responses it could not (their tokens count above,
   *  their USD is absent — the usage-neutrality law). ADDITIVE on the
   *  wire: absent = an older runner, or a row with no response yet. */
  inputTokens?: number
  outputTokens?: number
  costUSD?: number
  unpricedTurns?: number
  /** Agent and named-agent rows: the tracker's tool-use count and its
   *  latest activity line (the running tool's own description) — the
   *  transcript's agent card paints them. ADDITIVE like the counters. */
  toolUses?: number
  activity?: string
  /** The tool-use id of the launch that registered the row (an Agent tool
   *  call): the transcript's tool card joins its rows to the roster by it.
   *  Absent for a row no tool call minted (a named agent's spawn). */
  toolUseId?: string
  /** Workflow rows: the run identity + the board's list-level facts. */
  workflowRunId?: string
  phases?: WorkPhaseV1[]
  agentCount?: number
  /** Parked permission asks on this row (the board's answer affordance). */
  pendingAsks?: number
  /** Agent rows: the agent's kind word ('general-purpose', …). */
  agentType?: string
  /** Teammate rows: the team the teammate serves on. */
  team?: string
}

/** One row of the session's MISSION ledger (its own task list — the
 *  TaskCreate/TaskUpdate estate, keyed by the session in its runner). */
export type MissionRowV1 = {
  id: string
  subject: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** The session's work roster — what its runner is running (and recently
 *  ran) in its own process, and its mission ledger. The focused chat's
 *  work views render THIS, never a screen-global store (session A's work
 *  must not paint under session B). */
export type WorkRosterV1 = {
  rows: readonly WorkRowV1[]
  mission: readonly MissionRowV1[]
}

// ── workspace ───────────────────────────────────────────────────────────────

export type WorkspaceFactsV1 = {
  /** The session's logical working directory. */
  cwd: string
  /** The directory the session booted in. */
  originalCwd: string
  /** Where the session's project identity is anchored. */
  projectRoot: string
  /** The operator-added instruction roots beyond the workspace (the
   *  /add-dir list, read through the one facade getter). */
  instructionRoots: readonly string[]
}

// ── the /rewind safety net (FN-015 rank 8) ──────────────────────────────────

/**
 * The runner's checkpoint truth, read from its facts: whether it captures
 * per-turn file checkpoints and which user messages carry a saved point.
 * 'unknown' is an older runner's facts (never read as 'on'). Stable identity
 * per facts read (the uSES-snapshot law).
 */
export type CheckpointFactsV1 = {
  capture: 'on' | 'off' | 'unknown'
  restorable: ReadonlySet<string>
}

export type RewindRequestV1 = {
  /** The restore point — a user message's uuid (snapshots are taken there). */
  userMessageId: string
  mode: SessionRewindMode
  /** Report what a code restore would touch; write and append nothing. */
  dryRun?: boolean
}

/** The runner's own receipt as the daemon relayed it — or the cockpit's own
 *  typed refusal (no chat open, an older daemon, a daemon not answering).
 *  A refusal always names its kind; the surface paints the sentence. */
export type RewindReceiptV1 = SessionRewindOutcomeV1

// ── the connector ───────────────────────────────────────────────────────────

/**
 * ONE connector per session. Subscriptions follow the store contract
 * (subscribe returns unsubscribe; listeners pull through the snapshot
 * doors), so any face component can ride useSyncExternalStore on any door.
 */
export interface EngineConnectorV1 {
  /** Which engine carries this session. */
  readonly carrier: EngineCarrierKind

  /** The session's identity. */
  sessionId(): string

  // ── send words ──
  /** The words the operator sent from the composer land in THIS session,
   *  turn in flight or not — delivered instantly, read at the session's
   *  next readable moment, exactly once (the delivery law). */
  sendWords(text: string, opts?: SendWordsOptions): Promise<SendReceiptV1>
  /** The delivery door's ADDRESSED form: a note to one agent RUNNING
   *  INSIDE this session's runner (a workbench/folio reply). Same identity
   *  and exactly-once laws as sendWords — the same dispatch wire, the same
   *  frame identity, the runner's scoped drain folds it into that agent's
   *  own next turn. Not operator-transcript content: no echo row paints
   *  (the note lands in the agent's thread, not the chat). */
  sendAgentNote(agentId: string, text: string): Promise<SendReceiptV1>

  // ── the record stream (the engine lane) ──
  /** Always-current snapshot of the session's records. */
  records(): readonly Message[]
  subscribeRecords(listener: () => void): () => void
  /** A turn is in flight in this session. */
  turnActive(): boolean

  // ── asks ──
  asks(): readonly SessionAskV1[]
  subscribeAsks(listener: () => void): () => void
  /** Answer a pending ask with the full payload. */
  answerAsk(askId: string, answer: AskAnswerV1): Promise<AskReceiptV1>
  /** Retire a settled ask (the card answered through the payload's own
   *  verbs; this removes the entry those verbs already settled). */
  settleAsk(askId: string): void

  // ── interrupt ──
  /** Interrupt the session's turn (esc). True when something was running. */
  interrupt(): boolean

  // ── the model ──
  modelFacts(): ModelFactsV1
  subscribeModel(listener: () => void): () => void
  /** Switch THIS session's model, in place, from its next message. The
   *  receipt is the settlement owner's own word — applied, queued, no-op or
   *  refused come from the authority that decided them, never from the
   *  caller's guess (FN-015 rank 50). */
  setModel(setting: ModelSetting): Promise<ModelSwitchReceiptV1>

  // ── readouts ──
  usage(): UsageFactsV1
  identity(): SeatIdentityV1

  // ── rosters ──
  skillsRoster(): SkillsRosterV1
  mcpRoster(): McpRosterV1

  // ── the session's kit dials (ledger L24(3)) ──
  /** Dial THIS session's kit — /mcp enable|disable and the /skills
   *  tri-state ride this one verb (the setPermissionMode/setModel family):
   *  the record's one writer applies the edit and the live runner obeys the
   *  same beat; a mid-turn dial queues for the turn's end and the receipt
   *  says so honestly. Never the menu record, never a config file, never a
   *  sibling — the session owns its dials. */
  setKit(edit: SessionKitEditV1): Promise<KitDialReceiptV1>

  // ── the spawn switches (services/switchboard/spawnSwitches.ts) ──
  /** THIS session's sub-agents and workflows switches, with their sources
   *  (the boot menu's Agents rows at birth · the in-session toggle · the
   *  environment · the default). Absent facts read as both on. */
  spawnSwitches(): SpawnSwitchFacts
  /** Flip one switch for THIS session — /subagents on|off, /workflows
   *  on|off and the boot menu opened in-session ride this one verb: the
   *  daemon lands it on the record and the live runner obeys at the next
   *  turn boundary (a mid-turn toggle queues for the turn's end; a spawn
   *  already running finishes). The receipt is the settlement owner's word. */
  setSpawnSwitch(kind: SpawnSwitchKind, on: boolean): Promise<SpawnSwitchReceiptV1>

  // ── the /rewind safety net (FN-015 rank 8) ──
  /** The runner's checkpoint truth (its facts) — the surface offers a code
   *  restore only where a saved point exists. */
  checkpointFacts(): CheckpointFactsV1
  subscribeCheckpoints(listener: () => void): () => void
  /** Ask THIS session's runner to restore its files to the checkpoint at a
   *  user message, wind its conversation back to that turn boundary, or
   *  both — the typed receipt names what landed or why not; a dry run
   *  writes nothing. The cockpit never performs a restore itself: the
   *  process that captured the checkpoints and owns the conversation does. */
  rewind(req: RewindRequestV1): Promise<RewindReceiptV1>

  // ── the work roster (the session's runner's own tasks) ──
  workRoster(): WorkRosterV1
  subscribeWork(listener: () => void): () => void

  // ── the permission mode ──
  permissionMode(): PermissionMode
  subscribePermissionMode(listener: () => void): () => void
  setPermissionMode(mode: PermissionMode): void

  // ── the workspace ──
  workspace(): WorkspaceFactsV1

  // ── slash commands ──
  /** Dispatch a slash line ("/model opus", "/clear") against THIS session. */
  dispatchSlash(line: string): Promise<SendReceiptV1>

  // (The queue doors died with the operator-facing holding pen — the
  // steer-removal ruling: a sent message is delivered instantly and read
  // at the session's next readable moment, exactly once. The engine-side
  // transport that carries words to that moment is invisible plumbing in
  // the session's own runner; no cockpit surface holds, edits, restages,
  // or pulls back a sent message.)
}
