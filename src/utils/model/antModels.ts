/**
 * Internal-only model-override configuration. FOLDED TO INERT CONSTANTS in
 * this build: the override config resolves to nothing, the model list is
 * empty, and resolution passes through. The exported shapes remain for typed
 * consumers; the machinery behind them is deliberately absent.
 */

export type AntModel = {
  model: string
  displayName?: string
}

export type AntModelSwitchCalloutConfig = {
  message?: string
  showFor?: string[]
}

export type AntModelOverrideConfig = {
  models?: AntModel[]
  switchCallout?: AntModelSwitchCalloutConfig
}

/** Inert: no override configuration exists in this build. */
export function getAntModelOverrideConfig(): AntModelOverrideConfig | null {
  return null
}

/** Inert: the internal model list is empty in this build. */
export function getAntModels(): AntModel[] {
  return []
}

/** Inert: resolution never rewrites the model in this build. */
export function resolveAntModel(model: string): string | undefined {
  void model
  return undefined
}
