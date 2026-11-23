#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

console.log('============================================================')
console.log(' the quiet boot — no first-party side request at boot')
console.log('============================================================')

for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_MODEL',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'HF_TOKEN',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
  'MERCURY_FEEDBACK_COMMAND',
  'MERCURY_BUG_COMMAND',
]) {
  delete process.env[key]
}
delete process.env.NODE_ENV
const scratch = mkdtempSync(join(tmpdir(), 'prove-quiet-boot-roads-'))
const home = join(scratch, 'home')
const project = join(scratch, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(project, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const served: Array<{ method: string; url: string }> = []
const fixture = createServer((req, res) => {
  served.push({ method: req.method ?? '', url: req.url ?? '' })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{}')
})
const port = await new Promise<number>(resolvePort => {
  fixture.listen(0, '127.0.0.1', () => {
    const address = fixture.address()
    resolvePort(typeof address === 'object' && address !== null ? address.port : 0)
  })
})
const BASE = `http://127.0.0.1:${port}`
process.env.MERCURY_ANTHROPIC_OAUTH_BASE = BASE
process.env.ANTHROPIC_BASE_URL = BASE
writeFileSync(
  join(home, '.credentials.json'),
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fixture-access-token-000000000001',
      refreshToken: 'fixture-refresh-token-00000000001',
      expiresAt: 4102444800000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'enterprise',
      rateLimitTier: null,
    },
  }),
)


section('§2 the wire is quiet — the features the roads fed still answer, and the fixture serves nothing')
{
  const { enableConfigs } = await import('../../src/platform/settings/config.js')
  enableConfigs()
  const state = await import('../../src/boot/process-state/processState.js')
  state.setOriginalCwd(project)

  const { getModelOptions } = await import('../../src/models/catalogue/modelOptions.js')
  const rows = getModelOptions()
  check('the model list answers from the catalogue (rows present)', rows.length > 0, `${rows.length} rows — getModelOptions() in src/models/catalogue/modelOptions.ts must return the catalogue rows without a network read`)
  check('…with first-party rows for the signed-in account', rows.some(r => /claude|opus|sonnet|fable|haiku/i.test(r.value)), `${rows.map(r => r.value).slice(0, 8).join(', ')} — getModelOptions() in src/models/catalogue/modelOptions.ts must list first-party rows for the fixture's signed-in account`)

  const mdm = await import('../../src/platform/settings/mdm/settings.js')
  const settings = await import('../../src/platform/settings/settings.js')
  const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.js')
  mdm.setMdmSettingsCache({ settings: { engine: { model: 'policy-model' } }, errors: [] }, { settings: {}, errors: [] })
  resetSettingsCache()
  const origin = settings.getPolicySettingsOrigin()
  check('the policy origin is the device profile on this machine', origin === 'plist' || origin === 'hklm', `${String(origin)} — getPolicySettingsOrigin() in src/platform/settings/settings.ts must report the device profile (plist or hklm) when the MDM cache holds settings`)
  check('the per-source policy read answers the device profile', settings.getSettingsForSource('policySettings')?.engine?.model === 'policy-model', 'getSettingsForSource(policySettings) in src/platform/settings/settings.ts must return the settings set through setMdmSettingsCache')
  check('no policy origin is ever remote', String(origin) !== 'remote', `${String(origin)} — getPolicySettingsOrigin() in src/platform/settings/settings.ts must not return a remote origin`)
  mdm.clearMdmSettingsCache()
  resetSettingsCache()

  const feedback = (await import('../../src/commands/feedback/index.js')).default
  check('the bug-report command is on by default (no policy service consulted)', feedback.isEnabled() === true, 'feedbackEnabled() in src/commands/feedback/index.ts returned false with the default environment')
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  check('…and off under the essential-traffic posture (the local rule)', feedback.isEnabled() === false, 'feedbackEnabled() in src/commands/feedback/index.ts must return false when MERCURY_DISABLE_NONESSENTIAL_TRAFFIC=1')
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC

  await sleep(300)
  check('the fixture served NOTHING across every ask (no first-party side road fired)', served.length === 0, `${JSON.stringify(served)} — a boot-time road called the fixture; find the caller of that url and make it silent until a meter is shown or the operator asks`)

  const usage = await import('../../src/models/roads/providerUsage.js')
  const reader = await import('../../src/models/roads/anthropic/anthropicUsageState.js')
  reader._resetAnthropicUsageReaderForTesting()
  check('hidden: no meter is shown and nothing was read', !usage.providerUsageMeterShown() && served.length === 0, `shown=${usage.providerUsageMeterShown()} served=${JSON.stringify(served)} — providerUsageMeterShown() in src/models/roads/providerUsage.ts must be false with no watcher`)
  const release = usage.watchProviderUsageWhileShown({ family: () => 'anthropic' })
  await sleep(400)
  const usageReads = (): number => served.filter(s => s.url.includes('/api/oauth/usage')).length
  check('a shown meter reads the usage endpoint once', usageReads() === 1, `${JSON.stringify(served)} — watchProviderUsageWhileShown() in src/models/roads/providerUsage.ts must read /api/oauth/usage exactly once on show`)
  const releaseSecond = usage.watchProviderUsageWhileShown({ family: () => 'anthropic' })
  await sleep(300)
  check('a meter re-shown inside the floor makes no request', usageReads() === 1, `${JSON.stringify(served)} — watchProviderUsageWhileShown() in src/models/roads/providerUsage.ts must honour its refresh floor`)
  await usage.refreshProviderUsage('anthropic', { reason: 'operator' })
  check("the operator's retry reads again", usageReads() === 2, `${JSON.stringify(served)} — refreshProviderUsage(..., { reason: 'operator' }) in src/models/roads/providerUsage.ts must bypass the floor`)
  releaseSecond()
  release()
  await sleep(300)
  check('hidden again, nothing reads', !usage.providerUsageMeterShown() && usageReads() === 2, `${JSON.stringify(served)} — releasing every watcher in src/models/roads/providerUsage.ts must stop the meter and its reads`)
  check('every request the fixture saw was the usage read', served.every(s => s.url.includes('/api/oauth/usage')), `${JSON.stringify(served)} — a road other than the usage read called the fixture; find its caller by url`)
  served.length = 0
}

section('§3 poison control — the ledger works')
{
  const before = served.length
  try {
    await fetch(`${BASE}/poison`)
  } catch {
  }
  await sleep(50)
  check('a request to the fixture IS ledgered', served.length === before + 1 && served.at(-1)?.url === '/poison', JSON.stringify(served))
}

await new Promise<void>(resolveClose => fixture.close(() => resolveClose()))
try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
}
console.log(failures === 0 ? '\n✅ prove-quiet-boot-roads — all checks pass' : `\n❌ prove-quiet-boot-roads — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
