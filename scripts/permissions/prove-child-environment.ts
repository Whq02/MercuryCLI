#!/usr/bin/env bun
// gate-watch: src/utils/subprocessEnv.ts src/substrate/envStamps.ts src/utils/Shell.ts src/utils/hooks/commandRunner.ts src/services/mcp/client.ts docs/HOOKS.md
import { plugin } from 'bun'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } }))
  },
})

const root = mkdtempSync(join(tmpdir(), 'child-environment-'))
const home = join(root, 'home')
const cwd = join(root, 'cwd')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SHELL_ENGINE
delete process.env.MERCURY_SUBPROCESS_ENV_SCRUB
delete process.env.MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION
if (!(process.env.SHELL ?? '').includes('bash') && existsSync('/bin/bash')) process.env.SHELL = '/bin/bash'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const storeToken = 'm46-store-token-not-for-children'
writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: storeToken, refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'] } }))
process.env.M46_USER_EXPORT = 'user-export-present'
process.env.OPENAI_API_KEY = 'fixture-user-exported-provider-key'
process.env.MERCURY_ENTRYPOINT = 'cli'
process.env.MERCURY_GODOT_TOOLS = '1'
process.env.MERCURY_BOOT_ENV_APPLIED = JSON.stringify({ MERCURY_GODOT_TOOLS: '1' })
const stamps = ['MERCURY_BOOT_ENV_APPLIED', 'MERCURY_ENTRYPOINT', 'MERCURY_GODOT_TOOLS']
const environments = new Map<string, Record<string, string>>()
const readEnv = (path: string): Record<string, string> => Object.fromEntries(readFileSync(path, 'utf8').split('\n').flatMap(line => {
  const equals = line.indexOf('=')
  return equals > 0 ? [[line.slice(0, equals), line.slice(equals + 1)]] : []
}))

try {
  const { plainTextStorage } = await import('../../src/utils/secureStorage/plainTextStorage.ts')
  check('the scratch credential store carries the known token', plainTextStorage.read()?.claudeAiOauth?.accessToken === storeToken)

  const { exec, setCwd } = await import('../../src/utils/Shell.ts')
  setCwd(cwd)
  const bashDump = join(root, 'bash-env.txt')
  const bash = await exec(`env > ${JSON.stringify(bashDump)}`, new AbortController().signal, 'bash', { timeout: 20_000, shouldAutoBackground: false })
  const bashResult = await bash.result
  check('the Bash child runs', bashResult.code === 0, String(bashResult.code))
  environments.set('Bash', readEnv(bashDump))

  const { startCommandHook } = await import('../../src/utils/hooks/commandRunner.ts')
  const hookDump = join(root, 'hook-env.txt')
  const hook = await startCommandHook({ command: `env > ${JSON.stringify(hookDump)}`, shell: 'bash', name: 'environment', event: 'turn.start', index: 0, payloadJson: '{}', timeoutMs: 20_000, source: { kind: 'settings' }, cwd })
  const hookResult = await hook.result
  check('the hook child runs', hookResult.kind === 'exited' && hookResult.code === 0, JSON.stringify(hookResult))
  environments.set('hook', readEnv(hookDump))

  const { connectToServer, clearServerCache } = await import('../../src/services/mcp/client.ts')
  const mcpDump = join(root, 'mcp-env.json')
  const config = { type: 'stdio' as const, command: process.execPath, args: [join(import.meta.dir, '_fixture-child-environment.mjs')], env: { M46_ENV_DUMP: mcpDump }, scope: 'local' as const }
  const connection = await connectToServer('environment_fixture', config)
  check('the MCP child connects', connection.type === 'connected', connection.type)
  if (connection.type === 'connected') environments.set('MCP', JSON.parse(readFileSync(mcpDump, 'utf8')) as Record<string, string>)
  await clearServerCache('environment_fixture', config)

  for (const [road, env] of environments) {
    check(`${road} inherits the user's exported variable`, env.M46_USER_EXPORT === 'user-export-present', String(env.M46_USER_EXPORT))
    check(`${road} inherits a provider key the user exported`, env.OPENAI_API_KEY === 'fixture-user-exported-provider-key', String(env.OPENAI_API_KEY))
    check(`${road} does not inherit Mercury's own stamps`, stamps.every(name => env[name] === undefined), stamps.filter(name => env[name] !== undefined).join(','))
    check(`${road} does not inherit the credential loaded from Mercury's store`, !JSON.stringify(env).includes(storeToken))
  }
  check('all three child roads produced an environment dump', environments.size === 3, String(environments.size))

  const docs = readFileSync(join(import.meta.dir, '../../docs/HOOKS.md'), 'utf8')
  check('the hook docs say the user shell environment is inherited by default', docs.includes('inherits your shell environment by default'))
  check('the hook docs say exported provider keys stay', docs.includes('including provider keys and\nother variables you exported'))
  check('the hook docs say stored credentials are not added', docs.includes("credentials in Mercury's own store are\nnot added"))
  check('the hook docs name the stamps and sensitive variable families removed', docs.includes('Mercury removes its own session stamps, session tokens, OpenTelemetry\nvariables and browser-secret variables'))
} finally {
  delete process.env.M46_USER_EXPORT
  delete process.env.OPENAI_API_KEY
  for (const name of stamps) delete process.env[name]
  rmSync(root, { recursive: true, force: true })
}
console.log(failures === 0 ? 'CHILD ENVIRONMENT GREEN' : `${failures} CHILD ENVIRONMENT FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
