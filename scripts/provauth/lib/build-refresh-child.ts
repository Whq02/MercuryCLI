import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const [root = '', road = '', clockAheadMs = '0', lifeMs = '120000'] = process.argv.slice(2)
setTimeout(() => {
  console.log(JSON.stringify({ threw: `this process outlived its bound of ${lifeMs} ms` }))
  process.exit(3)
}, Number(lifeMs))
for (const parentGone of ['end', 'close']) process.stdin.once(parentGone, () => process.exit(2))
const from = <T>(file: string): Promise<T> => import(join(root, 'src', file)) as Promise<T>
const { enableConfigs } = await from<typeof import('../../../src/platform/settings/config.ts')>('platform/settings/config.ts')
enableConfigs()
const openai = await from<typeof import('../../../src/models/roads/openai/openaiAccounts.ts')>('models/roads/openai/openaiAccounts.ts')
const xai = await from<typeof import('../../../src/models/roads/xai/xaiOauth.ts')>('models/roads/xai/xaiOauth.ts')

const roads = {
  openai: () => openai.currentSubscriptionTokens({ now: () => Date.now() + Number(clockAheadMs) }),
  xai: () => xai.refreshXaiTokens(),
}
if (road !== 'openai' && road !== 'xai') throw new Error(`no such road: ${road}`)
console.log(JSON.stringify({ ready: true }))
await new Promise<void>(go => process.stdin.once('data', () => go()))
const refreshing = roads[road]()
console.log(JSON.stringify({ about: 'refresh', pid: process.pid }))
try {
  const tokens = await refreshing
  console.log(JSON.stringify({ answer: tokens?.refreshToken ?? null }))
} catch (error) {
  console.log(JSON.stringify({ threw: error instanceof Error ? error.message : String(error) }))
}
process.exit(0)
