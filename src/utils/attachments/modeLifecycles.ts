// Mode lifecycles — the plan/auto/supercode standing-reminder state machines
// (turn-counted full/sparse cadence, exit-once semantics), the per-turn
// deepthink/supercode keyword opt-ins (with the skipSkillDiscovery
// non-user-intent guard), the date-change signal (cache-prefix-preserving),
// and the fast-onboarding surface map.

import type { Message } from 'src/types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { getApolloModeSections } from '../../prompt/apolloMode.js'
import { getAutopilotModeSections } from '../autopilot/autopilotPrompt.js'
import {
  getIsNonInteractiveSession,
  getLastEmittedDate,
  getOriginalCwd,
  hasEnteredPlanModeThisSession,
  hasExitedPlanModeInSession,
  needsAutoModeExitAttachment,
  needsPlanModeExitAttachment,
  setHasExitedPlanMode,
  setLastEmittedDate,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from '../../bootstrap/state.js'
import { getLocalISODate } from '../../constants/common.js'
import { queuedDeepthinkRequested } from '../../run-core/attachment-drain.js'
import { hasSupercodeKeyword } from '../keywordTrigger/supercode.js'
import { getPlan, getPlanFilePath } from '../plans.js'
import {
  buildRepoSurfaceMap,
  hasOrientationDoc,
  repoSurfaceMapEnabled,
} from '../cockpit/repoSurfaceMap.js'
import { hasDeepthinkKeyword, isDeepthinkEnabled } from '../thinking.js'
import type { QueuedCommand } from 'src/types/textInputTypes.js'
import { hasToolResultContent } from './shared.js'
import {
  AUTO_MODE_ATTACHMENT_CONFIG,
  PLAN_MODE_ATTACHMENT_CONFIG,
  type Attachment,
} from './types.js'

const autoModeStateModule: typeof import('../permissions/autoModeState.js') | null = null

function getPlanModeAttachmentTurnCount(messages: Message[]): {
  turnCount: number
  foundPlanModeAttachment: boolean
} {
  let turnsSinceLastAttachment = 0
  let foundPlanModeAttachment = false

  // Newest-first, counting HUMAN turns only (non-meta, non-tool-result user
  // messages). Assistant messages are the wrong unit here: the tool loop
  // re-collects attachments every round, so an assistant-counted cadence of
  // "every 5" would really mean every 5 tool calls.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !hasToolResultContent(message.message.content)
    ) {
      turnsSinceLastAttachment++
    } else if (
      message?.type === 'attachment' &&
      (message.attachment.type === 'plan_mode' ||
        message.attachment.type === 'plan_mode_reentry')
    ) {
      foundPlanModeAttachment = true
      break
    }
  }

  return { turnCount: turnsSinceLastAttachment, foundPlanModeAttachment }
}

/**
 * plan_mode attachments since the last exit marker — the counter the
 * full/sparse cycle runs on, so re-entering strategy mode restarts the
 * cycle at "full".
 */
function countPlanModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'plan_mode_exit') {
        break
      }
      if (message.attachment.type === 'plan_mode') {
        count++
      }
    }
  }
  return count
}

export async function getPlanModeAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const permissionContext = appState.toolPermissionContext
  if (permissionContext.mode !== 'strategy') {
    return []
  }

  // The cadence throttle applies only once a first reminder exists — the
  // first strategy-mode turn always attaches.
  if (messages && messages.length > 0) {
    const { turnCount, foundPlanModeAttachment } =
      getPlanModeAttachmentTurnCount(messages)
    if (
      foundPlanModeAttachment &&
      turnCount < PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }
  }

  const planFilePath = getPlanFilePath(toolUseContext.agentId)
  const existingPlan = getPlan(toolUseContext.agentId)

  const attachments: Attachment[] = []

  // Re-entry guidance fires once: the session exited strategy mode before
  // AND a plan file survives from that pass.
  if (hasExitedPlanModeInSession() && existingPlan !== null) {
    attachments.push({ type: 'plan_mode_reentry', planFilePath })
    setHasExitedPlanMode(false)
  }

  // The cycle: attachment 1 is full, then sparse until the count wraps
  // (1st, 6th, 11th… full under the every-N config).
  const attachmentCount =
    countPlanModeAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse'

  attachments.push({
    type: 'plan_mode',
    reminderType,
    isSubAgent: !!toolUseContext.agentId,
    planFilePath,
    planExists: existingPlan !== null,
  })

  return attachments
}

/**
 * The one-shot strategy-mode exit notice. Armed by the mode transition,
 * disarmed on first fire (or on discovering the session is back in
 * strategy mode before it fired).
 */
export async function getPlanModeExitAttachment(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!needsPlanModeExitAttachment()) {
    return []
  }

  const appState = toolUseContext.getAppState()
  if (appState.toolPermissionContext.mode === 'strategy') {
    setNeedsPlanModeExitAttachment(false)
    return []
  }

  setNeedsPlanModeExitAttachment(false)

  const planFilePath = getPlanFilePath(toolUseContext.agentId)
  const planExists = getPlan(toolUseContext.agentId) !== null

  //  (NEW-2): validate the REFERENT before injecting — the
  // one-shot fires only for a session that actually entered strategy mode, or
  // when a real plan exists (a mid-plan resume that then exits). A cold
  // process replaying a stale persisted mode at boot injects NOTHING (the
  // field ghost: "Exited Strategy Mode" in a fresh session with no plan).
  if (!hasEnteredPlanModeThisSession() && !planExists) {
    return []
  }

  // Deliberately NO skill discovery here: relevant skills belong in
  // context DURING planning, and the moment that earns them is the
  // user_message that asked for the plan — which already fired the
  // signal. Firing again at exit would arrive after the plan is written.
  return [{ type: 'plan_mode_exit', planFilePath, planExists }]
}

function getAutoModeAttachmentTurnCount(messages: Message[]): {
  turnCount: number
  foundAutoModeAttachment: boolean
} {
  let turnsSinceLastAttachment = 0
  let foundAutoModeAttachment = false

  // Human-turn counting again, and here it matters most: flow exists for
  // long agentic stretches, where one human turn can carry a hundred tool
  // rounds — assistant-counted, that was ~20 reminders per turn and
  // 60-105 per session.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !hasToolResultContent(message.message.content)
    ) {
      turnsSinceLastAttachment++
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'auto_mode'
    ) {
      foundAutoModeAttachment = true
      break
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'auto_mode_exit'
    ) {
      // An exit marker resets the cadence: the next entry starts fresh.
      break
    }
  }

  return { turnCount: turnsSinceLastAttachment, foundAutoModeAttachment }
}

/**
 * auto_mode attachments since the last exit marker — flow's counterpart of
 * the plan-mode cycle counter.
 */
function countAutoModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'auto_mode_exit') {
        break
      }
      if (message.attachment.type === 'auto_mode') {
        count++
      }
    }
  }
  return count
}

export async function getAutoModeAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const permissionContext = appState.toolPermissionContext
  const inAuto = permissionContext.mode === 'flow'
  const inPlanWithAuto =
    permissionContext.mode === 'strategy' &&
    (autoModeStateModule?.isAutoModeActive() ?? false)
  if (!inAuto && !inPlanWithAuto) {
    return []
  }

  // First flow turn always attaches; the throttle needs a predecessor.
  if (messages && messages.length > 0) {
    const { turnCount, foundAutoModeAttachment } =
      getAutoModeAttachmentTurnCount(messages)
    if (
      foundAutoModeAttachment &&
      turnCount < AUTO_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }
  }

  // Same full-then-sparse wrap as the plan cycle.
  const attachmentCount =
    countAutoModeAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      AUTO_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse'

  return [{ type: 'auto_mode', reminderType }]
}

/**
 * The one-shot flow exit notice — armed by the transition, disarmed on
 * fire or on discovering flow is still effectively active.
 */
export async function getAutoModeExitAttachment(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!needsAutoModeExitAttachment()) {
    return []
  }

  const appState = toolUseContext.getAppState()
  // Suppress when flow is still active — covers both mode==='flow' and
  // strategy-with-flow-active (where mode==='strategy' but classifier runs).
  if (
    appState.toolPermissionContext.mode === 'flow' ||
    (autoModeStateModule?.isAutoModeActive() ?? false)
  ) {
    setNeedsAutoModeExitAttachment(false)
    return []
  }

  setNeedsAutoModeExitAttachment(false)
  return [{ type: 'auto_mode_exit' }]
}

// ── Supercode MODE standing reminder (fork) ────────────────────────────────
// Mirrors the auto_mode lifecycle structurally: while AppState.supercode is on,
// emit an ultra_effort reminder (full first, sparse on the throttled cadence);
// when it flips off, emit ultra_effort_exit once. Stateless — derived from the
// message history (attachment counting), exactly like auto_mode. Mercury-only.

function getUltraEffortAttachmentTurnCount(messages: Message[]): {
  turnCount: number
  foundUltraEffortAttachment: boolean
} {
  let turnsSinceLastAttachment = 0
  let foundUltraEffortAttachment = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !hasToolResultContent(message.message.content)
    ) {
      turnsSinceLastAttachment++
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'ultra_effort'
    ) {
      foundUltraEffortAttachment = true
      break
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'ultra_effort_exit'
    ) {
      break
    }
  }
  return { turnCount: turnsSinceLastAttachment, foundUltraEffortAttachment }
}

function countUltraEffortAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'ultra_effort_exit') break
      if (message.attachment.type === 'ultra_effort') count++
    }
  }
  return count
}

/** Fast onboarding (MERCURY_ONBOARDING): inject the auto-derived repo surface
 *  map ONCE per session — main thread, interactive, first turn, and only when
 *  the repo has no orientation doc — MERCURY.md, AGENTS.md or CLAUDE.md (a
 *  mapped repo already orients). The scan is
 *  bounded (~4000 entries / depth 5, <100ms) and structure-only by
 *  construction, so there is no content to leak. */
export function getRepoSurfaceMapAttachment(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Attachment[] {
  if (!repoSurfaceMapEnabled()) return []
  if (toolUseContext.agentId) return [] // main thread only
  // Interactive only (the headless-brief-leak rule: default-ON injections
  // gate OFF in -p/SDK — a headless caller opts in explicitly via /orient).
  if (getIsNonInteractiveSession()) return []
  // The cheap gate FIRST (hot-path cadence C3b): in a repo with a guide the
  // full-transcript scan below was paid every collection and then discarded.
  const root = getOriginalCwd()
  if (hasOrientationDoc(root)) return []
  // Once per session: any prior injection (visible in the transcript) wins.
  if (messages && messages.length > 0) {
    for (const m of messages) {
      if (m.type === 'attachment' && m.attachment.type === 'repo_surface_map') return []
    }
  }
  const markdown = buildRepoSurfaceMap(root)
  if (!markdown) return []
  return [{ type: 'repo_surface_map', markdown }]
}

export function getUltraEffortAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Attachment[] {
  
  if (toolUseContext.getAppState().supercode !== true) return []

  // Throttle after the first reminder (same cadence as auto_mode).
  if (messages && messages.length > 0) {
    const { turnCount, foundUltraEffortAttachment } =
      getUltraEffortAttachmentTurnCount(messages)
    if (
      foundUltraEffortAttachment &&
      turnCount < AUTO_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }
  }

  const attachmentCount =
    countUltraEffortAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      AUTO_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse'

  return [{ type: 'ultra_effort', reminderType }]
}

export function getUltraEffortExitAttachment(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Attachment[] {
  
  // Still on → nothing to announce.
  if (toolUseContext.getAppState().supercode === true) return []
  if (!messages || messages.length === 0) return []
  // Exit fires once: only if an ultra_effort reminder is still "open" (no exit
  // since the last enter) in the recent history.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'ultra_effort_exit') return []
      if (message.attachment.type === 'ultra_effort') {
        return [{ type: 'ultra_effort_exit' }]
      }
    }
  }
  return []
}

// ── Supercode KEYWORD opt-in (fork, per-turn) ───────────────────────────────
// A triggerable `supercode` in the SUBMITTED prompt is an explicit ONE-TURN
// opt-in to dynamic workflow orchestration (the keyword's confirming
// system-reminder, which the Workflow tool prompt tells the model to expect).
// No throttle/lifecycle — fires exactly on the turn whose input carries the
// keyword (the getDeepthinkEffortAttachment shape). Suppressed while the
// standing MODE is on (ultra_effort already carries the doctrine) and when the
// workflow stack or the keyword trigger is disabled. Lazy require: the
// workflowEnablement module pulls settings/auth/featureGates — kept off this
// module's import graph the same way the other
// lazy gates do it.
export function getSupercodeKeywordAttachment(
  input: string | null,
  toolUseContext: ToolUseContext,
  options?: { skipSkillDiscovery?: boolean },
): Attachment[] {
  
  // skipSkillDiscovery marks `input` as expanded SKILL.md/meta content, NOT
  // user intent (processSlashCommand) — a skill body containing the bare word
  // must never grant the cost opt-in.
  if (options?.skipSkillDiscovery) return []
  if (!input || !hasSupercodeKeyword(input)) return []
  if (toolUseContext.getAppState().supercode === true) return []
  const enablement =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../tools/WorkflowTool/workflowEnablement.js') as typeof import('../../tools/WorkflowTool/workflowEnablement.js')
  if (
    !enablement.dynamicWorkflowsEnabled() ||
    !enablement.workflowKeywordTriggerEnabled()
  ) {
    return []
  }
  return [{ type: 'supercode_keyword' }]
}

/**
 * The midnight signal: when the local date ticks over between turns, a
 * date_change attachment tells the model — appended at the TAIL, never by
 * touching messages[0]. The stale date in the prepended user context stays
 * stale on purpose: regenerating that prefix would flip the whole
 * conversation to cache_creation on the next turn (~920K effective tokens
 * per midnight crossing in an overnight session).
 *
 * Exported so the test that guards against re-adding the cache clear can
 * call it directly.
 */
export function getDateChangeAttachments(
  messages: Message[] | undefined,
): Attachment[] {
  const currentDate = getLocalISODate()
  const lastDate = getLastEmittedDate()

  if (lastDate === null) {
    // Nothing to compare against yet — record and stay silent.
    setLastEmittedDate(currentDate)
    return []
  }

  if (currentDate === lastDate) {
    return []
  }

  setLastEmittedDate(currentDate)

  return [{ type: 'date_change', newDate: currentDate }]
}

export function getDeepthinkEffortAttachment(
  input: string | null,
  _toolUseContext: ToolUseContext,
  options?: { skipSkillDiscovery?: boolean },
  queuedCommands?: QueuedCommand[],
): Attachment[] {
  // Same non-user-intent guard as getSupercodeKeywordAttachment: an expanded
  // SKILL.md body containing "deepthink" must not trigger the nudge.
  if (options?.skipSkillDiscovery) return []
  if (!isDeepthinkEnabled()) return []
  // A drained queued prompt is user text arriving THIS turn — the submission
  // scan never sees it (input is null on the drain pass), so the queued
  // snapshot is scanned on its PRE-expansion text (the ultraplan paste
  // guard: expanded file/skill content must not trigger).
  const keywordPresent =
    (!!input && hasDeepthinkKeyword(input)) ||
    queuedDeepthinkRequested(queuedCommands ?? [], hasDeepthinkKeyword)
  if (!keywordPresent) return []
  // ALIGNED: the keyword is a turn-scoped PROSE nudge
  // — no effort, budget, or wire change. Contract + research citations:
  // src/utils/effort.ts (DEEPTHINK block).
  return [{ type: 'deepthink_effort' }]
}

// ── the mode packs (apollo, autopilot) ───────────────────────────────────────
//
// A mode pack is behavioural guidance the operator's mode change asks for.
// It never composes into the top-level system prompt — that is part of the
// prefix every thinking block is bound to, and a mode change would rewrite
// it — so it rides the conversation as a persisted row: the pack on entry
// (its bytes captured then, replayed unchanged), an exit row on leaving.
// Main thread only (the ruled main-agent-only law for the packs).

function latestModePack(messages: readonly Message[]): 'apollo' | 'autopilot' | null {
  let current: 'apollo' | 'autopilot' | null = null
  for (const message of messages) {
    if (message.type !== 'attachment') continue
    if (message.attachment.type === 'mode_pack') current = message.attachment.mode
    else if (message.attachment.type === 'mode_pack_exit') current = null
  }
  return current
}

export function getModePackAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Attachment[] {
  if (toolUseContext.agentId) return []
  const mode = toolUseContext.getAppState().toolPermissionContext.mode
  const wanted: 'apollo' | 'autopilot' | null = mode === 'apollo' || mode === 'autopilot' ? mode : null
  const current = latestModePack(messages ?? [])
  if (wanted === current) return []
  const out: Attachment[] = []
  if (current !== null) out.push({ type: 'mode_pack_exit', mode: current })
  if (wanted !== null) {
    const sections =
      wanted === 'apollo' ? getApolloModeSections('apollo') : getAutopilotModeSections('autopilot')
    // A pack that renders nothing (autopilot with its gate off) emits no row.
    if (sections.length > 0) out.push({ type: 'mode_pack', mode: wanted, text: sections.join('\n\n') })
  }
  return out
}
