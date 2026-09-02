
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

export function getAntModelOverrideConfig(): AntModelOverrideConfig | null {
  return null
}

export function getAntModels(): AntModel[] {
  return []
}

export function resolveAntModel(model: string): string | undefined {
  void model
  return undefined
}
