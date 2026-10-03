;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startScriptedFixture } from '../lib/scriptedTurn.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { hostRunner } from '../lib/runnerHost.ts'

const at = process.argv.indexOf('--dist')
const dist = at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!
let failures = 0
const check = (label: string, okay: boolean, detail: unknown): void => { if (!okay) failures++; console.log(`[${okay ? 'PASS' : 'FAIL'}] ${label}${okay ? '' : ` — ${JSON.stringify(detail)}`}`) }
for (const kind of ['note-main', 'note-absent', 'shell', 'shell-signal']) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'input-delivery-')))
  seedFirstRun(home, [home])
  const fixture = await startScriptedFixture(() => [{ type: 'text', text: 'PROMPT-COMPLETE' }])
  const child = spawn(Bun.which('node')!, [dist, 'run', '--input', 'rows', '--format', 'rows', '--model', 'claude-opus-4-8'], { cwd: home, env: { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: fixture.base }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let interrupted = false
  child.stdout.on('data', data => {
    stdout += String(data)
    if (kind === 'shell-signal' && !interrupted && stdout.includes('"state":"started"')) {
      interrupted = true
      child.kill('SIGINT')
    }
  })
  child.stderr.on('data', data => { stderr += String(data) })
  const rows = kind === 'shell-signal' ? [{ type: 'shell', command: 'sleep 30' }] : kind === 'shell' ? [{ type: 'shell', command: 'printf "SHELL-OUT\\n"; printf "SHELL-ERR <>&\\n" >&2' }] : [{ type: 'note', to: kind === 'note-main' ? 'main' : 'no-such-agent', content: 'AGENT-ONLY-NOTE' }, { type: 'prompt', content: 'complete the main prompt' }]
  child.stdin.end(rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  const rc = await new Promise<number | null>(resolve => child.on('close', resolve))
  clearTimeout(timer)
  await fixture.close()
  const output = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, any>)
  const outcome = output.find(row => row.type === 'outcome')
  if (kind === 'shell-signal') {
    check('a signalled shell turn emits interrupted before exit 130', rc === 130 && outcome?.status === 'interrupted' && fixture.requests.length === 0, { rc, outcome, stderr })
  } else if (kind === 'shell') {
    const text = output.filter(row => row.type === 'command_output').map(row => row.text).join('\n')
    check('shell output reaches a command_output row and its outcome answer', rc === 0 && text.includes('SHELL-OUT') && text.includes('SHELL-ERR <>&') && outcome?.answer === text && fixture.requests.length === 0, { rc, output, stderr })
  } else {
    check(`${kind}: the main prompt behind an addressed note completes`, rc === 0 && outcome?.status === 'completed' && outcome.answer === 'PROMPT-COMPLETE', { rc, output, stderr })
    check(`${kind}: the agent note is not consumed by the main model`, fixture.requests.length === 1 && fixture.requests.every(req => !req.allTexts.some(text => text.includes('AGENT-ONLY-NOTE'))), fixture.requests.map(req => req.allTexts))
  }
  rmSync(home, { recursive: true, force: true })
}
{
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'shell-interrupt-')))
  seedFirstRun(home, [home])
  const host = hostRunner({ dist, node: Bun.which('node')!, home, cwd: home, env: { HOME: home, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } })
  try {
    await host.initialize()
    await host.request('queue/add', { type: 'shell', command: 'sleep 30' })
    const started = await host.waitFor('shell start', row => row.type === 'turn' && row.state === 'started')
    const interrupt = await host.request('turn/interrupt', { turn_id: String(started.turn_id) })
    const outcome = await host.waitFor('interrupted shell outcome', row => row.type === 'outcome')
    check('host interruption settles a shell turn as interrupted with its original identity', interrupt.interrupted && outcome.status === 'interrupted' && outcome.turn_id === started.turn_id && outcome.turn === started.turn, outcome)
    const rc = await host.stop()
    check('a hosted interrupted shell exits 1 on EOF', rc === 1, { rc, stderr: host.stderr() })
  } finally {
    await host.stop()
    rmSync(home, { recursive: true, force: true })
  }
}
process.exit(failures === 0 ? 0 : 1)
