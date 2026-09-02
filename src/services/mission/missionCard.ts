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
  goal: string
  state: MissionCardState
  nextStep: string | null
  iterations: number
  setAt: string
  updatedAt: string
}

export function missionCardsDir(cwd: string = getOriginalCwd()): string {
  return join(getProjectDir(cwd), 'missions')
}

export function missionCardPath(sessionId: string, cwd?: string): string {
  return join(missionCardsDir(cwd), `${sanitizePathComponent(sessionId)}.json`)
}

export function writeMissionCard(card: MissionCard, cwd?: string): void {
  try {
    const dir = missionCardsDir(cwd)
    mkdirSync(dir, { recursive: true })
    durableAtomicPublishSync(missionCardPath(card.sessionId, cwd), JSON.stringify(card, null, 1))
  } catch (error) {
    logForDebugging(`missionCard: write failed: ${String(error)}`)
  }
}

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
