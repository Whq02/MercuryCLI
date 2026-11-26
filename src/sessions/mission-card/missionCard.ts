import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getOriginalCwd } from '../../boot/process-state/processState.js'
import { durableAtomicPublishSync } from '../../platform/substrate/durablePublish.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isENOENT } from '../../platform/errors/errors.js'
import { getProjectDir } from '../transcripts/paths.js'
import { sanitizePathComponent } from '../../engine/task-framework/tasks.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export type MissionCardState = 'armed' | 'paused' | 'met' | 'cleared' | 'continued'

export function missionCardStands(state: string): state is 'armed' | 'paused' {
  return state === 'armed' || state === 'paused'
}

export interface MissionOutcome {
  reason: string
  metAt: string
  turns: number
}

export interface MissionCard {
  schema: 1
  sessionId: string
  goal: string
  state: MissionCardState
  nextStep: string | null
  iterations: number
  setAt: string
  updatedAt: string
  outcome?: MissionOutcome
}

function missionStore(cwd: string = getOriginalCwd()): string {
  return getProjectDir(cwd)
}

function missionCardsDir(store: string): string {
  return join(store, 'missions')
}

function missionCardPath(sessionId: string, store: string): string {
  return join(missionCardsDir(store), `${sanitizePathComponent(sessionId)}.json`)
}

function persistMissionCard(card: MissionCard, cwd?: string): void {
  const store = missionStore(cwd)
  mkdirSync(missionCardsDir(store), { recursive: true })
  durableAtomicPublishSync(missionCardPath(card.sessionId, store), JSON.stringify(card, null, 1))
}

type MissionCardWriteResult =
  | { ok: true; path: string }
  | { ok: false; path: string; error: string }

export function missionCardUnwrittenWords(path: string, error: string): string {
  logForDebugging(`missionCard: could not save ${path}: ${error}`, { level: 'error' })
  return 'the goal could not be saved, so it will not survive this session'
}

export function writeMissionCard(card: MissionCard, cwd?: string): MissionCardWriteResult {
  const path = missionCardPath(card.sessionId, missionStore(cwd))
  try {
    persistMissionCard(card, cwd)
    return { ok: true, path }
  } catch (error) {
    passedOver(error)
    const message = error instanceof Error ? error.message : String(error)
    logForDebugging(`missionCard: write failed for ${path}: ${message}`, { level: 'error' })
    return { ok: false, path, error: message }
  }
}

type MissionCardRead =
  | { state: 'absent' }
  | { state: 'ok'; card: MissionCard }
  | { state: 'unreadable'; path: string; error: unknown }

export function missionCardUnreadWords(path: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${path} could not be read (${detail}) — the goal is not shown`
}

function inspectCard(path: string): MissionCardRead {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return { state: 'absent' }
    return { state: 'unreadable', path, error }
  }
  try {
    const parsed = JSON.parse(raw) as MissionCard
    if (parsed && parsed.schema === 1 && typeof parsed.goal === 'string') {
      return { state: 'ok', card: parsed }
    }
    return { state: 'unreadable', path, error: new Error(`invalid goal card at ${path}`) }
  } catch (error) {
    return { state: 'unreadable', path, error }
  }
}

export function inspectMissionCard(sessionId: string, cwd?: string): MissionCardRead {
  return inspectCard(missionCardPath(sessionId, missionStore(cwd)))
}

export function missionGoalBeside(transcriptPath: string): string | null {
  const read = inspectCard(missionCardPath(basename(transcriptPath, '.jsonl'), dirname(transcriptPath)))
  if (read.state === 'unreadable') passedOver(read.error)
  return read.state === 'ok' && (missionCardStands(read.card.state) || read.card.state === 'met') ? read.card.goal : null
}

export function readMissionCard(sessionId: string, cwd?: string): MissionCard | null {
  const inspected = inspectMissionCard(sessionId, cwd)
  if (inspected.state === 'ok') return inspected.card
  if (inspected.state === 'unreadable') {
    passedOver(inspected.error)
    logForDebugging(`missionCard: read failed for ${sessionId}: ${String(inspected.error)}`)
  }
  return null
}

export function migrateOrphanedMissionCard(conversationId: string, cwd?: string): boolean {
  try {
    const existing = inspectMissionCard(conversationId, cwd)
    if (existing.state !== 'absent') {
      if (existing.state === 'unreadable') {
        logForDebugging(`missionCard: skipping migration over unreadable card for ${conversationId}: ${String(existing.error)}`)
      }
      return false
    }
    const projectDir = missionStore(cwd)
    const dir = missionCardsDir(projectDir)
    if (!existsSync(dir)) return false
    const orphans: MissionCard[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const card = readMissionCard(name.slice(0, -'.json'.length), cwd)
      if (card === null || !missionCardStands(card.state)) continue
      if (existsSync(join(projectDir, `${card.sessionId}.jsonl`))) continue
      orphans.push(card)
    }
    if (orphans.length !== 1) return false
    const orphan = orphans[0]!
    const now = new Date().toISOString()
    persistMissionCard({ ...orphan, sessionId: conversationId, updatedAt: now }, cwd)
    persistMissionCard({ ...orphan, state: 'continued', nextStep: `continued in session ${conversationId}`, updatedAt: now }, cwd)
    logForDebugging(`[mission] migrated the card keyed by a process id (${orphan.sessionId}) to the conversation ${conversationId}`)
    return true
  } catch (error) {
    logForDebugging(`missionCard: migration failed: ${String(error)}`)
    return false
  }
}
