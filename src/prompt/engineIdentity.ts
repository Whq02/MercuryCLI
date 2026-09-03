
import { getMarketingNameForModel, normalizeModelStringForAPI } from '../utils/model/model.js'

export function mercuryEngineIdentityLine(modelId: string): string {
  const wireId = normalizeModelStringForAPI(modelId)
  const marketing = getMarketingNameForModel(wireId)
  const named = marketing !== null && marketing.length > 0 ? ` (${marketing})` : ''
  return `Mercury is what you are; the model you run through Mercury is \`${wireId}\`${named}. That id is your engine, never a second name for you: asked which model runs you, name it plainly and exactly; asked who you are, the answer is Mercury.`
}
