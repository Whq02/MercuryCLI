import { readFile } from 'node:fs/promises'
import { useEffect, useState } from 'react'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { crewmateTranscriptFile, CREWMATE_TRANSCRIPT_TICK_MS } from './useCrewmateTranscript.js'
import type { CrewmateInView } from './useCrewmateView.js'

type CrewmateModel = { model: string | null; effort: string | null; next: { model: string | null; effort: string | null } | null }
type CrewmateRecord = { model: string | null; effort: string | null; effortOverride: string | null }
const word = (value: unknown): string | null => typeof value === 'string' && value.trim() !== '' ? value.trim() : null

export function crewmateModelOf(record: CrewmateRecord | null, running: { model: string | null; effort: string | null }): CrewmateModel {
  const model = running.model ?? record?.model ?? null
  const effort = record?.effort ?? running.effort ?? null
  const nextModel = record !== null && record.model !== null && record.model !== model ? record.model : null
  const nextEffort = record !== null && record.effortOverride !== null && record.effortOverride !== effort ? record.effortOverride : null
  return { model, effort, next: nextModel === null && nextEffort === null ? null : { model: nextModel, effort: nextEffort } }
}

export function crewmateMetadataFile(crewmate: Pick<CrewmateInView, 'taskId' | 'local' | 'facts'> | null): string | null {
  if (crewmate === null) return null
  const connector = getFocusedSessionConnector()
  const workspace = connector.workspace()
  return crewmateTranscriptFile(crewmate, { sessionId: connector.sessionId(), originalCwd: workspace.originalCwd || workspace.cwd })?.replace(/\.jsonl$/, '.meta.json') ?? null
}

export function useCrewmateModel(crewmate: CrewmateInView | null): CrewmateModel | null {
  const file = crewmateMetadataFile(crewmate)
  const startedAt = crewmate?.facts?.startedAt
  const [recorded, setRecorded] = useState<{ file: string; identity: CrewmateRecord } | null>(null)
  useEffect(() => {
    if (file === null) return
    let alive = true
    let reading = false
    const read = async (): Promise<void> => {
      if (reading) return
      reading = true
      let identity: CrewmateRecord = { model: null, effort: null, effortOverride: null }
      try {
        const meta = JSON.parse(await readFile(file, 'utf8')) as { model?: unknown; effort?: unknown; effortOverride?: unknown } | null
        identity = { model: word(meta?.model), effort: word(meta?.effort), effortOverride: word(meta?.effortOverride) }
      } catch {
      } finally {
        reading = false
      }
      if (alive) setRecorded(previous => previous?.file === file && previous.identity.model === identity.model && previous.identity.effort === identity.effort && previous.identity.effortOverride === identity.effortOverride ? previous : { file, identity })
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
  const launchModel = local !== undefined && isLocalAgentTask(local) ? word(local.model) : null
  const identity = recorded?.file === file ? recorded.identity : null
  return crewmateModelOf(identity, { model: launchModel ?? crewmate.facts?.model ?? null, effort: crewmate.facts?.effort ?? null })
}
