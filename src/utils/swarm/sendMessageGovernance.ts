
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


export type OpenQuestion = {
  request_id: string
  from: string
  to: string
  text: string
  summary?: string
  askedAt: string
  answeredAt?: string
  answeredBy?: string
  answerText?: string
}

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

async function mutateQuestions(
  teamName: string | undefined,
  mutate: (questions: OpenQuestion[]) => OpenQuestion[],
): Promise<void> {
  const path = getQuestionsPath(teamName)
  const team = teamName || getTeamName() || 'default'
  const safeTeam = sanitizePathComponent(team)
  const dir = join(getTeamsDir(), safeTeam)
  await mkdir(dir, { recursive: true })

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
      }
    }
  }
}

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

export function canAnswerCloseQuestion(
  question: { to?: string; answeredAt?: string },
  answeredBy: string,
): boolean {
  if (question.answeredAt) return false
  const addressee = (question.to ?? '').trim().toLowerCase()
  return addressee.length > 0 && addressee === (answeredBy ?? '').trim().toLowerCase()
}

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

export async function listOpenQuestions(
  agentName: string,
  teamName?: string,
): Promise<OpenQuestion[]> {
  const questions = await readQuestions(teamName)
  const me = (agentName ?? '').trim().toLowerCase()
  return questions.filter(
    q => (q.to ?? '').trim().toLowerCase() === me && !q.answeredAt,
  )
}


export type TeamGovernance = {
  broadcastEnabled?: boolean
  broadcastFairness?: {
    repostCooldownMs?: number
    activeWindowMs?: number
  }
}

export type TeamFileWithGovernance = TeamFile & {
  governance?: TeamGovernance
}

export function checkBroadcastAllowed(
  teamFile: TeamFileWithGovernance | null,
  isLead: boolean,
): string | null {
  if (!teamFile || teamFile.governance?.broadcastEnabled !== false) {
    return null
  }
  if (isLead) return null
  return 'Broadcasts (to: "*") are disabled for non-leads on this team (governance.broadcastEnabled=false). Send directed messages, or ask the team-lead to broadcast.'
}


export const DEFAULT_BROADCAST_REPOST_COOLDOWN_MS = 0
export const DEFAULT_BROADCAST_ACTIVE_WINDOW_MS = 10 * 60 * 1000

type BroadcastTurnState = {
  lastSpeaker: { actor: string; ts: string } | null
  lastSpokeAt: Record<string, string>
}

function freshTurnState(): BroadcastTurnState {
  return { lastSpeaker: null, lastSpokeAt: {} }
}

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
    for (const [actor, ts] of Object.entries(next.lastSpokeAt)) {
      const t = Date.parse(ts)
      if (!Number.isFinite(t) || nowMs - t > windowMs) {
        delete next.lastSpokeAt[actor]
      }
    }
    return next
  }

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

export async function checkBroadcastFairness(
  actor: string,
  governance: TeamGovernance | undefined,
  teamName: string | undefined,
): Promise<string | null> {
  const cooldownMs =
    governance?.broadcastFairness?.repostCooldownMs ??
    DEFAULT_BROADCAST_REPOST_COOLDOWN_MS
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
    logForDebugging(`[BroadcastFairness] check failed (allowing): ${error}`)
    return null
  } finally {
    if (release) {
      try {
        await release()
      } catch {
      }
    }
  }
  return refusal
}


export type MemberRole = string

export const DEFAULT_ROLE_LADDER: readonly string[] = Object.freeze([
  'operator',
  'lead',
  'field-commander',
  'room-commander',
  'specialist',
  'teammate',
  'scout',
])

export function rankOf(
  role: string | undefined,
  ladder: readonly string[] = DEFAULT_ROLE_LADDER,
): number {
  if (!role) return Number.POSITIVE_INFINITY
  const i = ladder.indexOf(role)
  return i === -1 ? Number.POSITIVE_INFINITY : i
}

export function outranks(
  a: string | undefined,
  b: string | undefined,
  ladder: readonly string[] = DEFAULT_ROLE_LADDER,
): boolean {
  return rankOf(a, ladder) < rankOf(b, ladder)
}

export type DirectActor = {
  name: string
  isLead: boolean
  role?: string
}

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

export function canDirect(
  actor: DirectActor,
  target: DirectActor,
  ladder: readonly string[] = DEFAULT_ROLE_LADDER,
): { allowed: boolean; reason: string } {
  if (actor.name === target.name) {
    return { allowed: true, reason: '' }
  }

  if (actor.role) {
    if (outranks(actor.role, target.role, ladder)) {
      return { allowed: true, reason: '' }
    }
    if (actor.isLead) return { allowed: true, reason: '' }
    return {
      allowed: false,
      reason: `${actor.name} (${actor.role}) does not outrank ${target.name}${
        target.role ? ` (${target.role})` : ''
      } — coordinate or escalate, do not direct a peer or superior.`,
    }
  }

  if (actor.isLead) return { allowed: true, reason: '' }
  return {
    allowed: false,
    reason: `${actor.name} is not the team lead and holds no command role — only the lead can issue directive messages. Send a normal message or escalate to the lead.`,
  }
}
