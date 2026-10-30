#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }

type Capture = { code: number | null; out: string; err: string; requests: number }
async function runWith(args: string[], prepare?: (home: string) => string[]): Promise<Capture> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-flag-')))
  seedFirstRun(home, [home])
  const api = await startFixtureApi([{ kind: 'text', text: 'the answer' }])
  const child = spawn('node', [dist, 'run', ...args, ...(prepare?.(home) ?? [])], { cwd: home, env: { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: api.url }, stdio: ['ignore', 'pipe', 'pipe'] })
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
  ['inline JSON that does not parse', '{bad', 'not valid JSON'],
  ['the path of a file that does not exist', '/no/such/folder/mcp-servers.json', 'no such file'],
  ['a relative path that does not exist', 'relative-typo.json', 'no such file'],
  ['well-formed JSON of the wrong shape (the control that was already refused)', '{"servers":[1,2]}', 'MCP'],
]
for (const [label, value, words] of bad) {
  for (const format of ['rows', 'text'] as const) {
    const cap = await runWith(['hi', '--ephemeral', '--format', format, '--mcp', value])
    const where = format === 'rows' ? String((firstRow(cap.out)?.error as { message?: string } | undefined)?.message ?? '') : cap.err
    check(`${label} (${format}): the run is refused as a usage error, exit 2`, cap.code === 2, `exit ${cap.code} out=${cap.out.slice(0, 160)} err=${cap.err.slice(0, 160)}`)
    check(`${label} (${format}): the refusal names the fault${format === 'rows' ? ' on the refused outcome row' : ' on stderr'}`, where.includes(words) && (value.startsWith('{"servers') || where.includes(value.slice(0, 20))), JSON.stringify(where.slice(0, 240)))
    check(`${label} (${format}): no model request was made`, cap.requests === 0, `${cap.requests} request(s)`)
  }
}

{
  const cap = await runWith(['hi', '--ephemeral', '--format', 'json', '--only-mcp'], home => {
    const file = join(home, 'servers.json')
    writeFileSync(file, '{"mcpServers":{}}\n')
    return ['--mcp', file]
  })
  check('the control: a file that exists and parses still runs, exit 0, the answer on the outcome', cap.code === 0 && firstRow(cap.out)?.status === 'completed' && cap.requests === 1, `exit ${cap.code} out=${cap.out.slice(0, 160)} err=${cap.err.slice(0, 160)}`)
}
process.exit(failures === 0 ? 0 : 1)
