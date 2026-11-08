import { getAgentModel } from '../model/agent.js'
import { matchReachableModelName, modelNameHeadlessRefusal } from '../model/modelNameRoad.js'
import { MODEL_LOOKUP_LADDER } from '../model/modelLookup.js'
import { resolveEngineDispatch, unrecognisedModelWordRefusal } from './engineDispatch.js'

export async function crewmateModelOverride(model: string | undefined, parent: string): Promise<string | undefined> {
  if (model === undefined) return undefined
  if (model.trim() === '') throw new Error('Model is empty. Read mercury://models and name a model id.')
  const matched = matchReachableModelName(model, 'pass')
  if (matched !== null && (matched.kind === 'none' || matched.kind === 'ambiguous')) {
    throw new Error(modelNameHeadlessRefusal(matched, 'model') + ' ' + MODEL_LOOKUP_LADDER)
  }
  const word = matched !== null && (matched.kind === 'match' || matched.kind === 'exact') ? matched.id : model
  const resolved = getAgentModel(undefined, parent, word)
  const dispatch = await resolveEngineDispatch(resolved)
  if (dispatch !== null) return dispatch.model
  const refusal = unrecognisedModelWordRefusal(word)
  if (refusal !== null) throw new Error(refusal)
  return resolved
}
