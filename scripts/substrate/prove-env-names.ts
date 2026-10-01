#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const SRC = process.env.PROVE_SRC ?? join(ROOT, 'src')
const J = (...parts: string[]): string => parts.join('')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const registry = await import(join(SRC, 'substrate/flagRegistry.ts'))
const timeouts = await import(join(SRC, 'utils/timeouts.ts'))
const limits = await import(join(SRC, 'utils/shell/outputLimits.ts'))
const managed = await import(join(SRC, 'utils/managedEnvConstants.ts'))
const subprocess = await import(join(SRC, 'utils/subprocessEnv.ts'))

const SHELL_TIMEOUT = 'MERCURY_SHELL_TIMEOUT_MS'
const SHELL_MAX_TIMEOUT = 'MERCURY_SHELL_MAX_TIMEOUT_MS'
const SHELL_MAX_OUTPUT = 'MERCURY_SHELL_MAX_OUTPUT'
const FORMER_TIMEOUT = J('BASH_', 'DEFAULT_TIMEOUT_MS')
const FORMER_MAX_TIMEOUT = J('BASH_', 'MAX_TIMEOUT_MS')
const FORMER_MAX_OUTPUT = J('BASH_', 'MAX_OUTPUT_LENGTH')
const FORMER_TIER_NAMES = ['HAIKU', 'OPUS', 'SONNET'].flatMap(tier =>
  ['_MODEL', '_MODEL_DESCRIPTION', '_MODEL_NAME'].map(suffix => J('ANTHROPIC_', 'DEFAULT_', tier, suffix)),
)
const FORMER_CI_NAMES = [J('ALL_', 'INPUTS'), J('OVERRIDE_', 'GITHUB_TOKEN'), J('DEFAULT_', 'WORKFLOW_TOKEN'), J('SSH_', 'SIGNING_KEY')]

const withEnv = <T>(pins: Record<string, string | undefined>, body: () => T): T => {
  const saved = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(pins)) {
    saved.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return body()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

section('§1 the shell knobs are registered value flags')
{
  for (const name of [SHELL_TIMEOUT, SHELL_MAX_TIMEOUT, SHELL_MAX_OUTPUT]) {
    const spec = registry.getFlagSpec(name)
    check(`${name} is a registered value row with a consumer`, spec !== undefined && spec.kind === 'value' && typeof spec.consumer === 'string' && spec.consumer.length > 0, JSON.stringify(spec ?? null))
  }
  const rows = registry.FLAG_REGISTRY as ReadonlyArray<{ env: string; formerly?: string }>
  check('no registry row names a former shell spelling, as its own name or as a former one', rows.every(r => ![FORMER_TIMEOUT, FORMER_MAX_TIMEOUT, FORMER_MAX_OUTPUT].includes(r.env) && ![FORMER_TIMEOUT, FORMER_MAX_TIMEOUT, FORMER_MAX_OUTPUT].includes(r.formerly ?? '')))
}

section('§2 the shell timeouts read their own names; a former spelling is inert')
{
  const defaultMs = timeouts.getDefaultBashTimeoutMs as (env?: NodeJS.ProcessEnv) => number
  const maxMs = timeouts.getMaxBashTimeoutMs as (env?: NodeJS.ProcessEnv) => number
  check('unset ⇒ the built-in default and ceiling', defaultMs({}) === 120_000 && maxMs({}) === 600_000, `${defaultMs({})} / ${maxMs({})}`)
  check('the default timeout follows its variable', defaultMs({ [SHELL_TIMEOUT]: '5000' }) === 5000, String(defaultMs({ [SHELL_TIMEOUT]: '5000' })))
  check('the ceiling follows its variable', maxMs({ [SHELL_MAX_TIMEOUT]: '700000' }) === 700_000, String(maxMs({ [SHELL_MAX_TIMEOUT]: '700000' })))
  check('the ceiling never drops below the resolved default', maxMs({ [SHELL_TIMEOUT]: '900000', [SHELL_MAX_TIMEOUT]: '7000' }) === 900_000)
  check('junk and non-positive values read as unset', defaultMs({ [SHELL_TIMEOUT]: '12abc' }) === 120_000 && defaultMs({ [SHELL_TIMEOUT]: '0' }) === 120_000 && maxMs({ [SHELL_MAX_TIMEOUT]: '-5' }) === 600_000)
  check('a former default-timeout spelling changes nothing', defaultMs({ [FORMER_TIMEOUT]: '5000' }) === 120_000, String(defaultMs({ [FORMER_TIMEOUT]: '5000' })))
  check('a former ceiling spelling changes nothing', maxMs({ [FORMER_MAX_TIMEOUT]: '700000' }) === 600_000, String(maxMs({ [FORMER_MAX_TIMEOUT]: '700000' })))
  check('the live process reads the same names', withEnv({ [SHELL_TIMEOUT]: '4321', [SHELL_MAX_TIMEOUT]: undefined }, () => defaultMs()) === 4321)
}

section('§3 the shell output cap reads its own name; a former spelling is inert')
{
  const cap = limits.getMaxOutputLength as () => number
  const budget = limits.resolveOutputBudget as (n: number) => { effective: number; clampedTo?: string }
  check('the exported spelling is the registered one', limits.SHELL_MAX_OUTPUT_ENV === SHELL_MAX_OUTPUT, String(limits.SHELL_MAX_OUTPUT_ENV))
  check('unset ⇒ the built-in cap', withEnv({ [SHELL_MAX_OUTPUT]: undefined, [FORMER_MAX_OUTPUT]: undefined }, cap) === 30_000)
  check('the cap follows its variable', withEnv({ [SHELL_MAX_OUTPUT]: '100', [FORMER_MAX_OUTPUT]: undefined }, cap) === 100, String(withEnv({ [SHELL_MAX_OUTPUT]: '100' }, cap)))
  check('a model request above the cap clamps to it', withEnv({ [SHELL_MAX_OUTPUT]: '100', [FORMER_MAX_OUTPUT]: undefined }, () => budget(2000)).effective === 100)
  check('a value past the ceiling caps at the ceiling', withEnv({ [SHELL_MAX_OUTPUT]: '999999', [FORMER_MAX_OUTPUT]: undefined }, cap) === 150_000)
  check('a former cap spelling changes nothing', withEnv({ [SHELL_MAX_OUTPUT]: undefined, [FORMER_MAX_OUTPUT]: '100' }, cap) === 30_000, String(withEnv({ [SHELL_MAX_OUTPUT]: undefined, [FORMER_MAX_OUTPUT]: '100' }, cap)))
}

section('§4 the pre-trust safe list and the host-managed strip set carry Mercury\'s names only')
{
  const safe = managed.SAFE_ENV_VARS as Set<string>
  check('the three shell knobs may be applied before trust', [SHELL_TIMEOUT, SHELL_MAX_TIMEOUT, SHELL_MAX_OUTPUT].every(n => safe.has(n)))
  check('no former shell spelling is applied before trust', ![FORMER_TIMEOUT, FORMER_MAX_TIMEOUT, FORMER_MAX_OUTPUT].some(n => safe.has(n)))
  check('no unread model-tier spelling is applied before trust', !FORMER_TIER_NAMES.some(n => safe.has(n)), FORMER_TIER_NAMES.filter(n => safe.has(n)).join(','))
  const managedVar = managed.isProviderManagedEnvVar as (k: string) => boolean
  check('the host-managed strip set keeps the provider endpoint, auth and model rows', ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_SMALL_FAST_MODEL', 'MERCURY_PROVIDER_MANAGED_BY_HOST'].every(managedVar))
  check('the host-managed strip set names no unread model-tier spelling', !FORMER_TIER_NAMES.some(managedVar), FORMER_TIER_NAMES.filter(managedVar).join(','))
  check('every safe-list spelling is Mercury\'s own', [...safe].every(n => n.startsWith('MERCURY_')), [...safe].filter(n => !n.startsWith('MERCURY_')).join(','))
}

section('§5 the CI scrub strips the registered credential families and exporter headers, nothing else')
{
  const env = subprocess.subprocessEnv as () => NodeJS.ProcessEnv
  const pins: Record<string, string> = { MERCURY_SUBPROCESS_ENV_SCRUB: '1', OTEL_EXPORTER_OTLP_HEADERS: 'x', ANTHROPIC_API_KEY: 'k', ACTIONS_RUNTIME_TOKEN: 't', PASSES_THROUGH: 'y' }
  for (const n of FORMER_CI_NAMES) pins[n] = 'v'
  const scrubbed = withEnv(pins, env)
  check('a credential, an exporter header and a CI runtime token are stripped', scrubbed.ANTHROPIC_API_KEY === undefined && scrubbed.OTEL_EXPORTER_OTLP_HEADERS === undefined && scrubbed.ACTIONS_RUNTIME_TOKEN === undefined)
  check('an unrelated variable passes through', scrubbed.PASSES_THROUGH === 'y')
  check('variables outside the registered families pass through', FORMER_CI_NAMES.every(n => scrubbed[n] === 'v'), FORMER_CI_NAMES.filter(n => scrubbed[n] !== 'v').join(','))
}

section('§6 the reviewer\'s confined verification resolves the bun runtime through the registered pin')
{
  const text = readFileSync(join(SRC, 'tools/AgentTool/reviewerPolicy.ts'), 'utf8')
  check('the runtime is read through the registry reader', /flagEnv\('MERCURY_BUN'\)/.test(text))
  check('no raw read of an unregistered runtime spelling remains', !/process\.env\.BUN\b/.test(text))
  check('the confined child receives the pin under both the registered spelling and the suites\' shell variable', text.includes('`MERCURY_BUN=${bun}`') && text.includes('`BUN=${bun}`'))
}

section('§7 no reader of a former spelling remains in src')
{
  const { execSync } = await import('node:child_process')
  const grep = (pattern: string): string => {
    try {
      return execSync(`grep -rEl ${JSON.stringify(pattern)} ${JSON.stringify(SRC)} --include=*.ts --include=*.tsx`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    } catch {
      return ''
    }
  }
  const former = [FORMER_TIMEOUT, FORMER_MAX_TIMEOUT, FORMER_MAX_OUTPUT, J('ANTHROPIC_', 'DEFAULT_\\$\\{'), J('ANTHROPIC_', 'DEFAULT_[A-Z]'), ...FORMER_CI_NAMES]
  const hits = former.map(n => [n, grep(`\\b${n}`).trim()] as const).filter(([, files]) => files !== '')
  check('no source file names a former spelling', hits.length === 0, hits.map(([n, f]) => `${n}: ${f.split('\n').join(' ')}`).join(' · '))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ env names: ${failures} FAILED`)
  process.exit(1)
}
console.log('✅ env names: clean')
