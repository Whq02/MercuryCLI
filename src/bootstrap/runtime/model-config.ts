import type { ModelSetting } from 'src/utils/model/model.js'
import type { ModelStrings } from 'src/utils/model/modelStrings.js'

export class ModelConfigOwner {
  mainLoopModelOverride: ModelSetting | undefined = undefined
  initialMainLoopModel: ModelSetting = null
  modelStrings: ModelStrings | null = null
  sdkBetas: string[] | undefined = undefined
}
