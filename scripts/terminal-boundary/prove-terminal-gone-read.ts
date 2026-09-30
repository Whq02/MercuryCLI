#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'

const ROOT = join(import.meta.dir, '..', '..')
const BIN = process.env.MERCURY_TERMINAL_GONE_BIN ?? join(ROOT, 'dist/mercury.mjs')
const HARNESS = join(import.meta.dir, 'lost-terminal.py')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-terminal-gone-')))
const SID = '00000000-aaaa-bbbb-cccc-e10e10e10e10'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

type Verdict = {
  mode: string
  productPid: number | null
  milestones: string[]
  exit: { code: number | null; signal: number | null; afterS: number } | null
  stateWhenGivenUp: string | null
  inflight: boolean | null
  crashes: Array<{ file: string; origin?: string; message?: string }>
  notes: string[]
  screen: string
}

function seedHome(name: string): { home: string; cwd: string; transcript: string; seeded: string } {
  const home = join(SCRATCH, name, 'home')
  const cwd = join(SCRATCH, name, 'proj')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  seedFirstRun(home, [cwd])
  const projDir = join(home, 'projects', sanitizePath(cwd))
  mkdirSync(projDir, { recursive: true })
  const lines: Record<string, unknown>[] = []
  let prev: string | null = null
  const base = { isSidechain: false, entrypoint: 'cli', cwd, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main' }
  for (let n = 1; n <= 3; n++) {
    const t = String(n).padStart(3, '0')
    const u = `00000000-0000-4000-8000-${String(n * 2).padStart(12, '0')}`
    const a = `00000000-0000-4000-8000-${String(n * 2 + 1).padStart(12, '0')}`
    lines.push({
      ...base, parentUuid: prev, type: 'user', uuid: u,
      message: { role: 'user', content: `TURN-${t} please survey the ledger` },
      timestamp: `2026-06-19T12:00:${String(n * 2).padStart(2, '0')}.000Z`,
    })
    lines.push({
      ...base, parentUuid: u, type: 'assistant', uuid: a, requestId: `req_synth_${t}`,
      message: {
        id: `msg_synth_${t}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'text', text: `TURN-${t} line 01 holds steady.` }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 50 },
      },
      timestamp: `2026-06-19T12:00:${String(n * 2 + 1).padStart(2, '0')}.000Z`,
    })
    prev = a
  }
  const seeded = encodeSeedTranscript(lines, SID)
  const transcript = join(projDir, `${SID}.jsonl`)
  writeFileSync(transcript, seeded)
  return { home, cwd, transcript, seeded }
}

async function loseTerminal(name: string, env: Record<string, string>): Promise<{ verdict: Verdict | null; home: string; transcript: string; seeded: string; log: string }> {
  const { home, cwd, transcript, seeded } = seedHome(name)
  const out = join(SCRATCH, name, 'verdict.json')
  const child = spawn('python3', [HARNESS, 'eio', BIN, home, cwd, out], {
    cwd: SCRATCH,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_ENV' && !k.startsWith('MERCURY_'))),
      MERCURY_CONFIG_DIR: home,
      MERCURY_CREDENTIAL_STORE: 'file',
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE ?? '1',
      LT_ARGV: JSON.stringify(['--resume', SID, '--debug']),
      LT_SETTLE_S: '4',
      LT_WAIT_EXIT_S: '75',
      ...env,
    },
  })
  let log = ''
  child.stdout.on('data', (d: Buffer) => { log += d.toString() })
  child.stderr.on('data', (d: Buffer) => { log += d.toString() })
  await new Promise<void>(resolve => child.on('exit', () => resolve()))
  let verdict: Verdict | null = null
  try {
    verdict = JSON.parse(readFileSync(out, 'utf8')) as Verdict
  } catch {}
  return { verdict, home, transcript, seeded, log }
}

function debugLog(home: string): string {
  const dir = join(home, 'debug')
  if (!existsSync(dir)) return ''
  return readdirSync(dir)
    .filter(f => f.endsWith('.txt'))
    .map(f => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
}

function judge(label: string, run: Awaited<ReturnType<typeof loseTerminal>>): void {
  const v = run.verdict
  check(`${label}: the harness produced a verdict`, v !== null, run.log.slice(-600))
  if (v === null) return
  check(`${label}: the reader was armed before the loss (input-live)`, v.milestones.includes('input-live'), v.milestones.join(','))
  check(`${label}: the terminal was taken from the session`, v.notes.includes('terminal-taken'))
  const eioReports = v.crashes.filter(c => c.origin === 'uncaught-exception' && /read EIO/.test(c.message ?? ''))
  check(`${label}: no crash report of origin uncaught-exception names read EIO`, eioReports.length === 0, eioReports.map(c => `${c.file}: ${c.message}`).join(' | '))
  check(`${label}: no crash report of any origin was written`, v.crashes.length === 0, v.crashes.map(c => `${c.file}: ${c.origin} ${c.message}`).join(' | '))
  check(`${label}: the session closed on its own`, v.exit !== null, `state when given up: ${v.stateWhenGivenUp ?? 'unknown'}`)
  if (v.exit !== null) {
    check(`${label}: the exit code is the gone-terminal law's (129)`, v.exit.code === 129, JSON.stringify(v.exit))
    check(`${label}: the close was prompt (under 10 s), not the orphan probe's next tick`, v.exit.afterS < 10, `${v.exit.afterS}s`)
  }
  const log = debugLog(run.home)
  check(`${label}: the session log records the reason in the hangup's words`, /terminal gone: stdin read EIO/.test(log), log.split('\n').filter(l => /EIO|uncaught/.test(l)).join(' | ').slice(0, 300))
  check(`${label}: the session log holds no uncaught read EIO`, !/uncaughtException: Error: read EIO/.test(log))
  const after = existsSync(run.transcript) ? readFileSync(run.transcript, 'utf8') : ''
  const lastSeeded = run.seeded.trim().split('\n').at(-1) ?? ''
  check(`${label}: the transcript's last seeded row is intact`, after.includes(lastSeeded), `${after.length} bytes after`)
}

section('§0 the artifact')
check('dist/mercury.mjs is built (this proof drives the artifact)', existsSync(BIN), BIN)
if (!existsSync(BIN)) {
  console.log('\nterminal-gone-read: RED (no artifact)')
  process.exit(1)
}

section('§1 the terminal is lost while the session is idle: the read answers EIO')
{
  const run = await loseTerminal('idle', {})
  judge('idle', run)
}

section('§2 the terminal is lost while a turn is in flight')
{
  const fixture = await startFixtureApi([{ kind: 'hang', deltas: ['holding the line while the terminal goes'] }])
  const inflight = join(SCRATCH, 'inflight.flag')
  const started = fixture.messageRequestStarted(1).then(() => writeFileSync(inflight, 'started'))
  const run = await loseTerminal('inflight', {
    ANTHROPIC_BASE_URL: fixture.url,
    LT_SEND_PROMPT: 'survey the ledger once more',
    LT_INFLIGHT_FILE: inflight,
    LT_PROMPT_SETTLE_S: '2',
  })
  await Promise.race([started, new Promise(r => setTimeout(r, 1000))])
  check('inflight: the turn reached the provider before the loss', run.verdict?.inflight === true, `message requests: ${fixture.messageRequests().length}`)
  judge('inflight', run)
  await fixture.close()
}

if (failures > 0) {
  console.log(`\nterminal-gone-read: RED (${failures} failed) — scratch kept at ${SCRATCH}`)
  process.exit(1)
}
rmSync(SCRATCH, { recursive: true, force: true })
console.log('\nterminal-gone-read: green')
process.exit(0)
