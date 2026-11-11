#!/usr/bin/env bun
// gate-watch: src/services/mcp/utils.ts src/services/mcp/config.ts src/services/mcp/types.ts docs/TRUST.md docs/AUTOMATION.md
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'approval-key-code-variables-')))
const HOME = join(SCRATCH, 'home')
const PROJECT = join(SCRATCH, 'project')
mkdirSync(HOME, { recursive: true })
mkdirSync(join(PROJECT, '.mercury'), { recursive: true })
const LOCAL = join(PROJECT, '.mercury', 'settings.local.json')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)

writeFileSync(join(HOME, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', numStartups: 10, theme: 'dark', projects: { [PROJECT]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({}))
const stdio = (env: Record<string, string>) => ({ type: 'stdio', command: 'node', args: ['server.js'], env })
writeFileSync(
  join(PROJECT, '.mercury', 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      first: stdio({ PATH: '${PROBE_PATH}:./bin', API_TOKEN: '${PROBE_TOKEN}' }),
      same: stdio({ PATH: '${PROBE_PATH}:./bin', API_TOKEN: '${PROBE_TOKEN}' }),
      other: stdio({ PATH: '${PROBE_PATH}:./other', API_TOKEN: '${PROBE_TOKEN}' }),
      plain: stdio({ API_TOKEN: '${PROBE_TOKEN}', LOG_LEVEL: 'info' }),
    },
  }),
)
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
process.env.PROBE_PATH = '/usr/bin:/bin'
process.env.PROBE_TOKEN = 'token-one'
process.chdir(PROJECT)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
const { setIsInteractive, setSessionTrustAccepted, setOriginalCwd, setProjectRoot } = await import('../../src/bootstrap/state.js')
const { setCwd } = await import('../../src/utils/Shell.js')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const { getProjectMcpConfigsFromCwd } = await import('../../src/services/mcp/config.js')
const { getProjectMcpServerStatus, projectMcpServerDefinitionDigest, recordProjectMcpServerChoices } = await import('../../src/services/mcp/utils.js')
enableConfigs()
setCwd(PROJECT)
setOriginalCwd(PROJECT)
setProjectRoot(PROJECT)
setSessionTrustAccepted(true)
setIsInteractive(true)
resetSettingsCache()

type Definition = { type?: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headersHelper?: string; scope: 'project' }
const digest = (definition: Definition): string => projectMcpServerDefinitionDigest(definition as never)
const status = (name: string, definition: Definition): string => getProjectMcpServerStatus(name, definition as never)
const before = (definition: Definition): string =>
  createHash('sha256')
    .update(JSON.stringify(definition.url === undefined ? { args: definition.args ?? [], command: definition.command, cwd: process.cwd(), env: Object.keys(definition.env ?? {}).sort() } : { args: [], env: [], ...(definition.headersHelper === undefined ? {} : { headersHelper: definition.headersHelper }), url: definition.url }))
    .digest('hex')
    .slice(0, 16)
const server = (env: Record<string, string>): Definition => ({ type: 'stdio', command: 'node', args: ['server.js'], env, scope: 'project' })

section('the pages say what the approval is keyed to')
for (const page of ['TRUST.md', 'AUTOMATION.md']) {
  check(`docs/${page} names the values of the variables a runtime loads its code by`, /environment variable names,\s+and\s+the values of the variables a runtime loads its code by, such as `PATH`\s+and\s+`NODE_OPTIONS`\)/.test(readFileSync(join(ROOT, 'docs', page), 'utf8')))
}

section('§1 a changed value of a variable a runtime loads its code by is another definition')
const CODE: Array<[string, string, string]> = [
  ['NODE_OPTIONS', '', '--require ./evil.js'],
  ['NODE_PATH', '/opt/modules', './modules'],
  ['PATH', '/usr/bin:/bin', './bin:/usr/bin:/bin'],
  ['Path', 'C:\\Windows\\System32', '.\\bin;C:\\Windows\\System32'],
  ['PYTHONPATH', '/opt/lib', './lib'],
  ['PYTHONSTARTUP', '', './start.py'],
  ['BASH_ENV', '', './env.sh'],
  ['ENV', '', './env.sh'],
  ['ZDOTDIR', '/home/me', '.'],
  ['LD_PRELOAD', '', './hook.so'],
  ['LD_LIBRARY_PATH', '/usr/lib', './lib'],
  ['DYLD_INSERT_LIBRARIES', '', './hook.dylib'],
  ['BASH_FUNC_git%%', '() { command git "$@"; }', '() { ./evil; }'],
  ['npm_config_registry', 'https://registry.npmjs.org/', 'https://registry.example.invalid/'],
  ['NPM_CONFIG_REGISTRY', 'https://registry.npmjs.org/', 'https://registry.example.invalid/'],
  ['PIP_INDEX_URL', 'https://pypi.org/simple', 'https://pypi.example.invalid/simple'],
  ['UV_INDEX_URL', 'https://pypi.org/simple', 'https://pypi.example.invalid/simple'],
  ['VIRTUAL_ENV', '/opt/venv', './venv'],
  ['BUN_OPTIONS', '', '--preload ./evil.ts'],
  ['DENO_DIR', '/home/me/.cache/deno', './cache'],
  ['PERL5OPT', '', '-Mevil'],
  ['RUBYOPT', '', '-revil'],
  ['JAVA_TOOL_OPTIONS', '', '-javaagent:./evil.jar'],
  ['CLASSPATH', '/opt/app.jar', './evil.jar:/opt/app.jar'],
  ['DOTNET_STARTUP_HOOKS', '', './evil.dll'],
  ['GOFLAGS', '', '-toolexec=./evil'],
  ['DOCKER_HOST', 'unix:///var/run/docker.sock', 'tcp://203.0.113.9:2375'],
  ['PSModulePath', 'C:\\Modules', '.\\Modules'],
]
for (const [name, was, becomes] of CODE) {
  const approved = server({ [name]: was, API_TOKEN: 'token-one' })
  const changed = server({ [name]: becomes, API_TOKEN: 'token-one' })
  check(`${name}: ${JSON.stringify(was)} → ${JSON.stringify(becomes)} is another digest`, digest(approved) !== digest(changed), `${digest(approved)} ${digest(changed)}`)
}
{
  const approved = server({ NODE_OPTIONS: '', API_TOKEN: 'token-one' })
  writeFileSync(LOCAL, JSON.stringify({}))
  resetSettingsCache()
  recordProjectMcpServerChoices({ approved: [{ name: 'runner', config: approved as never }] })
  resetSettingsCache()
  check('a server approved with NODE_OPTIONS empty is approved', status('runner', approved) === 'approved', status('runner', approved))
  const changed = server({ NODE_OPTIONS: '--require ./evil.js', API_TOKEN: 'token-one' })
  check('the same server with NODE_OPTIONS=--require ./evil.js is asked about again', status('runner', changed) === 'pending', status('runner', changed))
  const rotated = server({ NODE_OPTIONS: '', API_TOKEN: 'token-two' })
  check('the same server with another token is not asked about again', status('runner', rotated) === 'approved', status('runner', rotated))
}

section('§2 a token\'s value, and any other value, stays outside the key')
for (const [name, was, becomes] of [
  ['API_TOKEN', 'token-one', 'token-two'], ['GITHUB_TOKEN', 'ghp_one', 'ghp_two'], ['OPENAI_API_KEY', 'sk-one', 'sk-two'], ['DATABASE_URL', 'postgres://a', 'postgres://b'],
  ['LOG_LEVEL', 'info', 'debug'], ['NODE_ENV', 'production', 'test'], ['PYTHONUNBUFFERED', '1', '0'], ['HOME', '/home/me', '/tmp'],
  ['UV_PUBLISH_TOKEN', 'one', 'two'], ['UV_INDEX_FOO_PASSWORD', 'one', 'two'], ['PIP_INDEX_USERNAME', 'one', 'two'], ['npm_config__authToken', 'one', 'two'], ['NPM_CONFIG_//registry.npmjs.org/:_authToken', 'one', 'two'],
] as Array<[string, string, string]>) {
  check(`${name}: a changed value is the same digest`, digest(server({ [name]: was })) === digest(server({ [name]: becomes })), `${digest(server({ [name]: was }))} ${digest(server({ [name]: becomes }))}`)
}
check('a variable added is still another digest', digest(server({ API_TOKEN: 'one' })) !== digest(server({ API_TOKEN: 'one', LOG_LEVEL: 'info' })))

section('§3 a server that names none of them keeps the digest it had, and is not asked again')
{
  const plain = server({ API_TOKEN: 'token-one', LOG_LEVEL: 'info' })
  const bare: Definition = { type: 'stdio', command: 'node', args: ['server.js'], scope: 'project' }
  const remote: Definition = { type: 'http', url: 'https://probe.invalid/mcp', scope: 'project' }
  const helped: Definition = { type: 'http', url: 'https://probe.invalid/mcp', headersHelper: '/usr/bin/true first', scope: 'project' }
  for (const [label, definition] of [['a stdio server with a token and a log level', plain], ['a stdio server with no environment', bare], ['a remote server', remote], ['a remote server with a headers helper', helped]] as Array<[string, Definition]>) {
    check(`${label}: its digest is the one the names-only key gave`, digest(definition) === before(definition), `${digest(definition)} ${before(definition)}`)
  }
  writeFileSync(LOCAL, JSON.stringify({ kit: { projectOn: [`kept#${before(plain)}`] } }))
  resetSettingsCache()
  check('approved under the names-only key, it reads approved now', status('kept', plain) === 'approved', status('kept', plain))
}

section('§4 a server that names one is asked once after the update, and then no more')
{
  const named = server({ PATH: '/usr/bin:/bin', API_TOKEN: 'token-one' })
  check('its digest is no longer the names-only one', digest(named) !== before(named), `${digest(named)} ${before(named)}`)
  writeFileSync(LOCAL, JSON.stringify({ kit: { projectOn: [`named#${before(named)}`] } }))
  resetSettingsCache()
  check('approved under the names-only key, it is asked about once', status('named', named) === 'pending', status('named', named))
  recordProjectMcpServerChoices({ approved: [{ name: 'named', config: named as never }] })
  resetSettingsCache()
  check('once approved it stays approved', status('named', named) === 'approved', status('named', named))
  check('…until the value changes', status('named', server({ PATH: './bin:/usr/bin:/bin', API_TOKEN: 'token-one' })) === 'pending')
}

section('§5 the value is read as written: the user\'s own environment does not move the key')
{
  type Loaded = Definition & { unexpanded?: { env?: Record<string, string> } }
  const load = (): Record<string, Loaded> => getProjectMcpConfigsFromCwd().servers as unknown as Record<string, Loaded>
  const one = load()
  process.env.PROBE_PATH = '/opt/homebrew/bin:/usr/bin:/bin'
  process.env.PROBE_TOKEN = 'token-two'
  const two = load()
  check('the loader expands the reference with the user\'s environment', one.first?.env?.PATH === '/usr/bin:/bin:./bin' && two.first?.env?.PATH === '/opt/homebrew/bin:/usr/bin:/bin:./bin', `${one.first?.env?.PATH} ${two.first?.env?.PATH}`)
  check('…and keeps the code variable as written, and no token', JSON.stringify(two.first?.unexpanded?.env) === JSON.stringify({ PATH: '${PROBE_PATH}:./bin' }), JSON.stringify(two.first?.unexpanded))
  check('a server that names no code variable carries no written copy of its environment', two.plain?.unexpanded?.env === undefined, JSON.stringify(two.plain?.unexpanded))
  check('the digest is the same under both environments', digest(one.first as Definition) === digest(two.first as Definition), `${digest(one.first as Definition)} ${digest(two.first as Definition)}`)
  check('two definitions written alike have one digest', digest(two.first as Definition) === digest(two.same as Definition))
  check('a definition whose written value differs has another', digest(two.first as Definition) !== digest(two.other as Definition))
}

removeScratch(SCRATCH)
console.log(`\nprove-approval-key-reads-code-variables: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
