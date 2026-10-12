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

const SCRUB = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ZAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'XAI_MANAGEMENT_API_KEY',
  'MODEL_API_KEY',
  'META_API_KEY',
  'MOONSHOT_API_KEY',
  'MISTRAL_API_KEY',
  'NOUS_API_KEY',
  'OPENROUTER_API_KEY',
  'HF_TOKEN',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_LOCAL_API_KEY',
  'MERCURY_MODEL',
]

const scratchHome = mkdtempSync(join(tmpdir(), 'signed-out-home-'))
mkdirSync(join(scratchHome, '.mercury'), { recursive: true })

function run(verb: string[]): { status: number; json: Record<string, unknown> | null; stdout: string; stderr: string } {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    MERCURY_CONFIG_DIR: join(scratchHome, '.mercury'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    BROWSER: '/usr/bin/true',
  }
  for (const name of SCRUB) delete childEnv[name]
  let stdout = ''
  let stderr = ''
  let status = 0
  try {
    stdout = execFileSync('node', [BIN, ...verb], {
      cwd: scratchHome,
      env: childEnv,
      encoding: 'utf8',
      timeout: 120_000,
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

type HealthCheck = { id: string; status: string; evidence?: string; fix?: string }
const checksOf = (json: Record<string, unknown> | null): HealthCheck[] => {
  const sections = (json?.sections ?? []) as Array<{ checks?: HealthCheck[] }>
  return sections.flatMap(s => s.checks ?? [])
}

section('§1 a fresh home with no sign-in anywhere: health --json is not a fault')
{
  const r = run(['health', '--json'])
  check('health --json answered a certificate', r.json !== null, `${r.stdout.slice(0, 200)} · ${r.stderr.slice(-300)}`)
  const verdict = String(r.json?.verdict ?? '')
  check('the verdict is caution, never fault', verdict === 'caution', `verdict=${verdict}`)
  check('the exit is 0, never 3', r.status === 0, `status=${r.status}`)
  const failing = checksOf(r.json).filter(c => c.status === 'fail')
  check('no row reads fail on a signed-out install', failing.length === 0, JSON.stringify(failing.map(c => ({ id: c.id, evidence: c.evidence }))))
  const anthropic = checksOf(r.json).find(c => c.id === 'auth-anthropic')
  check('the Anthropic row reads warn', anthropic?.status === 'warn', JSON.stringify(anthropic))
  check('…and says "not signed in" first', (anthropic?.evidence ?? '').startsWith('not signed in'), JSON.stringify(anthropic))
  check('…with the way in: /logins', (anthropic?.fix ?? '').includes('/logins'), JSON.stringify(anthropic))
}

section('§2 the plain-text certificate agrees')
{
  const r = run(['health'])
  check('the plain report exits 0', r.status === 0, `status=${r.status} · ${r.stderr.slice(-300)}`)
  check('its verdict line reads CAUTION', /verdict: CAUTION/.test(r.stdout), r.stdout.split('\n').filter(l => l.includes('verdict')).join(' | '))
  check('it never says FAULT', !/FAULT/.test(r.stdout), r.stdout.split('\n').filter(l => l.includes('FAULT')).join(' | '))
  check('the Anthropic row is a warn that says not signed in', /\[WARN\] Anthropic — not signed in/.test(r.stdout), r.stdout.split('\n').filter(l => l.includes('Anthropic')).join(' | '))
}

rmSync(scratchHome, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-signed-out-is-not-a-fault — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-signed-out-is-not-a-fault — all checks pass')
process.exit(0)
