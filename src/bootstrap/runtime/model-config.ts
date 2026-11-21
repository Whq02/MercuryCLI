import type { ModelSetting } from 'src/services/model/model.js'
import type { ModelStrings } from 'src/utils/model/modelStrings.js'

export class ModelConfigOwner {
  engineModelOverride: ModelSetting | undefined = undefined
  modelStrings: ModelStrings | null = null
  sdkBetas: string[] | undefined = undefined
}
