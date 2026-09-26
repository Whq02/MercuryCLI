import { useEffect, useMemo, useRef, useState } from 'react'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import type { TaskState } from '../../tasks/types.js'
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

export function crewmateTranscriptFile(crewmate: Pick<CrewmateInView, 'taskId' | 'local'>, hosted: { sessionId: string; originalCwd: string }): string | null {
  const local = crewmate.local
  if (local !== undefined && isLocalAgentTask(local)) {
    try {
      return getAgentTranscriptPath(asAgentId(local.agentId))
    } catch {
      return null
    }
  }
  if (local !== undefined && isInProcessTeammateTask(local)) return null
  if (hosted.sessionId === '' || hosted.originalCwd === '') return null
  return join(getProjectDir(hosted.originalCwd), hosted.sessionId, 'subagents', `agent-${crewmate.taskId}.jsonl`)
}

export function liveTailOf(local: TaskState | undefined): readonly Message[] {
  if (local === undefined) return EMPTY
  if (isLocalAgentTask(local) || isInProcessTeammateTask(local)) return (local.messages ?? EMPTY) as readonly Message[]
  return EMPTY
}

export function mergeTranscriptRows(disk: readonly Message[], live: readonly Message[]): Message[] {
  const seen = new Set<string>()
  const out: Message[] = []
  for (const row of disk) {
    const uuid = (row as { uuid?: string }).uuid
    if (uuid !== undefined) {
      if (seen.has(uuid)) continue
      seen.add(uuid)
    }
    out.push(row)
  }
  for (const row of live) {
    const uuid = (row as { uuid?: string }).uuid
    if (uuid !== undefined) {
      if (seen.has(uuid)) continue
      seen.add(uuid)
    }
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

export function useCrewmateTranscript(crewmate: CrewmateInView | null, rosterStamp: unknown): CrewmateTranscript | null {
  const taskId = crewmate?.taskId
  const local = crewmate?.local
  const [disk, setDisk] = useState<{ taskId: string; rows: Message[]; read: boolean }>({ taskId: '', rows: EMPTY, read: false })
  const inFlight = useRef(false)
  const lastStamp = useRef<string>('')
  const file = useMemo(() => {
    if (crewmate === null) return null
    const connector = getFocusedSessionConnector()
    const workspace = connector.workspace()
    return crewmateTranscriptFile(crewmate, { sessionId: connector.sessionId(), originalCwd: workspace.originalCwd || workspace.cwd })
  }, [crewmate])
  const agentId = local !== undefined && isLocalAgentTask(local) ? local.agentId : taskId
  useEffect(() => {
    if (taskId === undefined || file === null || agentId === undefined) return
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
        if (alive) setDisk({ taskId, rows, read: true })
      } finally {
        inFlight.current = false
      }
    }
    void read()
    const timer = setInterval(() => void read(), CREWMATE_TRANSCRIPT_TICK_MS)
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
    const fresh = disk.taskId === taskId
    const rows = mergeTranscriptRows(fresh ? disk.rows : EMPTY, liveTailOf(local))
    const state = rows.length > 0 ? 'ready' : fresh && disk.read ? 'empty' : 'reading'
    return { messages: rows, state }
  }, [taskId, disk, local])
}
