import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { usePublish, useTimer } from '../effects/effects.js'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import { crewmateQueuedRows, crewmateQueueSize, crewmateQueueVersion, pruneLandedCrewmateLines, subscribeCrewmateQueue } from './crewmateQueue.js'
import { isCrewmateTask } from '../../engine/tasks/local-agent/crewmateTask.js'
import type { TaskState } from '../../engine/tasks/taskState.js'
import { crewmateTranscriptFileIn, resolveCrewmateTranscriptFile } from '../../crew/crewmates/crewmateTranscriptReader.js'
import { asAgentId } from '../../sessions/transcripts/ids.js'
import type { Message } from '../../engine/message-shapes/message.js'
import { loadTranscriptFile } from '../../sessions/transcripts/loading.js'
import { getCrewmateTranscriptPath } from '../../sessions/transcripts/paths.js'
import { getProjectDir } from '../../sessions/transcripts/sessionStoragePortable.js'
import type { CrewmateInView } from './useCrewmateView.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { errorMessage, isENOENT } from '../../platform/errors/errors.js'
import { subscribeTranscriptFile } from '../../sessions/transcripts/writer.js'
import { subscribeUiClock } from '../cockpit/uiClock.js'
export const CREWMATE_TRANSCRIPT_READING = 'reading the crewmate\'s transcript…'
export const CREWMATE_TRANSCRIPT_EMPTY = 'no transcript yet — the crewmate has not written a row'

export type CrewmateTranscript = { messages: Message[]; state: 'reading' | 'ready' | 'empty' | 'error'; error?: string }

const EMPTY: Message[] = []

export type CrewmateTranscriptSource = Pick<CrewmateInView, 'taskId' | 'local'> & { facts?: { transcriptAgentId: string | null } | null }

export function crewmateTranscriptAgentId(crewmate: CrewmateTranscriptSource): string | null {
  const local = crewmate.local
  if (local !== undefined && isCrewmateTask(local)) return local.agentId
  const carried = crewmate.facts?.transcriptAgentId ?? null
  return carried ?? crewmate.taskId
}

function ownTranscriptDir(agentId: string): string | null {
  try {
    return dirname(getCrewmateTranscriptPath(asAgentId(agentId)))
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function crewmateTranscriptFile(crewmate: CrewmateTranscriptSource, hosted: { sessionId: string; originalCwd: string }): string | null {
  const agentId = crewmateTranscriptAgentId(crewmate)
  if (agentId === null) return null
  const local = crewmate.local
  const own = local !== undefined && isCrewmateTask(local) ? ownTranscriptDir(agentId) : null
  const carried = hosted.sessionId === '' || hosted.originalCwd === '' ? null : join(getProjectDir(hosted.originalCwd), hosted.sessionId, 'subagents')
  const dirs = [own, carried].filter((dir, index, all): dir is string => dir !== null && all.indexOf(dir) === index)
  const primary = dirs[0]
  if (primary === undefined) return null
  if (dirs.length === 1) return crewmateTranscriptFileIn(primary, agentId)
  return resolveCrewmateTranscriptFile(dirs, agentId) ?? crewmateTranscriptFileIn(primary, agentId)
}

export function liveTailOf(local: TaskState | undefined): readonly Message[] {
  if (local === undefined) return EMPTY
  if (isCrewmateTask(local)) return (local.messages ?? EMPTY) as readonly Message[]
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
  const loaded = await loadTranscriptFile(file, { keepAllLeaves: true, throwOnError: true })
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
  const [disk, setDisk] = useState<{ taskId: string; rows: Message[]; read: boolean; error: string | null }>({ taskId: '', rows: EMPTY, read: false, error: null })
  const [tick, setTick] = useState(0)
  const queueVersion = useSyncExternalStore(subscribeCrewmateQueue, crewmateQueueVersion, crewmateQueueVersion)
  const inFlight = useRef(false)
  const pendingRead = useRef(false)
  const latestRead = useRef<(() => Promise<void>) | null>(null)
  const lastStamp = useRef<string>('')
  const hasQueued = taskId !== undefined && crewmateQueueSize(taskId) > 0
  const file = useMemo(() => {
    if (crewmate === null) return null
    const connector = getFocusedSessionConnector()
    const workspace = connector.workspace()
    return crewmateTranscriptFile(crewmate, { sessionId: connector.sessionId(), originalCwd: workspace.originalCwd || workspace.cwd })
  }, [crewmate])
  const agentId = crewmate === null ? null : crewmateTranscriptAgentId(crewmate)
  useTimer(signal => {
    if (taskId === undefined || file === null || agentId === null) return
    const read = async (): Promise<void> => {
      if (inFlight.current) {
        pendingRead.current = true
        return
      }
      inFlight.current = true
      try {
        let stamp = ''
        let readError: string | null = null
        try {
          const facts = await stat(file)
          stamp = `${facts.size}:${facts.mtimeMs}`
        } catch (error) {
          if (isENOENT(error)) {
            stamp = 'absent'
          } else {
            passedOver(error)
            readError = `the transcript at ${file} could not be read (${errorMessage(error)})`
            stamp = `error:${readError}`
          }
        }
        const fullStamp = `${file}|${agentId}|${stamp}`
        if (fullStamp === lastStamp.current) return
        let rows: Message[] = EMPTY
        if (readError === null && stamp !== 'absent') {
          try {
            rows = await readCrewmateTranscriptFile(file, agentId)
          } catch (error) {
            if (!isENOENT(error)) {
              passedOver(error)
              readError = `the transcript at ${file} could not be read (${errorMessage(error)})`
            }
          }
        }
        if (signal.aborted) return
        lastStamp.current = readError !== null ? `${file}|${agentId}|error:${readError}` : fullStamp
        pruneLandedCrewmateLines(taskId, landedUserTexts(rows))
        setDisk({ taskId, rows, read: true, error: readError })
      } finally {
        inFlight.current = false
        if (pendingRead.current) {
          pendingRead.current = false
          void latestRead.current?.()
        }
      }
    }
    latestRead.current = read
    void read()
    const stop = subscribeTranscriptFile(file, () => { void read() })
    return () => {
      if (latestRead.current === read) latestRead.current = null
      stop()
    }
  }, [taskId, file, agentId, rosterStamp])
  useTimer(() => {
    if (!hasQueued) return
    return subscribeUiClock(1000, () => setTick(n => n + 1))
  }, [hasQueued])
  usePublish(() => {
    lastStamp.current = ''
  }, [taskId])
  return useMemo(() => {
    if (taskId === undefined) return null
    void queueVersion
    void tick
    const fresh = disk.taskId === taskId
    const error = fresh ? disk.error : null
    const queued = crewmateQueuedRows(taskId, { running, endedAt }, name, Date.now())
    const rows = mergeTranscriptRows(fresh ? disk.rows : EMPTY, [...liveTailOf(local), ...queued])
    const state = rows.length > 0 ? 'ready' : error !== null ? 'error' : fresh && disk.read ? 'empty' : 'reading'
    return error !== null ? { messages: rows, state, error } : { messages: rows, state }
  }, [taskId, disk, local, queueVersion, tick, running, endedAt, name])
}
