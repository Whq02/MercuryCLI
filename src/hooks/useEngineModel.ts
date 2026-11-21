import { getEngineModel, type ModelName } from '../services/model/model.js'

export function useEngineModel(): ModelName {
  return getEngineModel()
}
