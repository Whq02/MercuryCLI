
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { isOutcome, outcomeErrorText, parseRow } from '../../src/rows/read.ts'

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

const COUNT_FIXTURE = [
  "const { createServer } = require('node:http')",
  "const server = createServer((req, res) => {",
  "  req.resume()",
  "  req.on('end', () => {",
  "    if (req.method === 'POST' && String(req.url).includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 1200 })); return }",
  "    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'the count fixture serves count_tokens only' } }))",
  "  })",
  "})",
  "server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\\n`))",
].join('\n')
const counter = spawn('node', ['-e', COUNT_FIXTURE], { stdio: ['ignore', 'pipe', 'inherit'] })
const COUNT_BASE = await new Promise<string>((resolve, reject) => {
  counter.stdout.once('data', chunk => resolve(`http://127.0.0.1:${String(chunk).trim()}`))
  counter.once('exit', code => reject(new Error(`the count fixture ended before listening (exit ${String(code)})`)))
})

function drive(prompt: string): { result: string; ok: boolean; refused: boolean; raw: string } {
  const res = spawnSync('node', [dist, 'run', prompt, '--format', 'json'], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(60000),
    cwd: repo,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: RUN_HOME,
      NODE_ENV: 'test',
      ANTHROPIC_API_KEY: PROBE_KEY,
      ANTHROPIC_BASE_URL: COUNT_BASE,
    },
  })
  const stdout = res.stdout ?? ''
  const raw = `${stdout}\n${res.error ? `spawn: ${res.error.message}\n` : ''}${(res.stderr ?? '').split('\n').slice(-6).join('\n')}`
  const row = parseRow(stdout.split('\n').find(line => line.startsWith('{')) ?? '')
  if (row === null || !isOutcome(row)) return { result: '', ok: false, refused: false, raw }
  const refused = res.status === 1 && row.status === 'refused'
  const completed = res.status === 0 && row.status === 'completed'
  return { result: refused ? outcomeErrorText(row) ?? '' : completed ? String(row.answer ?? '') : '', ok: completed, refused, raw }
}

{
  const { result, refused } = drive('/critter')
  check('run /critter answers a refused outcome (exit 1, status refused — the command did not run)', refused)
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
  const { result, raw } = drive('/context')
  check(
    'control: /context serves its headless breakdown (the pair twin still answers)',
    result.length > 0 && !result.includes('Unknown skill') && !result.includes('is an interactive surface'),
    result.slice(0, 160) || raw.slice(-400),
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

counter.kill()
rmSync(RUN_HOME, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nprove-unavailable-honesty: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-unavailable-honesty: green')
process.exit(0)
