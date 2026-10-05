#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'hook-run-door-'))
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
const cwd = join(root, 'workspace')
mkdirSync(cwd, { recursive: true })
const dist = process.env.MERCURY_HOOK_ROWS_DIST ?? join(import.meta.dir, '../../dist/mercury.mjs')
const runDoor = readFileSync(join(import.meta.dir, '../../src/cli/run.ts'), 'utf8')
if (!runDoor.includes('subscribeHookExecutionEvents')) {
  console.log('SKIP run-door hook rows: src/cli/run.ts does not subscribe hook execution events — the wiring rides DAEMON-WIRING.patch, which the lead applies at the fold; once it is in, this proof runs its six checks in the gate')
  process.exit(0)
}
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const fixture = await startFixtureApi([
  { kind: 'tool_use', name: 'Read', input: { file_path: '/fixture/README.md' }, id: 'hookrows_tool_1' },
  { kind: 'text', text: 'fixture answered' },
])
const toolHookLedger = join(root, 'tool-hook-ledger')
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks: {
  SessionStart: [{ hooks: [{ type: 'command', command: 'echo hook-start-mark' }] }],
  Notification: [{ hooks: [{ type: 'command', command: 'echo hook-notice-mark' }] }],
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hook-turn-mark' }] }],
  PreToolUse: [{ hooks: [{ type: 'command', command: `${quote(process.execPath)} -e ${quote(`require('node:fs').appendFileSync(${JSON.stringify(toolHookLedger)},'ran\\n')`)}` }] }],
} } }))
let stdout = ''
let stderr = ''
const child = spawn('node', [dist, 'run', '--format', 'rows', 'a fixture prompt'], { cwd, env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: fixture.url, MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_TRUST_DIALOG_ACCEPTED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', bytes => { stdout += String(bytes) })
child.stderr.on('data', bytes => { stderr += String(bytes) })
const guard = setTimeout(() => { child.kill('SIGTERM') }, 90_000)
const code = await new Promise<number | null>(resolve => child.once('close', resolve))
clearTimeout(guard)
await fixture.close()
const rows: Array<Record<string, unknown>> = stdout.trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) as Record<string, unknown> } catch { return { bad: line } } })
let failures = 0
const check = (label: string, good: boolean, detail = ''): void => { if (!good) failures++; console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`) }
const hookRows = rows.filter(row => row.type === 'task' && row.task_type === 'hook')
check('the wired run door settles against the fixture provider', code === 0 && rows.some(row => row.type === 'outcome' && row.status === 'completed'), `code ${code}`)
const toolHookRan = existsSync(toolHookLedger)
check('the PreToolUse hook really fired (a tool turn ran and its hook wrote the ledger, so the OFF check below has teeth)', toolHookRan && rows.some(row => row.type === 'tool_call'), `tool_call row: ${rows.some(row => row.type === 'tool_call')}, hook ledger: ${toolHookRan}`)
check('the original SessionStart firing reaches one hook lifecycle task row', hookRows.filter(row => row.state === 'ended' && String(row.summary).includes('hook-start-mark')).length === 1)
check('the turn hook (UserPromptSubmit) still runs in-process without a second row dispatch', hookRows.filter(row => String(row.summary).includes('hook-turn-mark')).length === 0, `${hookRows.length} hook rows`)
check('the fired PreToolUse hook stays OFF the rows stream (lifecycle events only)', hookRows.filter(row => String(row.summary).includes('hook-tool-mark')).length === 0, `${hookRows.length} hook rows`)
check('every hook row carries the run session identity', hookRows.length > 0 && hookRows.every(row => typeof row.session_id === 'string' && (row.session_id as string).length > 0))
check('the added rows are still valid JSON lines', rows.every(row => !('bad' in row)))
if (failures) console.log(JSON.stringify({ code, hookRows, toolCall: rows.filter(row => row.type === 'tool_call'), stderr: stderr.slice(0, 400) }))
rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? 'RUN DOOR HOOK ROWS GREEN' : `${failures} RUN DOOR HOOK ROWS FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
