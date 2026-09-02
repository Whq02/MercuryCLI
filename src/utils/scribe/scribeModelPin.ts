import type { EffortValue } from '../effort.js'
import { modelSupportsXHighEffort } from '../effort.js'
import { resolveScribeSeat, resolveScribeSeatModel } from '../model/seatSlots.js'
import { focusedOptionSupports1m } from '../model/modelOptions.js'

export function scribeSeatModel(): string {
  return resolveScribeSeatModel().model
}

export function scribeSeatEffort(): EffortValue {
  return resolveScribeSeat().effort
}

let scribeContext1mPref: boolean | undefined = undefined

export function setScribeContext1mPref(use1m: boolean | undefined): void {
  scribeContext1mPref = use1m
}

export function resolvedScribeModel(): string {
  const pinned = scribeSeatModel()
  if (scribeContext1mPref === undefined) return pinned
  const base = pinned.replace(/\[1m\]$/i, '')
  if (!focusedOptionSupports1m(base)) return base
  return scribeContext1mPref ? `${base}[1m]` : base
}

export type ScribeModelSetting = string | null | undefined

export type ScribePinSnapshot = {
  model: ScribeModelSetting
  effort: EffortValue | undefined
}

export function scribePinIsApplicable(): boolean {
  return modelSupportsXHighEffort(resolvedScribeModel())
}

export function decideScribeEngage(): ScribePinSnapshot | null {
  if (!scribePinIsApplicable()) return null
  return { model: resolvedScribeModel(), effort: scribeSeatEffort() }
}

export function decideScribeRestore(
  snapshot: ScribePinSnapshot | null,
  currentModel: ScribeModelSetting,
  currentEffort?: EffortValue | undefined,
): ScribePinSnapshot | null {
  if (snapshot === null) return null
  if (!modelIsScribePin(currentModel)) return null
  if (currentEffort !== undefined && currentEffort !== scribeSeatEffort()) {
    return { model: snapshot.model, effort: currentEffort }
  }
  return snapshot
}

export function modelIsScribePin(model: ScribeModelSetting): boolean {
  return model === resolvedScribeModel()
}

export function decideScribeSessionModel(
  current: ScribePinSnapshot,
): { next: ScribePinSnapshot; snapshot: ScribePinSnapshot } | null {
  if (!scribePinIsApplicable()) return null
  if (modelIsScribePin(current.model) && current.effort === scribeSeatEffort()) return null
  return {
    next: { model: resolvedScribeModel(), effort: scribeSeatEffort() },
    snapshot: { model: current.model, effort: current.effort },
  }
}
