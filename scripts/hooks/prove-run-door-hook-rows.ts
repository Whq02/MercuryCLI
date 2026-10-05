#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'hook-run-door-'))
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
const cwd = join(root, 'workspace')
mkdirSync(cwd, { recursive: true })
const dist = process.env.MERCURY_HOOK_ROWS_DIST ?? join(import.meta.dir, '../../dist/mercury.mjs')
if (process.env.MERCURY_HOOK_ROWS_PROOF !== '1') {
  console.log('SKIP run-door hook rows: the lane ships the wiring as DAEMON-WIRING.patch (the lead applies it at the fold). Build with the patch applied, then run with MERCURY_HOOK_ROWS_PROOF=1 [and optionally MERCURY_HOOK_ROWS_DIST=<dist>] to pin the wired road')
  process.exit(0)
}
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const fixture = await startFixtureApi([{ kind: 'text', text: 'fixture answered' }])
writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks: {
  SessionStart: [{ hooks: [{ type: 'command', command: 'echo hook-start-mark' }] }],
  Notification: [{ hooks: [{ type: 'command', command: 'echo hook-notice-mark' }] }],
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hook-turn-mark' }] }],
  PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hook-tool-mark' }] }],
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
check('the patched run door settles against the fixture provider', code === 0 && rows.some(row => row.type === 'outcome' && row.status === 'completed'), `code ${code}`)
check('the original SessionStart firing reaches one hook lifecycle task row', hookRows.filter(row => row.state === 'ended' && String(row.summary).includes('hook-start-mark')).length === 1)
check('the turn hook (UserPromptSubmit) still runs in-process without a second row dispatch', hookRows.filter(row => String(row.summary).includes('hook-turn-mark')).length === 0, `${hookRows.length} hook rows`)
check('tool events stay OFF the rows stream (lifecycle events only)', hookRows.filter(row => String(row.summary).includes('hook-tool-mark')).length === 0, `${hookRows.length} hook rows`)
check('every hook row carries the run session identity', hookRows.length > 0 && hookRows.every(row => typeof row.session_id === 'string' && (row.session_id as string).length > 0))
check('the added rows are still valid JSON lines', rows.every(row => !('bad' in row)))
if (failures) console.log(JSON.stringify({ code, hookRows, stderr: stderr.slice(0, 400) }))
rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? 'RUN DOOR HOOK ROWS GREEN' : `${failures} RUN DOOR HOOK ROWS FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
