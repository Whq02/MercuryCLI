
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const repo = path.resolve(import.meta.dir, '../..')
const dist = path.join(repo, 'dist/mercury.mjs')

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('prove-unavailable-honesty — a real command is never an unknown skill')

if (!existsSync(dist)) {
  console.error('prove-unavailable-honesty: dist/mercury.mjs missing — run the build first (the gate prebuilds it)')
  process.exit(1)
}

const RUN_HOME = mkdtempSync(path.join(tmpdir(), 'mercury-verity-honesty-'))
const PROBE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-verity-shape-probe'
writeFileSync(
  path.join(RUN_HOME, '.mercury.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    projects: { [repo]: { hasTrustDialogAccepted: true } },
    customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
  }),
)

function drive(prompt: string): { result: string; ok: boolean; refused: boolean; raw: string } {
  const res = spawnSync('node', [dist, '-p', prompt, '--output-format', 'json'], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(60000),
    cwd: repo,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: RUN_HOME,
      NODE_ENV: 'test',
      ANTHROPIC_API_KEY: PROBE_KEY,
    },
  })
  const raw = res.stdout ?? ''
  try {
    const envelope = JSON.parse(raw.slice(raw.indexOf('{'))) as { result?: string; is_error?: boolean }
    return { result: envelope.result ?? '', ok: res.status === 0, refused: res.status === 1 && envelope.is_error === true, raw }
  } catch {
    return { result: '', ok: false, refused: false, raw: `${raw}\n${res.stderr ?? ''}` }
  }
}

{
  const { result, refused } = drive('/critter')
  check('-p /critter answers the refusal envelope (exit 1, is_error — the command did not run)', refused)
  check(
    '/critter (local-jsx) answers the interactive-surface reason',
    result.includes('/critter command is an interactive surface'),
    result.slice(0, 160),
  )
  check('/critter is NOT called an unknown skill', !result.includes('Unknown skill'), result.slice(0, 160))
}

{
  const { result } = drive('/concourse')
  check(
    '/concourse (interactive-only local) answers the foreground reason',
    result.includes('/concourse command is an interactive surface') ||
      result.includes('/concourse command is interactive-only'),
    result.slice(0, 160),
  )
  check('/concourse is NOT called an unknown skill', !result.includes('Unknown skill'), result.slice(0, 160))
}

{
  const { result } = drive('/context')
  check(
    'control: /context serves its headless breakdown (the pair twin still answers)',
    result.length > 0 && !result.includes('Unknown skill') && !result.includes('is an interactive surface'),
    result.slice(0, 160),
  )
}

{
  const { result } = drive('/zz-not-a-command-zz')
  check(
    'control: an unregistered name still answers the unknown-skill line',
    result.startsWith('Unknown skill: zz-not-a-command-zz'),
    result.slice(0, 160),
  )
}

rmSync(RUN_HOME, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nprove-unavailable-honesty: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-unavailable-honesty: green')
process.exit(0)
