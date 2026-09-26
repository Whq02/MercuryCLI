import { readFile } from 'node:fs/promises'
import { useEffect, useState } from 'react'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId } from '../../types/ids.js'
import { getAgentMetadataPath } from '../../utils/sessionStorage/paths.js'
import { crewmateTranscriptFile, CREWMATE_TRANSCRIPT_TICK_MS } from './useCrewmateTranscript.js'
import type { CrewmateInView } from './useCrewmateView.js'

type CrewmateModel = { model: string | null; effort: string | null }
const word = (value: unknown): string | null => typeof value === 'string' && value.trim() !== '' ? value.trim() : null

function metadataFile(crewmate: CrewmateInView | null): string | null {
  if (crewmate === null) return null
  const local = crewmate.local
  if (local !== undefined && isInProcessTeammateTask(local)) {
    return getAgentMetadataPath(asAgentId(local.identity.agentId))
  }
  const connector = getFocusedSessionConnector()
  const workspace = connector.workspace()
  return crewmateTranscriptFile(crewmate, { sessionId: connector.sessionId(), originalCwd: workspace.originalCwd || workspace.cwd })?.replace(/\.jsonl$/, '.meta.json') ?? null
}

export function useCrewmateModel(crewmate: CrewmateInView | null): CrewmateModel | null {
  const file = metadataFile(crewmate)
  const startedAt = crewmate?.facts?.startedAt
  const [recorded, setRecorded] = useState<{ file: string; identity: CrewmateModel } | null>(null)
  useEffect(() => {
    if (file === null) return
    let alive = true
    let reading = false
    const read = async (): Promise<void> => {
      if (reading) return
      reading = true
      let identity: CrewmateModel = { model: null, effort: null }
      try {
        const meta = JSON.parse(await readFile(file, 'utf8')) as { model?: unknown; effort?: unknown; effortOverride?: unknown } | null
        identity = { model: word(meta?.model), effort: word(meta?.effort) ?? word(meta?.effortOverride) }
      } catch {
      } finally {
        reading = false
      }
      if (alive) setRecorded(previous => previous?.file === file && previous.identity.model === identity.model && previous.identity.effort === identity.effort ? previous : { file, identity })
    }
    void read()
    const timer = setInterval(() => { void read() }, CREWMATE_TRANSCRIPT_TICK_MS)
    timer.unref?.()
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [file, startedAt])
  if (crewmate === null) return null
  const local = crewmate.local
  const launchModel = local !== undefined && (isLocalAgentTask(local) || isInProcessTeammateTask(local)) ? word(local.model) : null
  const identity = recorded?.file === file ? recorded.identity : null
  return { model: identity?.model ?? launchModel ?? crewmate.facts?.model ?? null, effort: identity?.effort ?? null }
}
