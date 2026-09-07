import { getMainLoopModel, type ModelName } from '../utils/model/model.js'

export function useMainLoopModel(): ModelName {
  return getMainLoopModel()
}
