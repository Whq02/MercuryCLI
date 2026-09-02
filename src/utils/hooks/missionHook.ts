import { existsSync } from 'node:fs'
import type { Message } from '../../types/message.js'
import type { SetAppState } from '../messageQueueManager.js'
import { getSessionId } from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import {
  claimContinuation,
  turnBoundaryIndex,
} from '../../services/run/continuationLatch.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import {
  readMissionCard,
  writeMissionCard,
  type MissionCardState,
} from '../../services/mission/missionCard.js'
import { addFunctionHook, removeFunctionHook } from './sessionHooks.js'

// ============================================================================
// missionHook — the machinery behind /mission.
// ----------------------------------------------------------------------------
// A mission is a free-text finish line. While one is armed, a session-scoped
// Stop hook refuses to let the agent end its turn; the refusal text re-states
// the mission, so each blocked stop becomes another working round. Completion
// is signalled BY THE MODEL: the directive tells it to close a turn with a
// sentinel on its own final line once the condition truly holds, and the hook
// hunts for that sentinel to lift the block.
//
// Two brakes bound the loop:
//   • a per-session cap on blocks — after it, the hook disarms and says so;
//   • conditions the compile step can prove unverifiable get a single
//     feasibility round instead of an endless one.
//
// Records live in a module Map keyed by session id. That map is deliberately
// process-ephemeral (missions die with the session hooks) and is the shared
// truth for the status report, the clear keywords, and the footer chip.
// ============================================================================

/** Longest accepted mission condition, in characters. */
export const MISSION_CONDITION_MAX_LENGTH = 4000

/** How many blocks a mission gets before the hook stands down. */
const DEFAULT_MISSION_MAX_BLOCKS = 12

/**
 * The completion marker. The model writes it as the last line of a turn;
 * this module greps transcripts for it. Both sides depend on this exact
 * spelling, so treat it as frozen. Shaped to be unmistakable — nothing in
 * ordinary prose looks like it.
 * CONSTRAINT: the value keeps its GOAL spelling — saved transcripts carry it,
 * and a resumed session must still find it.
 */
export const MISSION_MET_SENTINEL = '<<<GOAL-MET>>>'

/**
 * First line of every mission directive. Frozen for the same reason as the
 * sentinel: the transcript scan uses this line as a fence, so completions
 * that belong to an OLDER mission stay on the far side of it and can never
 * bleed into a newer one.
 * CONSTRAINT: same stored-spelling rule as the sentinel — the text stays as is.
 */
export const MISSION_DIRECTIVE_HEADER = 'A standing goal is now active for this session:'

/**
 * What the compile step can conclude about a condition. The grammar behind
 * it prizes precision over recall — anything it cannot decide outright is
 * left 'attainable' and gets the normal block-until-done treatment.
 */
export type MissionFeasibility =
  | 'attainable'
  | 'unknown-needs-check'
  | 'already-met'
  | 'needs-operator'
  | 'unattainable-now'

export interface MissionContract {
  outcome: string
  feasibility: MissionFeasibility
  /** The preflight fact that decided the classification. */
  evidence?: string
}

/**
 * Classify a condition using only facts available without a model turn
 * (regex shape + a filesystem probe). Pure except for the injectable probe.
 */
export function compileMissionContract(
  condition: string,
  probes: { fileExists: (p: string) => boolean } = {
    fileExists: p => {
      try {
        return existsSync(p)
      } catch {
        return false
      }
    },
  },
): MissionContract {
  const text = condition.trim()
  // Self-described as uncheckable ⇒ blocking forever would help nobody.
  if (/\bno observable\b|\bwithout (any )?observable\b|\bcannot be (checked|observed|verified)\b/i.test(text)) {
    return { outcome: text, feasibility: 'unattainable-now', evidence: 'the condition declares itself unobservable' }
  }
  // Both halves of a contradiction demanded at the same time.
  if (/simultaneously[^.]*\b(enabled and disabled|disabled and enabled|on and off|true and false|present and absent)\b/i.test(text)) {
    return { outcome: text, feasibility: 'unattainable-now', evidence: 'the condition demands mutually exclusive states at once' }
  }
  // "the file X exists" is checkable right now.
  const fileExists = /\bthe file\s+(\S+)\s+exists\b/i.exec(text)
  if (fileExists?.[1] && probes.fileExists(fileExists[1])) {
    return { outcome: text, feasibility: 'already-met', evidence: `${fileExists[1]} exists` }
  }
  return { outcome: text, feasibility: 'attainable' }
}

/** Everything known about a session's armed mission. */
export interface ActiveMission {
  /** The finish line, as the user typed it. */
  condition: string
  /** Count of stop attempts this mission has blocked (0 until the first). */
  iterations: number
  /** Verdict text left behind by the newest hook evaluation. */
  lastReason?: string
  /** Latched true the first time this mission's own sentinel is found; the
   *  latch never re-opens, and a successor mission starts with it clear —
   *  which is exactly what keeps old sentinels from counting twice. */
  met?: boolean
  /** True when a brake (cap or terminal feasibility) stood the hook down
   *  short of completion. Status surfaces read this to avoid claiming an
   *  armed mission that no longer blocks anything. */
  gaveUp?: boolean
  /** Epoch ms when the mission was installed. */
  setAt: number
  /** Id of the Stop hook, so clearing removes precisely this one. */
  hookId: string
  /** What the compile step concluded, and on what evidence. */
  contract?: MissionContract
  /** The single feasibility round has been used up. */
  feasibilityBlocked?: boolean
}

/** Arguments that mean "drop the mission" rather than "set one". */
const CLEAR_WORDS = new Set([
  'clear',
  'stop',
  'off',
  'reset',
  'none',
  'cancel',
])

/** Armed missions by session id. Process-ephemeral on purpose. */
const missionsBySession = new Map<string, ActiveMission>()

/**
 * Mirror one mission's transition onto its persisted card (the continuity
 * record resume/compaction/concourse read). Best-effort by the card
 * owner's contract — the hook's own decision never waits on the disk.
 */
function persistCard(sessionId: string, mission: ActiveMission, state: MissionCardState): void {
  writeMissionCard({
    schema: 1,
    sessionId,
    goal: mission.condition,
    state,
    nextStep:
      state === 'met'
        ? null
        : state === 'cleared'
          ? null
          : (mission.lastReason ??
            `keep working toward the goal; end a turn with the ${MISSION_MET_SENTINEL} line once it is genuinely met`),
    iterations: mission.iterations,
    setAt: new Date(mission.setAt).toISOString(),
    updatedAt: new Date().toISOString(),
  })
}

/** True when the argument is one of the clear keywords. */
export function isMissionClearKeyword(text: string): boolean {
  return CLEAR_WORDS.has(text.trim().toLowerCase())
}

/** The session's armed mission, if any. */
export function getActiveMission(sessionId: string = getSessionId()): ActiveMission | undefined {
  return missionsBySession.get(sessionId)
}

/**
 * The prompt handed to the model when a mission arms. Frozen text: its first
 * line is the transcript fence, and the indented sentinel example inside it
 * is precisely why "sentinel as the final non-empty line" separates a real
 * completion from a turn that merely quoted these instructions.
 */
export function buildMissionDirective(condition: string): string {
  return [
    MISSION_DIRECTIVE_HEADER,
    ``,
    `    ${condition}`,
    ``,
    `Acknowledge the mission in one line, then immediately start (or continue)`,
    `working toward it. Do not stop until the condition is genuinely met — a`,
    `Stop hook will keep re-prompting you until it is.`,
    ``,
    `When — and only when — the condition is genuinely and fully met, end that`,
    `turn with a single final line containing exactly:`,
    ``,
    `    ${MISSION_MET_SENTINEL}`,
    ``,
    `Do not emit that line prematurely, and do not tell the user to clear the`,
    `mission — emitting the line is how you signal completion.`,
    ``,
    `If the condition reads as a progress snapshot (a plan, an "in flight"`,
    `status, a worklist), it is met when the work it directs is complete —`,
    `being PAST the described state counts as met, not unmet.`,
  ].join('\n')
}

/** Flatten a message to searchable text. Only user/assistant messages have
 *  an API payload; string bodies pass through, text blocks concatenate with
 *  a newline each, and every other message kind contributes nothing. */
function textOf(m: Message): string {
  if (m.type !== 'user' && m.type !== 'assistant') return ''
  const content = m.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text + '\n'
  }
  return out
}

/**
 * True when the sentinel is the last thing said — trailing blank lines
 * ignored. Mid-text occurrences don't count, which is what disqualifies a
 * turn that quoted the directive (its embedded sentinel example always has
 * instruction lines after it).
 */
function endsOnSentinel(text: string): boolean {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line === '') continue
    return line === MISSION_MET_SENTINEL
  }
  return false
}

/**
 * Search the tail of the transcript for THIS mission's completion signal.
 *
 * The walk runs newest → oldest and is fenced twice: it stops at the nearest
 * directive header (the mission's own installation point) and at the nearest
 * user message (arming a mission IS a user message, so anything older belongs
 * to a previous era). Fencing is the anti-replay property — the sentinel an
 * earlier mission earned sits beyond a fence and cannot satisfy this one.
 *
 * Ordering nuance: each assistant message is tested for a final-line
 * sentinel BEFORE either fence test, so a turn that quotes the header and
 * then genuinely finishes still counts as finished.
 */
export function sawMissionMetSentinel(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const text = textOf(m)
    if (m.type === 'assistant' && endsOnSentinel(text)) return true
    if (text.includes(MISSION_DIRECTIVE_HEADER)) break // own installation fence
    if (m.type === 'user') break // previous-era fence
  }
  return false
}

/**
 * Arm a mission: put the Stop hook in place, record it, and return the
 * directive for the caller to hand the model. A session holds at most one
 * mission — arming over an existing one tears the old hook down first.
 */
export function setActiveMission(
  setAppState: SetAppState,
  condition: string,
  options?: { maxBlocks?: number; sessionId?: string },
): string {
  const sessionId = options?.sessionId ?? getSessionId()
  const maxBlocks = options?.maxBlocks ?? DEFAULT_MISSION_MAX_BLOCKS

  const prior = missionsBySession.get(sessionId)
  if (prior) {
    removeFunctionHook(setAppState, sessionId, 'Stop', prior.hookId)
    missionsBySession.delete(sessionId)
  }

  const setAt = Date.now()
  const contract = compileMissionContract(condition)
  const record: ActiveMission = {
    condition,
    iterations: 0,
    setAt,
    hookId: '', // assigned right after registration
    contract,
    // Proven true at compile time ⇒ born met. Not a single continuation is
    // spent, and since `met` is a one-way latch the sentinel path can only
    // agree with it.
    ...(contract.feasibility === 'already-met' ? { met: true, lastReason: `already met at compile: ${contract.evidence}` } : {}),
  }

  const hookId = addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '', // empty matcher: evaluate at every stop attempt
    messages => {
      const mission = missionsBySession.get(sessionId)
      // The record vanished or now belongs to a different condition — this
      // closure is stale; let the stop through.
      if (!mission || mission.condition !== condition) return true
      // One-way latch: met missions never block again.
      if (mission.met) return true
      if (sawMissionMetSentinel(messages)) {
        mission.met = true
        persistCard(sessionId, mission, 'met')
        return true
      }
      // Provably-unverifiable contract: spend one round asking the model to
      // verify or restate something observable, then stand down with the
      // evidence on record.
      if (mission.contract?.feasibility === 'unattainable-now') {
        if (mission.feasibilityBlocked) {
          mission.gaveUp = true
          mission.lastReason = `feasibility terminal: ${mission.contract.evidence} — disarmed after the one bounded feasibility check`
          persistCard(sessionId, mission, 'stood-down')
          return true
        }
        mission.feasibilityBlocked = true
        mission.iterations += 1
        mission.lastReason = `feasibility check issued: ${mission.contract.evidence}`
        persistCard(sessionId, mission, 'armed')
        return false
      }
      // Cap brake. Standing down is recorded on the mission so status never
      // claims a hook that no longer blocks.
      if (mission.iterations >= maxBlocks) {
        mission.gaveUp = true
        mission.lastReason = `block cap (${maxBlocks}) reached — hook disarmed without the mission being met`
        persistCard(sessionId, mission, 'stood-down')
        logForDebugging(
          `[mission] block cap (${maxBlocks}) reached for "${condition}" — allowing stop`,
        )
        return true
      }
      // Continuations are budgeted one-per-stop-attempt process-wide, and
      // every hook family draws from the same latch. Losing the draw is not
      // a failure: some other hook is already re-prompting, this stop goes
      // through, and the mission — still armed — gets the next attempt.
      const claimed = claimContinuation(
        processMainOwner(),
        turnBoundaryIndex(messages),
        messages.length,
      )
      if (!claimed) {
        mission.lastReason = 'another hook claimed this stop attempt — mission defers one round'
        persistCard(sessionId, mission, 'armed')
        return true
      }
      mission.iterations += 1
      mission.lastReason = `Mission not yet met (check ${mission.iterations})`
      persistCard(sessionId, mission, 'armed')
      return false // refuse the stop; the errorMessage below re-prompts
    },
    `The standing mission for this session is not yet met: ${condition}\nKeep working toward it. When it is genuinely met, end your turn with a final line containing exactly ${MISSION_MET_SENTINEL}. A snapshot-style condition (a plan or in-flight status) counts as met once the work it directs is complete — being past the described state is completion, not a mismatch.`,
    { timeout: 5000, id: `mission-${sessionId}-${setAt}` },
  )

  record.hookId = hookId
  missionsBySession.set(sessionId, record)
  persistCard(sessionId, record, record.met ? 'met' : 'armed')
  logForDebugging(`[mission] installed standing mission for session ${sessionId}`)
  return buildMissionDirective(condition)
}

/**
 * Disarm and forget the session's mission. Hands back the condition that was
 * cleared, or null when nothing was armed.
 */
export function clearActiveMission(
  setAppState: SetAppState,
  sessionId: string = getSessionId(),
): string | null {
  const mission = missionsBySession.get(sessionId)
  if (!mission) return null
  removeFunctionHook(setAppState, sessionId, 'Stop', mission.hookId)
  missionsBySession.delete(sessionId)
  persistCard(sessionId, mission, 'cleared')
  logForDebugging(`[mission] cleared standing mission for session ${sessionId}`)
  return mission.condition
}

/**
 * Resume continuity: a mission card left ARMED by the previous run of a
 * session re-arms its Stop hook, so the mission survives the process
 * boundary the in-memory map deliberately does not. A live mission always
 * wins (never re-arm over it); met/stood-down/cleared/continued cards are
 * history, not obligations.
 *
 * The card KEY and the arm target are separate on purpose: a `--continue`
 * boot can adopt an old transcript while the live process answers a
 * different session id — the card is read under the ADOPTED id
 * (`cardSessionId`) and the hook arms under the LIVE id (`armSessionId`),
 * and when the two differ the old card is rewritten as `continued`
 * pointing at its successor instead of sitting orphaned-armed for a
 * session no process honours. A bare string argument keeps the original
 * same-id contract. Returns whether a mission was re-armed.
 */
export function rearmMissionFromCard(
  setAppState: SetAppState,
  target: string | { cardSessionId?: string; armSessionId?: string } = {},
): boolean {
  const normalized = typeof target === 'string' ? { cardSessionId: target, armSessionId: target } : target
  const cardSessionId = normalized.cardSessionId ?? getSessionId()
  const armSessionId = normalized.armSessionId ?? getSessionId()
  if (missionsBySession.has(armSessionId)) return false
  const card = readMissionCard(cardSessionId)
  if (!card || card.state !== 'armed') return false
  setActiveMission(setAppState, card.goal, { sessionId: armSessionId })
  const mission = missionsBySession.get(armSessionId)
  if (mission) {
    mission.lastReason = `re-armed on resume (the previous run closed at check ${card.iterations})`
    persistCard(armSessionId, mission, 'armed')
  }
  if (cardSessionId !== armSessionId) {
    writeMissionCard({
      ...card,
      state: 'continued',
      nextStep: `continued in session ${armSessionId}`,
      updatedAt: new Date().toISOString(),
    })
  }
  logForDebugging(
    `[mission] re-armed from card (card session ${cardSessionId} → live session ${armSessionId})`,
  )
  return true
}
