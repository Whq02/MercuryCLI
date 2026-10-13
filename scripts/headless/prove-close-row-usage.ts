#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, handoffTurn, isHandoffRequest, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }

const home = realpathSync(mkdtempSync(join(tmpdir(), 'close-row-')))
seedFirstRun(home, [home])
const cwd = join(home, 'project')
mkdirSync(cwd, { recursive: true })
const answer: ScriptedTurn = { kind: 'text', text: 'DONE', usage: { input_tokens: 100, output_tokens: 10 } }
const close: ScriptedTurn = { ...handoffTurn('The note for the next session.'), usage: { input_tokens: 120, output_tokens: 12 } }
const api = await startFixtureApi([answer, close])
const child = spawn('node', [dist, 'run', '--format', 'rows', 'reply with exactly DONE'], {
  cwd,
  env: { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_HOME: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: api.url },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', d => { out += String(d) })
child.stderr.on('data', d => { err += String(d) })
const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000)
try {
  const code = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
  const requests = api.messageRequests()
  const closeRequests = requests.filter(r => isHandoffRequest(r as never))
  const rows = out.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(r => r !== null) as Array<Record<string, unknown>>
  const outcomeRow = rows.filter(r => r.type === 'outcome').at(-1) as { usage?: Record<string, number>; status?: string } | undefined
  const closeRows = rows.filter(r => r.type === 'close')
  check('the run completed (exit 0)', code === 0, JSON.stringify({ code, err: err.slice(0, 300) }))
  check('the close ask fired (the fixture saw its request)', closeRequests.length > 0, `${closeRequests.length} of ${requests.length} requests`)
  check('the rows carry a close row', closeRows.length > 0, rows.map(r => r.type).join(','))
  const closeUsage = closeRows.at(-1) as { state?: string; usage?: Record<string, number> } | undefined
  check('the close row carries the close ask\'s usage', closeUsage !== undefined && closeUsage.usage !== undefined && (closeUsage.usage.output_tokens ?? 0) > 0, JSON.stringify(closeUsage))
  const stepRows = rows.filter(r => r.type === 'step') as Array<{ usage?: Record<string, number> }>
  const sumOf = (pick: (row: Record<string, number>) => number | undefined): number =>
    stepRows.reduce((sum, row) => sum + (row.usage ? pick(row.usage as Record<string, number>) ?? 0 : 0), 0) +
    closeRows.reduce((sum, row) => sum + (row.usage ? pick(row.usage as Record<string, number>) ?? 0 : 0), 0)
  const outcomeUsage = outcomeRow?.usage ?? {}
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_write_input_tokens'] as const) {
    const each = sumOf(usage => usage[key])
    const total = Number(outcomeUsage[key] ?? 0)
    check(`every row's ${key} sums to the outcome's (${each} = ${total})`, each === total, JSON.stringify({ each, total }))
  }
} finally {
  clearTimeout(timeout)
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
