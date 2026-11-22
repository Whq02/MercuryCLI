import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type ModelCapability = Unbuilt

export function getModelCapability(model: string): ModelCapability | undefined {
  return notBuilt('src/utils/model/modelCapabilities.ts:12')
}
