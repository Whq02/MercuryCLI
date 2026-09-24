import type { KimiRegion } from '../providers/moonshot/moonshotAccounts.js'
import type { WalletAuthKind, WalletProvider } from './wallet.js'

export type IdentityKind = 'device-code' | 'subscription' | 'oauth' | 'api-key'

const ACCOUNT_WORDS: Record<WalletProvider, string> = {
  anthropic: 'Claude account',
  openai: 'ChatGPT account',
  gemini: 'Google account',
  moonshot: 'Kimi account',
  huggingface: 'Hugging Face account',
  openrouter: 'OpenRouter account',
}

const DEVICE_CODE_SIGN_INS: ReadonlySet<WalletProvider> = new Set<WalletProvider>(['moonshot', 'huggingface'])

const KIMI_HOST_WORDS: Record<KimiRegion, string> = { global: 'global', 'mainland-cn': 'mainland China' }

export function isWalletProvider(id: string): id is WalletProvider {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_WORDS, id)
}

export function accountWordOf(provider: WalletProvider): string {
  return ACCOUNT_WORDS[provider]
}

export function identityKindOf(entry: { provider: WalletProvider; kind: WalletAuthKind }): IdentityKind {
  if (entry.kind === 'api-key') return 'api-key'
  if (entry.kind === 'subscription-oauth') return 'subscription'
  return DEVICE_CODE_SIGN_INS.has(entry.provider) ? 'device-code' : 'oauth'
}

export function kimiHostWords(region: KimiRegion): string {
  return KIMI_HOST_WORDS[region]
}

export function identityWords(provider: WalletProvider, kind: IdentityKind, account?: string, host?: string): string {
  const how = host !== undefined ? `${kind}, ${host}` : kind
  return account !== undefined ? `${ACCOUNT_WORDS[provider]} · ${account} (${how})` : `${ACCOUNT_WORDS[provider]} · ${how}`
}

export function signInWords(provider: WalletProvider, kind: WalletAuthKind, account?: string, host?: string): string {
  return identityWords(provider, identityKindOf({ provider, kind }), account, host)
}
