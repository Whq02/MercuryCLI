#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const ENTRY = 'frame--120x40--light--truecolor--full'
const OWNER_MODEL = 'local/qwen3.5:27b'
const PROOF_KEY = 'proof-key-ci-gate-not-a-real-key'
const KEEP = process.argv.includes('--keep')
const SCRATCH_ROOT = existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir()
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'capture-hermetic-'))
const BUN = process.env.BUN ?? process.execPath

let fail = 0
function report(ok: boolean, words: string): void {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${words}`)
  if (!ok) fail = 1
}

function scratchHome(name: string, settings: Record<string, unknown>): string {
  const home = join(scratch, name)
  mkdirSync(join(home, '.mercury'), { recursive: true })
  writeFileSync(join(home, '.mercury', 'settings.json'), JSON.stringify(settings))
  return home
}

const fixtureRequests: string[] = []
const fixture = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    fixtureRequests.push(`${request.method} ${path}`)
    if (request.method === 'GET' && path === '/api/tags') {
      return Response.json({
        models: [{ name: OWNER_MODEL.slice('local/'.length), model: OWNER_MODEL.slice('local/'.length), details: { family: 'qwen3', parameter_size: '27B', quantization_level: 'Q4_K_M' } }],
      })
    }
    if (request.method === 'GET' && path === '/api/version') return Response.json({ version: '0.34.4' })
    if (request.method === 'GET' && path === '/api/ps') return Response.json({ models: [] })
    if (request.method === 'POST' && path === '/api/show') {
      return Response.json({ capabilities: ['tools', 'thinking'], model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 262144 } })
    }
    return new Response(null, { status: 404 })
  },
})
const FIXTURE_ORIGIN = `http://127.0.0.1:${fixture.port}`

interface Run {
  name: string
  text: string[] | null
  log: string
  status: number | null
}

async function capture(name: string, env: Record<string, string | undefined>): Promise<Run> {
  const out = join(scratch, `vb-${name}`)
  rmSync(out, { recursive: true, force: true })
  const runEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) runEnv[k] = v
  delete runEnv.MERCURY_HOME
  runEnv.TMPDIR = scratch
  runEnv.MERCURY_CREDENTIAL_STORE = 'file'
  runEnv.ANTHROPIC_API_KEY = PROOF_KEY
  runEnv.VSHOT_SLOTS = runEnv.VSHOT_SLOTS ?? '999'
  runEnv.MERCURY_VSHOT_BUDGET_SCALE = runEnv.MERCURY_VSHOT_BUDGET_SCALE ?? '1'
  const child = spawn(BUN, ['run', 'scripts/ui/generate-visual-baseline.ts', '--only', ENTRY, '--out', out], {
    cwd: REPO,
    env: runEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', d => (log += String(d)))
  child.stderr.on('data', d => (log += String(d)))
  const status = await new Promise<number | null>(resolve => {
    child.on('exit', code => resolve(code))
    child.on('error', () => resolve(null))
  })
  writeFileSync(join(scratch, `${name}.log`), log)
  const gridPath = join(out, 'grids', `${ENTRY}.grid.json`)
  let text: string[] | null = null
  try {
    text = (JSON.parse(readFileSync(gridPath, 'utf8')) as { text: string[] }).text
  } catch {
    text = null
  }
  return { name, text, log, status }
}

function modelRow(text: string[] | null): string {
  const row = text?.find(t => t.includes('ready · '))
  return row === undefined ? '(no ready row)' : row.trim().replace(/\s{2,}/g, ' ')
}

function ctxRow(text: string[] | null): string {
  const row = text?.find(t => t.includes('· ctx '))
  return row === undefined ? '(no ctx row)' : row.trim().replace(/\s{2,}/g, ' ')
}

function firstDiff(a: string[], b: string[]): string {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `row ${i}: ${JSON.stringify((a[i] ?? '').trimEnd())} vs ${JSON.stringify((b[i] ?? '').trimEnd())}`
  }
  return 'identical'
}

function tail(log: string): string {
  return log.trim().split('\n').slice(-6).join('\n    ')
}

function judgePair(leg: string, a: Run, b: Run, why: string): void {
  const captured = a.text !== null && b.text !== null
  report(captured, `${leg}: both captures landed a grid (${a.name} rc=${a.status}, ${b.name} rc=${b.status})`)
  if (!captured) {
    console.log(`    ${a.name}: ${tail(a.log)}`)
    console.log(`    ${b.name}: ${tail(b.log)}`)
    return
  }
  const same = JSON.stringify(a.text) === JSON.stringify(b.text)
  report(same, `${leg}: ${why} — ${same ? 'the frames are equal' : firstDiff(a.text!, b.text!)}`)
  for (const run of [a, b]) {
    const clean = !run.text!.some(t => t.includes('local/'))
    report(clean, `${leg}: ${run.name} names no local model — ${modelRow(run.text)} · ${ctxRow(run.text)}`)
  }
}

console.log(`capture hermeticity — a capture under a scratch config home reads neither the operator's settings nor a live local server (scratch ${scratch})`)

const withLine = scratchHome('home-with-model-line', { model: OWNER_MODEL })
const withoutLine = scratchHome('home-without-model-line', {})

console.log(`\nleg 1 — a scratch HOME whose .mercury/settings.json carries "model": "${OWNER_MODEL}", the shell pinning MERCURY_CONFIG_DIR at that very folder`)
const lineOn = await capture('settings-line', { HOME: withLine, MERCURY_CONFIG_DIR: join(withLine, '.mercury'), MERCURY_DAEMON_DIR: join(withLine, '.mercury', 'daemon'), MERCURY_LOCAL_PROBE_TARGETS: 'none' })
const lineOff = await capture('settings-clean', { HOME: withoutLine, MERCURY_CONFIG_DIR: join(withoutLine, '.mercury'), MERCURY_DAEMON_DIR: join(withoutLine, '.mercury', 'daemon'), MERCURY_LOCAL_PROBE_TARGETS: 'none' })
judgePair('settings', lineOn, lineOff, 'the capture with the model line equals the capture without it')

console.log(`\nleg 2 — a local server on the loopback listing ${OWNER_MODEL.slice('local/'.length)} (a fixture at ${FIXTURE_ORIGIN}; the probe target named in the shell, as a running server is found by default)`)
fixtureRequests.length = 0
const serverOn = await capture('server-listed', { HOME: withoutLine, MERCURY_CONFIG_DIR: join(withoutLine, '.mercury'), MERCURY_DAEMON_DIR: join(withoutLine, '.mercury', 'daemon'), MERCURY_LOCAL_PROBE_TARGETS: `ollama=${FIXTURE_ORIGIN}` })
const seenByFixture = fixtureRequests.length
fixtureRequests.length = 0
const serverOff = await capture('server-none', { HOME: withoutLine, MERCURY_CONFIG_DIR: join(withoutLine, '.mercury'), MERCURY_DAEMON_DIR: join(withoutLine, '.mercury', 'daemon'), MERCURY_LOCAL_PROBE_TARGETS: 'none' })
judgePair('server', serverOn, serverOff, 'the capture beside a listing server equals the capture with the probe off')
report(seenByFixture === 0, `server: the captured product sent the loopback server ${seenByFixture} request(s) — a capture reaches no server on the machine`)

console.log('\nleg 3 — every capture script pins the probe off in the product\'s own environment')
const PINNED = /MERCURY_LOCAL_PROBE_TARGETS(?::\s*|\s*=\s*(?:process\.env\.MERCURY_LOCAL_PROBE_TARGETS\s*\?\?\s*)?)'none'/
for (const file of [
  'scripts/ui/generate-visual-baseline.ts',
  'scripts/ui/renderScenarios.ts',
  'scripts/visual-contract/baseline-capture.ts',
  'scripts/streaming/artifactArena.ts',
]) {
  const source = readFileSync(join(REPO, file), 'utf8')
  report(PINNED.test(source), `${file} names MERCURY_LOCAL_PROBE_TARGETS 'none' for the product it spawns`)
}

fixture.stop(true)
if (KEEP || fail !== 0) console.log(`\nkept ${scratch} (the four grids and logs)`)
else rmSync(scratch, { recursive: true, force: true })
console.log(fail === 0 ? '\n✅ capture hermeticity GREEN' : '\n❌ capture hermeticity RED')
process.exit(fail)
