import { recordSignIn, type SignInLedgerIo } from '../accounts/signInLedger.js'

const KNOWN_FAMILIES = new Set([
  'anthropic',
  'openai',
  'zai',
  'moonshot',
  'deepseek',
  'openai-compat',
  'openrouter',
  'gemini',
  'huggingface',
  'local',
])

export interface DefaultProviderReads {
  configuredProvider?: () => string | undefined
}

export function configuredDefaultProvider(reads?: DefaultProviderReads): string | undefined {
  try {
    const raw =
      reads?.configuredProvider !== undefined
        ? reads.configuredProvider()
        : (
            require('../config.js') as { getGlobalConfig: () => { defaultProvider?: string } }
          ).getGlobalConfig().defaultProvider
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    return KNOWN_FAMILIES.has(trimmed) ? trimmed : undefined
  } catch {
    return undefined
  }
}

export function switchDefaultProvider(family: string, io?: SignInLedgerIo): boolean {
  if (!KNOWN_FAMILIES.has(family)) return false
  return recordSignIn(family, 'operator-switch', io)
}

export function knownDefaultProviderFamilies(): readonly string[] {
  return [...KNOWN_FAMILIES]
}
