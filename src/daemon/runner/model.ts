import { loginsActionFor } from '../../screen/concourse-model/workerModels.js'
import { modelRefusalBeforeAnyRequest } from '../../models/roads/callModelRouter.js'
import { compatModelRefusal } from '../../models/roads/openaicompat/compatAccounts.js'
import { resolveEngineDispatch, unrecognisedModelWordRefusal } from '../../crew/crewmates/engineDispatch.js'
import { parseUserSpecifiedModel } from '../../models/catalogue/engineModel.js'
import { resetSettingsCache } from '../../platform/settings/settingsCache.js'

function compatRefusalAfterReread(model: string): string | undefined {
  const refusal = compatModelRefusal(model)
  if (refusal === undefined || !refusal.includes('has no configured endpoint')) return refusal
  resetSettingsCache()
  return compatModelRefusal(model)
}
export async function resolveHeadlessModel(requested: string): Promise<string> {
  const word = requested.trim().toLowerCase()
  let model: string
  if (word === 'compat' || word === 'local' || word === 'huggingface') {
    const dispatch = await resolveEngineDispatch(word)
    if (dispatch === null) throw new Error(unrecognisedModelWordRefusal(word) ?? `The '${word}' class cannot resolve.`)
    model = dispatch.model
  } else model = parseUserSpecifiedModel(requested)
  const refusal = model.toLowerCase().startsWith('compat/')
    ? compatRefusalAfterReread(model)
    : await modelRefusalBeforeAnyRequest(model)
  if (refusal) throw new Error(refusal)
  return model
}

export function bootModelRefusalLine(model: string, refusal: string): string {
  const wayOn = model.toLowerCase().startsWith('compat/')
    ? loginsActionFor('openai-compat').replace(/^ask the operator to /, '')
    : 'pick another model with /model'
  return `${refusal.trim().replace(/\.$/, '')} — ${wayOn}`
}
