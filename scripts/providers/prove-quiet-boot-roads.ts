#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
console.log(' the quiet boot — the first-party side roads are gone')
console.log('============================================================')

for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
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
  'DISABLE_TELEMETRY',
  'DISABLE_FEEDBACK_COMMAND',
  'DISABLE_BUG_COMMAND',
  'MERCURY_AUGUR',
  'MERCURY_AUGUR_MODEL',
  'MERCURY_AUGUR_TOOL',
  'MERCURY_AUGUR_BRIEF',
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
process.env.MERCURY_CUSTOM_OAUTH_URL = BASE
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

section('§1 the roads are gone (source)')
{
  for (const gone of [
    'src/services/api/bootstrap.ts',
    'src/utils/apiPreconnect.ts',
    'src/services/policyLimits',
    'src/services/remoteManagedSettings',
    'src/components/ManagedSettingsSecurityDialog',
    'src/bridge',
    'src/hooks/notifs/useCanSwitchToExistingSubscription.tsx',
  ]) {
    check(`gone: ${gone}`, !existsSync(join(ROOT, gone)))
  }
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(ts|tsx)$/.test(entry) && !/\.generated\.ts$/.test(entry)) files.push(path)
    }
  }
  walk(join(ROOT, 'src'))
  const spelled = (needle: string): string[] => files.filter(f => readFileSync(f, 'utf8').includes(needle)).map(f => f.slice(ROOT.length + 1))
  for (const needle of [
    '/api/claude_cli/bootstrap',
    '/api/claude_code/policy_limits',
    '/api/claude_code/settings',
    '/api/web/domain_info',
    '/api/claude_cli_profile',
    '/api/oauth/files/',
    'http://1.1.1.1',
    'checkQuotaStatus',
    'preconnectAnthropicApi',
    'startup-prefetch-batch',
    'hasInternetAccess',
  ]) {
    const hits = spelled(needle)
    check(`no source file spells ${needle}`, hits.length === 0, hits.join(', '))
  }
  const webfetch = readFileSync(join(ROOT, 'src/tools/WebFetchTool/utils.ts'), 'utf8')
  check('WebFetch asks no policy service (no preflight in the module)', !/preflight/i.test(webfetch) && !webfetch.includes('domain_info'))
  const repl = readFileSync(join(ROOT, 'src/screens/REPL.tsx'), 'utf8')
  check("the composer's mount-time key read makes no request (probe: false)", repl.includes('reverify({ probe: false })'))
  const hook = readFileSync(join(ROOT, 'src/hooks/useApiKeyVerification.ts'), 'utf8')
  check('the key hook honours probe: false before any wire call', hook.indexOf('opts?.probe === false') !== -1 && hook.indexOf('opts?.probe === false') < hook.indexOf('await verifyApiKey('))
  const main = readFileSync(join(ROOT, 'src/main.tsx'), 'utf8')
  check('the boot registers no startup request batch', !main.includes('startup-prefetch-batch') && !main.includes('runStartupPrefetchBatch'))
  const limits = readFileSync(join(ROOT, 'src/services/claudeAiLimits.ts'), 'utf8')
  check('the usage record holds no quota probe', !limits.includes('quota_check') && !limits.includes("content: 'quota'"))
  check('the boot arms no usage clock', !main.includes("'usage-poll'") && !main.includes('armProviderUsagePoll'))
  const usageOwner = readFileSync(join(ROOT, 'src/services/providers/providerUsage.ts'), 'utf8')
  check('the usage owner keeps no timer and no turn poke', !usageOwner.includes('setInterval') && !usageOwner.includes('pokeProviderUsage'))
  const frame = readFileSync(join(ROOT, 'src/components/MercuryFrame.tsx'), 'utf8')
  check('the frame pokes no reader after a turn; its chips read on show', !frame.includes('pokeProviderUsage') && frame.includes('useProviderUsageOnShow('))
  check("the picker's catalogue is not primed at boot idle", !repl.includes('getGptSeatAvailability'))
}

section('§2 the wire is quiet — the features the roads fed still answer, and the fixture serves nothing')
{
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const state = await import('../../src/bootstrap/state.js')
  state.setOriginalCwd(project)

  const { getModelOptions } = await import('../../src/utils/model/modelOptions.js')
  const rows = getModelOptions()
  check('the model list answers from the catalogue (rows present)', rows.length > 0, String(rows.length))
  check('…with first-party rows for the signed-in account', rows.some(r => /claude|opus|sonnet|fable|haiku/i.test(r.value)), rows.map(r => r.value).slice(0, 8).join(', '))

  const mdm = await import('../../src/utils/settings/mdm/settings.js')
  const settings = await import('../../src/utils/settings/settings.js')
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
  mdm.setMdmSettingsCache({ settings: { model: 'policy-model' }, errors: [] }, { settings: {}, errors: [] })
  resetSettingsCache()
  const origin = settings.getPolicySettingsOrigin()
  check('the policy origin is the device profile on this machine', origin === 'plist' || origin === 'hklm', String(origin))
  check('the per-source policy read answers the device profile', settings.getSettingsForSource('policySettings')?.model === 'policy-model')
  check('no policy origin is ever remote', String(origin) !== 'remote')
  mdm.clearMdmSettingsCache()
  resetSettingsCache()

  const feedback = (await import('../../src/commands/feedback/index.js')).default
  check('the bug-report command is on by default (no policy service consulted)', feedback.isEnabled() === true)
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  check('…and off under the essential-traffic posture (the local rule)', feedback.isEnabled() === false)
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC

  const augur = await import('../../src/utils/model/augur.js')
  check('a variant switch is off by default', augur.isAugurHeader() === false)
  process.env.MERCURY_AUGUR = '1'
  check('…and on by the operator\'s own environment', augur.isAugurHeader() === true)
  delete process.env.MERCURY_AUGUR

  await sleep(300)
  check('the fixture served NOTHING across every ask (no first-party side road fired)', served.length === 0, JSON.stringify(served))

  const usage = await import('../../src/services/providers/providerUsage.js')
  const reader = await import('../../src/services/providers/anthropic/anthropicUsageState.js')
  reader._resetAnthropicUsageReaderForTesting()
  check('hidden: no meter is shown and nothing was read', !usage.providerUsageMeterShown() && served.length === 0)
  const release = usage.watchProviderUsageWhileShown({ family: () => 'anthropic' })
  await sleep(400)
  const usageReads = (): number => served.filter(s => s.url.includes('/api/oauth/usage')).length
  check('a shown meter reads the usage endpoint once', usageReads() === 1, JSON.stringify(served))
  const releaseSecond = usage.watchProviderUsageWhileShown({ family: () => 'anthropic' })
  await sleep(300)
  check('a meter re-shown inside the floor makes no request', usageReads() === 1, JSON.stringify(served))
  await usage.refreshProviderUsage('anthropic', { reason: 'operator' })
  check("the operator's retry reads again", usageReads() === 2, JSON.stringify(served))
  releaseSecond()
  release()
  await sleep(300)
  check('hidden again, nothing reads', !usage.providerUsageMeterShown() && usageReads() === 2, JSON.stringify(served))
  check('every request the fixture saw was the usage read', served.every(s => s.url.includes('/api/oauth/usage')), JSON.stringify(served))
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
