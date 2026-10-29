#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, handoffTurn, isHandoffRequest, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { hostRunner } from '../lib/runnerHost.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }
const nodeBin = Bun.which('node') ?? 'node'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }
const NOTE = 'The note for the next session.'
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens'] as const
type Row = Record<string, unknown> & { usage?: Record<string, number> }
const usageSum = (rows: Row[], key: string): number => rows.reduce((sum, row) => sum + (row.usage?.[key] ?? 0), 0)
const ledgerNoteOf = (home: string): string | null => {
  const projects = join(home, 'projects')
  if (!existsSync(projects)) return null
  let note: string | null = null
  for (const key of readdirSync(projects)) {
    const ledger = join(projects, key, 'lineage', 'ledger.jsonl')
    if (!existsSync(ledger)) continue
    for (const line of readFileSync(ledger, 'utf8').split('\n')) {
      if (!line.startsWith('{')) continue
      const entry = JSON.parse(line) as { handoff?: { text?: string } | null }
      if (entry.handoff && typeof entry.handoff.text === 'string') note = entry.handoff.text
    }
  }
  return note
}
const world = (prefix: string): { home: string; cwd: string; env: (url: string) => Record<string, string> } => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  seedFirstRun(home, [home])
  const cwd = join(home, 'project')
  mkdirSync(cwd, { recursive: true })
  return { home, cwd, env: url => ({ HOME: home, PATH: `/usr/bin:/bin:${dirname(nodeBin)}`, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_HOME: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: url }) }
}
const answer: ScriptedTurn = { kind: 'text', text: 'DONE', usage: { input_tokens: 100, output_tokens: 10 } }
const close: ScriptedTurn = { ...handoffTurn(NOTE), usage: { input_tokens: 120, output_tokens: 12 } }

console.log('§1 an unattended run (mercury run): the stream ends on the outcome, no close ask, no close row; the outcome is the sum of the step rows')
{
  const { home, cwd, env } = world('close-row-run-')
  const api = await startFixtureApi([answer, close])
  const child = spawn(nodeBin, [dist, 'run', '--format', 'rows', 'reply with exactly DONE'], { cwd, env: env(api.url), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', d => { out += String(d) })
  child.stderr.on('data', d => { err += String(d) })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000)
  try {
    const code = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
    const requests = api.messageRequests()
    const rows = out.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(r => r !== null) as Row[]
    const outcome = rows.filter(r => r.type === 'outcome').at(-1)
    const steps = rows.filter(r => r.type === 'step')
    check('the run completed (exit 0)', code === 0, JSON.stringify({ code, err: err.slice(0, 300) }))
    check('one request reached the model: the answer; the close ask never fired (the fixture\'s note turn stayed unserved)', requests.length === 1 && !requests.some(r => isHandoffRequest(r as never)), `${requests.length} requests, ${requests.filter(r => isHandoffRequest(r as never)).length} asks`)
    check('the stream ends on the outcome row with no close row', rows.at(-1)?.type === 'outcome' && !rows.some(r => r.type === 'close'), rows.map(r => r.type).join(','))
    check('the ledger holds no note for the run', ledgerNoteOf(home) === null, JSON.stringify(ledgerNoteOf(home)))
    for (const key of USAGE_KEYS) {
      const each = usageSum(steps, key)
      const total = Number(outcome?.usage?.[key] ?? 0)
      check(`the step rows' ${key} sum to the outcome's (${each} = ${total})`, outcome !== undefined && each === total, JSON.stringify({ each, total }))
    }
    check('the outcome counts the answer alone', outcome?.usage?.input_tokens === 100 && outcome.usage.output_tokens === 10, JSON.stringify(outcome?.usage))
  } finally {
    clearTimeout(timeout)
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}

console.log('§2 a hosted session (mercury runner) whose host closes its end after the outcome: the close ask runs, the close row follows the outcome with the ask\'s usage, apart from the outcome\'s')
{
  const { home, cwd, env } = world('close-row-runner-')
  const api = await startFixtureApi([answer, close])
  const host = hostRunner({ node: nodeBin, dist, cwd, home, env: env(api.url) })
  const killer = setTimeout(() => host.child.kill('SIGKILL'), 90_000)
  try {
    await host.initialize()
    await host.prompt('reply with exactly DONE', { id: 'close-row-1' })
    await host.waitFor('the outcome row', row => row.type === 'outcome', 60_000)
    host.end()
    const code = await host.exited
    const rows = host.rows as Row[]
    const requests = api.messageRequests()
    const outcome = rows.filter(r => r.type === 'outcome').at(-1)
    const steps = rows.filter(r => r.type === 'step')
    const closeRow = rows.find(r => r.type === 'close')
    check('the runner left with exit 0', code === 0, `exit ${code} · ${host.stderr().slice(0, 300)}`)
    check('two requests reached the model: the answer, then the marked close ask', JSON.stringify(requests.map(r => isHandoffRequest(r as never))) === JSON.stringify([false, true]), JSON.stringify(requests.map(r => isHandoffRequest(r as never))))
    check('the close row follows the outcome row and ends the stream', closeRow !== undefined && rows.indexOf(closeRow) > rows.indexOf(outcome!) && rows.at(-1) === closeRow, rows.map(r => `${r.type}${r.state !== undefined ? `:${String(r.state)}` : ''}`).join(','))
    check('the close row says stored and carries the close ask\'s usage', closeRow?.state === 'stored' && closeRow.usage?.input_tokens === 120 && closeRow.usage.output_tokens === 12, JSON.stringify(closeRow))
    check('the ledger holds the note exactly as the model wrote it', ledgerNoteOf(home) === NOTE, JSON.stringify(ledgerNoteOf(home)))
    for (const key of USAGE_KEYS) {
      const each = usageSum(steps, key)
      const total = Number(outcome?.usage?.[key] ?? 0)
      check(`the outcome's ${key} is the step rows' sum, the close ask's apart (${each} = ${total})`, outcome !== undefined && each === total, JSON.stringify({ each, total }))
    }
  } finally {
    clearTimeout(killer)
    await host.stop()
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}
process.exit(failures === 0 ? 0 : 1)
