import { readFileSync } from 'node:fs'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const road = process.argv[2]
const { enableConfigs } = await import('../../../src/platform/settings/config.ts')
enableConfigs()
const kimi = await import('../../../src/models/roads/moonshot/moonshotAccounts.ts')
const huggingface = await import('../../../src/models/roads/huggingface/huggingfaceAccounts.ts')

const roads = {
  kimi: { store: kimi.moonshotAuthPathForDisplay(), refresh: () => kimi.refreshMoonshotTokens() },
  huggingface: { store: huggingface.huggingfaceAuthPathForDisplay(), refresh: () => huggingface.refreshHuggingfaceTokens() },
}
if (road !== 'kimi' && road !== 'huggingface') throw new Error(`no such road: ${road}`)
const { store, refresh } = roads[road]
const stored = (): string | undefined => (JSON.parse(readFileSync(store, 'utf8')) as { tokens?: { refreshToken?: string } }).tokens?.refreshToken
const before = stored()
const refreshing = refresh()
console.log(JSON.stringify({ about: 'refresh', before }))
const tokens = await refreshing
console.log(JSON.stringify({ before, after: tokens?.refreshToken, access: tokens?.accessToken, stored: stored() }))
