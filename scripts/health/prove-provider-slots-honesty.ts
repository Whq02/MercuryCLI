#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'provider-slots-honesty-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_LOCAL_BASE_URL']) delete process.env[key]
const slotsRowHint = ' | change the provider-slots row in authChecks (src/platform/health/sections/auth.ts) or the catalogue in buildProviderSnapshot (src/models/roads/modelRegistry.ts)'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' Provider slots — honest-unavailable acceptance law')
console.log('============================================================')

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { authChecks } = await import('../../src/platform/health/sections/auth.ts')
const { buildProviderSnapshot } = await import('../../src/models/roads/modelRegistry.ts')
const slots = await (await authChecks()).find(row => row.id === 'provider-slots')?.run()
const snap = buildProviderSnapshot()
const unavailable = snap.providers.filter(p => p.id !== 'anthropic' && !p.available).map(p => p.reason ?? '')
check('the accepted-code list exists', slots?.status === 'ok' && unavailable.length > 0, slots?.evidence + slotsRowHint)

check("the defect-class code 'no-account:' is in the list", slots?.status === 'ok' && unavailable.some(reason => reason.startsWith('no-account:')), unavailable.join(' ') + slotsRowHint)

check(
  'with no qualified engine seat the row says the seats are unresolved and the defaults stay Anthropic',
  snap.resolve('gpt') === null && snap.resolve('glm') === null && slots?.evidence.includes('engine seats unresolved (no qualified candidate) — defaults stay Anthropic') === true,
  slots?.evidence + slotsRowHint,
)

const authIds = (await authChecks()).map(row => row.id).filter(id => id.startsWith('auth-'))
check(
  'AUTH rows enumerate the catalogue (buildProviderSnapshot inside providerAuthChecks)',
  authIds.length === snap.providers.length && authIds.length > 5,
  `${authIds.length} auth rows, ${snap.providers.length} providers | providerAuthChecks in src/platform/health/sections/auth.ts must emit one auth-<provider id> row per provider of buildProviderSnapshot`,
)
check(
  'AUTH row ids derive from the enumerated provider id (never a literal row list)',
  JSON.stringify(authIds) === JSON.stringify(snap.providers.map(p => `auth-${p.id}`)),
  authIds.join(' ') + ' | providerAuthChecks in src/platform/health/sections/auth.ts must derive each row id from the provider id',
)
process.env.ZAI_API_KEY = 'fixture-zai-key'
process.env.MERCURY_ZAI_API_BASE = 'http://127.0.0.1:9'
const credentialed = await (await authChecks()).find(row => row.id === 'auth-zai')?.run()
delete process.env.ZAI_API_KEY
check(
  'the no-network-probe law is stated on present credentials',
  credentialed?.status === 'ok' && credentialed.evidence.endsWith('(present — validity untested: no network probe by design)'),
  credentialed?.evidence + ' | the auth-<provider> row in providerAuthChecks (src/platform/health/sections/auth.ts) must end its ok evidence with the no-network-probe words',
)

{
  const { mock } = await import('bun:test')
  const registryPath = join(ROOT, 'src', 'models', 'roads', 'modelRegistry.ts')
  const registry = { ...(await import(registryPath)) }
  const honest = registry.buildProviderSnapshot()
  const seated = async (seat: 'gpt' | 'glm', provider: string): Promise<{ status: string; evidence: string; fix?: string } | undefined> => {
    mock.module(registryPath, () => ({
      ...registry,
      buildProviderSnapshot: () => ({ ...honest, resolve: (modelClass: string) => (modelClass === seat ? { provider, model: `${seat}-fixture`, modelClass: seat, effort: 'high', contextWindow: 200_000 } : honest.resolve(modelClass)) }),
    }))
    const says = await (await authChecks()).find(row => row.id === 'provider-slots')?.run()
    mock.module(registryPath, () => registry)
    return says
  }
  const BROKE = 'Provider resolution broke an invariant — report this.'
  const glmElsewhere = await seated('glm', 'openai')
  check('a glm seat that resolves on another engine than Z.AI breaks the row (the registry stubbed to answer one): fail, seat-law=false, and the fix says to report it', glmElsewhere?.status === 'fail' && glmElsewhere.evidence.startsWith('provider honesty broke: ') && glmElsewhere.evidence.includes(' seat-law=false ') && glmElsewhere.fix === BROKE, `${glmElsewhere?.status}: ${glmElsewhere?.evidence}${slotsRowHint}`)
  const gptElsewhere = await seated('gpt', 'zai')
  check('a gpt seat that resolves on another engine than OpenAI breaks it the same way', gptElsewhere?.status === 'fail' && gptElsewhere.evidence.includes(' seat-law=false ') && gptElsewhere.fix === BROKE, `${gptElsewhere?.status}: ${gptElsewhere?.evidence}${slotsRowHint}`)
  const glmAtHome = await seated('glm', 'zai')
  check('the same seat on its own engine reads ok and the row names it', glmAtHome?.status === 'ok' && glmAtHome.evidence.endsWith(' · engine seats: glm→glm-fixture (explicit slots only)') && glmAtHome.fix === undefined, `${glmAtHome?.status}: ${glmAtHome?.evidence}${slotsRowHint}`)
}

console.log(failures === 0 ? '\n✅ provider-slots honesty law holds' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
