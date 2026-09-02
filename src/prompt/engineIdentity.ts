
import { getMarketingNameForModel } from '../utils/model/model.js'

export function mercuryEngineIdentityLine(modelId: string): string {
  const marketing = getMarketingNameForModel(modelId)
  const named = marketing !== null && marketing.length > 0 ? ` (${marketing})` : ''
  return `Mercury is what you are; the model you run through Mercury is \`${modelId}\`${named}. That id is your engine, never a second name for you: asked which model runs you, name it plainly and exactly; asked who you are, the answer is Mercury.`
}
