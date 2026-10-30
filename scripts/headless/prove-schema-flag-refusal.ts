#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }

type Capture = { code: number | null; out: string; err: string; requests: number }
async function runWith(args: string[], turns: ScriptedTurn[]): Promise<Capture> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'schema-flag-')))
  seedFirstRun(home, [home])
  const api = await startFixtureApi(turns)
  const child = spawn('node', [dist, 'run', ...args], { cwd: home, env: { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: api.url }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', data => { out += String(data) })
  child.stderr.on('data', data => { err += String(data) })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000)
  try {
    const code = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
    return { code, out, err, requests: api.messageRequests().length }
  } finally {
    clearTimeout(timeout)
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}
const firstRow = (out: string): Record<string, unknown> | null => { try { return JSON.parse(out.trim().split('\n')[0] ?? '') as Record<string, unknown> } catch { return null } }

const bad: Array<[string, string, string]> = [
  ['not JSON', 'not-json', '--schema is not JSON — '],
  ['a type the engine refuses', '{"type":"nonsense-type"}', '--schema is not a JSON schema — '],
  ['an array, not an object', '[1,2]', '--schema must be a JSON object'],
]
for (const [label, schema, words] of bad) {
  for (const format of ['rows', 'text'] as const) {
    const cap = await runWith(['hi', '--format', format, '--schema', schema], [{ kind: 'text', text: 'plain prose' }])
    const where = format === 'rows' ? String((firstRow(cap.out)?.error as { message?: string } | undefined)?.message ?? '') : cap.err
    check(`${label} (${format}): the run is refused as a usage error, exit 2`, cap.code === 2, `exit ${cap.code} out=${cap.out.slice(0, 160)} err=${cap.err.slice(0, 160)}`)
    check(`${label} (${format}): the refusal names --schema and the fault${format === 'rows' ? ' on the refused outcome row' : ' on stderr'}`, where.startsWith(words), JSON.stringify(where.slice(0, 200)))
    check(`${label} (${format}): no model request was made`, cap.requests === 0, `${cap.requests} request(s)`)
    if (format === 'rows') check(`${label} (rows): the row is a refused outcome and stderr is silent`, firstRow(cap.out)?.type === 'outcome' && firstRow(cap.out)?.status === 'refused' && cap.err === '', `${cap.out.slice(0, 120)} err=${cap.err.slice(0, 120)}`)
  }
}

{
  const schema = '{"type":"object","properties":{"a":{"type":"number"}},"required":["a"]}'
  const cap = await runWith(['hi', '--format', 'json', '--schema', schema], [{ kind: 'tool_use', name: 'StructuredOutput', input: { a: 1 } }, { kind: 'text', text: 'done' }])
  const outcome = firstRow(cap.out)
  check('the control: a schema the engine accepts still runs, the outcome completes and carries the structured answer', cap.code === 0 && outcome?.status === 'completed' && JSON.stringify(outcome?.structured) === '{"a":1}', `exit ${cap.code} out=${cap.out.slice(0, 200)} err=${cap.err.slice(0, 160)}`)
}
process.exit(failures === 0 ? 0 : 1)
