#!/usr/bin/env bun
// prove-config-write-contention — concurrent global-config writes (field card
// FC-011, folding E008 138/139). A contended config lock was abandoned after
// one attempt and the save proceeded through the LOCKLESS read-modify-write,
// so 16 concurrent `mcp add --scope user` runs all printed success and most
// registrations were silently lost (14/16 survived on this box at base;
// 3/16 on the field box), and a raced `mcp remove` printed Removed while the
// server stayed registered. saveConfigWithLock now retries a CONTENDED lock
// with bounded backoff before any fallback; the fresh-home ENOENT class
// still falls through immediately.
//
// Drives the BUILT artifact (this suite's existing character): real
// processes, real lock contention, real config file.
//
//   §1 sixteen concurrent adds: every reported success is a real write.
//   §2 the remove/add race: every reported outcome is true afterwards.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

if (!existsSync(DIST)) {
  console.error('  [FAIL] dist/mercury.mjs missing — run bun run build.ts first')
  process.exit(1)
}

const HOME = mkdtempSync(join(tmpdir(), 'config-contention-'))

type Run = { rc: number; out: string }
const runMercury = (args: string[]): Promise<Run> =>
  new Promise(resolve => {
    const child = spawn('node', [DIST, ...args], {
      env: { ...process.env, MERCURY_CONFIG_DIR: HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', d => (out += String(d)))
    child.stderr.on('data', d => (out += String(d)))
    child.on('close', rc => resolve({ rc: rc ?? -1, out }))
  })

const registeredServers = (): string[] => {
  try {
    const cfg = JSON.parse(readFileSync(join(HOME, '.mercury.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    return Object.keys(cfg.mcpServers ?? {})
  } catch {
    return []
  }
}

section('§1 SIXTEEN CONCURRENT ADDS')
{
  const runs = await Promise.all(
    Array.from({ length: 16 }, (_, i) => runMercury(['mcp', 'add', '--scope', 'user', `srv_${i + 1}`, '--', 'echo', `cmd_${i + 1}`])),
  )
  const successes = runs.filter(r => r.rc === 0 && /Added/i.test(r.out)).length
  const survivors = registeredServers().filter(name => name.startsWith('srv_')).length
  check('all sixteen adds report success', successes === 16, `successes=${successes}`)
  check(
    'every reported success is a REAL registration (FC-011: none silently lost)',
    survivors === 16,
    `survivors=${survivors}/16`,
  )
}

section('§2 THE REMOVE/ADD RACE')
{
  const raced = await Promise.all([
    runMercury(['mcp', 'remove', 'srv_1', '--scope', 'user']),
    runMercury(['mcp', 'remove', 'srv_2', '--scope', 'user']),
    runMercury(['mcp', 'remove', 'srv_3', '--scope', 'user']),
    runMercury(['mcp', 'add', '--scope', 'user', 'srv_17', '--', 'echo', 'cmd_17']),
    runMercury(['mcp', 'add', '--scope', 'user', 'srv_18', '--', 'echo', 'cmd_18']),
    runMercury(['mcp', 'add', '--scope', 'user', 'srv_19', '--', 'echo', 'cmd_19']),
  ])
  const after = new Set(registeredServers())
  const removedReported = raced.slice(0, 3).filter(r => r.rc === 0 && /Removed/i.test(r.out)).length
  const addedReported = raced.slice(3).filter(r => r.rc === 0 && /Added/i.test(r.out)).length
  check('the three removes report removed', removedReported === 3, `reported=${removedReported}`)
  check(
    'a reported remove IS removed (no ghost registrations)',
    !after.has('srv_1') && !after.has('srv_2') && !after.has('srv_3'),
    JSON.stringify([...after].filter(n => /^srv_[123]$/.test(n))),
  )
  check('the three raced adds report added', addedReported === 3, `reported=${addedReported}`)
  check(
    'a reported raced add IS registered',
    after.has('srv_17') && after.has('srv_18') && after.has('srv_19'),
    JSON.stringify([...after].filter(n => /^srv_1[789]$/.test(n))),
  )
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-config-write-contention: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-config-write-contention: all green')
