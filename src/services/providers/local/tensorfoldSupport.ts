import { TENSORFOLD_NOT_BUILT } from '../../tensorfold/contracts.js'

export type TensorFoldSupportFacts = {
  version?: string
  backend?: string
  chip?: string
  host?: string
  osVersion?: string
  repo?: string
  drafter?: string
  context?: number
  promptCacheGib?: number
  mercuryVersion?: string
}

export type TensorFoldSupportFocus = Pick<TensorFoldSupportFacts, 'repo' | 'drafter' | 'context' | 'promptCacheGib' | 'host'>

export function tensorFoldSupportLine(facts: TensorFoldSupportFacts): string {
  void facts
  throw new Error(TENSORFOLD_NOT_BUILT)
}

export async function readTensorFoldSupportLine(focus?: TensorFoldSupportFocus): Promise<string | undefined> {
  void focus
  throw new Error(TENSORFOLD_NOT_BUILT)
}
