
import path from 'node:path'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  agentTranscriptFile,
  readAgentMeta,
  readAgentTranscript,
  resolveAgentTranscriptFile,
  type AgentTranscriptView,
} from '../../tools/WorkflowTool/agentTranscriptReader.js'

const REREAD_THROTTLE_MS = 2000

export type AgentReadStatus = 'idle' | 'loading' | 'done' | 'missing'
export type AgentReadState = {
  status: AgentReadStatus
  view?: AgentTranscriptView
  meta?: { agentType?: string; worktreePath?: string; description?: string }
}

export function useAgentTranscriptView(opts: {
  transcriptDir: string
  fallbackDirs?: readonly string[]
  agentId: string | undefined
  enabled: boolean
  liveState: string | undefined
  version: number | undefined
}): AgentReadState {
  const { transcriptDir, fallbackDirs, agentId, enabled, liveState, version } = opts
  const [readState, setReadState] = useState<AgentReadState>({ status: 'idle' })
  const lastReadRef = useRef(0)
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const identityRef = useRef('')
  identityRef.current = `${transcriptDir}|${agentId ?? ''}`

  const doRead = useCallback(async (): Promise<void> => {
    if (!agentId) return
    const issuedFor = `${transcriptDir}|${agentId}`
    const file =
      resolveAgentTranscriptFile([transcriptDir, ...(fallbackDirs ?? [])], agentId) ??
      agentTranscriptFile(transcriptDir, agentId)
    const [view, meta] = await Promise.all([
      readAgentTranscript(file),
      readAgentMeta(path.dirname(file), agentId),
    ])
    if (identityRef.current !== issuedFor) return
    setReadState({ status: view ? 'done' : 'missing', view, meta })
  }, [agentId, transcriptDir, fallbackDirs])

  useEffect(() => {
    setReadState({ status: 'idle' })
    if (pendingRef.current) {
      clearTimeout(pendingRef.current)
      pendingRef.current = null
    }
  }, [agentId, transcriptDir])

  useEffect(() => {
    if (!enabled || !agentId || readState.status !== 'idle') return
    lastReadRef.current = Date.now()
    setReadState({ status: 'loading' })
    void doRead()
  }, [enabled, agentId, doRead, readState.status])

  useEffect(() => {
    if (!enabled || !agentId) return
    if (liveState !== 'start' && liveState !== 'progress') return
    const now = Date.now()
    const sinceLast = now - lastReadRef.current
    if (sinceLast >= REREAD_THROTTLE_MS) {
      lastReadRef.current = now
      void doRead()
    } else if (!pendingRef.current) {
      pendingRef.current = setTimeout(() => {
        pendingRef.current = null
        lastReadRef.current = Date.now()
        void doRead()
      }, REREAD_THROTTLE_MS - sinceLast)
    }
    return () => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current)
        pendingRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, enabled, agentId, liveState, doRead])

  useEffect(
    () => () => {
      if (pendingRef.current) clearTimeout(pendingRef.current)
    },
    [],
  )

  return readState
}
