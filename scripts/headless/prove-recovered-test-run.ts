#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, handoffTurn, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, ok: boolean, detail: unknown) { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(detail)}`); if (!ok) failures++ }
for (const shape of ['recovered', 'discovery-only', 'still-blocked'] as const) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'recovered-test-')))
  const cwd = join(home, 'project')
  mkdirSync(cwd)
  seedFirstRun(home, [cwd])
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  writeFileSync(join(cwd, 'sum.test.cjs'), "const { test } = require('node:test'); for (const name of ['one','two','three']) test(name,()=>{});\n")
  const answer = shape === 'still-blocked' ? '3 passed, 0 failed, 0 skipped, 0 errored. Publishing needs your go.' : shape === 'recovered' ? '3 passed, 0 failed, 0 skipped, 0 errored.' : 'The execution is unavailable.'
  const turns: ScriptedTurn[] = [
    { kind: 'tool_use', name: 'Bash', input: { command: 'node --test', description: 'Run project tests' } },
    { kind: 'tool_use', name: 'ToolSearch', input: { query: 'select:Test' } },
    ...(shape === 'discovery-only' ? [] : [{ kind: 'tool_use' as const, name: 'Test', input: { op: 'run', framework: 'node-test' } }]),
    ...(shape === 'still-blocked' ? [{ kind: 'tool_use' as const, name: 'AskUserQuestion', input: { questions: [{ question: 'Publish the package now?', header: 'Publish', options: [{ label: 'yes', description: 'publish' }, { label: 'no', description: 'hold' }], multiSelect: false }] } }] : []),
    { kind: 'text', text: answer }, handoffTurn(), handoffTurn(),
  ]
  const api = await startFixtureApi(turns)
  try {
    const child = spawn('node', [join(ROOT, 'dist', 'mercury.mjs'), 'run', '--format', 'rows', 'run the tests and tell me the counts', '--allowed-tools', 'Test'], {
      windowsHide: true, cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), BROWSER: '/usr/bin/true', MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url },
    })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const code = await new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit) })
    const rows = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
    const outcome = rows.find(row => row.type === 'outcome')
    check(`${shape}: the Bash denial stays recorded`, outcome?.denials?.some((d: { tool: string }) => d.tool === 'Bash') === true, outcome?.denials)
    if (shape === 'recovered') {
      check('the Test tool really ran and returned its three passed tests', rows.some(row => row.type === 'tool_result' && String(row.output).includes('3 passed · 0 failed')), rows.filter(row => row.type === 'tool_result').map(row => String(row.output).slice(0, 240)))
      check('work delivered after the denial completes with exit zero', code === 0 && outcome?.status === 'completed' && outcome.answer === answer, { code, outcome, stderr })
      check('the closing outcome keeps a note about the routed-around denial', outcome?.notices?.some((n: { text: string }) => n.text.includes('Bash') && n.text.includes('continued')) === true, outcome?.notices)
    } else check(`${shape}: an unanswered operation still blocks`, code === 1 && outcome?.status === 'blocked', { code, outcome, stderr })
    if (shape === 'still-blocked') check('RED ON THE BASE: the question nobody answered is quoted on the outcome, read from the ask (the Test tool that ran before it recovers nothing)', String(outcome?.error?.message ?? '').includes('«Publish the package now?»') && outcome?.denials?.some((d: { tool: string }) => d.tool === 'AskUserQuestion') === true, outcome?.error)
  } finally { await api.close(); rmSync(home, { recursive: true, force: true }) }
}
if (failures) process.exit(1)
console.log('prove-recovered-test-run: GREEN')
