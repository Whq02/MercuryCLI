import { modelRefusalBeforeAnyRequest } from '../../services/providers/callModelRouter.js'
import { compatModelRefusal } from '../../services/providers/openaicompat/compatAccounts.js'
import { resolveEngineDispatch, unrecognisedModelWordRefusal } from '../../utils/crew/engineDispatch.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'

export async function resolveHeadlessModel(requested: string): Promise<string> {
  const word = requested.trim().toLowerCase()
  let model: string
  if (word === 'compat' || word === 'local' || word === 'huggingface') {
    const dispatch = await resolveEngineDispatch(word)
    if (dispatch === null) throw new Error(unrecognisedModelWordRefusal(word) ?? `The '${word}' class cannot resolve.`)
    model = dispatch.model
  } else model = parseUserSpecifiedModel(requested)
  const refusal = model.toLowerCase().startsWith('compat/')
    ? compatModelRefusal(model)
    : await modelRefusalBeforeAnyRequest(model)
  if (refusal) throw new Error(refusal)
  return model
}
