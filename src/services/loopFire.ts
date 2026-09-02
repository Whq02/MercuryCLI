// =============================================================================
// services / loopFire.ts — sentinel expansion for the `/loop` subsystem.
// -----------------------------------------------------------------------------
// The /loop skill never stores its full per-tick instructions in the scheduled
// prompt. It stores one of four short SENTINEL strings (in a ScheduleWakeup
// prompt for dynamic pacing, or a recurring-cron prompt for fixed pacing), and
// the resolvers here expand that sentinel at fire time:
//
//   • FIRST delivery of a chain (or a fire after loop.md changed) expands to
//     the full instructions — preamble and/or loop.md body plus the tick text.
//   • Subsequent unchanged fires expand to a short reminder that refers back
//     to the earlier message. Keeping the long text in the already-delivered
//     prefix means it is cached, not reflowed into every tick.
//
// Enablement is default-on, with per-gate env opt-outs (=0); the registered
// MERCURY spellings are the only ones decoded.
// =============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getProjectRoot } from '../bootstrap/state.js'
import { MONITOR_TOOL_NAME } from '../tools/MonitorTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../tools/TaskListTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../tools/TaskStopTool/prompt.js'
import { SCHEDULE_WAKEUP_TOOL_NAME } from '../tools/ScheduleWakeupTool/prompt.js'
import { getMercuryHome, isEnvTruthy } from '../utils/envUtils.js'
import { isENOENT } from '../utils/errors.js'
import { flagEnv } from '../substrate/flagRegistry.js'

// =============================================================================
// SENTINELS — the literal strings the /loop skill schedules. They persist
// inside cron/wakeup prompts, so their exact bytes are a compatibility
// surface. Two axes: task source (a loop.md file vs the autonomous default)
// and pacing (a recurring cron vs self-paced ScheduleWakeup rescheduling).
// =============================================================================

/** Tasks come from loop.md; a recurring cron drives the beat. */
export const LOOP_FILE_SENTINEL = '<<loop.md>>' as const
/** Tasks come from loop.md; each tick reschedules itself via ScheduleWakeup. */
export const LOOP_FILE_DYNAMIC_SENTINEL = '<<loop.md-dynamic>>' as const
/** Autonomous default; a recurring cron drives the beat. */
export const AUTONOMOUS_LOOP_SENTINEL = '<<autonomous-loop>>' as const
/** Autonomous default; each tick reschedules itself via ScheduleWakeup. */
export const AUTONOMOUS_LOOP_DYNAMIC_SENTINEL = '<<autonomous-loop-dynamic>>' as const

/** Either autonomous sentinel, fixed or dynamic. */
export function isAutonomousLoopSentinel(prompt: string): boolean {
  return (
    prompt === AUTONOMOUS_LOOP_SENTINEL ||
    prompt === AUTONOMOUS_LOOP_DYNAMIC_SENTINEL
  )
}

/** Either loop.md sentinel, fixed or dynamic. */
export function isLoopFileSentinel(prompt: string): boolean {
  return prompt === LOOP_FILE_SENTINEL || prompt === LOOP_FILE_DYNAMIC_SENTINEL
}

// =============================================================================
// PER-CHAIN DELIVERY STATE
// Module-local, one chain per process: `preambleSent` records that the
// autonomous preamble already went out as a header; `lastExpandedBody` records
// the loop.md content most recently delivered in full (or the marker below on
// the loop.md-absent fallback), so an unchanged file gets the short reminder
// and an edited file re-delivers in full. Both live for the process: a loop
// ends by scheduling no further wake, and the next process starts clean.
// =============================================================================

// Stand-in stored in lastExpandedBody when the autonomous preamble (not a
// loop.md body) was what the first fire delivered.
const PREAMBLE_SENT_MARKER = '__autonomous_preamble__'

/** One sentinel chain's expansion state — explicit so SATURN's ticker can
 *  hold one per SESSION (the daemon fires many sessions' loops; a shared
 *  chain would cross their reminder economies). The module-global instance
 *  below keeps the historical in-process behaviour for same-process
 *  callers. */
export interface LoopFireChainStateV1 {
  preambleSent: boolean
  lastExpandedBody: string | null
}

export function freshLoopFireChainState(): LoopFireChainStateV1 {
  return { preambleSent: false, lastExpandedBody: null }
}

const moduleChain: LoopFireChainStateV1 = freshLoopFireChainState()

// =============================================================================
// ENABLEMENT GATES — default-on; `=0` opts out per gate.
// =============================================================================

/**
 * Persistent-preamble mode: the loop is framed as meant-to-keep-running, and
 * the SendMessage end-condition copy softens to match. A truthy
 * MERCURY_LOOP_PERSISTENT forces it on; =0 opts out; unset ⇒ on.
 */
export function isLoopPersistentPreambleEnabled(): boolean {
  if (isEnvTruthy(flagEnv('MERCURY_LOOP_PERSISTENT'))) {
    return true
  }
  return flagEnv('MERCURY_LOOP_PERSISTENT') !== '0'
}

/**
 * Master gate for sentinel expansion (the autonomous default + loop.md
 * reading). When off, the resolvers return null and a sentinel prompt passes
 * through to the model verbatim. MERCURY_LOOP_PROMPT=0 opts out.
 */
export function isLoopDefaultPromptEnabled(): boolean {
  return flagEnv('MERCURY_LOOP_PROMPT') !== '0'
}

/**
 * Self-pacing mode for /loop: given no interval, `/loop <prompt>` lets the
 * model choose each next wake through ScheduleWakeup, rather than falling
 * back to a fixed 10m cron. MERCURY_LOOP_DYNAMIC=0 opts out.
 */
export function isDynamicLoopEnabled(): boolean {
  return flagEnv('MERCURY_LOOP_DYNAMIC') !== '0'
}

/**
 * Keepalive gate for dynamic loops: covers the case where a dynamic tick ran
 * but no reschedule was issued — one extra wake would let the chain recover
 * instead of dying there. MERCURY_LOOP_KEEPALIVE=0 opts out; unset ⇒ on.
 */
export function isLoopKeepaliveEnabled(): boolean {
  return flagEnv('MERCURY_LOOP_KEEPALIVE') !== '0'
}

/**
 * "User may be away" hint: appends the SendMessage end-condition addendum to
 * every tick. MERCURY_LOOP_AWAY_HINT=0 opts out.
 */
function awayHintEnabled(): boolean {
  return flagEnv('MERCURY_LOOP_AWAY_HINT') !== '0'
}

// =============================================================================
// AUTONOMOUS-LOOP PREAMBLE — delivered once, as the header of the first fire.
// =============================================================================

const PREAMBLE_STANDARD = `# Autonomous loop

You are running an autonomous loop with no fixed task list. Each tick, do the most useful next thing for the current project: triage failing tests or CI, pick up the next item on an in-flight plan, review open diffs, or otherwise advance whatever work is in front of you. Keep each tick small and self-contained — finish one concrete unit, leave the tree in a clean state, and let the next tick continue.

If there is genuinely nothing to do this tick, say so briefly and end the tick — do not invent busywork.`

const PREAMBLE_PERSISTENT = `# Autonomous loop (persistent)

You are running a persistent autonomous loop with no fixed task list. Each tick, do the most useful next thing for the current project and keep the loop alive across ticks: triage failing tests or CI, advance an in-flight plan, review open diffs, or otherwise move the work forward. Keep each tick small and self-contained — finish one concrete unit and leave the tree clean for the next tick.

This loop is meant to keep running. End it only when you are newly blocked on a decision you cannot make alone, or the user tells you to stop. If a single tick has nothing to do, end that tick briefly and wait for the next — do not end the whole loop.`

/** Choose persistent vs standard preamble per the gate. */
export function getAutonomousLoopPreamble(): string {
  return isLoopPersistentPreambleEnabled() ? PREAMBLE_PERSISTENT : PREAMBLE_STANDARD
}

/** Activation seam for the first autonomous tick — currently a no-op. */
export function logAutonomousLoopActivation(): void {
}

// =============================================================================
// SHARED PROSE FRAGMENTS
// For event-gated waits the prose steers toward the always-shipped Monitor
// tool first, and toward a background Bash task (run_in_background +
// TaskList/TaskStop) where Monitor cannot express the watch. Either way the
// wake arrives as a <task-notification>.
// =============================================================================

/** SendMessage end-condition addendum, gated on the away hint. */
function sendMessageOutcomeHint(isLoopFileMode = false): string {
  if (!awayHintEnabled()) return ''
  // The persistent framing softens the end conditions — but only for the
  // autonomous loops; loop-file mode keeps the fuller list either way.
  const softEnd = !isLoopFileMode && isLoopPersistentPreambleEnabled()
  const endCondition = softEnd
    ? "newly blocked on a decision you won't make alone, you're ending the loop"
    : "newly blocked on a decision you won't make alone, third straight tick with nothing to do, you're ending the loop"
  return `\n\nUse ${SEND_MESSAGE_TOOL_NAME} when the loop can't move further without the user, or when something landed that they'd want to act on now: ${endCondition}, or a major update arrived (CI went red, a review changes the plan). Progress you made yourself isn't a trigger — the transcript covers that. One ping per state, not per tick.`
}

/** Scheduling footer for dynamic (self-paced) ticks. */
const DYNAMIC_PACING_FOOTER = `\n\nIf the next tick is gated on an event, prefer a ${MONITOR_TOOL_NAME} watch on the log/process/command (or, for watches it doesn't fit, a long-running \`run_in_background\` Bash task — check ${TASK_LIST_TOOL_NAME}): its events arrive as \`<task-notification>\` messages and wake this loop immediately, so keep \`delaySeconds\` at 1200–1800s — the watch is your wake signal and this is only the fallback heartbeat. If you were woken by a \`<task-notification>\`, handle the event before rescheduling. To stop the loop, also ${TASK_STOP_TOOL_NAME} that watch (use ${TASK_LIST_TOOL_NAME} to find its task ID if it is no longer in context).`

// =============================================================================
// TICK BODIES — the short reminder texts delivered on every fire after the
// first. Each names its own pacing contract (cron refires itself; dynamic
// ticks must reschedule or the loop ends).
// =============================================================================

// The self-pacing paragraph shared by the two dynamic ticks that still run
// from their normal task source.
const rescheduleReminder = (sentinel: string): string =>
  `You scheduled this tick via the ${SCHEDULE_WAKEUP_TOOL_NAME} tool (not a recurring cron). To keep the loop alive, call ${SCHEDULE_WAKEUP_TOOL_NAME} again at the end of this turn with \`prompt\` set to the literal sentinel \`${sentinel}\` — otherwise the loop ends after this tick.`

/** Autonomous tick, FIXED (recurring-cron) pacing. */
function autonomousFixedTick(): string {
  return `# Autonomous loop tick

Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick. The recurring cron will fire the next tick automatically — do not call ${SCHEDULE_WAKEUP_TOOL_NAME} from this tick.${sendMessageOutcomeHint()}`
}

/** Autonomous tick, DYNAMIC (self-paced) pacing. */
function autonomousDynamicTick(): string {
  return `# Autonomous loop tick (dynamic pacing)

Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick.

${rescheduleReminder(AUTONOMOUS_LOOP_DYNAMIC_SENTINEL)}${DYNAMIC_PACING_FOOTER}${sendMessageOutcomeHint()}`
}

/** loop.md tasks, FIXED (recurring-cron) pacing. */
function loopFileFixedTick(): string {
  return `# /loop tick — loop.md tasks

Work the tasks from the loop.md contents established earlier in this conversation. If you cannot find them, treat this as a no-op tick. The recurring cron will fire the next tick automatically — do not call ${SCHEDULE_WAKEUP_TOOL_NAME} from this tick.${sendMessageOutcomeHint(true)}`
}

/** loop.md tasks, DYNAMIC (self-paced) pacing. */
function loopFileDynamicTick(): string {
  return `# /loop tick — loop.md tasks (dynamic pacing)

Work the tasks from the loop.md contents established earlier in this conversation. If you cannot find them, treat this as a no-op tick.

${rescheduleReminder(LOOP_FILE_DYNAMIC_SENTINEL)}${DYNAMIC_PACING_FOOTER}${sendMessageOutcomeHint(true)}`
}

/** loop.md ABSENT, DYNAMIC pacing — run autonomous, keep rescheduling (and
 *  keep watching for loop.md to reappear). */
function loopFileAbsentDynamicTick(): string {
  return `# /loop tick — loop.md absent (dynamic pacing)

loop.md is not currently present. Run the autonomous check using the loop instructions established earlier in this conversation.

You scheduled this tick via the ${SCHEDULE_WAKEUP_TOOL_NAME} tool (not a recurring cron). To keep the loop alive — and to pick up loop.md if it is recreated — call ${SCHEDULE_WAKEUP_TOOL_NAME} again at the end of this turn with \`prompt\` set to the literal sentinel \`${LOOP_FILE_DYNAMIC_SENTINEL}\` — otherwise the loop ends after this tick.${DYNAMIC_PACING_FOOTER}${sendMessageOutcomeHint()}`
}

// =============================================================================
// loop.md READER
// =============================================================================

// Hard byte cap on loop.md before truncation.
const LOOP_FILE_BYTE_CAP = 25000

/** Truncate an oversize loop.md, preferring a newline boundary for the cut. */
function capLoopFile(content: string): string {
  if (content.length <= LOOP_FILE_BYTE_CAP) return content
  const boundary = content.lastIndexOf('\n', LOOP_FILE_BYTE_CAP)
  const cutAt = boundary > 0 ? boundary : LOOP_FILE_BYTE_CAP
  return `${content.slice(0, cutAt)}\n\n> WARNING: loop.md was truncated to ${LOOP_FILE_BYTE_CAP} bytes. Keep the task list concise.`
}

export interface LoopFile {
  /** Absolute source path of the winning candidate. */
  path: string
  /** Its text, whitespace-trimmed and capped if oversize. */
  content: string
}

/**
 * Read the loop-tasks file. Two candidates, in order: `<config-home>/loop.md`
 * then `<project-root>/loop.md`; the first non-empty one wins. ENOENT and
 * EISDIR skip to the next candidate; any other fs error is rethrown (a
 * permission failure must surface, not silently become "no loop file").
 */
export function readLoopFile(): LoopFile | null {
  for (const candidate of [
    join(getMercuryHome(), 'loop.md'),
    join(getProjectRoot(), 'loop.md'),
  ]) {
    let raw: string
    try {
      raw = readFileSync(candidate, 'utf-8')
    } catch (err) {
      if (isENOENT(err) || (err as NodeJS.ErrnoException)?.code === 'EISDIR') {
        continue
      }
      throw err
    }
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    return { path: candidate, content: capLoopFile(trimmed) }
  }
  return null
}

// =============================================================================
// SENTINEL RESOLVERS — sentinel string → expanded per-tick prompt.
// =============================================================================

function resolveAutonomousWith(prompt: string, chain: LoopFireChainStateV1): string | null {
  if (!isAutonomousLoopSentinel(prompt)) return null
  if (!isLoopDefaultPromptEnabled()) return null
  logAutonomousLoopActivation()
  const tickBody =
    prompt === AUTONOMOUS_LOOP_DYNAMIC_SENTINEL
      ? autonomousDynamicTick()
      : autonomousFixedTick()
  // Anything already delivered on this chain — the preamble, or a loop.md
  // body from the sibling resolver — means the header went out: reminder
  // only.
  if (chain.preambleSent || chain.lastExpandedBody !== null) return tickBody
  chain.preambleSent = true
  return `${getAutonomousLoopPreamble()}\n\n---\n\n${tickBody}`
}

function resolveLoopFileWith(
  prompt: string,
  chain: LoopFireChainStateV1,
  loopFile: LoopFile | null,
): string | null {
  if (!isLoopFileSentinel(prompt)) return null
  if (!isLoopDefaultPromptEnabled()) return null

  const isDynamic = prompt === LOOP_FILE_DYNAMIC_SENTINEL

  if (loopFile !== null) {
    const tickBody = isDynamic ? loopFileDynamicTick() : loopFileFixedTick()
    // Unchanged since the last full delivery ⇒ the reminder suffices. Any
    // edit re-delivers the whole body so the model works the CURRENT list.
    if (chain.lastExpandedBody === loopFile.content) return tickBody
    chain.lastExpandedBody = loopFile.content
    return `# /loop tick — tasks from ${loopFile.path}\n\nThe user configured a loop-tasks file. Work through the tasks defined below; these are the instructions for this tick and every subsequent tick (the reminder on later fires refers back to this message).\n\n---\n\n${loopFile.content}\n\n---\n\n${tickBody}`
  }

  // loop.md absent → autonomous fallback (dynamic keeps rescheduling so a
  // recreated loop.md is picked up on a later tick).
  logAutonomousLoopActivation()
  const fallbackBody = isDynamic ? loopFileAbsentDynamicTick() : autonomousFixedTick()
  // Deliberately NARROWER header dedupe than the autonomous resolver's: a
  // lastExpandedBody holding real loop.md content does NOT suppress the
  // header here, so deliver-then-delete-loop.md still gets the preamble.
  if (chain.lastExpandedBody === PREAMBLE_SENT_MARKER || chain.preambleSent) {
    return fallbackBody
  }
  chain.lastExpandedBody = PREAMBLE_SENT_MARKER
  chain.preambleSent = true
  return `${getAutonomousLoopPreamble()}\n\n---\n\n${fallbackBody}`
}

/** Expand an AUTONOMOUS sentinel; null when it isn't one (or the gate is off). */
export function resolveAutonomousLoopFire(prompt: string): string | null {
  return resolveAutonomousWith(prompt, moduleChain)
}

/** Expand a loop.md sentinel; null when it isn't one (or the gate is off). */
export function resolveLoopFileFire(prompt: string): string | null {
  return resolveLoopFileWith(prompt, moduleChain, readLoopFile())
}

/**
 * Top-level entry: autonomous expansion first, loop.md expansion second,
 * and failing both the prompt comes back verbatim — so every fired prompt
 * can be routed through here, sentinel or not.
 */
export function resolveLoopDefaultFire(prompt: string): string {
  return (
    resolveAutonomousLoopFire(prompt) ?? resolveLoopFileFire(prompt) ?? prompt
  )
}

/**
 * SATURN's fire-road entry (the expansion REVIVED — it had been dead since
 * the stranded-estate walk deleted the one REPL mount; the daemon road
 * never expanded at all): the same total resolution over an EXPLICIT chain
 * state (one per session, the ticker's map) and the SESSION'S OWN workspace
 * for loop.md (the daemon's cwd is nobody's project). Non-sentinel prompts
 * come back verbatim.
 */
export function resolveLoopFireForWorkspace(
  prompt: string,
  workspaceDir: string,
  chain: LoopFireChainStateV1,
): string {
  return (
    resolveAutonomousWith(prompt, chain) ??
    resolveLoopFileWith(prompt, chain, readLoopFileFrom(workspaceDir)) ??
    prompt
  )
}

/**
 * The workspace-keyed loop.md read: `<config-home>/loop.md` then
 * `<workspaceDir>/loop.md` — the same two-candidate ladder as readLoopFile
 * with the SESSION's root in the project seat.
 */
export function readLoopFileFrom(workspaceDir: string): LoopFile | null {
  for (const candidate of [join(getMercuryHome(), 'loop.md'), join(workspaceDir, 'loop.md')]) {
    let raw: string
    try {
      raw = readFileSync(candidate, 'utf-8')
    } catch (err) {
      if (isENOENT(err) || (err as NodeJS.ErrnoException)?.code === 'EISDIR') {
        continue
      }
      throw err
    }
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    return { path: candidate, content: capLoopFile(trimmed) }
  }
  return null
}
