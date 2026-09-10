#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'neutral-surfaces-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const { providerFamilyPresences } = await import('../../src/services/providers/providerUsage.ts')
const { usageSectionPlan } = await import('../../src/components/Settings/Usage.tsx')
const { noteCredentialChange } = await import('../../src/utils/accounts/signInLedger.ts')
const { configProviderRows, mainLoopPointerText } = await import(
  '../../src/components/Settings/Config.tsx'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' Provider-neutral settings surfaces — the derivation law')
console.log('============================================================')

type ProvidersDouble = Parameters<typeof providerFamilyPresences>[0]
const account = (kind: string, label: string) => ({ kind, label })
const double = [
  {
    id: 'anthropic',
    available: true,
    transport: 'anthropic-messages',
    description: { account: account('inherited-main', 'main-loop credentials') },
  },
  {
    id: 'openai',
    available: false,
    reason: 'no-account:openai',
    transport: 'openai-responses',
    description: { account: account('none', 'no OpenAI account source connected') },
  },
  {
    id: 'acme',
    available: true,
    transport: 'acme-wire',
    description: { account: account('api-key', 'ACME_API_KEY (env)') },
  },
] as unknown as ProvidersDouble

section('(1) providerFamilyPresences — the shared family enumeration')
{
  const reads = {
    claudeSubscriber: () => true,
    subscriptionType: () => 'max',
    anthropicApiKeyPresent: () => false,
  }
  const fams = providerFamilyPresences(double, reads)
  check('one presence per catalogue family (3 in, 3 out)', fams.length === 3)
  const [a, o, x] = fams
  check('anthropic: credentialed via the auth owners', a?.credentialed === true)
  check(
    'anthropic: the subscription label carries the plan',
    a?.credentialLabel === 'Claude subscription (max)',
    String(a?.credentialLabel),
  )
  check('openai: absent account ⇒ not credentialed, still enumerated', o?.credentialed === false)
  check('unknown family flows through with its own account label', x?.id === ('acme' as never) && x?.credentialed === true && x?.credentialLabel === 'ACME_API_KEY (env)')

  const apiKeyOnly = providerFamilyPresences(double, {
    claudeSubscriber: () => false,
    subscriptionType: () => null,
    anthropicApiKeyPresent: () => true,
  })
  check('anthropic: API-key-only is credentialed with the key label', apiKeyOnly[0]?.credentialed === true && apiKeyOnly[0]?.credentialLabel === 'Anthropic API key')

}

section('(2) usageSectionPlan — one /usage section per family (derived, never hidden)')
{
  const fams = providerFamilyPresences(double, {
    claudeSubscriber: () => true,
    subscriptionType: () => 'max',
    anthropicApiKeyPresent: () => false,
  })
  const plan = usageSectionPlan(fams)
  check('three families ⇒ three sections, catalogue order', plan.length === 3 && plan[0]?.id === 'anthropic')
  check('anthropic section keeps its own kind + title', plan[0]?.kind === 'anthropic' && plan[0]?.title === 'Anthropic usage')
  check('openai section: known-id presentation', plan[1]?.kind === 'engine' && plan[1]?.title === 'OpenAI usage')
  check(
    'unknown family gets the honest generic section (never silence)',
    plan[2]?.title === 'acme usage' && plan[2]?.connect.includes('/capabilities') && plan[2]?.limitsNote.includes('No polled usage meter'),
  )
  check('every enumerated family mounts a section (no hidden lanes)', usageSectionPlan(fams).some(s => s.id === ('openai' as never)))
}

section('(3) /config — derived account rows + the read-only model pointer')
{
  const fams = providerFamilyPresences(double, {
    claudeSubscriber: () => false,
    subscriptionType: () => null,
    anthropicApiKeyPresent: () => true,
  })
  const rows = configProviderRows(fams)
  check('one row per family', rows.length === 3)
  check('anthropic row: presence + the /accounts pointer', rows[0]?.valueText === 'Anthropic API key — /accounts')
  check('openai row: honest absent text with the connect route', rows[1]?.valueText === 'not signed in — /logins connects' && rows[1]?.credentialed === false)
  check('unknown family row appears, labeled by its id', rows[2]?.id === 'account-acme' && rows[2]?.label === 'acme account' && rows[2]?.valueText === 'ACME_API_KEY (env)')
  check('every family keeps its /config row (no hidden lanes)', configProviderRows(fams).some(r => r.id === 'account-openai'))
  const edgeRows = configProviderRows([
    { id: 'huggingface', available: true, credentialed: false },
    { id: 'local', available: true, credentialed: false },
  ] as never)
  check('huggingface row: the /logins route, never the unknown-family fallback',
    edgeRows[0]?.valueText === 'not signed in — /logins connects (or HF_TOKEN)', edgeRows[0]?.valueText ?? '')
  check('local row: the no-sign-in truth, never a sign-in route',
    edgeRows[1]?.valueText === 'no sign-in — start a local server or MERCURY_LOCAL_BASE_URL', edgeRows[1]?.valueText ?? '')
  const keyLaneRows = configProviderRows([
    { id: 'moonshot', available: true, credentialed: false },
    { id: 'zai', available: true, credentialed: false },
    { id: 'deepseek', available: true, credentialed: false },
  ] as never)
  check('moonshot row: the /logins moonshot route (a sign-in exists)',
    keyLaneRows[0]?.valueText === 'not signed in — /logins moonshot connects (or MOONSHOT_API_KEY)', keyLaneRows[0]?.valueText ?? '')
  check('zai row: the /logins zai route, key-only wording',
    keyLaneRows[1]?.valueText === 'no key — /logins zai connects (or ZAI_API_KEY)', keyLaneRows[1]?.valueText ?? '')
  check('deepseek row: the /logins deepseek route, key-only wording',
    keyLaneRows[2]?.valueText === 'no key — /logins deepseek connects (or DEEPSEEK_API_KEY)', keyLaneRows[2]?.valueText ?? '')

  const anthropicPtr = mainLoopPointerText('claude-opus-5')
  check('model pointer: provider from the routing law (anthropic)', anthropicPtr.startsWith('Anthropic · ') && anthropicPtr.endsWith('— /model'), anthropicPtr)
  const gptPtr = mainLoopPointerText('gpt-5.2')
  check('model pointer: provider from the routing law (openai)', gptPtr.startsWith('OpenAI · '), gptPtr)
  const defaultPtr = mainLoopPointerText(null, { resolvedModel: () => 'claude-opus-5', routeOf: () => 'anthropic' })
  check('null setting reads the resolved default honestly', defaultPtr.includes('default ('), defaultPtr)
}

section('(4) the /usage gate — UNGATED, proven OpenAI-only')
{
  const usageCommand = (await import('../../src/commands/usage/index.ts')).default
  check(
    'the whole-panel gate is DEAD: /usage declares NO availability gate at all',
    (usageCommand as { availability?: unknown }).availability === undefined,
    JSON.stringify((usageCommand as { availability?: unknown }).availability),
  )

  writeFileSync(
    join(HOME, '.openai-auth.json'),
    JSON.stringify({
      version: 1,
      tokens: {
        idToken: '',
        accessToken: 'fixture-access',
        refreshToken: 'fixture-refresh',
        accountId: 'acct_fixture',
        planType: 'plus',
      },
    }),
  )
  noteCredentialChange()
  const fams = providerFamilyPresences()
  const openai = fams.find(f => f.id === 'openai')
  check('fixture auth ⇒ the openai family is credentialed', openai?.credentialed === true, JSON.stringify(openai))
  const plan = usageSectionPlan(fams)
  check('the /usage plan carries the OpenAI section', plan.some(s => s.id === 'openai' && s.kind === 'engine'))

  const { meetsAvailabilityRequirement } = await import('../../src/commands.ts')
  check(
    'meetsAvailabilityRequirement passes on the OpenAI credential alone',
    meetsAvailabilityRequirement({ name: 'usage', description: '', availability: ['any-provider-credential'] } as never) === true,
  )
}

section('(5) the gate under an ISOLATED credential world (fresh child, file store, no ambient keys)')
{
  const { spawnSync } = await import('node:child_process')
  const CREDENTIAL_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_OAUTH_REFRESH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR', 'MERCURY_API_UNIX_SOCKET', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HF_TOKEN', 'MERCURY_COMPAT_API_KEY', 'MERCURY_LOCAL_API_KEY', 'MERCURY_HOME']
  const isolatedWorld = (home: string): Record<string, unknown> => {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !CREDENTIAL_ENV.includes(k)) env[k] = v
    env.MERCURY_CONFIG_DIR = home
    env.MERCURY_CREDENTIAL_STORE = 'file'
    env.HOME = home
    const src = `
      ;(globalThis).MACRO = { VERSION: '1.0.0' }
      const { enableConfigs } = await import(${JSON.stringify(join(import.meta.dir, '../../src/utils/config.ts'))})
      enableConfigs()
      const { providerFamilyPresences, anyProviderCredentialed } = await import(${JSON.stringify(join(import.meta.dir, '../../src/services/providers/providerUsage.ts'))})
      const { meetsAvailabilityRequirement } = await import(${JSON.stringify(join(import.meta.dir, '../../src/commands.ts'))})
      const fams = providerFamilyPresences()
      console.log(JSON.stringify({
        credentialed: fams.filter(f => f.credentialed).map(f => f.id),
        labels: Object.fromEntries(fams.filter(f => f.credentialed).map(f => [f.id, f.credentialLabel ?? null])),
        any: anyProviderCredentialed(),
        gate: meetsAvailabilityRequirement({ name: 'usage', description: '', availability: ['any-provider-credential'] }),
      }))
    `
    const res = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', timeout: 120_000, env })
    if (res.error) return { childFailed: `spawn error: ${res.error.message}` }
    if (res.signal) return { childFailed: `killed by ${res.signal}` }
    if (res.status !== 0) return { childFailed: `exit ${res.status}`, stderr: (res.stderr ?? '').slice(-600) }
    const line = (res.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '{}'
    try {
      return JSON.parse(line) as Record<string, unknown>
    } catch {
      return { parseError: line }
    }
  }
  const emptyHome = mkdtempSync(join(tmpdir(), 'neutral-surfaces-empty-'))
  const none = isolatedWorld(emptyHome)
  check('isolated world, no credentials: the child ran', none.childFailed === undefined && none.parseError === undefined, JSON.stringify(none))
  check('isolated world, no credentials: NO family is credentialed', Array.isArray(none.credentialed) && (none.credentialed as string[]).length === 0, JSON.stringify(none.credentialed))
  check('isolated world, no credentials: anyProviderCredentialed() is false and the gate refuses', none.any === false && none.gate === false, JSON.stringify(none))
  const openaiHome = mkdtempSync(join(tmpdir(), 'neutral-surfaces-openai-'))
  writeFileSync(join(openaiHome, '.openai-auth.json'), JSON.stringify({ version: 1, tokens: { idToken: '', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accountId: 'acct_fixture', planType: 'plus' } }))
  const only = isolatedWorld(openaiHome)
  check('isolated world, fixture OpenAI only: the child ran', only.childFailed === undefined && only.parseError === undefined, JSON.stringify(only))
  check('isolated world, fixture OpenAI only: EXACTLY the openai family is credentialed', JSON.stringify(only.credentialed) === '["openai"]', JSON.stringify(only.credentialed))
  check('…with the provider label the adapter itself reports for the fixture', typeof (only.labels as Record<string, unknown> | undefined)?.openai === 'string' && ((only.labels as Record<string, string>).openai).length > 0, JSON.stringify(only.labels))
  check('isolated world, fixture OpenAI only: the gate passes on that credential ALONE', only.any === true && only.gate === true, JSON.stringify(only))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ provider-neutral surfaces: all green')
  process.exit(0)
}
console.log(` ❌ ${failures} NEUTRAL-SURFACE FAILURE(S)`)
process.exit(1)
