// useAgentTranscriptView — the ONE live agent-transcript read hook, shared by
// the /workflows run view's dossier card (RunDetailPane) and the full agent
// inspector (AgentInspectorPane).
//
// Contract (lifted from AgentInspectorPane's original inline read logic):
//   • reads immediately when armed (agentId resolved + `enabled`) — the callers
//     want content on entry, not behind an extra keypress;
//   • while the agent is still live (`liveState` start/progress), re-reads on
//     each `version` bump (a live task's progressVersion / a disk manifest's
//     mtime), trailing-edge THROTTLED to REREAD_THROTTLE_MS so watching a
//     thinking agent never re-reads the file per progress frame;
//   • switching agents resets to a fresh idle→loading read (keyed effect);
//   • never fabricates: 'missing' when the transcript file isn't there.

import path from 'node:path'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  agentTranscriptFile,
  readAgentMeta,
  readAgentTranscript,
  resolveAgentTranscriptFile,
  type AgentTranscriptView,
} from '../../tools/WorkflowTool/agentTranscriptReader.js'

// Mirrors RUN_MANIFEST_WRITE_THROTTLE_MS so the manifest writer and the live
// re-reads share one cadence.
const REREAD_THROTTLE_MS = 2000

export type AgentReadStatus = 'idle' | 'loading' | 'done' | 'missing'
export type AgentReadState = {
  status: AgentReadStatus
  view?: AgentTranscriptView
  meta?: { agentType?: string; worktreePath?: string; description?: string }
}

export function useAgentTranscriptView(opts: {
  transcriptDir: string
  /** Older destinations this run has written under (the manifest's
   *  append-only transcriptDirs — Q12): a chain that started before a
   *  /clear or cross-session resume is found by fallback, never read as
   *  missing while the file exists. */
  fallbackDirs?: readonly string[]
  agentId: string | undefined
  /** Gate the whole hook (a collapsed surface passes false — zero I/O). */
  enabled: boolean
  /** The agent's live lifecycle state — re-reads only while start/progress. */
  liveState: string | undefined
  /** Live task progressVersion or disk manifest mtime — the re-read trigger. */
  version: number | undefined
}): AgentReadState {
  const { transcriptDir, fallbackDirs, agentId, enabled, liveState, version } = opts
  const [readState, setReadState] = useState<AgentReadState>({ status: 'idle' })
  const lastReadRef = useRef(0)
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Identity guard: a trailing re-read timer's
  // closure captures the agent it was armed FOR; the consumer often re-props
  // the same component instance on selection moves (no key), so the hook never
  // unmounts and a stale timer could land agent A's transcript under agent B's
  // header — permanently, when B is settled (no later read corrects it). Every
  // read stamps the identity it was issued for and bails on mismatch.
  const identityRef = useRef('')
  identityRef.current = `${transcriptDir}|${agentId ?? ''}`

  const doRead = useCallback(async (): Promise<void> => {
    if (!agentId) return
    const issuedFor = `${transcriptDir}|${agentId}`
    // Fallback across every destination the run has written under (
    // Q12) — the primary dir first, then the manifest's append-only list.
    const file =
      resolveAgentTranscriptFile([transcriptDir, ...(fallbackDirs ?? [])], agentId) ??
      agentTranscriptFile(transcriptDir, agentId)
    const [view, meta] = await Promise.all([
      readAgentTranscript(file),
      readAgentMeta(path.dirname(file), agentId),
    ])
    if (identityRef.current !== issuedFor) return // selection moved mid-read
    setReadState({ status: view ? 'done' : 'missing', view, meta })
  }, [agentId, transcriptDir, fallbackDirs])

  // Agent switch ⇒ fresh read state (the dossier must never show the previous
  // agent's prompt while the new one loads) AND kill the previous agent's
  // trailing timer — its closure reads the OLD doRead.
  useEffect(() => {
    setReadState({ status: 'idle' })
    if (pendingRef.current) {
      clearTimeout(pendingRef.current)
      pendingRef.current = null
    }
  }, [agentId, transcriptDir])

  // First read — immediate, unthrottled.
  useEffect(() => {
    if (!enabled || !agentId || readState.status !== 'idle') return
    lastReadRef.current = Date.now()
    setReadState({ status: 'loading' })
    void doRead()
  }, [enabled, agentId, doRead, readState.status])

  // Live re-read while start/progress — trailing-edge throttled. The cleanup
  // kills any timer THIS effect run armed (review BLOCKER: the unmount-only
  // cleanup let a stale timer survive agent switches and deps churn).
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
