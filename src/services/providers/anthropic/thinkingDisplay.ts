import { THINKING_DISPLAY_UPDATES_BETA_HEADER } from '../../../constants/betas.js'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import { logForDebugging } from '../../../utils/debug.js'
import { modelNarratesInThinkingBlocks } from '../../../utils/model/capabilities.js'
import { isFirstPartyAnthropicBaseUrl } from '../../../utils/model/providers.js'

export type ThinkingDisplay = 'updates'

export type ThinkingDisplayField = { display: ThinkingDisplay }

export interface ThinkingDisplaySetting {
  display: ThinkingDisplay | null
  explicit: boolean
}

export function resolveThinkingDisplaySetting(raw: string | undefined): ThinkingDisplaySetting {
  if (raw === undefined || raw.trim() === '') return { display: null, explicit: false }
  const value = raw.trim().toLowerCase()
  if (value === 'updates' || value === '1' || value === 'true') return { display: 'updates', explicit: true }
  if (value === '0' || value === 'off' || value === 'false' || value === 'none' || value === 'omitted') {
    return { display: null, explicit: true }
  }
  logForDebugging(
    `MERCURY_THINKING_DISPLAY=${raw}: not a known value (updates · off) — riding updates`,
    { level: 'warn' },
  )
  return { display: 'updates', explicit: true }
}

export interface ThinkingDisplayReads {
  firstParty?: () => boolean
  env?: string | undefined
}

export function applyThinkingDisplay<T extends { type: string }>(
  model: string,
  thinking: T | undefined,
  betas: string[],
  reads?: ThinkingDisplayReads,
): T | (T & ThinkingDisplayField) | undefined {
  if (thinking === undefined || thinking.type === 'disabled') return thinking
  if (!modelNarratesInThinkingBlocks(model)) return thinking
  const raw = reads !== undefined && 'env' in reads ? reads.env : flagEnv('MERCURY_THINKING_DISPLAY')
  const setting = resolveThinkingDisplaySetting(raw)
  if (setting.display === null) return thinking
  if (!setting.explicit) {
    const firstParty = (reads?.firstParty ?? isFirstPartyAnthropicBaseUrl)()
    if (!firstParty) return thinking
  }
  if (!betas.includes(THINKING_DISPLAY_UPDATES_BETA_HEADER)) {
    betas.push(THINKING_DISPLAY_UPDATES_BETA_HEADER)
  }
  return { ...thinking, display: setting.display }
}
