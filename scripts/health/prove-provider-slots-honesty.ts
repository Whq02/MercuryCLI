#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'provider-slots-honesty-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_LOCAL_BASE_URL']) delete process.env[key]
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' Provider slots — honest-unavailable acceptance law')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { healthContext } = await import('../../src/utils/healthReport.ts')
const { authChecks } = await import('../../src/utils/health/sections/auth.ts')
const { buildProviderSnapshot } = await import('../../src/services/providers/modelRegistry.ts')
const context = await healthContext()
const slots = await authChecks(context).find(row => row.id === 'provider-slots')?.run()
const snap = buildProviderSnapshot()
const unavailable = snap.providers.filter(p => p.id !== 'anthropic' && !p.available).map(p => p.reason ?? '')
check('the accepted-code list exists', slots?.status === 'ok' && unavailable.length > 0, slots?.evidence)

const providerFiles = ['src/services/providers/openai/openaiAdapter.ts', 'src/services/providers/zai/zaiAdapter.ts']
const emitted = new Set<string>()
for (const f of providerFiles) {
  const src = readFileSync(join(ROOT, f), 'utf8')
  for (const m of src.matchAll(/reason: '([a-z-]+:[a-z-]+)'/g)) emitted.add(m[1]!)
}
check('provider reason literals found', emitted.size >= 2, [...emitted].join(', '))
const standing = [...emitted].filter(reason => unavailable.includes(reason))
check('a home with no account holds provider reasons the adapters spell', standing.length >= 2, `standing: ${standing.join(', ')} · spelled: ${[...emitted].join(', ')}`)
for (const reason of standing) {
  check(
    `'${reason}' is accepted as an honest unavailable state`,
    slots?.status === 'ok' && slots.evidence.includes(`${reason.slice(0, reason.indexOf(':') + 1)} `),
    slots?.evidence,
  )
}
check("the defect-class code 'no-account:' is in the list", slots?.status === 'ok' && unavailable.some(reason => reason.startsWith('no-account:')), unavailable.join(' '))

check(
  'with no qualified engine seat the row says the seats are unresolved and the defaults stay Anthropic',
  snap.resolve('gpt') === null && snap.resolve('glm') === null && slots?.evidence.includes('engine seats unresolved (no qualified candidate) — defaults stay Anthropic') === true,
  slots?.evidence,
)

const authIds = authChecks(context).map(row => row.id).filter(id => id.startsWith('auth-'))
check(
  'AUTH rows enumerate the catalogue (buildProviderSnapshot inside providerAuthChecks)',
  authIds.length === snap.providers.length && authIds.length > 5,
  `${authIds.length} auth rows, ${snap.providers.length} providers`,
)
check(
  'AUTH row ids derive from the enumerated provider id (never a literal row list)',
  JSON.stringify(authIds) === JSON.stringify(snap.providers.map(p => `auth-${p.id}`)),
  authIds.join(' '),
)
process.env.ZAI_API_KEY = 'fixture-zai-key'
process.env.MERCURY_ZAI_API_BASE = 'http://127.0.0.1:9'
const credentialed = await authChecks(context).find(row => row.id === 'auth-zai')?.run()
delete process.env.ZAI_API_KEY
check(
  'the no-network-probe law is stated on present credentials',
  credentialed?.status === 'ok' && credentialed.evidence.endsWith('(present — validity untested: no network probe by design)'),
  credentialed?.evidence,
)

console.log(failures === 0 ? '\n✅ provider-slots honesty law holds' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
