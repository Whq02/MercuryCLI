import { readFileSync } from 'node:fs'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../../src/platform/settings/config.ts')
enableConfigs()
const accounts = await import('../../../src/models/roads/openai/openaiAccounts.ts')

const stored = (): string | undefined => (JSON.parse(readFileSync(accounts.openaiAuthPathForDisplay(), 'utf8')) as { tokens?: { refreshToken?: string } }).tokens?.refreshToken
const before = stored()
const refreshing = accounts.currentSubscriptionTokens()
console.log(JSON.stringify({ about: 'refresh', before }))
const tokens = await refreshing
console.log(JSON.stringify({ before, after: tokens?.refreshToken, access: tokens?.accessToken, stored: stored() }))
