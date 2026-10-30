#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const waitFor = async (ready: () => boolean, budgetMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) { if (ready()) return true; await sleep(50) }
  return ready()
}

for (const [signal, expected] of [['SIGHUP', 129], ['SIGTERM', 143]] as const) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hangup-tool-')))
  seedFirstRun(home, [home])
  const marker = join(home, 'tool.pid')
  const turns: ScriptedTurn[] = [
    { kind: 'tool_use', name: 'Bash', input: { command: `sh -c 'echo $$ > ${marker}; sleep 120'`, description: 'a long step' } },
    { kind: 'text', text: 'after the step' },
  ]
  const api = await startFixtureApi(turns)
  const child = spawn('node', [dist, 'run', 'hold the step', '--mode', 'sovereign', '--format', 'rows'], { cwd: home, env: { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: api.url }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', data => { out += String(data) })
  child.stderr.on('data', data => { err += String(data) })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000)
  const closed = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
  let toolPid = 0
  try {
    await api.messageRequestStarted(1)
    const toolStarted = await waitFor(() => existsSync(marker) && readFileSync(marker, 'utf8').trim() !== '', 20_000)
    toolPid = toolStarted ? Number(readFileSync(marker, 'utf8').trim()) : 0
    check(`${signal}: the shell tool is running before the signal`, toolPid > 0 && alive(toolPid), `pid ${toolPid}`)
    child.kill(signal)
    const code = await closed
    const rows: Array<Record<string, unknown>> = []
    for (const line of out.trim().split('\n')) { try { rows.push(JSON.parse(line)) } catch {} }
    const last = rows.at(-1)
    check(`${signal}: exits ${expected}`, code === expected, JSON.stringify({ code, err: err.slice(0, 300) }))
    check(`${signal}: the last row is the interrupted turn's outcome`, last?.type === 'outcome' && last.status === 'interrupted', JSON.stringify(last ?? rows.map(row => row.type)))
    const toolGone = await waitFor(() => !alive(toolPid), 5_000)
    check(`${signal}: the tool's shell is gone with the run (no process left behind)`, toolGone, `pid ${toolPid} still alive after the run exited`)
  } finally {
    clearTimeout(timeout)
    if (toolPid > 0 && alive(toolPid)) { try { process.kill(toolPid, 'SIGKILL') } catch {} }
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}
process.exit(failures === 0 ? 0 : 1)
