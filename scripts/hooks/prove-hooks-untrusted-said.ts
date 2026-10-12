#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { dist, quote } from './lib/runDoor.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let failures = 0
const check = (label: string, good: boolean, detail = ''): void => {
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
if (!existsSync(dist)) {
  console.log(`FAIL — ${dist} is missing; build first`)
  process.exit(1)
}

async function run(trusted: boolean): Promise<{ code: number | null; stderr: string; stdout: string; marks: number }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hooks-untrusted-')))
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(cwd, '.mercury'), { recursive: true })
  const marks = join(root, 'marks.txt')
  writeFileSync(join(cwd, '.mercury', 'settings.json'), JSON.stringify({ events: { hooks: { 'turn.start': [{ name: 'project-start', run: `echo project >> ${quote(marks)}` }], 'tool.before': [{ name: 'project-guard', match: 'Read', run: `echo guard >> ${quote(marks)}` }] } } }))
  writeFileSync(join(cwd, '.mercury', 'settings.local.json'), JSON.stringify({ events: { hooks: { 'turn.start': [{ name: 'local-start', run: `echo local >> ${quote(marks)}` }] } } }))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks: { 'turn.start': [{ name: 'user-start', run: `echo user >> ${quote(marks)}` }] } } }))
  if (trusted) {
    writeFileSync(join(home, '.mercury.json'), JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true, projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
  }
  const api = await startFixtureApi([{ kind: 'text', text: 'ok' }])
  const child = spawn('node', [dist, 'run', '--format', 'rows', 'say ok'], {
    cwd,
    env: { ...process.env, HOME: home, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: api.url, MERCURY_LOCAL_PROBE_TARGETS: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', bytes => { stdout += String(bytes) })
  child.stderr.on('data', bytes => { stderr += String(bytes) })
  const guard = setTimeout(() => child.kill('SIGKILL'), 90_000)
  const code = await new Promise<number | null>(resolve => child.once('close', resolve))
  clearTimeout(guard)
  await api.close()
  const marksCount = existsSync(marks) ? readFileSync(marks, 'utf8').split('\n').filter(Boolean).length : 0
  rmSync(root, { recursive: true, force: true })
  return { code, stderr, stdout, marks: marksCount }
}

const untrusted = await run(false)
check('the untrusted run completes', untrusted.code === 0, `${untrusted.code} ${untrusted.stderr.slice(0, 300)}`)
check('only the user hook fired: the three checkout hooks stayed unloaded', untrusted.marks === 1, `${untrusted.marks} mark(s)`)
const line = untrusted.stderr.split('\n').find(l => /hooks: this folder is not trusted/.test(l)) ?? ''
check('stderr says the folder is not trusted and counts the three hooks left unloaded', /hooks: this folder is not trusted, so its 3 project and local hooks were not loaded — start Mercury here once and accept the trust card, and they run$/.test(line), untrusted.stderr.trim().slice(0, 400) || '(stderr empty)')
check('the line is said once', untrusted.stderr.split('\n').filter(l => /this folder is not trusted/.test(l)).length === 1)
check('nothing about trust reaches stdout', !/not trusted/.test(untrusted.stdout))

const trusted = await run(true)
check('the trusted run completes', trusted.code === 0, `${trusted.code} ${trusted.stderr.slice(0, 300)}`)
check('every hook fired in the trusted folder', trusted.marks === 3, `${trusted.marks} mark(s)`)
check('…and no trust line is drawn', !/not trusted/.test(trusted.stderr), trusted.stderr.trim().slice(0, 300))

if (failures > 0) {
  console.log(`\nprove-hooks-untrusted-said: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-hooks-untrusted-said: all green')
