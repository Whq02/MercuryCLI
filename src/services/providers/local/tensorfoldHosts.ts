import { TENSORFOLD_NOT_BUILT, type HelperModelState, type TensorFoldHost } from '../../tensorfold/contracts.js'

export async function rememberTensorFoldHost(host: TensorFoldHost): Promise<void> {
  void host
  throw new Error(TENSORFOLD_NOT_BUILT)
}

export async function forgetTensorFoldHost(name: string): Promise<void> {
  void name
  throw new Error(TENSORFOLD_NOT_BUILT)
}

export function tensorFoldHosts(): readonly TensorFoldHost[] {
  throw new Error(TENSORFOLD_NOT_BUILT)
}

export function helperModelState(): HelperModelState {
  throw new Error(TENSORFOLD_NOT_BUILT)
}
