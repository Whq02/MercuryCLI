#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }

type Capture = { code: number | null; out: string; err: string }
function runWith(args: string[]): Capture {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'refusal-shape-')))
  seedFirstRun(home, [home])
  try {
    const r = spawnSync('node', [dist, 'run', ...args], { cwd: home, env: { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }, input: '', encoding: 'utf8', timeout: 90_000 })
    return { code: r.status, out: r.stdout, err: r.stderr }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
type Outcome = { type?: string; status?: string; error?: { message?: string; class?: string } }
const oneOutcome = (out: string): Outcome | null => {
  const lines = out.trim().split('\n').filter(Boolean)
  if (lines.length !== 1) return null
  try { return JSON.parse(lines[0]!) as Outcome } catch { return null }
}
const keysOf = (value: unknown): string => (value && typeof value === 'object' ? Object.keys(value as object).sort().join(',') : '')

const refusals: Array<[string, string[], number, string]> = [
  ['an option refusal (--max-turns 0)', ['hi', '--ephemeral', '--max-turns', '0'], 2, 'positive integer'],
  ['an invalid --mcp configuration', ['hi', '--ephemeral', '--mcp', '{"mcpServers":{"x":{}}}'], 2, 'MCP'],
  ['a resume of an unknown session id', ['--resume', randomUUID(), 'hi'], 1, ''],
  ['a compat model with no configured endpoint', ['hi', '--ephemeral', '--model', 'compat/no-such-endpoint'], 1, 'no-such-endpoint'],
]
for (const [label, args, exit, words] of refusals) {
  const rows = runWith([...args, '--format', 'rows'])
  const json = runWith([...args, '--format', 'json'])
  const text = runWith([...args, '--format', 'text'])
  const rowsOutcome = oneOutcome(rows.out)
  const jsonOutcome = oneOutcome(json.out)
  check(`${label}: rows exits ${exit} with one refused outcome row on stdout and nothing on stderr`, rows.code === exit && rowsOutcome?.type === 'outcome' && rowsOutcome.status === 'refused' && rows.err === '' && String(rowsOutcome.error?.message ?? '').includes(words), `exit ${rows.code} out=${rows.out.slice(0, 160)} err=${rows.err.slice(0, 120)}`)
  check(`${label}: json exits ${exit} with the same outcome as one object on stdout and nothing on stderr`, json.code === exit && jsonOutcome?.type === 'outcome' && jsonOutcome.status === 'refused' && json.err === '' && String(jsonOutcome.error?.message ?? '').includes(words), `exit ${json.code} out=${json.out.slice(0, 160)} err=${json.err.slice(0, 120)}`)
  check(`${label}: the json object carries the rows row's field set and error class`, rowsOutcome !== null && jsonOutcome !== null && keysOf(rowsOutcome) === keysOf(jsonOutcome) && rowsOutcome.error?.class === jsonOutcome.error?.class, `${keysOf(rowsOutcome)} vs ${keysOf(jsonOutcome)}`)
  check(`${label}: text exits ${exit} with the sentence on stderr and nothing on stdout`, text.code === exit && text.out === '' && text.err.includes(words) && text.err.trim() !== '', `exit ${text.code} out=${text.out.slice(0, 120)} err=${text.err.slice(0, 160)}`)
}
process.exit(failures === 0 ? 0 : 1)
