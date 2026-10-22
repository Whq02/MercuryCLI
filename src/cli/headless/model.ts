import { modelRefusalBeforeAnyRequest } from '../../services/providers/callModelRouter.js'
import { compatModelRefusal } from '../../services/providers/openaicompat/compatAccounts.js'
import { resolveEngineDispatch } from '../../utils/crew/engineDispatch.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'

export async function resolveHeadlessModel(requested: string): Promise<string> {
  const word = requested.trim().toLowerCase()
  const model = word === 'compat' || word === 'local' || word === 'huggingface'
    ? (await resolveEngineDispatch(word))!.model
    : parseUserSpecifiedModel(requested)
  const refusal = model.toLowerCase().startsWith('compat/')
    ? compatModelRefusal(model)
    : await modelRefusalBeforeAnyRequest(model)
  if (refusal) throw new Error(refusal)
  return model
}
