export type TensorFoldFamily = {
  id: string
  repos: readonly string[]
  quantisations: readonly string[]
  drafter?: string
  promptCacheDefaultGib?: number
  qualified: boolean
}

export type TensorFoldOptionalLibrary = { name: string; found: boolean; note?: string }

export type TensorFoldEngine = {
  version: string
  binary: string
  chip: string
  backends: readonly string[]
  families: readonly TensorFoldFamily[]
  optionalLibraries?: readonly TensorFoldOptionalLibrary[]
}

export type TensorFoldModelState = 'serving' | 'loading' | 'on-disk' | 'pulling' | 'not-pulled'

export type TensorFoldFitVerdict = 'fits' | 'needs-gpu-limit' | 'too-big'

export type TensorFoldFitParts = {
  weightsGib: number
  drafterGib?: number
  cacheGib: number
  promptCacheGib?: number
  promptCacheCapGib?: number
  runtimeGib: number
}

export type TensorFoldFit = {
  verdict: TensorFoldFitVerdict
  neededGib: number
  availableGib: number
  estimate: true
  reason?: string
  remedy?: string
  parts?: TensorFoldFitParts
}

export type TensorFoldLadderRung = { window: number; fit: TensorFoldFit }

export type TensorFoldLastReply = { firstTokenMs?: number; tokensPerSecond?: number }

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
  label?: string
  downloadBytes?: number
  ladder?: readonly TensorFoldLadderRung[]
  inUseBytes?: number
  startedBy?: 'mercury' | 'outside'
  lastReply?: TensorFoldLastReply
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
  drafter?: string
  promptCacheGib?: number
}

export type TensorFoldHostOrigin = 'lan-paired' | 'typed' | 'pod' | 'app'

export type TensorFoldHost = {
  name: string
  baseUrl: string
  origin: TensorFoldHostOrigin
  keyRef?: string
  serving?: string
  version?: string
  chip?: string
  window?: number
  lastReply?: TensorFoldLastReply
}

export type TensorFoldMachine = { chip: string; usableGib?: number }

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
