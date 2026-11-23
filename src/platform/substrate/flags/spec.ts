export type FlagKind = 'default-on' | 'opt-in' | 'value' | 'mixed'

export type FlagTier = 'display' | 'additive' | 'behavioral' | 'security' | 'infra'

export interface FlagSpec {
  env: string
  kind: FlagKind
  summary: string
  off: string
  consumer: string
  tier?: FlagTier
  evidence?: string
  requires?: string[]
  excludes?: string[]
  interactsWith?: string[]
  retirement?: string
  preBoot?: true
  selfStamped?: true
}
