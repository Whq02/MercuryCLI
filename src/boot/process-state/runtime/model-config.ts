import type { ModelSetting } from 'src/models/catalogue/engineModel.js'
import type { ModelStrings } from 'src/models/facts/pinnedModelIds.js'

export class ModelConfigOwner {
  engineModelOverride: ModelSetting | undefined = undefined
  modelStrings: ModelStrings | null = null
  sdkBetas: string[] | undefined = undefined
}
