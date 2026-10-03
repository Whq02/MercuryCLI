import { getEngineModel, type ModelName } from '../utils/model/model.js'

export function useEngineModel(): ModelName {
  return getEngineModel()
}
