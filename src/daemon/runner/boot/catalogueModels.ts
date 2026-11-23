import { getModelOptions } from '../../../models/catalogue/modelOptions.js'
import { parseUserSpecifiedModel } from '../../../models/catalogue/engineModel.js'
import { modelSupportsEffort, modelSupportsAdaptiveThinking } from '../../../models/facts/capabilities.js'
import { resolveEffortTruth } from '../../../models/effort/effort.js'
import type { BootMade, BootStep } from '../runnerPorts.js'

export type ModelCatalogueEntry = {
  value: string
  display_name?: string
  description?: string
  supports_effort?: boolean
  supported_effort_levels?: string[]
  supports_adaptive_thinking?: boolean
}

function buildModelCatalogue(): ModelCatalogueEntry[] {
  const options = getModelOptions()
  return options.map(option => {
    const resolved = parseUserSpecifiedModel(option.value) ?? option.value
    const entry: ModelCatalogueEntry = {
      value: option.value,
      display_name: option.label,
      description: option.description,
    }
    if (modelSupportsEffort(resolved)) {
      entry.supports_effort = true
      entry.supported_effort_levels = [...resolveEffortTruth(resolved, undefined).selectable]
    }
    if (modelSupportsAdaptiveThinking(resolved)) entry.supports_adaptive_thinking = true
    return entry
  })
}

function run(): BootMade<'modelInfos'> {
  const modelInfos = buildModelCatalogue()
  return { modelInfos }
}

export const catalogueModels: BootStep<'modelInfos'> = { name: 'catalogueModels', makes: ['modelInfos'], run }
