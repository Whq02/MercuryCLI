#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { endProcessTree } from '../../src/utils/processGroup.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { slashed } from '../lib/platformPath.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { SHELL_PID_COMMAND, shellTreeRows, shellTreeWords } from '../lib/toolShellTree.ts'

if (process.platform === 'win32') {
  console.log('prove-hangup-ends-the-tool-tree: SKIPPED — Node maps SIGHUP and SIGTERM to a forced TerminateProcess on Windows, so neither signal reaches the run; the hangup twin is a console close, which needs a console window this proof does not open (the forced kill is prove-shell-parent-death)')
  process.exit(0)
}

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (ready: () => boolean, budgetMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) { if (ready()) return true; await sleep(50) }
  return ready()
}
const pidWritten = (file: string): boolean => existsSync(file) && /^\d+\s*$/.test(readFileSync(file, 'utf8'))

for (const [signal, expected] of [['SIGHUP', 129], ['SIGTERM', 143]] as const) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hangup-tool-')))
  seedFirstRun(home, [home])
  const marker = join(home, 'tool.pid')
  const turns: ScriptedTurn[] = [
    { kind: 'tool_use', name: 'Bash', input: { command: `sh -c '${SHELL_PID_COMMAND} > "${slashed(marker)}"; sleep 120'`, description: 'a long step' } },
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
    const toolStarted = await waitFor(() => pidWritten(marker), 20_000)
    toolPid = toolStarted ? Number(readFileSync(marker, 'utf8')) : 0
    const before = shellTreeRows(toolPid)
    check(`${signal}: the shell tool is running before the signal`, toolPid > 1 && before.length > 0, `pid ${toolPid}, rows: ${shellTreeWords(before)}`)
    child.kill(signal)
    const code = await closed
    const rows: Array<Record<string, unknown>> = []
    for (const line of out.trim().split('\n')) { try { rows.push(JSON.parse(line)) } catch {} }
    const last = rows.at(-1)
    check(`${signal}: exits ${expected}`, code === expected, JSON.stringify({ code, err: err.slice(0, 300) }))
    check(`${signal}: the last row is the interrupted turn's outcome`, last?.type === 'outcome' && last.status === 'interrupted', JSON.stringify(last ?? rows.map(row => row.type)))
    let left = shellTreeRows(toolPid)
    const deadline = Date.now() + 5_000
    while (left.length > 0 && Date.now() < deadline) { await sleep(50); left = shellTreeRows(toolPid) }
    check(`${signal}: the tool's shell is gone with the run (no process left behind)`, left.length === 0, `still alive after the run exited: ${shellTreeWords(left)}`)
  } finally {
    clearTimeout(timeout)
    if (toolPid > 1) await endProcessTree(toolPid)
    await api.close()
    removeScratch(home)
  }
}
process.exit(failures === 0 ? 0 : 1)
