
import { getMarketingNameForModel, normalizeModelStringForAPI } from '../utils/model/model.js'

export function mercuryEngineIdentityLine(modelId: string): string {
  const wireId = normalizeModelStringForAPI(modelId)
  const marketing = getMarketingNameForModel(wireId)
  const named = marketing !== null && marketing.length > 0 ? ` (${marketing})` : ''
  return `In this seat the model you run through Mercury is \`${wireId}\`${named}; asked which model runs you, name it exactly.`
}
