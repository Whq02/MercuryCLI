import type { ModelSetting } from 'src/models/catalogue/engineModel.js'
import type { PinnedModelIds } from 'src/models/facts/pinnedModelIds.js'

export class ModelConfigOwner {
  engineModelOverride: ModelSetting | undefined = undefined
  modelStrings: PinnedModelIds | null = null
  sdkBetas: string[] | undefined = undefined
}
