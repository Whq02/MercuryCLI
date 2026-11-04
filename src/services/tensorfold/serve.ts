import { TENSORFOLD_NOT_BUILT, type TensorFoldModelRow, type TensorFoldPullProgress, type TensorFoldServeRequest, type TensorFoldServed } from './contracts.js'

export async function startTensorFold(request: TensorFoldServeRequest): Promise<TensorFoldServed> {
  void request
  throw new Error(TENSORFOLD_NOT_BUILT)
}

export async function stopTensorFold(name: string): Promise<void> {
  void name
  throw new Error(TENSORFOLD_NOT_BUILT)
}

export async function pullTensorFold(repo: string, onProgress: (progress: TensorFoldPullProgress) => void): Promise<void> {
  void repo
  void onProgress
  throw new Error(TENSORFOLD_NOT_BUILT)
}

export function servedTensorFold(): readonly TensorFoldServed[] {
  throw new Error(TENSORFOLD_NOT_BUILT)
}

export function tensorFoldWillRun(row: TensorFoldModelRow, window: number): string[] {
  void row
  void window
  throw new Error(TENSORFOLD_NOT_BUILT)
}
