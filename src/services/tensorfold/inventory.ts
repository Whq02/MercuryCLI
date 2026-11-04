import { TENSORFOLD_NOT_BUILT, type TensorFoldEngine, type TensorFoldModelRow } from './contracts.js'

export async function readTensorFoldInventory(engine: TensorFoldEngine): Promise<TensorFoldModelRow[]> {
  void engine
  throw new Error(TENSORFOLD_NOT_BUILT)
}

export function bestTensorFoldFit(rows: readonly TensorFoldModelRow[]): TensorFoldModelRow | null {
  void rows
  throw new Error(TENSORFOLD_NOT_BUILT)
}
