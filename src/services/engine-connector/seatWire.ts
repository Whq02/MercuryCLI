import type { SessionRewindOutcomeV1 } from '../../daemon/protocol.js'
import type { SessionKitV1 } from '../../daemon/sessionKit.js'
import type { SaturnFactsRowV1, ScheduleOpRequestV1 } from '../../daemon/saturn.js'
import type { SessionFactsAnswerV1 } from './seatProjections.js'

type KeyTable = Readonly<Record<string, string>>
type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value)

function flip(table: KeyTable): KeyTable {
  const out: Record<string, string> = {}
  for (const [key, wire] of Object.entries(table)) out[wire] = key
  return out
}

function renamed(value: Row, table: KeyTable): Row {
  const out: Row = {}
  for (const [key, inner] of Object.entries(value)) out[table[key] ?? key] = inner
  return out
}

function row(value: unknown, table: KeyTable, nested?: (out: Row) => void): unknown {
  if (!isRow(value)) return value
  const out = renamed(value, table)
  nested?.(out)
  return out
}

function rows(value: unknown, table: KeyTable, nested?: (out: Row) => void): unknown {
  return Array.isArray(value) ? value.map(item => row(item, table, nested)) : value
}

const USAGE: KeyTable = {
  totalCostUSD: 'total_cost_usd',
  totalAPIDurationMs: 'total_api_duration_ms',
  totalDurationMs: 'total_duration_ms',
  totalLinesAdded: 'total_lines_added',
  totalLinesRemoved: 'total_lines_removed',
  totalInputTokens: 'total_input_tokens',
  totalOutputTokens: 'total_output_tokens',
  totalCacheReadInputTokens: 'total_cache_read_input_tokens',
  totalCacheCreationInputTokens: 'total_cache_creation_input_tokens',
  hasUnknownModelCost: 'has_unknown_model_cost',
  unpricedTurns: 'unpriced_turns',
  limitWarning: 'limit_warning',
  openaiObserved: 'openai_observed',
}
const BAND: KeyTable = {
  usedPct: 'used_pct',
  windowMinutes: 'window_minutes',
  resetsAtMs: 'resets_at_ms',
  observedAtMs: 'observed_at_ms',
}
const IDENTITY: KeyTable = {
  firstPartyApi: 'first_party_api',
  consoleBilling: 'console_billing',
  claudeAiBilling: 'claude_ai_billing',
  accountEmail: 'account_email',
}
const WORKSPACE: KeyTable = {
  originalCwd: 'original_cwd',
  projectRoot: 'project_root',
  instructionRoots: 'instruction_roots',
}
const WORK_ROW: KeyTable = {
  startTime: 'start_time',
  endTime: 'end_time',
  totalTokens: 'total_tokens',
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  contextTokens: 'context_tokens',
  costUSD: 'cost_usd',
  unpricedTurns: 'unpriced_turns',
  toolUses: 'tool_uses',
  toolUseId: 'tool_use_id',
  workflowRunId: 'workflow_run_id',
  agentCount: 'agent_count',
  pendingAsks: 'pending_asks',
  pausedBy: 'paused_by',
  agentType: 'agent_type',
  stopReason: 'stop_reason',
}
const WORK_PULSE: KeyTable = {
  phaseTitle: 'phase_title',
  maxAttempt: 'max_attempt',
  lastEventAt: 'last_event_at',
}
const AGENT_WAIT: KeyTable = {
  sinceMs: 'since_ms',
  budgetMs: 'budget_ms',
  streamedChars: 'streamed_chars',
}
const AGENT_PAUSE: KeyTable = {
  resumesAtMs: 'resumes_at_ms',
}
const MISSION_ROW: KeyTable = {
  blockedBy: 'blocked_by',
  activeForm: 'active_form',
}
const KIT: KeyTable = {
  skillsOff: 'skills_off',
}
const KIT_DELTAS: KeyTable = {
  mcpOff: 'mcp_off',
  skillStates: 'skill_states',
  extensionsOff: 'extensions_off',
}
const SCHEDULE_ROW: KeyTable = {
  nextFireMs: 'next_fire_ms',
}
const SCHEDULE_EDIT: KeyTable = {
  scheduleId: 'schedule_id',
}
const SUBMISSION: KeyTable = {
  modelKey: 'model_key',
}
const WHEN: KeyTable = {
  atMs: 'at_ms',
}
const ACTION: KeyTable = {
  onParked: 'on_parked',
}
const BIRTH: KeyTable = {
  workspaceDir: 'workspace_dir',
  modelKey: 'model_key',
  kitPreset: 'kit_preset',
}
const REWIND: KeyTable = {
  dryRun: 'dry_run',
}
const REWIND_CODE: KeyTable = {
  filesChanged: 'files_changed',
}
const REWIND_CONVERSATION: KeyTable = {
  turnUuid: 'turn_uuid',
}
const CATALOGUE: KeyTable = {
  sourceKind: 'source_kind',
  fetchedAtMs: 'fetched_at_ms',
}
const FACTS: KeyTable = {
  permissionMode: 'permission_mode',
  effortSent: 'effort_sent',
  pendingScheduleEdits: 'pending_schedule_edits',
  fileCheckpoints: 'file_checkpoints',
  streamIdleTimeoutMs: 'stream_idle_timeout_ms',
  spawnSwitches: 'spawn_switches',
}

function usageNested(table: KeyTable, bandTable: KeyTable, observedKey: string): (out: Row) => void {
  return out => {
    const observed = out[observedKey]
    if (isRow(observed)) {
      out[observedKey] = {
        ...observed,
        ...(isRow(observed.primary) ? { primary: renamed(observed.primary, bandTable) } : {}),
        ...(isRow(observed.secondary) ? { secondary: renamed(observed.secondary, bandTable) } : {}),
      }
    }
    void table
  }
}

function workRowNested(pulseTable: KeyTable, waitTable: KeyTable, pauseTable: KeyTable): (out: Row) => void {
  return out => {
    if (isRow(out.pulse)) out.pulse = renamed(out.pulse, pulseTable)
    if (isRow(out.phase)) out.phase = renamed(out.phase, waitTable)
    if (isRow(out.paused)) out.paused = renamed(out.paused, pauseTable)
  }
}

function kitNested(deltasTable: KeyTable): (out: Row) => void {
  return out => {
    if (isRow(out.deltas)) out.deltas = renamed(out.deltas, deltasTable)
  }
}

function scheduleEditNested(submission: KeyTable, when: KeyTable, action: KeyTable, birth: KeyTable): (out: Row) => void {
  return out => {
    if (!isRow(out.schedule)) return
    const sub = renamed(out.schedule, submission)
    if (isRow(sub.when)) sub.when = renamed(sub.when, when)
    if (isRow(sub.action)) {
      const act = renamed(sub.action, action)
      if (isRow(act.birth)) act.birth = renamed(act.birth, birth)
      sub.action = act
    }
    out.schedule = sub
  }
}

function rewindNested(code: KeyTable, conversation: KeyTable): (out: Row) => void {
  return out => {
    if (isRow(out.code)) out.code = renamed(out.code, code)
    if (isRow(out.conversation)) out.conversation = renamed(out.conversation, conversation)
  }
}

function factsNested(direction: 'to' | 'from'): (out: Row) => void {
  const t = (table: KeyTable): KeyTable => (direction === 'to' ? table : flip(table))
  const workKey = 'work'
  const missionKey = 'mission'
  const kitKey = 'kit'
  const editsKey = direction === 'to' ? 'pending_schedule_edits' : 'pendingScheduleEdits'
  const observedKey = direction === 'to' ? 'openai_observed' : 'openaiObserved'
  return out => {
    out.usage = row(out.usage, t(USAGE), usageNested(t(USAGE), t(BAND), observedKey))
    out.identity = row(out.identity, t(IDENTITY))
    out.workspace = row(out.workspace, t(WORKSPACE))
    if (workKey in out) out[workKey] = rows(out[workKey], t(WORK_ROW), workRowNested(t(WORK_PULSE), t(AGENT_WAIT), t(AGENT_PAUSE)))
    if (missionKey in out) out[missionKey] = rows(out[missionKey], t(MISSION_ROW))
    if (kitKey in out) out[kitKey] = row(out[kitKey], t(KIT), kitNested(t(KIT_DELTAS)))
    if (editsKey in out) out[editsKey] = rows(out[editsKey], t(SCHEDULE_EDIT), scheduleEditNested(t(SUBMISSION), t(WHEN), t(ACTION), t(BIRTH)))
  }
}

export function sessionFactsToWire(answer: SessionFactsAnswerV1): Record<string, unknown> {
  return row(answer, FACTS, factsNested('to')) as Record<string, unknown>
}

export function sessionFactsFromWire(raw: unknown): SessionFactsAnswerV1 | null {
  if (!isRow(raw)) return null
  const model = raw.model
  const usage = raw.usage
  const workspace = raw.workspace
  if (
    !isRow(model) ||
    typeof model.effective !== 'string' ||
    !isRow(usage) ||
    typeof usage.total_cost_usd !== 'number' ||
    !Array.isArray(raw.skills) ||
    !Array.isArray(raw.mcp) ||
    typeof raw.permission_mode !== 'string' ||
    !isRow(workspace) ||
    !Array.isArray(raw.queue)
  ) {
    return null
  }
  return row(raw, flip(FACTS), factsNested('from')) as SessionFactsAnswerV1
}

export function rewindOutcomeToWire(outcome: SessionRewindOutcomeV1): Record<string, unknown> {
  return row(outcome, REWIND, rewindNested(REWIND_CODE, REWIND_CONVERSATION)) as Record<string, unknown>
}

export function rewindOutcomeFromWire(raw: unknown): SessionRewindOutcomeV1 | null {
  if (!isRow(raw)) return null
  const outcome = raw.outcome
  const mode = raw.mode
  if (outcome !== 'applied' && outcome !== 'refused' && outcome !== 'noop') return null
  if (mode !== 'code' && mode !== 'conversation' && mode !== 'both') return null
  return row(raw, flip(REWIND), rewindNested(flip(REWIND_CODE), flip(REWIND_CONVERSATION))) as SessionRewindOutcomeV1
}

export function sessionKitToWire(kit: SessionKitV1): Record<string, unknown> {
  return row(kit, KIT, kitNested(KIT_DELTAS)) as Record<string, unknown>
}

export function sessionKitFromWire(raw: unknown): unknown {
  return row(raw, flip(KIT), kitNested(flip(KIT_DELTAS)))
}

export function scheduleRosterToWire(schedules: readonly SaturnFactsRowV1[]): Record<string, unknown>[] {
  return rows(schedules, SCHEDULE_ROW) as Record<string, unknown>[]
}

export function scheduleRosterFromWire(raw: unknown): unknown {
  return rows(raw, flip(SCHEDULE_ROW))
}

export function scheduleEditToWire(edit: ScheduleOpRequestV1): Record<string, unknown> {
  return row(edit, SCHEDULE_EDIT, scheduleEditNested(SUBMISSION, WHEN, ACTION, BIRTH)) as Record<string, unknown>
}

export function openaiCatalogueToWire(catalogue: { sourceKind: string; models: unknown[]; fetchedAtMs: number }): Record<string, unknown> {
  return renamed(catalogue, CATALOGUE)
}

export function openaiCatalogueFromWire(raw: unknown): unknown {
  return row(raw, flip(CATALOGUE))
}
