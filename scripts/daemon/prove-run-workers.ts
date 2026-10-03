#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { composeProcessSweepFacts } from '../../src/daemon/processSweep.ts'
import { createPeer } from '../../src/runner/wire/peer.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL worker bundle exists: ${dist}`); process.exit(1) }
const home = realpathSync(mkdtempSync(join(tmpdir(), 'run-workers-')))
seedFirstRun(home, [home])
const api = await startFixtureApi([{ kind: 'text', text: 'The worker answered.' }, { kind: 'text', text: 'The scheduled run answered.' }])
Object.assign(process.env, { HOME: home, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key' })
delete process.env.MERCURY_DAEMON_PERMISSION_MODE
const executable = Object.getOwnPropertyDescriptor(process, 'execPath')!
Object.defineProperty(process, 'execPath', { ...executable, value: execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim() })
const { spawnStreamJsonChild, runTaskHeadless } = await import('../../src/daemon/headlessRun.ts')
const savedArgv = process.argv[1]
process.argv[1] = dist
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }
try {
  const { child, argv } = spawnStreamJsonChild({ model: 'claude-sonnet-5', effort: 'high', appendSystemPrompt: 'Answer the fixture prompt.', role: 'MERCURY_CONCOURSE_WORKER', agentName: 'worker', agentId: 'worker', plainIdentity: true, permissionMode: 'flow', allowBypass: true, cwd: home, extraArgv: ['--session-id', randomUUID()] })
  check('the daemon worker starts through the runner door with its mode and availability', argv[1] === 'runner' && !argv.some(word => word.startsWith('--input') || word.startsWith('--format') || word.startsWith('--permission')) && argv[argv.indexOf('--mode') + 1] === 'flow' && argv.includes('--allow-sovereign'), JSON.stringify(argv))
  let out = '', err = ''
  child.stdout!.on('data', data => { out += data })
  child.stderr!.on('data', data => { err += data })
  child.stdin!.on('error', () => {})
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
  const closed = new Promise<number | null>(resolve => child.on('close', code => { clearTimeout(timer); resolve(code) }))
  const rows: Array<Record<string, unknown>> = []
  const peer = createPeer({ input: child.stdout!, output: child.stdin!, side: 'host', log: () => {} })
  peer.onNotification('row', row => { rows.push(row as Record<string, unknown>) })
  await peer.request('initialize', { protocol: 1, host: { name: 'proof', version: '0' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } }, { deadlineMs: 60_000 })
  await peer.request('queue/add', { type: 'prompt', content: 'answer the worker' }, { deadlineMs: 10_000 })
  child.stdin!.end()
  const code = await closed
  peer.close('done')
  check('the spawned daemon worker completes a loopback turn', code === 0 && rows.some(row => row.type === 'outcome' && row.answer === 'The worker answered.' && row.status === 'completed'), JSON.stringify({ code, out, err }))
  let oneShotArgv: string[] = []
  const oneShot = await runTaskHeadless({ id: 'scheduled', prompt: 'answer the scheduled run', permissionMode: 'flow', allowedTools: ['Read', 'Bash'] }, home, child => { oneShotArgv = child.spawnargs }, 60_000)
  check('the scheduled run protects its prompt from tool-list parsing', oneShotArgv.includes('run') && oneShotArgv[oneShotArgv.length - 2] === '--' && oneShot.code === 0 && oneShot.stdout.trim() === 'The scheduled run answered.', JSON.stringify({ oneShotArgv, oneShot }))
  for (const [args, kind] of [[['run', '--format', 'rows'], 'runner'], [['--format', 'rows'], 'window'], [['--model', 'run', 'daemon'], 'daemon'], [['daemon', 'run'], 'daemon'], [['--', 'run'], 'window']] as const) {
    const facts = composeProcessSweepFacts({ complete: true, observations: [{ process: { pid: 2222, ppid: 1, exe: 'node', args: ['node', '/fixture/mercury.mjs', ...args], startedAtMs: 1, user: 'fixture', terminal: null }, startToken: 'fixture', state: 'S', terminalAlive: false }] }, { nowMs: 1000, platform: 'linux', selfPid: 3333, user: 'fixture', configHome: home, drainMs: 1, heartbeatAllowanceMs: 1, planes: [], registrations: [], memory: {} })
    check(`the process sweep classifies ${args.join(' ')} as ${kind}`, facts[0]?.kind === kind, JSON.stringify(facts[0]))
  }
} finally {
  process.argv[1] = savedArgv!
  Object.defineProperty(process, 'execPath', executable)
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
