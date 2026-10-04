import { SYNTHETIC_MODEL } from '../messages/factories.js'
import {
  getDefaultEngineModelSetting,
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from './model.js'

export function servedModelOfAssistantRow(row: {
  type?: unknown
  message?: { model?: unknown }
}): string | undefined {
  if (row.type !== 'assistant') return undefined
  const model = row.message?.model
  return typeof model === 'string' && model !== '' && model !== SYNTHETIC_MODEL ? model : undefined
}

export function billingSafeRetainedForm(servedModel: string): string {
  const resolvedDefault = parseUserSpecifiedModel(getDefaultEngineModelSetting())
  return servedModel === normalizeModelStringForAPI(resolvedDefault) ? resolvedDefault : servedModel
}

export function sessionModelOfEntry(entry: { type?: unknown; model?: unknown }): string | undefined {
  if (entry.type !== 'model') return undefined
  const model = entry.model
  return typeof model === 'string' && model !== '' ? model : undefined
}
