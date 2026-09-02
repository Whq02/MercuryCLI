#!/usr/bin/env bun
// ============================================================================
//  prove-provider-key-isolation — FN-013 AUTH-07: provider credentials
//  stop reaching model-driven children by ambient inheritance, and the
//  strip set stops drifting.
//
//    §1 DERIVATION: the strip set derives from the route-law family table —
//       every declared id-space route carries at least one credential
//       spelling, and the flat set contains each (the Record over
//       CallModelRoute is the compile-time half of the ratchet: a new
//       family cannot typecheck without a row).
//    §2 LANGUAGE SERVERS are stripped UNCONDITIONALLY: no flag armed, a
//       provider key in the live env is absent from languageServerEnv()
//       while the default subprocessEnv() still carries it (the default
//       path for shell/hooks/MCP is unchanged this release).
//    §3 THE ISOLATION FLAG: armed, subprocessEnv() drops the whole
//       provider set; unarmed with nothing else to strip, the LIVE env
//       object returns BY REFERENCE (the hot path preserved).
//    §4 THE CI SCRUB armed strips every spelling AND its INPUT_ twin.
//    §5 the wiring, structural: every language-server spawn path consumes
//       languageServerEnv; the isolation flag is registered; the strip
//       path logs nothing (no credential value can reach a diagnostic).
//
//  Run:  ~/.bun/bin/bun run scripts/permissions/prove-provider-key-isolation.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const ROOT = join(import.meta.dir, '..', '..')

console.log('============================================================')
console.log(' provider-key isolation — derived, unconditional for LSP')
console.log('============================================================')

const spellings = await import('../../src/services/providers/credentialEnvSpellings.ts')
const idSpaces = await import('../../src/services/providers/idSpaces.ts')

section('§1 the strip set derives from the route-law family table')
{
  // The id-space table declares the nine engine routes; anthropic is the
  // home space — the family union is the nine plus it.
  const routes = new Set([
    ...(idSpaces.PROVIDER_ID_SPACES as Array<{ route: string }>).map(space => space.route),
    'anthropic',
  ])
  check('the family union covers the ten routes', routes.size === 10, [...routes].join(','))
  for (const route of routes) {
    const vars = (spellings.PROVIDER_CREDENTIAL_ENV_VARS as Record<string, readonly string[]>)[route]
    check(`route '${route}' carries at least one credential spelling`, Array.isArray(vars) && vars.length > 0, JSON.stringify(vars))
    for (const name of vars ?? []) {
      check(`  '${name}' lands in the flat derived set`, spellings.ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes(name))
    }
  }
  const seven = ['ZAI_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'OPENROUTER_API_KEY', 'HF_TOKEN', 'MERCURY_COMPAT_API_KEY', 'MERCURY_LOCAL_API_KEY']
  check('the seven previously-missing spellings are all covered', seven.every(name => spellings.ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes(name)))
}

// The env manipulations below need a clean slate: no scrub/isolation flags,
// no always-strip triggers, so the hot path can be pinned by identity.
const subEnvModule = await import('../../src/utils/subprocessEnv.ts')
const SPELLINGS = [...spellings.ALL_PROVIDER_CREDENTIAL_ENV_VARS]
const cleanTriggers = (): void => {
  delete process.env.MERCURY_SUBPROCESS_ENV_SCRUB
  delete process.env.MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION
  delete process.env.MERCURY_OAUTH_TOKEN
  delete process.env.MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('OTEL_') || key.startsWith('MERCURY_BROWSER_SECRET_')) delete process.env[key]
  }
  for (const name of subEnvModule.ALWAYS_STRIP_TOKEN_VARS) delete process.env[name]
}

section('§2 language servers: stripped with NO flag armed; the default path unchanged')
{
  cleanTriggers()
  process.env.DEEPSEEK_API_KEY = 'fixture-deepseek-secret'
  process.env.HF_TOKEN = 'fixture-hf-secret'
  const forLs = subEnvModule.languageServerEnv()
  check('the language-server env carries NO provider key', SPELLINGS.every(name => forLs[name] === undefined), JSON.stringify(SPELLINGS.filter(n => forLs[n] !== undefined)))
  check('startup facts survive (PATH intact)', forLs.PATH === process.env.PATH)
  const forChild = subEnvModule.subprocessEnv()
  check('the DEFAULT child path still inherits (unchanged this release)', forChild.DEEPSEEK_API_KEY === 'fixture-deepseek-secret' && forChild.HF_TOKEN === 'fixture-hf-secret')
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.HF_TOKEN
}

section('§3 the isolation flag and the hot path')
{
  cleanTriggers()
  process.env.OPENROUTER_API_KEY = 'fixture-openrouter-secret'
  process.env.MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION = '1'
  const isolated = subEnvModule.subprocessEnv()
  check('armed: the provider set is absent from every child env', SPELLINGS.every(name => isolated[name] === undefined))
  check('armed: non-credential env survives', isolated.PATH === process.env.PATH)
  delete process.env.MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION
  const ambient = subEnvModule.subprocessEnv()
  check('unarmed: ambient inheritance, byte-identical', ambient.OPENROUTER_API_KEY === 'fixture-openrouter-secret')
  delete process.env.OPENROUTER_API_KEY
  const hot = subEnvModule.subprocessEnv()
  check('the hot path returns the LIVE env by reference when nothing needs stripping', hot === process.env)
}

section('§4 the CI scrub armed: every spelling and its INPUT_ twin')
{
  cleanTriggers()
  process.env.MERCURY_SUBPROCESS_ENV_SCRUB = '1'
  for (const name of SPELLINGS) {
    process.env[name] = `fixture-${name}`
    process.env[`INPUT_${name}`] = `fixture-input-${name}`
  }
  const scrubbed = subEnvModule.subprocessEnv()
  check('all spellings absent', SPELLINGS.every(name => scrubbed[name] === undefined), JSON.stringify(SPELLINGS.filter(n => scrubbed[n] !== undefined)))
  check('all INPUT_-prefixed twins absent', SPELLINGS.every(name => scrubbed[`INPUT_${name}`] === undefined))
  for (const name of SPELLINGS) {
    delete process.env[name]
    delete process.env[`INPUT_${name}`]
  }
  delete process.env.MERCURY_SUBPROCESS_ENV_SCRUB
}

section('§5 the wiring, structural')
{
  for (const file of ['src/services/lsp/LSPServerInstance.ts', 'src/services/lsp/clangdLane.ts', 'src/services/lsp/ruffLane.ts']) {
    const src = readFileSync(join(ROOT, file), 'utf8')
    check(`${file} spawns through languageServerEnv`, src.includes('languageServerEnv()') && !src.includes('subprocessEnv()'))
  }
  const registry = readFileSync(join(ROOT, 'src/substrate/flagRegistry.ts'), 'utf8')
  check('the isolation flag is registered with its off arm', registry.includes("env: 'MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION'") && registry.includes('ambient inheritance, byte-identical'))
  const subEnvSrc = readFileSync(join(ROOT, 'src/utils/subprocessEnv.ts'), 'utf8')
  check('the strip path emits no log or diagnostic (no credential value can leak through one)', !/console\.|logError|logForDebugging/.test(subEnvSrc))
  check('the CI list derives from the family table (no hand-kept provider spellings)', subEnvSrc.includes('...ALL_PROVIDER_CREDENTIAL_ENV_VARS') && !subEnvSrc.includes("'OPENAI_API_KEY'"))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-provider-key-isolation — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-provider-key-isolation — all checks pass')
process.exit(0)
