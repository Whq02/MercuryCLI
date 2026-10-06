import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import { crewmateQueuedRows, crewmateQueueSize, crewmateQueueVersion, pruneLandedCrewmateLines, subscribeCrewmateQueue } from './crewmateQueue.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../../tasks/types.js'
import { agentTranscriptFile, resolveAgentTranscriptFile } from '../../tools/WorkflowTool/agentTranscriptReader.js'
import { asAgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { loadTranscriptFile } from '../../utils/sessionStorage/loading.js'
import { getAgentTranscriptPath } from '../../utils/sessionStorage/paths.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import type { CrewmateInView } from './useCrewmateView.js'

export const CREWMATE_TRANSCRIPT_TICK_MS = 2500
export const CREWMATE_TRANSCRIPT_READING = 'reading the crewmate\'s transcript…'
export const CREWMATE_TRANSCRIPT_EMPTY = 'no transcript yet — the crewmate has not written a row'

export type CrewmateTranscript = { messages: Message[]; state: 'reading' | 'ready' | 'empty' }

const EMPTY: Message[] = []

export type CrewmateTranscriptSource = Pick<CrewmateInView, 'taskId' | 'local'> & { facts?: { transcriptAgentId: string | null } | null }

export function crewmateTranscriptAgentId(crewmate: CrewmateTranscriptSource): string | null {
  const local = crewmate.local
  if (local !== undefined && isLocalAgentTask(local)) return local.agentId
  const carried = crewmate.facts?.transcriptAgentId ?? null
  return carried ?? crewmate.taskId
}

function ownTranscriptDir(agentId: string): string | null {
  try {
    return dirname(getAgentTranscriptPath(asAgentId(agentId)))
  } catch {
    return null
  }
}

export function crewmateTranscriptFile(crewmate: CrewmateTranscriptSource, hosted: { sessionId: string; originalCwd: string }): string | null {
  const agentId = crewmateTranscriptAgentId(crewmate)
  if (agentId === null) return null
  const local = crewmate.local
  const own = local !== undefined && isLocalAgentTask(local) ? ownTranscriptDir(agentId) : null
  const carried = hosted.sessionId === '' || hosted.originalCwd === '' ? null : join(getProjectDir(hosted.originalCwd), hosted.sessionId, 'subagents')
  const dirs = [own, carried].filter((dir, index, all): dir is string => dir !== null && all.indexOf(dir) === index)
  const primary = dirs[0]
  if (primary === undefined) return null
  if (dirs.length === 1) return agentTranscriptFile(primary, agentId)
  return resolveAgentTranscriptFile(dirs, agentId) ?? agentTranscriptFile(primary, agentId)
}

export function liveTailOf(local: TaskState | undefined): readonly Message[] {
  if (local === undefined) return EMPTY
  if (isLocalAgentTask(local)) return (local.messages ?? EMPTY) as readonly Message[]
  return EMPTY
}

export function userRowText(row: Message): string | null {
  if (row.type !== 'user') return null
  const content = (row as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.length === 0) return null
  const texts: string[] = []
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block?.type !== 'text' || typeof block.text !== 'string') return null
    texts.push(block.text)
  }
  return texts.join('\n')
}

export function mergeTranscriptRows(disk: readonly Message[], live: readonly Message[]): Message[] {
  const seen = new Set<string>()
  const landedUserTexts: string[] = []
  const out: Message[] = []
  for (const row of disk) {
    const uuid = (row as { uuid?: string }).uuid
    if (uuid !== undefined) {
      if (seen.has(uuid)) continue
      seen.add(uuid)
    }
    const text = userRowText(row)
    if (text !== null) landedUserTexts.push(text)
    out.push(row)
  }
  for (const row of live) {
    const uuid = (row as { uuid?: string }).uuid
    if (uuid !== undefined) {
      if (seen.has(uuid)) continue
      seen.add(uuid)
    }
    const text = userRowText(row)
    if (text !== null && text !== '' && landedUserTexts.some(landed => landed.includes(text))) continue
    out.push(row)
  }
  return out
}

export async function readCrewmateTranscriptFile(file: string, agentId: string): Promise<Message[]> {
  const loaded = await loadTranscriptFile(file, { keepAllLeaves: true })
  const rows: Message[] = []
  for (const row of loaded.messages.values()) {
    const tagged = row as { agentId?: string; isSidechain?: boolean; parentUuid?: string | null }
    if (tagged.agentId !== agentId) continue
    const { isSidechain: _sidechain, parentUuid: _parent, ...bare } = row as Message & { isSidechain?: boolean; parentUuid?: string | null }
    void _sidechain
    void _parent
    rows.push(bare as Message)
  }
  return rows
}

export function landedUserTexts(rows: readonly Message[]): string[] {
  const texts: string[] = []
  for (const row of rows) {
    const text = userRowText(row)
    if (text !== null) texts.push(text)
  }
  return texts
}

export function useCrewmateTranscript(crewmate: CrewmateInView | null, rosterStamp: unknown): CrewmateTranscript | null {
  const taskId = crewmate?.taskId
  const local = crewmate?.local
  const name = crewmate?.name ?? ''
  const running = crewmate?.facts?.running ?? true
  const endedAt = crewmate?.facts?.endedAt ?? null
  const [disk, setDisk] = useState<{ taskId: string; rows: Message[]; read: boolean }>({ taskId: '', rows: EMPTY, read: false })
  const [tick, setTick] = useState(0)
  const queueVersion = useSyncExternalStore(subscribeCrewmateQueue, crewmateQueueVersion, crewmateQueueVersion)
  const inFlight = useRef(false)
  const lastStamp = useRef<string>('')
  const file = useMemo(() => {
    if (crewmate === null) return null
    const connector = getFocusedSessionConnector()
    const workspace = connector.workspace()
    return crewmateTranscriptFile(crewmate, { sessionId: connector.sessionId(), originalCwd: workspace.originalCwd || workspace.cwd })
  }, [crewmate])
  const agentId = crewmate === null ? null : crewmateTranscriptAgentId(crewmate)
  useEffect(() => {
    if (taskId === undefined || file === null || agentId === null) return
    let alive = true
    const read = async (): Promise<void> => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        let stamp = ''
        try {
          const facts = await stat(file)
          stamp = `${facts.size}:${facts.mtimeMs}`
        } catch {
          stamp = 'absent'
        }
        if (stamp === lastStamp.current) return
        lastStamp.current = stamp
        const rows = stamp === 'absent' ? EMPTY : await readCrewmateTranscriptFile(file, agentId)
        if (!alive) return
        pruneLandedCrewmateLines(taskId, landedUserTexts(rows))
        setDisk({ taskId, rows, read: true })
      } finally {
        inFlight.current = false
      }
    }
    void read()
    const timer = setInterval(() => {
      void read()
      if (crewmateQueueSize(taskId) > 0) setTick(n => n + 1)
    }, CREWMATE_TRANSCRIPT_TICK_MS)
    timer.unref?.()
    return () => {
      alive = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the roster stamp re-arms the read on the crew's own cadence
  }, [taskId, file, agentId, rosterStamp])
  useEffect(() => {
    lastStamp.current = ''
  }, [taskId])
  return useMemo(() => {
    if (taskId === undefined) return null
    void queueVersion
    void tick
    const fresh = disk.taskId === taskId
    const queued = crewmateQueuedRows(taskId, { running, endedAt }, name, Date.now())
    const rows = mergeTranscriptRows(fresh ? disk.rows : EMPTY, [...liveTailOf(local), ...queued])
    const state = rows.length > 0 ? 'ready' : fresh && disk.read ? 'empty' : 'reading'
    return { messages: rows, state }
  }, [taskId, disk, local, queueVersion, tick, running, endedAt, name])
}
