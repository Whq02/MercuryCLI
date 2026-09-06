#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

const scratchHome = mkdtempSync(join(tmpdir(), 'auth-routed-home-'))
mkdirSync(join(scratchHome, '.mercury'), { recursive: true })

const SCRUB = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ZAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENROUTER_API_KEY',
  'HF_TOKEN',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_LOCAL_API_KEY',
  'MERCURY_MODEL',
]

function run(verb: string[], env: Record<string, string>): { status: number; json: Record<string, unknown> | null; stdout: string; stderr: string } {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    MERCURY_CONFIG_DIR: join(scratchHome, '.mercury'),
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
  }
  for (const name of SCRUB) delete childEnv[name]
  Object.assign(childEnv, env)
  let stdout = ''
  let stderr = ''
  let status = 0
  try {
    stdout = execFileSync('node', [BIN, ...verb], {
      cwd: scratchHome,
      env: childEnv,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    status = err.status ?? -1
    stdout = err.stdout ?? ''
    stderr = err.stderr ?? ''
  }
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    json = null
  }
  return { status, json, stdout, stderr }
}

type HealthCheck = { id: string; status: string; evidence?: string }
const checksOf = (json: Record<string, unknown> | null): HealthCheck[] => {
  const sections = (json?.sections ?? []) as Array<{ checks?: HealthCheck[] }>
  return sections.flatMap(s => s.checks ?? [])
}
const rowOf = (json: Record<string, unknown> | null, id: string): HealthCheck | undefined =>
  checksOf(json).find(c => c.id === id)

section('§1 engine-routed with its credential: Anthropic absence is info, exit 0')
{
  const r = run(['health', '--json'], {
    DEEPSEEK_API_KEY: 'fixture-deepseek-key',
    MERCURY_MODEL: 'deepseek-chat',
  })
  const anthropicRow = rowOf(r.json, 'auth-anthropic')
  const deepseekRow = rowOf(r.json, 'auth-deepseek')
  check('health --json parsed', r.json !== null, r.stdout.slice(0, 200))
  check('the Anthropic row reads info (absence is a fact, not a failure)', anthropicRow?.status === 'info', JSON.stringify(anthropicRow))
  check('the routed DeepSeek row is present and not failing', deepseekRow !== undefined && deepseekRow.status !== 'fail', JSON.stringify(deepseekRow))
  check('exit 0 (no FAULT from the unused lane)', r.status === 0, `status=${r.status} verdict=${String(r.json?.verdict)}`)
}

section('§2 engine-routed with the engine credential MISSING: fail, FAULT, exit 3')
{
  const r = run(['health', '--json'], {
    ANTHROPIC_API_KEY: 'fixture-anthropic-key',
    MERCURY_MODEL: 'deepseek-chat',
  })
  const deepseekRow = rowOf(r.json, 'auth-deepseek')
  check('the routed family with no credential reads fail', deepseekRow?.status === 'fail', JSON.stringify(deepseekRow))
  check('verdict FAULT, exit 3 (preflight no longer false-greens the missing engine credential)', r.status === 3 && String(r.json?.verdict ?? '').toLowerCase().includes('fault'), `status=${r.status} verdict=${String(r.json?.verdict)}`)
}

section('§3 the default Anthropic posture is unchanged')
{
  const r = run(['health', '--json'], {})
  const anthropicRow = rowOf(r.json, 'auth-anthropic')
  check('anthropic-routed with no credential: the anthropic row still fails', anthropicRow?.status === 'fail', JSON.stringify(anthropicRow))
  check('…and the report exits 3 as before', r.status === 3, `status=${r.status}`)
  const ok = run(['health', '--json'], { ANTHROPIC_API_KEY: 'fixture-anthropic-key' })
  const okRow = rowOf(ok.json, 'auth-anthropic')
  check('anthropic-routed with the credential: the row is ok', okRow?.status === 'ok', JSON.stringify(okRow))
}

section('§4 auth status --json: per-family rows, frozen fields, routed exit')
{
  const engineRouted = run(['auth', 'status', '--json'], {
    CI: 'true',
    DEEPSEEK_API_KEY: 'fixture-deepseek-key',
    MERCURY_MODEL: 'deepseek-chat',
  })
  check('stdout is JSON-only', engineRouted.json !== null, `stdout: ${engineRouted.stdout.slice(0, 120)} · stderr: ${engineRouted.stderr.slice(0, 200)}`)
  const providers = (engineRouted.json?.providers ?? []) as Array<{ id: string; kind: string; source: string; present: boolean }>
  check('one row per declared family (ten)', providers.length === 10, String(providers.length))
  check(
    'each row carries id, kind, source, present — and no value is secret-shaped',
    providers.every(p => typeof p.id === 'string' && typeof p.kind === 'string' && typeof p.source === 'string' && typeof p.present === 'boolean') &&
      !engineRouted.stdout.includes('fixture-deepseek-key'),
  )
  check('the routed family is named', engineRouted.json?.routedProvider === 'deepseek', String(engineRouted.json?.routedProvider))
  check('the DeepSeek row reads present', providers.find(p => p.id === 'deepseek')?.present === true)
  check('the frozen Anthropic fields are retained', 'loggedIn' in (engineRouted.json ?? {}) && 'authMethod' in (engineRouted.json ?? {}) && engineRouted.json?.apiProvider === 'firstParty')
  check('the exit answers for the ROUTED family (present ⇒ 0, Anthropic ladder empty or not)', engineRouted.status === 0, `status=${engineRouted.status}`)

  const engineMissing = run(['auth', 'status', '--json'], {
    ANTHROPIC_API_KEY: 'fixture-anthropic-key',
    MERCURY_MODEL: 'deepseek-chat',
  })
  check('engine-routed with the credential missing exits 1', engineMissing.status === 1, `status=${engineMissing.status}`)
  check('…while the Anthropic ladder still reports loggedIn true (frozen field, unchanged meaning)', engineMissing.json?.loggedIn === true)

  const anthropicDefault = run(['auth', 'status', '--json'], { ANTHROPIC_API_KEY: 'fixture-anthropic-key' })
  check('the Anthropic-routed default exits 0 exactly as before', anthropicDefault.status === 0 && anthropicDefault.json?.loggedIn === true, `status=${anthropicDefault.status}`)
}

rmSync(scratchHome, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-auth-routed-verdict — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-auth-routed-verdict — all checks pass')
process.exit(0)
