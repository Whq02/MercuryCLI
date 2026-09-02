#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const PTYDRIVE = join(ROOT, 'scripts', 'streaming', 'ptydrive.py')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

if (!existsSync(DIST)) {
  console.log('❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)')
  process.exit(1)
}
const nodeBin = Bun.which('node')!

const RELEASE = '\x1b[0m\x1b[?1049l\x1b[?25h'

async function drivePty(argv: string[], seconds: number, extraEnv: Record<string, string> = {}): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'lucid-tr-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'lucid-tr-cwd-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  const out = join(home, 'drive.jsonl')
  const child = spawn(
    '/usr/bin/python3',
    [PTYDRIVE, '--cols', '100', '--rows', '30', '--seconds', String(seconds), '--out', out, '--', nodeBin, DIST, ...argv],
    {
      cwd,
      env: {
        ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
        HOME: home,
        PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
        TERM: 'xterm-256color',
        MERCURY_CONFIG_DIR: join(home, '.claude'),
        ANTHROPIC_API_KEY: 'fixture-key-000',
        MERCURY_DAEMON_DIR: join(home, 'daemon'),
        MERCURY_TEAMS_DIR: join(home, 'teams'),
        MERCURY_ALT_HELD: '1',
        ...extraEnv,
      },
    },
  )
  let driverErr = ''
  child.stderr?.on('data', d => (driverErr += String(d)))
  const killer = setTimeout(() => child.kill('SIGKILL'), (seconds + 30) * 1000)
  const status = await new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  clearTimeout(killer)
  if (!existsSync(out)) {
    console.log(`  [dbg] ptydrive produced no byte log — status=${status} stderr=${driverErr.slice(0, 300)}`)
    return ''
  }
  let bytes = ''
  for (const line of readFileSync(out, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as { b64?: string }
      if (rec.b64) bytes += Buffer.from(rec.b64, 'base64').toString('utf8')
    } catch {
    }
  }
  return bytes
}

section('R1 — flag typo: release first, error readable on the main screen')
{
  const bytes = await drivePty(['--definitely-not-a-flag'], 12)
  const rel = bytes.lastIndexOf('\x1b[?1049l')
  const err = bytes.indexOf('unknown option')
  check('the release sequence appears', rel !== -1, JSON.stringify(bytes.slice(0, 200)))
  check('the commander error appears', err !== -1, JSON.stringify(bytes.slice(-300)))
  check('the error prints AFTER the (last) release — on the main screen', rel !== -1 && err > rel, `rel=${rel} err=${err}`)
}

section('R2 — -p: release precedes the result; the result lands on the main screen')
{
  const { startFixtureApi } = await import('../lib/fixtureApi.ts')
  const fx = await startFixtureApi([{ kind: 'text', text: 'PROOF-TR-RESULT.' }])
  const bytes = await drivePty(['-p', 'say it'], 45, { ANTHROPIC_BASE_URL: fx.url })
  await fx.close().catch(() => {})
  const rel = bytes.indexOf('\x1b[?1049l')
  const result = bytes.indexOf('PROOF-TR-RESULT.')
  check('the release sequence appears', rel !== -1, JSON.stringify(bytes.slice(0, 200)))
  check('the -p result appears', result !== -1, JSON.stringify(bytes.slice(-300)))
  check('the release PRECEDES the result', rel !== -1 && result > rel, `rel=${rel} result=${result}`)
}

section('R3 — launcher: splash/hold gated on takeover; OSC title gated on TTY')
{
  const launcher = readFileSync(join(ROOT, 'scripts', 'ops', 'launcher-mercury.sh'), 'utf8')
  check('MERCURY_TAKEOVER gate exists', launcher.includes('MERCURY_TAKEOVER=1') && launcher.includes('MERCURY_TAKEOVER=0'))
  check('print/help args disable the takeover', /-p\|--print\|-h\|--help\|-v\|-V\|--version\)\s*MERCURY_TAKEOVER=0/.test(launcher))
  check('subcommands disable the takeover', launcher.includes('daemon|doctor|error|export|install|join|join-kit|log|mcp|extensions|setup-token|task|themis|up|update) MERCURY_TAKEOVER=0') || /case "\$\{1:-\}" in\n\s*[a-z|-]*daemon[a-z|-]*\) MERCURY_TAKEOVER=0/.test(launcher))
  check('the splash block requires the takeover gate', launcher.includes('[ "$MERCURY_TAKEOVER" = "1" ] && [ "${MERCURY_NO_BANNER:-0}" != "1" ] && [ -t 1 ]'))
  check('the OSC title is TTY-gated', launcher.includes(`[ -t 1 ] && printf '\\033]0;Mercury\\007'`))
  const syn = spawnSync('bash', ['-n', join(ROOT, 'scripts', 'ops', 'launcher-mercury.sh')], { encoding: 'utf8' })
  check('launcher syntax holds', syn.status === 0, syn.stderr ?? '')
}

section('R4 — interactive boot: the hold is consumed by the takeover, never released early')
{
  const { runArtifactArena, visibleText } = await import('../streaming/artifactArena.ts')
  const run = await runArtifactArena({
    turns: [],
    sends: [],
    seconds: 9,
    cols: 100,
    rows: 30,
    keep: true,
    extraEnv: { MERCURY_ALT_HELD: '1' },
  })
  try {
    const raw = readFileSync(run.paths.drive, 'utf8')
    let bytes = ''
    let t0 = 0
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line) as { b64?: string; ts?: number }
        if (!rec.b64 || typeof rec.ts !== 'number') continue
        if (t0 === 0) t0 = rec.ts
        if (rec.ts - t0 > 8000) break
        bytes += Buffer.from(rec.b64, 'base64').toString('utf8')
      } catch {
      }
    }
    check('the cockpit boots (rail chrome present)', visibleText(bytes).includes('lanes'), JSON.stringify(bytes.slice(0, 200)))
    check('ZERO alt-screen exits during the live window', !bytes.includes('\x1b[?1049l'))
  } finally {
    run.cleanup()
  }
}

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ terminal-restoration proofs: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ terminal-restoration proofs: all legs green')
process.exit(0)
