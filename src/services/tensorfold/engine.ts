import { TENSORFOLD_NOT_BUILT, type TensorFoldEngine, type TensorFoldMachine } from './contracts.js'

export async function findTensorFoldEngine(): Promise<TensorFoldEngine | null> {
  throw new Error(TENSORFOLD_NOT_BUILT)
}

export function tensorFoldMachine(): TensorFoldMachine {
  throw new Error(TENSORFOLD_NOT_BUILT)
}
