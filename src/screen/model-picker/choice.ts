import type { CatalogueDoorFacet } from '../../models/facts/modelPickerGroups.js'
import type { TensorFoldChoice } from '../tensorfold/tensorfoldRows.js'

export const fmtCtx = (n: number, local = false): string =>
  local && n > 0 && n % 1_048_576 === 0
    ? `${n / 1_048_576}M`
    : local && n > 0 && n % 1024 === 0
      ? `${n / 1024}k`
      : n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
        : `${Math.round(n / 1000)}k`
export type ModelChoice = {
  id: string
  name: string
  tag: string
  ctx: string
  ctxBase?: string
  ctx1m?: string
  group: string
  door?: string
  gated?: boolean
  enableFlag?: string
  gatedReason?: string
  action?: boolean
  searchableAction?: boolean
  expand?: CatalogueDoorFacet
  choice?: string
  rest?: boolean
  key?: string
  tensorfold?: TensorFoldChoice
}
