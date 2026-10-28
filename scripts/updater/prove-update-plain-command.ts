#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver } from '../lib/captureDriver.js'
import { closedLoopbackPort } from './journeyFixtures.js'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_JOURNEY_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.log(`prove-update-plain-command: SKIPPED — ${DIST} is not built`)
  process.exit(0)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`prove-update-plain-command: SKIPPED — a console on stdin needs the POSIX pty driver (this host: ${driver.kind})`)
  process.exit(0)
}
const python = driver.python

const NOTE = 'stdout is not attached to a terminal'
const scratch = mkdtempSync(join(tmpdir(), 'update-plain-command-'))
const home = join(scratch, 'home')
const configHome = join(home, '.mercury')
const versionsDir = join(scratch, 'versions')
for (const p of [home, configHome, versionsDir]) mkdirSync(p, { recursive: true })
const DEAD_BASE = `http://127.0.0.1:${await closedLoopbackPort()}`

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}

const PTY_STDIN = [
  'import json, os, pty, subprocess, sys',
  'master, slave = pty.openpty()',
  'p = subprocess.run(sys.argv[1:], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)',
  'os.close(slave); os.close(master)',
  "print(json.dumps({'code': p.returncode, 'stdout': p.stdout.decode('utf8', 'replace'), 'stderr': p.stderr.decode('utf8', 'replace')}))",
].join('\n')

function consoleOnStdinOnly(args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(python, ['-c', PTY_STDIN, 'node', DIST, ...args], {
    encoding: 'utf8',
    timeout: 150_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      MERCURY_CONFIG_DIR: configHome,
      MERCURY_VERSIONS_DIR: versionsDir,
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_UPDATE_API_BASE_URL: DEAD_BASE,
      MERCURY_UPDATE_NOTICE: '0',
      ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
      ANTHROPIC_BASE_URL: DEAD_BASE,
      CI: '1',
      TERM: 'dumb',
    },
  })
  const line = (res.stdout ?? '').trim().split('\n').pop() ?? ''
  try {
    return JSON.parse(line) as { code: number; stdout: string; stderr: string }
  } catch {
    return { code: -1, stdout: res.stdout ?? '', stderr: `${res.stderr ?? ''}\n${String(res.error ?? '')}` }
  }
}

console.log('§1 `mercury update`, a console on stdin and its output captured (a scheduled task, a CI job, a detached run): no word about terminals')
for (const args of [['update', '--check'], ['update', '--status'], ['update', '--check', '--json']]) {
  const r = consoleOnStdinOnly(args)
  const all = `${r.stdout}\n${r.stderr}`
  check(`${args.join(' ')} answers as itself (exit ${r.code})`, r.code === 0 || r.code === 1, all)
  check(`${args.join(' ')} prints no non-interactive note`, !all.includes(NOTE) && !all.includes('non-interactive') && !all.includes('Pass run to silence'), all)
  check(`${args.join(' ')} says what it did`, /update check|update available|installed|channel|could not be reached/.test(all), all)
}

console.log('§2 the note stays with the chat entry, where a session would have started')
{
  const r = consoleOnStdinOnly(['--fork'])
  check('the chat entry with its output captured prints the note before its own refusal', r.stderr.includes(NOTE) && r.stderr.includes('--fork requires mercury run') && r.stderr.indexOf(NOTE) < r.stderr.indexOf('--fork requires'), r.stderr)
}

console.log('§3 the help page captured to a file carries no note either')
{
  const r = consoleOnStdinOnly(['--help'])
  check('mercury --help prints its page and nothing about terminals', r.code === 0 && r.stdout.includes('Usage:') && !`${r.stdout}\n${r.stderr}`.includes(NOTE), `${r.stdout.slice(0, 120)} · ${r.stderr}`)
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-update-plain-command: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
