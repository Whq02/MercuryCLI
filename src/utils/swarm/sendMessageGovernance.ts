/**
 * SendMessage governance.
 *
 * Three additive, default-no-op governance layers over the existing
 * file-based teammate mailbox + roster:
 *
 *   12. Directed Q&A status lifecycle — `question`/`answer` structured messages
 *       keyed by request_id open and close a pending entry for the recipient.
 *   13. Broadcast fairness + lead gate — an optional team-config flag to disable
 *       broadcasts for non-leads, plus a turn-fairness decision (`decideTurn`)
 *       to keep one agent from flooding `to:'*'`.
 *   14. Command-rank authority gate (canDirect) — an optional members[].role
 *       ladder; DIRECTIVE messages (shutdown/assign/directive) are gated on a
 *       flat lead>teammate default, extended by the role ladder when configured.
 *
 * EVERYTHING here is designed so that with no new config and no new message
 * types, behavior is unchanged: plain messages flow untouched,
 * broadcasts are allowed, the lead can direct, peers message freely.
 */

import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getTeamsDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import * as lockfile from '../lockfile.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { sanitizePathComponent } from '../tasks.js'
import { getTeamName } from '../teammate.js'
import { TEAM_LEAD_NAME } from './constants.js'
import type { TeamFile } from './teamHelpers.js'

const LOCK_OPTIONS = {
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
  },
}

// ===========================================================================
// ITEM 12 — Directed Q&A status lifecycle
// ===========================================================================

/**
 * A pending question addressed to an agent. Stored per-recipient in a small
 * sidecar file so the open→answered lifecycle is observable independently of
 * the (append-only) inbox message log.
 */
export type OpenQuestion = {
  request_id: string
  from: string
  /** The recipient agent name this question was addressed to. */
  to: string
  /** Question text (the `content` field of the question message). */
  text: string
  summary?: string
  askedAt: string
  /** Set when an answer referencing this request_id closes the entry. */
  answeredAt?: string
  answeredBy?: string
  answerText?: string
}

/**
 * Path to a team's questions ledger. One file per team holds every agent's
 * open/answered questions; kept separate from inboxes so a question's lifecycle
 * is not affected by mailbox reads or mark-as-read.
 * Structure: <config home>/teams/{team}/questions.json
 */
function getQuestionsPath(teamName?: string): string {
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  return join(getTeamsDir(), safeTeam, 'questions.json')
}

async function readQuestions(teamName?: string): Promise<OpenQuestion[]> {
  const path = getQuestionsPath(teamName)
  try {
    const content = await readFile(path, 'utf-8')
    const parsed = jsonParse(content)
    return Array.isArray(parsed) ? (parsed as OpenQuestion[]) : []
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') return []
    logForDebugging(`[QnA] readQuestions failed: ${error}`)
    return []
  }
}

/**
 * Mutate the questions ledger under a lock. STATE fails open: a junk/missing
 * file resets to an empty ledger rather than blocking the send.
 */
async function mutateQuestions(
  teamName: string | undefined,
  mutate: (questions: OpenQuestion[]) => OpenQuestion[],
): Promise<void> {
  const path = getQuestionsPath(teamName)
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  const dir = join(getTeamsDir(), safeTeam)
  await mkdir(dir, { recursive: true })

  // proper-lockfile requires the file to exist before locking.
  try {
    await writeFile(path, '[]', { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') {
      logForDebugging(`[QnA] could not create questions file: ${error}`)
      return
    }
  }

  const lockFilePath = `${path}.lock`
  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(path, {
      lockfilePath: lockFilePath,
      ...LOCK_OPTIONS,
    })
    const current = await readQuestions(teamName)
    const next = mutate(current)
    await writeFile(path, jsonStringify(next, null, 2), 'utf-8')
  } catch (error) {
    logForDebugging(`[QnA] mutateQuestions failed: ${error}`)
    logError(error)
  } finally {
    if (release) {
      try {
        await release()
      } catch {
        // already released
      }
    }
  }
}

/**
 * Open a pending question for the recipient. Idempotent on request_id — a
 * re-sent question with the same id refreshes rather than duplicates.
 */
export async function openQuestion(
  q: {
    request_id: string
    from: string
    to: string
    text: string
    summary?: string
  },
  teamName?: string,
): Promise<void> {
  await mutateQuestions(teamName, questions => {
    const filtered = questions.filter(x => x.request_id !== q.request_id)
    filtered.push({
      request_id: q.request_id,
      from: q.from,
      to: q.to,
      text: q.text,
      summary: q.summary,
      askedAt: new Date().toISOString(),
    })
    return filtered
  })
}

/**
 * May `answeredBy` close this question? Only the question's ADDRESSEE (`to`) can —
 * an answer from anyone else must NOT close (or spoof-answer) a question that
 * wasn't directed to them (review #18). An already-answered question never
 * re-closes. Pure + testable.
 */
export function canAnswerCloseQuestion(
  question: { to?: string; answeredAt?: string },
  answeredBy: string,
): boolean {
  if (question.answeredAt) return false
  // Match the addressee case-INSENSITIVELY, like the rest of the swarm compares
  // agent/member names (SendMessageTool member filter, resolveDirectActor lead
  // check, all .toLowerCase()). A question addressed to "Bob" answered by "bob"
  // must close — otherwise the answer is delivered but the question silently stays
  // open in listOpenQuestions / TeamBrief. Still requires a non-empty addressee.
  const addressee = (question.to ?? '').trim().toLowerCase()
  return addressee.length > 0 && addressee === (answeredBy ?? '').trim().toLowerCase()
}

/**
 * Close a pending question by request_id (an answer references it). Closes ONLY
 * when the answerer is the question's addressee — a non-addressee's answer is
 * still delivered as a normal message but cannot close the question. No-op if
 * the id is unknown.
 * @returns true if a matching open question was closed.
 */
export async function answerQuestion(
  a: {
    request_id: string
    answeredBy: string
    answerText?: string
  },
  teamName?: string,
): Promise<boolean> {
  let closed = false
  await mutateQuestions(teamName, questions => {
    const next = questions.map(x => {
      if (x.request_id === a.request_id && canAnswerCloseQuestion(x, a.answeredBy)) {
        closed = true
        return {
          ...x,
          answeredAt: new Date().toISOString(),
          answeredBy: a.answeredBy,
          answerText: a.answerText,
        }
      }
      return x
    })
    // Bound the persisted ledger (RESOURCE: writer-with-no-reaper): answered
    // questions were never pruned, so questions.json grew for the team's whole
    // life. Keep every OPEN question (they're owed answers) + the newest 100
    // answered ones (recent audit trail).
    const answered = next.filter(x => x.answeredAt)
    if (answered.length > 100) {
      const cut = new Set(
        answered
          .sort((p, q) => String(p.answeredAt).localeCompare(String(q.answeredAt)))
          .slice(0, answered.length - 100)
          .map(x => x.request_id),
      )
      return next.filter(x => !cut.has(x.request_id))
    }
    return next
  })
  return closed
}

/**
 * List open (unanswered) questions addressed to `agentName`. Surfaced in
 * TeamBrief's unread section so an agent sees what it still owes answers to.
 */
export async function listOpenQuestions(
  agentName: string,
  teamName?: string,
): Promise<OpenQuestion[]> {
  const questions = await readQuestions(teamName)
  // Match the addressee case-insensitively, like the sibling
  // canAnswerCloseQuestion (:184). A case-sensitive `===` dropped a directed question
  // from the recipient's TeamBrief whenever the sender cased the name differently.
  const me = (agentName ?? '').trim().toLowerCase()
  return questions.filter(
    q => (q.to ?? '').trim().toLowerCase() === me && !q.answeredAt,
  )
}

// ===========================================================================
// ITEM 13 — Broadcast fairness + lead gate
// ===========================================================================

/**
 * Team-config governance block. Entirely optional; absence means defaults that
 * reproduce default behaviour exactly.
 */
export type TeamGovernance = {
  /** ITEM 13a: broadcasts allowed for non-leads. Default true (no change). */
  broadcastEnabled?: boolean
  /** ITEM 13b: broadcast turn-fairness thresholds (permissive by default). */
  broadcastFairness?: {
    /** ms a repeat broadcaster must yield while others are active. */
    repostCooldownMs?: number
    /** ms an actor counts as "active in the room" after its last broadcast. */
    activeWindowMs?: number
  }
}

/** A TeamFile may carry an optional governance block (additive). */
export type TeamFileWithGovernance = TeamFile & {
  governance?: TeamGovernance
}

/**
 * ITEM 13a — Lead-enable gate. Broadcasts are allowed by default; a team may
 * set governance.broadcastEnabled=false to restrict `to:'*'` to the lead.
 * @returns null when allowed, or a refusal message string when denied.
 */
export function checkBroadcastAllowed(
  teamFile: TeamFileWithGovernance | null,
  isLead: boolean,
): string | null {
  // Default (no flag, or true) — allowed for everyone, exactly as today.
  if (!teamFile || teamFile.governance?.broadcastEnabled !== false) {
    return null
  }
  if (isLead) return null
  return 'Broadcasts (to: "*") are disabled for non-leads on this team (governance.broadcastEnabled=false). Send directed messages, or ask the team-lead to broadcast.'
}

// --- Broadcast turn-fairness (decideTurn) ---

/**
 * Default thresholds are intentionally permissive so normal use sees no change:
 * a 0ms cooldown means a single agent broadcasting is never throttled; fairness
 * only ever engages when a team opts into a positive cooldown via config.
 */
export const DEFAULT_BROADCAST_REPOST_COOLDOWN_MS = 0
export const DEFAULT_BROADCAST_ACTIVE_WINDOW_MS = 10 * 60 * 1000

type BroadcastTurnState = {
  lastSpeaker: { actor: string; ts: string } | null
  lastSpokeAt: Record<string, string>
}

function freshTurnState(): BroadcastTurnState {
  return { lastSpeaker: null, lastSpokeAt: {} }
}

/** STATE fails open: anything unreadable resets to fresh. */
function normalizeTurnState(raw: unknown): BroadcastTurnState {
  if (!raw || typeof raw !== 'object') return freshTurnState()
  const r = raw as Record<string, unknown>
  const out = freshTurnState()
  const ls = r.lastSpeaker
  if (
    ls &&
    typeof ls === 'object' &&
    typeof (ls as Record<string, unknown>).actor === 'string' &&
    typeof (ls as Record<string, unknown>).ts === 'string'
  ) {
    out.lastSpeaker = {
      actor: (ls as Record<string, string>).actor,
      ts: (ls as Record<string, string>).ts,
    }
  }
  const lsa = r.lastSpokeAt
  if (lsa && typeof lsa === 'object') {
    for (const [actor, ts] of Object.entries(lsa as Record<string, unknown>)) {
      if (typeof ts === 'string' && Number.isFinite(Date.parse(ts))) {
        out.lastSpokeAt[actor] = ts
      }
    }
  }
  return out
}

function activeActors(
  state: BroadcastTurnState,
  nowMs: number,
  windowMs: number,
): string[] {
  const out: string[] = []
  for (const [actor, ts] of Object.entries(state.lastSpokeAt)) {
    const t = Date.parse(ts)
    if (Number.isFinite(t) && nowMs - t <= windowMs) out.push(actor)
  }
  return out
}

/**
 * Pure decision (`decideTurn`): while OTHER actors
 * are active, an agent may not broadcast twice in a row until a reply or the
 * repost cooldown elapses. Deny leaves the state unchanged.
 */
export function decideBroadcastTurn(
  rawState: unknown,
  attempt: {
    actor: string
    nowMs: number
    repostCooldownMs?: number
    activeWindowMs?: number
  },
): {
  allow: boolean
  reason: string
  state: BroadcastTurnState
  retryAfterMs?: number
} {
  const state = normalizeTurnState(rawState)
  const nowMs = attempt.nowMs
  const cooldownMs =
    typeof attempt.repostCooldownMs === 'number' && attempt.repostCooldownMs > 0
      ? attempt.repostCooldownMs
      : DEFAULT_BROADCAST_REPOST_COOLDOWN_MS
  const windowMs =
    typeof attempt.activeWindowMs === 'number' && attempt.activeWindowMs > 0
      ? attempt.activeWindowMs
      : DEFAULT_BROADCAST_ACTIVE_WINDOW_MS
  const nowISO = new Date(nowMs).toISOString()

  const speak = (): BroadcastTurnState => {
    const next: BroadcastTurnState = {
      lastSpeaker: { actor: attempt.actor, ts: nowISO },
      lastSpokeAt: { ...state.lastSpokeAt, [attempt.actor]: nowISO },
    }
    // Prune actors that left the active window.
    for (const [actor, ts] of Object.entries(next.lastSpokeAt)) {
      const t = Date.parse(ts)
      if (!Number.isFinite(t) || nowMs - t > windowMs) {
        delete next.lastSpokeAt[actor]
      }
    }
    return next
  }

  // cooldown<=0 (the default): fairness disabled — always allow.
  if (cooldownMs <= 0) {
    return { allow: true, reason: '', state: speak() }
  }

  const last = state.lastSpeaker
  if (last && last.actor === attempt.actor) {
    const lastMs = Date.parse(last.ts)
    const sinceMs = Number.isFinite(lastMs)
      ? nowMs - lastMs
      : Number.POSITIVE_INFINITY
    const others = activeActors(state, nowMs, windowMs).filter(
      a => a !== attempt.actor,
    )
    if (others.length > 0 && sinceMs < cooldownMs) {
      const retryAfterMs = Math.max(0, cooldownMs - sinceMs)
      return {
        allow: false,
        reason:
          `You broadcast last and ${others.length} other agent(s) are active — yield the turn: ` +
          `wait for a reply or ~${Math.ceil(retryAfterMs / 1000)}s before broadcasting again.`,
        state,
        retryAfterMs,
      }
    }
  }

  return { allow: true, reason: '', state: speak() }
}

function getBroadcastTurnsPath(teamName?: string): string {
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  return join(getTeamsDir(), safeTeam, 'broadcast-turns.json')
}

/**
 * Persisted broadcast-turn check. Returns null when allowed (and records the
 * turn); returns a refusal message when fairness throttles this broadcast.
 *
 * Fast-path: when the resolved cooldown is <= 0 (the default), this never
 * touches disk and never throttles — guaranteeing no observable change in
 * normal use.
 */
export async function checkBroadcastFairness(
  actor: string,
  governance: TeamGovernance | undefined,
  teamName: string | undefined,
): Promise<string | null> {
  const cooldownMs =
    governance?.broadcastFairness?.repostCooldownMs ??
    DEFAULT_BROADCAST_REPOST_COOLDOWN_MS
  // Default / disabled — no-op, no IO.
  if (!(cooldownMs > 0)) return null

  const windowMs =
    governance?.broadcastFairness?.activeWindowMs ??
    DEFAULT_BROADCAST_ACTIVE_WINDOW_MS
  const path = getBroadcastTurnsPath(teamName)
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  await mkdir(join(getTeamsDir(), safeTeam), { recursive: true })

  try {
    await writeFile(path, '{}', { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') {
      // Can't persist state — fail open (allow).
      return null
    }
  }

  const lockFilePath = `${path}.lock`
  let release: (() => Promise<void>) | undefined
  let refusal: string | null = null
  try {
    release = await lockfile.lock(path, {
      lockfilePath: lockFilePath,
      ...LOCK_OPTIONS,
    })
    let raw: unknown = {}
    try {
      raw = jsonParse(await readFile(path, 'utf-8'))
    } catch {
      raw = {}
    }
    const decision = decideBroadcastTurn(raw, {
      actor,
      nowMs: Date.now(),
      repostCooldownMs: cooldownMs,
      activeWindowMs: windowMs,
    })
    if (decision.allow) {
      await writeFile(path, jsonStringify(decision.state, null, 2), 'utf-8')
    } else {
      refusal = decision.reason
    }
  } catch (error) {
    // Fairness is a discipline, not a security boundary — fail open.
    logForDebugging(`[BroadcastFairness] check failed (allowing): ${error}`)
    return null
  } finally {
    if (release) {
      try {
        await release()
      } catch {
        // already released
      }
    }
  }
  return refusal
}

// ===========================================================================
// ITEM 14 — Command-rank authority gate (canDirect)
// ===========================================================================

/**
 * Optional per-member role. When unset, identity stays flat (lead > teammate)
 * and canDirect reproduces default behaviour exactly. A team may configure a role
 * ladder via members[].role to refine directive authority.
 */
export type MemberRole = string

/**
 * Default role ladder, highest authority first. The command
 * ladder shape (operator/field-commander/…/scout) but is only consulted when a
 * team actually assigns roles. Unknown roles hold no rank.
 */
export const DEFAULT_ROLE_LADDER: readonly string[] = Object.freeze([
  'operator',
  'lead',
  'field-commander',
  'room-commander',
  'specialist',
  'teammate',
  'scout',
])

/** Rank of a role: lower index = higher authority. Unknown => +Infinity. */
export function rankOf(
  role: string | undefined,
  ladder: readonly string[] = DEFAULT_ROLE_LADDER,
): number {
  if (!role) return Number.POSITIVE_INFINITY
  const i = ladder.indexOf(role)
  return i === -1 ? Number.POSITIVE_INFINITY : i
}

/** Does role `a` STRICTLY outrank role `b`? Unknown roles never outrank. */
export function outranks(
  a: string | undefined,
  b: string | undefined,
  ladder: readonly string[] = DEFAULT_ROLE_LADDER,
): boolean {
  return rankOf(a, ladder) < rankOf(b, ladder)
}

export type DirectActor = {
  /** Agent name. */
  name: string
  /** True if this actor is the team lead (flat-identity authority). */
  isLead: boolean
  /** Optional configured role (Item 14). */
  role?: string
}

/**
 * Item 14 — resolve an actor's directive authority context (lead flag + optional
 * configured role) from the team roster. Used to gate DIRECTIVE messages via
 * canDirect. Returns a flat (role-less) actor when the team file or member is
 * unavailable, preserving default behaviour. Shared by the SEND path (SendMessageTool)
 * and the RECEIVE path so both gate identically.
 */
export function resolveDirectActor(
  teamFile: TeamFile | null,
  name: string,
  leadAgentId: string | undefined,
): DirectActor {
  const member = teamFile?.members.find(
    m => m.name.toLowerCase() === name.toLowerCase(),
  )
  const isLead =
    name.toLowerCase() === TEAM_LEAD_NAME.toLowerCase() ||
    (!!leadAgentId && member?.agentId === leadAgentId)
  return { name, isLead, role: member?.role }
}

/**
 * May `actor` issue a DIRECTIVE (shutdown/assign/directive) to `target`?
 *
 * DEFAULT (no roles configured): the team lead can direct anyone; a non-lead
 * cannot direct — exactly as today (directive paths were already lead-gated or
 * lead-targeted). When roles ARE configured on both actor and target, the role
 * ladder decides (strictly-higher rank may direct).
 */
export function canDirect(
  actor: DirectActor,
  target: DirectActor,
  ladder: readonly string[] = DEFAULT_ROLE_LADDER,
): { allowed: boolean; reason: string } {
  // Self-directives (e.g. approving one's own shutdown) are never gated.
  if (actor.name === target.name) {
    return { allowed: true, reason: '' }
  }

  // Role ladder takes precedence when the actor carries a configured role.
  if (actor.role) {
    if (outranks(actor.role, target.role, ladder)) {
      return { allowed: true, reason: '' }
    }
    // Lead retains authority even if a target's role is unranked/equal.
    if (actor.isLead) return { allowed: true, reason: '' }
    return {
      allowed: false,
      reason: `${actor.name} (${actor.role}) does not outrank ${target.name}${
        target.role ? ` (${target.role})` : ''
      } — coordinate or escalate, do not direct a peer or superior.`,
    }
  }

  // Flat default: lead directs anyone; non-lead directs no one.
  if (actor.isLead) return { allowed: true, reason: '' }
  return {
    allowed: false,
    reason: `${actor.name} is not the team lead and holds no command role — only the lead can issue directive messages. Send a normal message or escalate to the lead.`,
  }
}
