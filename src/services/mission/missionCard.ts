// ============================================================================
//  services/mission/missionCard — the persisted mission card: goal, state,
//  next step, one card per session, on disk where the session's own
//  transcript lives.
//
//  WHY A CARD: the armed mission itself is a process-ephemeral Stop hook
//  (utils/hooks/missionHook.ts — deliberately so; hooks die with the
//  process). The card is the CONTINUITY fact that outlives it:
//    · a resumed session finds its own card and re-arms the hook — the
//      mission survives the process boundary, not just the turn boundary;
//    · compaction can erase the directive text from the transcript, but
//      the card (and the hook's own re-stating refusal) carry the goal;
//    · the concourse surfaces that already exist (the MissionView
//      projection, mercury://mission) read the card like any other owner's
//      fact, so a teammate picking up the session sees goal · state · next
//      step without archaeology.
//
//  The card is a RECORD of the hook's transitions, written best-effort at
//  each one — never load-bearing for the hook's own decisions (the hook
//  map stays the runtime truth; a failed write costs the record, not the
//  mission). One writer: the mission hook. Readers: resume re-arm, the
//  projection, status surfaces.
// ============================================================================
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { logForDebugging } from '../../utils/debug.js'
import { getProjectDir } from '../../utils/sessionStorage/paths.js'
import { sanitizePathComponent } from '../../utils/tasks.js'

export type MissionCardState = 'armed' | 'met' | 'stood-down' | 'cleared' | 'continued'

export interface MissionCard {
  schema: 1
  sessionId: string
  /** The finish line, verbatim as armed. */
  goal: string
  state: MissionCardState
  /** What the loop last said to do — the hand-off sentence. */
  nextStep: string | null
  iterations: number
  setAt: string
  updatedAt: string
}

/** The per-project card directory — beside the session transcripts, so a
 *  card's lifetime and discovery scope match the session's own records. */
export function missionCardsDir(cwd: string = getOriginalCwd()): string {
  return join(getProjectDir(cwd), 'missions')
}

export function missionCardPath(sessionId: string, cwd?: string): string {
  return join(missionCardsDir(cwd), `${sanitizePathComponent(sessionId)}.json`)
}

/** Write (or overwrite) a session's card. Best-effort: a failed write is a
 *  debug line, never a throw into the hook path. */
export function writeMissionCard(card: MissionCard, cwd?: string): void {
  try {
    const dir = missionCardsDir(cwd)
    mkdirSync(dir, { recursive: true })
    durableAtomicPublishSync(missionCardPath(card.sessionId, cwd), JSON.stringify(card, null, 1))
  } catch (error) {
    logForDebugging(`missionCard: write failed: ${String(error)}`)
  }
}

/** A session's card, or null (missing and corrupt both answer null). */
export function readMissionCard(sessionId: string, cwd?: string): MissionCard | null {
  try {
    const path = missionCardPath(sessionId, cwd)
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as MissionCard
    return parsed && parsed.schema === 1 && typeof parsed.goal === 'string' ? parsed : null
  } catch {
    return null
  }
}

/** Every card in this project, newest update first — the concourse survey. */
export function listMissionCards(cwd?: string): MissionCard[] {
  try {
    const dir = missionCardsDir(cwd)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .flatMap(name => {
        try {
          const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as MissionCard
          return parsed && parsed.schema === 1 && typeof parsed.goal === 'string' ? [parsed] : []
        } catch {
          return []
        }
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  } catch {
    return []
  }
}

/**
 * THE ORPHAN MIGRATION (once, at a resume): before the card keyed by the
 * conversation, the cockpit keyed it by its own process id — an id no
 * transcript carries, so a resume adopting the conversation found nothing.
 * When the adopted conversation has no card and exactly ONE armed card is
 * keyed by an id with no transcript in this project, that card is the
 * operator's standing mission: it is re-keyed to the conversation and the
 * old card rewritten as `continued`. Two or more orphans are ambiguous and
 * left alone. Returns whether a card was migrated.
 */
export function migrateOrphanedMissionCard(conversationId: string, cwd?: string): boolean {
  try {
    if (readMissionCard(conversationId, cwd) !== null) return false
    const dir = missionCardsDir(cwd)
    if (!existsSync(dir)) return false
    const projectDir = getProjectDir(cwd ?? getOriginalCwd())
    const orphans: MissionCard[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const card = readMissionCard(name.slice(0, -'.json'.length), cwd)
      if (card === null || card.state !== 'armed') continue
      if (existsSync(join(projectDir, `${card.sessionId}.jsonl`))) continue
      orphans.push(card)
    }
    if (orphans.length !== 1) return false
    const orphan = orphans[0]!
    const now = new Date().toISOString()
    writeMissionCard({ ...orphan, sessionId: conversationId, updatedAt: now }, cwd)
    writeMissionCard({ ...orphan, state: 'continued', nextStep: `continued in session ${conversationId}`, updatedAt: now }, cwd)
    logForDebugging(`[mission] migrated the card keyed by a process id (${orphan.sessionId}) to the conversation ${conversationId}`)
    return true
  } catch (error) {
    logForDebugging(`missionCard: migration failed: ${String(error)}`)
    return false
  }
}
