#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
process.env.NODE_ENV = 'test'
const home = mkdtempSync(join(tmpdir(), 'runner-slow-init-home-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_SESSION_HOME

let checks = 0
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const j = (v: unknown): string => JSON.stringify(v)

const headless = await import('../../src/daemon/headlessRun.ts')
const { buildConcourseWorkerSpec } = await import('../../src/daemon/concourseWorkers.ts')

section('§3 a respawn never rides --resume onto a conversation nobody wrote (the receipt: "No conversation found for session id" ×3, each counted as a crash)')
{
  const workspaceId = realpathSync(mkdtempSync(join(tmpdir(), 'runner-slow-init-ws-')))
  const sessionId = '90555e9a-3846-4405-9e48-ca69a8c175af'
  const spec = buildConcourseWorkerSpec({ runnerId: 'concourse-w64', sessionId, workspaceId, modelKey: 'claude-fable-5', cwd: join(workspaceId, '.wt', 'concourse-w64') })
  const first = headless.buildRunnerInvocation(spec)
  check('the first boot pins --session-id', first.argv.includes('--session-id') && first.argv.includes(sessionId) && !first.argv.includes('--resume'), first.argv.join(' '))
  const unwritten = headless.buildRunnerInvocation(spec, { respawn: true })
  check('a respawn before any transcript exists boots the SAME id with --session-id, never --resume', unwritten.argv.includes('--session-id') && unwritten.argv.includes(sessionId) && !unwritten.argv.includes('--resume'), unwritten.argv.join(' '))
  const home = String(unwritten.env.MERCURY_SESSION_HOME)
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, `${sessionId}.jsonl`), `${j({ type: 'user', uuid: `${sessionId}-u1`, sessionId, message: { role: 'user', content: 'a turn' } })}\n`)
  const written = headless.buildRunnerInvocation(spec, { respawn: true })
  check('once the transcript exists the respawn rides --resume of the same durable session', written.argv.includes('--resume') && written.argv.includes(sessionId) && !written.argv.includes('--session-id'), written.argv.join(' '))
  const readmitted = buildConcourseWorkerSpec({ runnerId: 'concourse-w65', sessionId: '11111111-2222-4333-8444-555555555555', workspaceId, modelKey: 'claude-fable-5', resume: true })
  const readmit = headless.buildRunnerInvocation(readmitted)
  check('a re-admission (resume: true) of a record whose transcript was never written boots --session-id too', readmit.argv.includes('--session-id') && !readmit.argv.includes('--resume'), readmit.argv.join(' '))
  const identityArgvOf = (headless as Partial<typeof headless>).identityArgvOf
  check('identityArgvOf keeps the rest of the argv in place around the swapped flag', identityArgvOf !== undefined && j(identityArgvOf({ cwd: workspaceId, extraEnv: { MERCURY_SESSION_HOME: home } }, ['--resume', 'nobody-wrote-me', '--brief-add', 'x'], () => false)) === j(['--session-id', 'nobody-wrote-me', '--brief-add', 'x']))
  check('identityArgvOf leaves an argv without --resume untouched', identityArgvOf !== undefined && j(identityArgvOf({ cwd: workspaceId }, ['--session-id', 'x'], () => false)) === j(['--session-id', 'x']))
  const runnerSessionHome = (headless as Partial<typeof headless>).runnerSessionHome
  check('the transcript is looked up in the pinned session home (the workspace project dir), not the carved worktree cwd', runnerSessionHome !== undefined && runnerSessionHome(spec) === home && home !== join(workspaceId, '.wt', 'concourse-w64'), j({ home, got: runnerSessionHome?.(spec) }))
  rmSync(workspaceId, { recursive: true, force: true })
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-respawn-unwritten-session: ALL LAWS HOLD' : `prove-respawn-unwritten-session: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
