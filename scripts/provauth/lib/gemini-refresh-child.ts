import { readFileSync } from 'node:fs'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const signIn = process.argv[2]
const { enableConfigs } = await import('../../../src/platform/settings/config.ts')
enableConfigs()
const accounts = await import('../../../src/models/roads/gemini/geminiAccounts.ts')

type Stored = { tokens?: { accessToken?: string }; plan?: { tokens?: { accessToken?: string } } }
const stored = (): string | undefined => {
  const file = JSON.parse(readFileSync(accounts.geminiAuthPathForDisplay(), 'utf8')) as Stored
  return signIn === 'plan' ? file.plan?.tokens?.accessToken : file.tokens?.accessToken
}
const before = stored()
const refreshing = signIn === 'plan' ? accounts.currentGeminiPlanTokens() : accounts.currentGeminiTokens()
console.log(JSON.stringify({ about: 'refresh', before }))
const tokens = await refreshing
console.log(JSON.stringify({ before, access: tokens?.accessToken, refresh: tokens?.refreshToken, stored: stored() }))
