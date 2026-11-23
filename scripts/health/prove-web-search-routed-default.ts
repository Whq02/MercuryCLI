import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_PROVIDER_CREDENTIAL_ENV_VARS } from '../../src/models/sign-in/credentials/credentialEnvSpellings.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const root = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'web-search-routed-default-'))
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
type Row = { id: string; status: string; evidence?: string }
function run(label: string, extra: Record<string, string>): Row[] {
  const home = join(scratch, label)
  mkdirSync(home)
  seedFirstRun(home, [scratch])
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('MERCURY_') || ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes(key) || ['BRAVE_API_KEY', 'TAVILY_API_KEY', 'HUGGINGFACE_API_KEY', 'CI', 'NODE_ENV'].includes(key)) delete env[key]
  }
  Object.assign(env, {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    MERCURY_OPENROUTER_API_BASE: 'http://127.0.0.1:1',
    MERCURY_OPENAI_API_BASE: 'http://127.0.0.1:1',
    MERCURY_ANTHROPIC_OAUTH_BASE: 'http://127.0.0.1:1',
    ...extra,
  })
  const result = spawnSync('node', [join(root, 'dist', 'mercury.mjs'), 'health', '--json'], {
    cwd: scratch, env, encoding: 'utf8', timeout: 60_000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let rows: Row[] = []
  try {
    const certificate = JSON.parse(result.stdout) as { sections: Array<{ checks: Row[] }> }
    rows = certificate.sections.flatMap(section => section.checks)
  } catch {}
  check(`${label}: health emits a certificate`, rows.length > 0, `exit=${result.status} — run node dist/mercury.mjs health --json (build first with bun run build.ts) and read why it printed no certificate`)
  return rows
}
try {
  for (const keyless of [true, false]) {
    const label = keyless ? 'router-only' : 'router-no-keyless'
    const rows = run(label, { OPENROUTER_API_KEY: 'fixture-router-key', ...(keyless ? {} : { MERCURY_SEARCH_KEYLESS: '0' }) })
    const model = rows.find(row => row.id === 'model')
    const search = rows.find(row => row.id === 'web-search-door')
    check(`${label}: model is not resolved before the catalogue is fetched`, String(model?.evidence).includes('no usable row yet'), `${JSON.stringify(model)} — the model check in src/platform/health/sections/settings/model.ts must report an unresolved default before the catalogue is fetched`)
    check(`${label}: search reports the same unresolved model`, String(search?.evidence).includes('no usable row yet'), `${JSON.stringify(search)} — webSearchDoorCheck in src/platform/health/sections/auth.ts must report the same unresolved model as the model check`)
    check(`${label}: search does not advertise a native provider`, !String(search?.evidence).includes('(native, session account)'), `${JSON.stringify(search)} — webSearchDoorCheck in src/platform/health/sections/auth.ts must not name a native provider while the default model is unresolved`)
    check(`${label}: search status follows the available doors`, search?.status === (keyless ? 'ok' : 'info'), `${JSON.stringify(search)} — webSearchDoorCheck in src/platform/health/sections/auth.ts must be ok with the keyless door and info without it (MERCURY_SEARCH_KEYLESS=0)`)
  }
  const native = run('native-default', { ANTHROPIC_API_KEY: 'fixture-anthropic-key' }).find(row => row.id === 'web-search-door')
  check('native default keeps its native search door', native?.status === 'ok' && String(native.evidence).includes('Anthropic web search (native, session account)'), `${JSON.stringify(native)} — webSearchDoorCheck in src/platform/health/sections/auth.ts must keep the native door for an Anthropic default`)
  const explicit = run('explicit-router', { OPENROUTER_API_KEY: 'fixture-router-key', MERCURY_MODEL: 'openrouter/fixture/search-model' }).find(row => row.id === 'web-search-door')
  check('explicit model still wins', String(explicit?.evidence).includes('openrouter/fixture/search-model'), `${JSON.stringify(explicit)} — webSearchDoorCheck in src/platform/health/sections/auth.ts must name the model set by MERCURY_MODEL`)
  check('explicit routed model does not acquire native search', !String(explicit?.evidence).includes('(native, session account)'), `${JSON.stringify(explicit)} — webSearchDoorCheck in src/platform/health/sections/auth.ts must not add a native search door for a routed model`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`prove-web-search-routed-default: ${checks - failures}/${checks} PASS`)
process.exit(failures === 0 ? 0 : 1)
