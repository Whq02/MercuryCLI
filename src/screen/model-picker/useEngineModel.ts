import { getEngineModel, type ModelName } from '../../models/catalogue/engineModel.js'

export function useEngineModel(): ModelName {
  return getEngineModel()
}
