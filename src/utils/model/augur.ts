
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getCanonicalName, getMainLoopModel } from './model.js'

export const AUGUR_BETA_HEADER = 'pewter-owl-2026-04-01'

const AUGUR_VARIANTS = ['augur_header', 'augur_tool', 'augur_brief'] as const
export type AugurVariant = (typeof AUGUR_VARIANTS)[number]

function triBoolFlag(name: string): boolean | undefined {
  const raw = flagEnv(name)
  if (raw === undefined || raw === '') return undefined
  if (isEnvTruthy(raw)) return true
  if (isEnvDefinedFalsy(raw)) return false
  return undefined
}

export function augurPinnedModel(): string {
  const fromEnv = flagEnv('MERCURY_AUGUR_MODEL')
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim()
  }
  return ''
}

function augurVariantEnabled(_variant: AugurVariant): boolean {
  const familyOverride = triBoolFlag('MERCURY_AUGUR')
  if (familyOverride !== undefined) {
    return familyOverride
  }
  const pinned = augurPinnedModel()
  if (pinned !== '' && !getCanonicalName(getMainLoopModel()).includes(pinned)) {
    return false
  }
  return false
}

export function isAugurHeader(): boolean {
  return augurVariantEnabled('augur_header')
}

export function isAugurTool(): boolean {
  const armOverride = triBoolFlag('MERCURY_AUGUR_TOOL')
  if (armOverride !== undefined) {
    return armOverride
  }
  return augurVariantEnabled('augur_tool')
}

export function isAugurBrief(): boolean {
  const armOverride = triBoolFlag('MERCURY_AUGUR_BRIEF')
  if (armOverride !== undefined) {
    return armOverride
  }
  return augurVariantEnabled('augur_brief')
}
