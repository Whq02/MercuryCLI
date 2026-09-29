import { flagPair } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../debug.js'
import { daemonSnapshot } from '../cockpit/daemonSnapshot.js'
import {
  clearDeadSupervisorRecords,
  daemonControlRpc,
} from '../../daemon/controlSocket.js'
import { spawnOwnedDaemon } from '../../daemon/ownedDaemon.js'
import { clearDaemonHaltStanddown } from '../daemonStanddown.js'
import {
  CREW_TEAM,
  crewEnabled,
  isValidCrewName,
} from '../../daemon/crewSpawn.js'
import { readTeamFileAsync } from '../swarm/teamHelpers.js'
import {
  getMailboxStore,
  markMessagesFromAsRead,
  readMailbox,
  writeToMailbox,
  type TeammateMessage,
} from '../teammateMailbox.js'
import type { DaemonRequest, WireRosterEntry } from '../../daemon/protocol.js'
import type { CrewSeatGlanceV1 } from '../../services/crew/roster.js'

export const CREW_LEAD_INBOX = 'team-lead'

export function isRetryableSpawnReplyCode(code: string | undefined, frameWritten?: boolean): boolean {
  return code === 'ESTARTING' || frameWritten === false && (code === 'ENOCONN' || code === 'ETIMEOUT')
}


export function ensureCrewDaemon(projectDir: string): void {
  clearDaemonHaltStanddown()
  if (!crewEnabled()) return
  let state: string
  try {
    state = daemonSnapshot().state
  } catch (e) {
    logForDebugging(`[crew] ensureCrewDaemon: probe failed: ${e}`)
    return
  }
  if (state !== 'live') {
    spawnCrewDaemon(projectDir)
    return
  }
  void (async () => {
    let sawConnRefusal = false
    for (let i = 0; i < 8; i++) {
      try {
        const ping = await daemonControlRpc({ op: 'ping' }, { timeoutMs: 1000 })
        if (ping.ok) return
      } catch (e) {
        const msg = String(e)
        if (msg.includes('ENOCONN') || msg.includes('ENOENT') || msg.includes('ECONNREFUSED')) {
          sawConnRefusal = true
        }
      }
      await new Promise(res => setTimeout(res, 1000))
    }
    if (!sawConnRefusal) {
      logForDebugging('[crew] daemon slow but its socket never refused — alive-but-busy, no clearance')
      return
    }
    logForDebugging('[crew] recorded daemon is pid-alive but not serving — clearing + respawning')
    try {
      await clearDeadSupervisorRecords()
    } catch {
    }
    spawnCrewDaemon(projectDir)
  })()
}

function spawnCrewDaemon(projectDir: string): void {
  spawnOwnedDaemon(projectDir, {
    label: 'crew',
    extraEnv: { ...flagPair('MERCURY_DAEMON_CREW', '1') },
  })
}


export interface CrewSpawnResult {
  ok: boolean
  pid?: number
  error?: string
}

export async function spawnCrewTeammate(
  name: string,
  modelKey: string,
  projectDir: string,
): Promise<CrewSpawnResult> {
  if (!crewEnabled()) return { ok: false, error: 'crew is disabled (MERCURY_CREW=0)' }
  if (!isValidCrewName(name)) {
    return { ok: false, error: 'name must be [a-z][a-z0-9-]{1,15} (reserved names refused)' }
  }
  if (String(modelKey).trim() === '') {
    return { ok: false, error: 'pick a model — a family word (openai, anthropic, …), a generation key or a model id' }
  }
  ensureCrewDaemon(projectDir)
  let lastError = 'daemon did not become ready'
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const reply = await daemonControlRpc(
        { op: 'crewSpawn', name, model: String(modelKey), cwd: projectDir } as DaemonRequest,
        { timeoutMs: 3000 },
      )
      if (reply.ok && reply.op === 'crewSpawn') return { ok: true, pid: reply.pid }
      if (!reply.ok) {
        if (isRetryableSpawnReplyCode(reply.code, reply.frameWritten)) {
          lastError = reply.error ?? 'daemon still starting'
        } else {
          return { ok: false, error: reply.error }
        }
      }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
    await new Promise(r => setTimeout(r, 400))
  }
  return { ok: false, error: `spawn timed out: ${lastError}` }
}

export const CREW_SEAT_ID_PREFIX = 'seat:'

export function crewResumeNoModelWords(name: string): string {
  return `no model is recorded for @${name} — spawn it again with n and name its model`
}

export function crewResumingWords(name: string): string {
  return `resuming @${name} from its transcript…`
}

export function crewResumedWords(name: string): string {
  return `@${name} resumed from its transcript — it continues under the same name and model`
}

export function crewResumeRefusedWords(name: string, reason: string | undefined): string {
  return `the resume of @${name} was refused: ${reason ?? 'no reason given'}`
}

export function crewMessageWakesWords(name: string): string {
  return `@${name} was stopped — the message wakes it from its transcript`
}

export async function resumeCrewTeammate(name: string, model: string | undefined, projectDir: string): Promise<CrewSpawnResult> {
  if (model === undefined || model.trim() === '') return { ok: false, error: crewResumeNoModelWords(name) }
  return spawnCrewTeammate(name, model, projectDir)
}

export async function killCrewTeammate(name: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const reply = await daemonControlRpc({ op: 'kill', short: name } as DaemonRequest, { timeoutMs: 3000 })
    if (reply.ok) return { ok: true }
    return { ok: false, error: reply.error }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export async function crewRosterStatus(names: readonly string[]): Promise<Map<string, WireRosterEntry>> {
  const out = new Map<string, WireRosterEntry>()
  if (names.length === 0) return out
  try {
    const reply = await daemonControlRpc({ op: 'list' } as DaemonRequest, { timeoutMs: 1500 })
    if (reply.ok && reply.op === 'list') {
      for (const j of reply.jobs) {
        if (!j.outcome && names.includes(j.short)) out.set(j.short, j)
      }
    }
  } catch {
  }
  return out
}


export interface CrewMemberInfo {
  name: string
  model?: string
  joinedAt: number
  cwd?: string
  worktree?: string
}

export async function listCrewMembers(): Promise<CrewMemberInfo[]> {
  const team = await readTeamFileAsync(CREW_TEAM)
  if (!team) return []
  return team.members
    .filter(m => m.name !== CREW_LEAD_INBOX)
    .map(m => ({
      name: m.name,
      model: m.model,
      joinedAt: m.joinedAt,
      ...(typeof m.cwd === 'string' && m.cwd !== '' ? { cwd: m.cwd } : {}),
      ...(typeof m.worktreePath === 'string' && m.worktreePath !== '' ? { worktree: m.worktreePath } : {}),
    }))
}

export async function crewSeatGlances(): Promise<CrewSeatGlanceV1[]> {
  const members = await listCrewMembers()
  if (members.length === 0) return []
  const [status, unread] = await Promise.all([crewRosterStatus(members.map(m => m.name)), crewUnreadCounts()])
  return members.map(m => {
    const live = status.get(m.name)
    return {
      name: m.name,
      ...(live?.model !== undefined && live.model !== '' ? { model: live.model } : m.model !== undefined ? { model: m.model } : {}),
      online: live !== undefined,
      unread: unread.get(m.name) ?? 0,
      ...(live?.busy !== undefined ? { busy: live.busy } : {}),
      ...(live?.pid !== undefined ? { pid: live.pid } : {}),
      ...(live !== undefined ? { startedAt: live.startedAt } : {}),
      joinedAt: m.joinedAt,
      ...(live?.turnStartedAt !== undefined ? { turnStartedAt: live.turnStartedAt } : {}),
      ...(live?.cwd !== undefined ? { cwd: live.cwd } : m.cwd !== undefined ? { cwd: m.cwd } : {}),
      ...(live?.worktree !== undefined ? { worktree: live.worktree } : m.worktree !== undefined ? { worktree: m.worktree } : {}),
    }
  })
}

export interface CrewChatRow {
  ts: number
  dir: 'out' | 'in'
  text: string
  read: boolean
}

const toTs = (m: TeammateMessage): number => {
  const t = Date.parse(m.timestamp ?? '')
  return Number.isFinite(t) ? t : 0
}

export async function readCrewChat(name: string): Promise<CrewChatRow[]> {
  const [outbox, leadInbox] = await Promise.all([
    readMailbox(name, CREW_TEAM),
    readMailbox(CREW_LEAD_INBOX, CREW_TEAM),
  ])
  const rows: CrewChatRow[] = []
  for (const m of outbox) {
    if (m.from === CREW_LEAD_INBOX) rows.push({ ts: toTs(m), dir: 'out', text: m.text, read: !!m.read })
  }
  for (const m of leadInbox) {
    if (m.from === name) rows.push({ ts: toTs(m), dir: 'in', text: m.text, read: !!m.read })
  }
  rows.sort((a, b) => a.ts - b.ts)
  return rows
}

export async function crewUnreadCounts(): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const leadInbox = await readMailbox(CREW_LEAD_INBOX, CREW_TEAM)
  for (const m of leadInbox) {
    if (!m.read && m.from) out.set(m.from, (out.get(m.from) ?? 0) + 1)
  }
  return out
}

export async function sendCrewMessage(name: string, text: string): Promise<boolean> {
  const trimmed = text.trim()
  if (!trimmed) return false
  return writeToMailbox(
    name,
    { from: CREW_LEAD_INBOX, text: trimmed, timestamp: new Date().toISOString() },
    CREW_TEAM,
  )
}

export async function markCrewChatRead(name: string): Promise<void> {
  await markMessagesFromAsRead(CREW_LEAD_INBOX, name, CREW_TEAM)
}

export function crewChatStores(name: string): { outbox: { subscribe: (fn: () => void) => () => void }; leadInbox: { subscribe: (fn: () => void) => () => void } } {
  return {
    outbox: getMailboxStore(name, CREW_TEAM),
    leadInbox: getMailboxStore(CREW_LEAD_INBOX, CREW_TEAM),
  }
}
