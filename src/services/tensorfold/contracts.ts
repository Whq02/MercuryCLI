export type TensorFoldFamily = {
  id: string
  repos: readonly string[]
  quantisations: readonly string[]
  drafter?: string
  promptCacheDefaultGib?: number
  qualified: boolean
}

export type TensorFoldEngine = {
  version: string
  binary: string
  chip: string
  backends: readonly string[]
  families: readonly TensorFoldFamily[]
}

export type TensorFoldModelState = 'serving' | 'loading' | 'on-disk' | 'pulling' | 'not-pulled'

export type TensorFoldFitVerdict = 'fits' | 'needs-gpu-limit' | 'too-big'

export type TensorFoldFit = {
  verdict: TensorFoldFitVerdict
  neededGib: number
  availableGib: number
  estimate: true
  reason?: string
  remedy?: string
}

export type TensorFoldModelRow = {
  repo: string
  shortName: string
  family: string
  state: TensorFoldModelState
  fit: TensorFoldFit
  window: number
  qualified: boolean
  drafter?: string
  promptCacheGib?: number
  port?: number
  loadingSeconds?: number
  bytesOnDisk?: number
}

export type TensorFoldServeRequest = {
  repo: string
  window: number
  name?: string
  port?: number
  drafter?: string
  promptCacheGib?: number
}

export type TensorFoldServed = {
  repo: string
  name: string
  port: number
  window: number
  pid: number
  startedAt: string
  keyFile?: string
}

export type TensorFoldHostOrigin = 'lan-paired' | 'typed' | 'pod' | 'app'

export type TensorFoldHost = {
  name: string
  baseUrl: string
  origin: TensorFoldHostOrigin
  keyRef?: string
  serving?: string
  version?: string
}

export type HelperModelSize = '2b' | '4b' | 'session'

export type HelperModelState = {
  enabled: boolean
  size?: HelperModelSize
  engine?: 'tensorfold' | 'llamacpp'
  repo?: string
  port?: number
}

export type TensorFoldPullProgress = { repo: string; bytes: number; totalBytes?: number }

export const TENSORFOLD_NOT_BUILT = 'TensorFold support is not built on this branch yet'
