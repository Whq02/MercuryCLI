import { TENSORFOLD_NOT_BUILT, type TensorFoldEngine } from './contracts.js'

export async function findTensorFoldEngine(): Promise<TensorFoldEngine | null> {
  throw new Error(TENSORFOLD_NOT_BUILT)
}
