#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, NODE } from '../daemon/dupline-world.ts'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

type Check = { id: string; status: string; evidence?: string; fix?: string }
const flatten = (value: unknown, out: Check[] = []): Check[] => {
  if (Array.isArray(value)) for (const item of value) flatten(item, out)
  else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.id === 'string' && typeof record.status === 'string') out.push(record as unknown as Check)
    for (const inner of Object.values(record)) flatten(inner, out)
  }
  return out
}

const world = realpathSync(mkdtempSync(join(tmpdir(), 'health-provider-')))
console.log(`build under proof: ${DIST}`)

function health(extraEnv: Record<string, string>): { code: number | null; verdict: string | undefined; checks: Check[]; stderr: string } {
  const home = mkdtempSync(join(world, 'home-'))
  const work = join(home, 'work')
  mkdirSync(work)
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(world, 'os-home'), MERCURY_CONFIG_DIR: join(home, 'config'), TMPDIR: world, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ...extraEnv }
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_HOME', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'HF_TOKEN', 'HUGGINGFACE_API_KEY']) {
    if (!(name in extraEnv)) delete env[name]
  }
  mkdirSync(env.HOME!, { recursive: true })
  const run = spawnSync(NODE, [DIST, 'health', '--json'], { cwd: work, env, encoding: 'utf8', timeout: 120_000 })
  let parsed: unknown = null
  try {
    parsed = JSON.parse(run.stdout)
  } catch {
    parsed = null
  }
  const verdict = parsed !== null && typeof parsed === 'object' ? String((parsed as { verdict?: unknown }).verdict) : undefined
  return { code: run.status, verdict, checks: flatten(parsed), stderr: run.stderr }
}

section('§1 a home whose only credential is an OpenRouter key: the verdict follows the provider the session will use')
const openrouterOnly = health({ OPENROUTER_API_KEY: 'sk-or-proof-not-a-real-key' })
const anthropicRow = openrouterOnly.checks.find(c => c.id === 'auth-anthropic')
const openrouterRow = openrouterOnly.checks.find(c => c.id === 'auth-openrouter')
check('health answered a certificate', openrouterOnly.verdict !== undefined, openrouterOnly.stderr.slice(-300))
check('the OpenRouter key reads present', openrouterRow?.status === 'ok', JSON.stringify(openrouterRow))
check("Anthropic's absence is a fact, not a failure: the session routes to openrouter", anthropicRow?.status === 'info' && (anthropicRow.evidence ?? '').includes('session routes to openrouter'), JSON.stringify(anthropicRow))
check('no row says no turn can run', !openrouterOnly.checks.some(c => (c.fix ?? '').includes('no turn can run')))
check('the verdict is not FAULT and the exit is not 3', openrouterOnly.verdict !== 'fault' && openrouterOnly.code !== 3, `${openrouterOnly.verdict} / exit ${openrouterOnly.code}`)

section('§2 a home with no credential anywhere still names the sign-in as the way forward')
const keyless = health({})
const keylessAnthropic = keyless.checks.find(c => c.id === 'auth-anthropic')
check('health answered a certificate', keyless.verdict !== undefined, keyless.stderr.slice(-300))
check('the Anthropic row is not informational in a keyless home', keylessAnthropic !== undefined && keylessAnthropic.status !== 'info' && keylessAnthropic.status !== 'ok', JSON.stringify(keylessAnthropic))
check('its fix names the sign-in', (keylessAnthropic?.fix ?? '').includes('/logins'), JSON.stringify(keylessAnthropic))

rmSync(world, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL LAWS HOLD' : `${failures} FAILURE(S)`} — prove-health-follows-signed-in-provider`)
process.exit(failures === 0 ? 0 : 1)
