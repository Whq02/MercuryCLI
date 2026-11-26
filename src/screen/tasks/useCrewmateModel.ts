import { crewmateNextTurnWords } from '../cockpit/crewmateWords.js'
import { readFile } from 'node:fs/promises'
import { useState } from 'react'
import { useTimer } from '../effects/effects.js'
import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import { isCrewmateTask } from '../../engine/tasks/local-agent/crewmateTask.js'
import { getContextWindowForModel } from '../../models/facts/capabilities.js'
import { normalizeModelStringForAPI, parseUserSpecifiedModel, renderModelChip } from '../../models/catalogue/engineModel.js'
import { crewmateTranscriptFile } from './useCrewmateTranscript.js'
import { crewmateLive, useComposerCrewmate, useViewedCrewmate, type CrewmateInView } from './useCrewmateView.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { subscribeCrewmateMetadataPath } from '../../sessions/transcripts/fileWatch.js'

type CrewmateModel = { model: string | null; effort: string | null; next: { model: string | null; effort: string | null } | null }
type CrewmateRecord = { model: string | null; effort: string | null; effortOverride: string | null }
const word = (value: unknown): string | null => typeof value === 'string' && value.trim() !== '' ? value.trim() : null

function resolveAlike(recorded: string, running: string): boolean {
  const [one, other] = [parseUserSpecifiedModel(recorded), parseUserSpecifiedModel(running)]
  return normalizeModelStringForAPI(one) === normalizeModelStringForAPI(other) && getContextWindowForModel(one) === getContextWindowForModel(other)
}

function crewmateModelOf(record: CrewmateRecord | null, running: { model: string | null; effort: string | null }): CrewmateModel {
  const model = running.model ?? record?.model ?? null
  const effort = record?.effort ?? running.effort ?? null
  const nextModel = record !== null && record.model !== null && model !== null && record.model !== model && !resolveAlike(record.model, model) ? record.model : null
  const nextEffort = record !== null && record.effortOverride !== null && record.effortOverride !== effort ? record.effortOverride : null
  return { model, effort, next: nextModel === null && nextEffort === null ? null : { model: nextModel, effort: nextEffort } }
}

export function crewmateMetadataFile(crewmate: Pick<CrewmateInView, 'taskId' | 'local' | 'facts'> | null): string | null {
  if (crewmate === null) return null
  const connector = getFocusedSessionConnector()
  const workspace = connector.workspace()
  return crewmateTranscriptFile(crewmate, { sessionId: connector.sessionId(), originalCwd: workspace.originalCwd || workspace.cwd })?.replace(/\.jsonl$/, '.meta.json') ?? null
}

export function crewmateContextPercent(crewmate: CrewmateInView, model: string | null): number | null {
  const context = crewmate.facts?.tokens?.context ?? null
  if (context === null || model === null) return null
  try {
    const window = getContextWindowForModel(crewmate.facts?.model ?? model)
    return window > 0 ? Math.round((context / window) * 100) : null
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function useCrewmateModel(crewmate: CrewmateInView | null): CrewmateModel | null {
  const file = crewmateMetadataFile(crewmate)
  const startedAt = crewmate?.facts?.startedAt
  const [recorded, setRecorded] = useState<{ file: string; identity: CrewmateRecord } | null>(null)
  useTimer(signal => {
    if (file === null) return
    let reading = false
    let pending = false
    const read = async (): Promise<void> => {
      if (reading) {
        pending = true
        return
      }
      reading = true
      let identity: CrewmateRecord = { model: null, effort: null, effortOverride: null }
      try {
        const meta = JSON.parse(await readFile(file, 'utf8')) as { model?: unknown; effort?: unknown; effortOverride?: unknown } | null
        identity = { model: word(meta?.model), effort: word(meta?.effort), effortOverride: word(meta?.effortOverride) }
      } catch (error) {
        passedOver(error)
      } finally {
        reading = false
      }
      if (!signal.aborted) setRecorded(previous => previous?.file === file && previous.identity.model === identity.model && previous.identity.effort === identity.effort && previous.identity.effortOverride === identity.effortOverride ? previous : { file, identity })
      if (pending && !signal.aborted) {
        pending = false
        void read()
      }
    }
    void read()
    const stop = subscribeCrewmateMetadataPath(file, () => { void read() })
    return () => {
      stop()
    }
  }, [file, startedAt])
  if (crewmate === null) return null
  const local = crewmate.local
  const launchModel = local !== undefined && isCrewmateTask(local) ? word(local.model) : null
  const identity = recorded?.file === file ? recorded.identity : null
  return crewmateModelOf(identity, { model: launchModel ?? crewmate.facts?.model ?? null, effort: crewmate.facts?.effort ?? null })
}

export function useCrewmateIdentity() {
  const viewed = useViewedCrewmate()
  const target = useComposerCrewmate()
  const crewmate = viewed ?? target
  const identity = useCrewmateModel(crewmate)
  if (crewmate === null || identity === null) return null
  const { model, effort, next } = identity
  return {
    address: viewed === null ? `main chat: ${crewmate.name}` : `viewing ${viewed.name}`,
    viewed: viewed !== null,
    live: crewmateLive(crewmate),
    running: crewmate.running,
    model: model === null ? 'model unreported' : renderModelChip(model),
    effort,
    next: next === null ? '' : crewmateNextTurnWords(renderModelChip(next.model ?? model ?? ''), next.effort ?? effort),
    contextPercent: crewmateContextPercent(crewmate, model),
  }
}
