#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = path.resolve(import.meta.dir, '../..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? path.join(REPO, 'dist/mercury.mjs')
const VENDORED_NODE = path.join(path.dirname(DIST), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')
const BUN = process.env.BUN ?? path.join(process.env.HOME ?? '', '.bun/bin/bun')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

if (!existsSync(DIST)) {
  console.log(`FAIL ${DIST} missing — run \`bun run build.ts\` first (the drive proves the BUILT bundle)`)
  process.exit(1)
}

const CHOSEN = 'claude-sonnet-5'
const CHOSEN_NAME = 'Sonnet 5'
const FLAG = 'claude-fable-5-1'
const FLAG_NAME = 'Fable 5.1'
const TURN_B = 'persisted choice turn alpha-goose'
const TURN_C = 'flag wins turn beta-heron'

const SCRATCH = path.join(realpathSync(tmpdir()), `mercury-modelsave-${process.pid}`)
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })
const capture = path.join(SCRATCH, 'wire-capture.jsonl')
const fixture: ChildProcess = spawn(BUN, ['run', path.join(import.meta.dir, 'mission-fixture-server.ts'), capture], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, MISSION_FIXTURE_REPLY_DELAY_MS: '300' },
})
const port = await new Promise<number>((resolve, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture server never printed PORT')), 15_000)
  let buffer = ''
  fixture.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const m = /PORT (\d+)/.exec(buffer)
    if (m) {
      clearTimeout(killer)
      resolve(Number(m[1]))
    }
  })
  fixture.on('exit', code => reject(new Error(`fixture server exited early (${code})`)))
}).catch(err => {
  console.log(`FAIL ${String(err)}`)
  process.exit(1)
})
const base = `http://127.0.0.1:${port}`

const reap = (): void => {
  try {
    fixture.kill('SIGTERM')
  } catch {
  }
  if (failures === 0) {
    try {
      rmSync(SCRATCH, { recursive: true, force: true })
    } catch {
    }
  } else {
    console.log(`[forensics] world kept: ${SCRATCH}`)
  }
}
process.on('exit', reap)

interface World {
  home: string
  cwd: string
}
function makeWorld(name: string): World {
  const home = path.join(SCRATCH, name)
  const cwd = path.join(home, 'repo')
  mkdirSync(cwd, { recursive: true })
  const probeKey = 'sk-ant-modelsave-probe'
  writeFileSync(
    path.join(home, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [probeKey.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({}))
  writeFileSync(path.join(cwd, 'README.md'), '# model choice fixture\n')
  return { home, cwd }
}

function worldEnv(world: World): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEBUG: '1',
    MERCURY_CONFIG_DIR: world.home,
    MERCURY_CREDENTIAL_STORE: 'file',
    BROWSER: '/usr/bin/true',
    ANTHROPIC_API_KEY: 'sk-ant-modelsave-probe',
    ANTHROPIC_BASE_URL: base,
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_DOCTOR_STATE_DIR: path.join(world.home, 'doctor-state'),
    MERCURY_DAEMON_DIR: path.join(world.home, 'daemon'),
    MERCURY_TEAMS_DIR: path.join(world.home, 'teams'),
    MERCURY_TABULA_DIR: path.join(world.home, 'tabula'),
    MERCURY_HOME: path.join(world.home, 'proof-home'),
  }
  delete env.NODE_ENV
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.MERCURY_MODEL
  delete env.MERCURY_EFFORT
  return env
}

type Grid = Array<Array<{ c: string }>>
const textOf = (grid: Grid): string => grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')

function drive(world: World, name: string, argvTail: string[], sends: unknown[], readyText: string[], total: number): { grid: string; marks: Record<string, string> } {
  const out = path.join(world.home, `grid-${name}.json`)
  const cfg = { argv: [NODE, DIST, ...argvTail], cwd: world.cwd, sends, readyText, readySettleTicks: 4, total, cols: 110, rows: 44, out }
  const cfgPath = path.join(world.home, `cfg-${name}.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(180_000),
    cwd: world.cwd,
    env: worldEnv(world),
  })
  if (!existsSync(out)) {
    check(`${name}: capture produced a grid`, false, `vshot: ${String(res.stderr).slice(0, 300)}`)
    return { grid: '', marks: {} }
  }
  const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Grid; marks?: Array<{ label: string; grid: Grid }> }
  const grid = textOf(payload.grid)
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) {
    marks[m.label] = textOf(m.grid)
    writeFileSync(path.join(world.home, `mark-${name}-${m.label}.txt`), marks[m.label]!)
  }
  writeFileSync(path.join(world.home, `final-${name}.txt`), grid)
  if (readyText.length > 0 && !readyText.some(t => grid.includes(t))) {
    console.log(`  [vshot ${name}] ${String(res.stderr ?? '').trim().replace(/\s+/g, ' ').slice(-700)}`)
  }
  return { grid, marks }
}

function savedModel(world: World): string | undefined {
  try {
    return (JSON.parse(readFileSync(path.join(world.home, 'settings.json'), 'utf8')) as { model?: string }).model
  } catch {
    return undefined
  }
}

function wireRequests(): Array<{ path: string; body: Record<string, unknown> | null }> {
  try {
    return readFileSync(capture, 'utf8')
      .trim()
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => JSON.parse(l) as { path: string; body: Record<string, unknown> | null })
      .filter(r => r.path.endsWith('/v1/messages'))
  } catch {
    return []
  }
}
const requestCarrying = (words: string): Record<string, unknown> | null => {
  const rows = wireRequests().filter(r => JSON.stringify(r.body ?? null).includes(words))
  return rows[rows.length - 1]?.body ?? null
}
const stripLine = (grid: string, model: string): string =>
  grid.split('\n').find(l => l.includes(model) && /\b(high|max|medium|low|xhigh)\b/.test(l)) ?? ''
const noticeLines = (grid: string): string => grid.split('\n').filter(l => /model|Model|saved/.test(l)).map(l => l.trim()).join(' | ').slice(0, 600)

console.log('============================================================')
console.log(' /model saves the choice — the flag, then the saved choice, then the family default')
console.log(`   bundle: ${DIST}`)
console.log('============================================================')

const world = makeWorld('world')

section(`stage A — a fresh boot; /model ${CHOSEN} saves the choice`)
const a = drive(
  world,
  'choose',
  [],
  [
    { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { atTick: 120, minTick: 20, awaitText: '· ready', awaitSettleTicks: 6, data: `/model ${CHOSEN}\r` },
    { atTick: 220, minTick: 30, awaitText: 'Model set to', awaitSettleTicks: 6, data: '', mark: 'chosen' },
    { afterPrevTicks: 2, data: '/exit\r' },
  ],
  [],
  300,
)
const chosen = a.marks.chosen ?? a.grid
check('the /model answer painted', new RegExp(`Model set to ${CHOSEN_NAME.replace('.', '\\.')}`).test(chosen.replace(/\s+/g, ' ')), noticeLines(chosen) || a.grid.slice(-400))
check('the answer says the choice is saved as your default', /saved as your default/.test(chosen.replace(/\s+/g, ' ')), noticeLines(chosen) || '(no notice)')
check(`settings.json carries model: ${CHOSEN}`, savedModel(world) === CHOSEN, `model=${String(savedModel(world))}`)

section('stage B — a fresh boot with no flag starts on the saved choice')
const b = drive(
  world,
  'saved-boot',
  [],
  [
    { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { atTick: 100, minTick: 20, awaitText: '? for shortcuts', awaitSettleTicks: 2, data: `${TURN_B}\r` },
    { atTick: 220, minTick: 30, awaitText: 'reply to [[persisted choice turn', awaitSettleTicks: 3, data: '', mark: 'answered' },
    { afterPrevTicks: 2, data: '/exit\r' },
  ],
  [],
  300,
)
const answeredB = b.marks.answered ?? b.grid
check('the turn settled on the saved-choice boot', answeredB.includes('reply to [[persisted choice turn'), b.grid.slice(-400))
check(`the strip reads ${CHOSEN_NAME} on the boot with no flag (the saved choice, not the family default Opus 5)`, stripLine(answeredB, CHOSEN_NAME) !== '', (stripLine(answeredB, 'Fable') || stripLine(answeredB, 'Sonnet') || stripLine(answeredB, 'Opus') || '(no strip line)').trim())
const bodyB = requestCarrying(TURN_B)
check(`the request carries model ${CHOSEN}`, bodyB?.model === CHOSEN, `model=${String(bodyB?.model)}`)

section(`stage C — --model ${FLAG} wins over the saved choice; the saved choice stays`)
const c = drive(
  world,
  'flag-boot',
  ['--model', FLAG],
  [
    { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { atTick: 100, minTick: 20, awaitText: '? for shortcuts', awaitSettleTicks: 2, data: `${TURN_C}\r` },
    { atTick: 220, minTick: 30, awaitText: 'reply to [[flag wins turn', awaitSettleTicks: 3, data: '', mark: 'answered' },
    { afterPrevTicks: 2, data: '/exit\r' },
  ],
  [],
  300,
)
const answeredC = c.marks.answered ?? c.grid
check('the turn settled on the flagged boot', answeredC.includes('reply to [[flag wins turn'), c.grid.slice(-400))
check(`the strip reads ${FLAG_NAME} under --model ${FLAG} (the flag wins over the saved choice)`, stripLine(answeredC, FLAG_NAME) !== '', (stripLine(answeredC, 'Opus') || stripLine(answeredC, 'Sonnet') || stripLine(answeredC, 'Fable') || '(no strip line)').trim())
const bodyC = requestCarrying(TURN_C)
check(`the request carries model ${FLAG}`, bodyC?.model === FLAG, `model=${String(bodyC?.model)}`)
check(`settings.json still carries model: ${CHOSEN} (a flag never rewrites the saved choice)`, savedModel(world) === CHOSEN, `model=${String(savedModel(world))}`)

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' model choice persists: ALL LAWS HOLD')
  process.exit(0)
}
console.log(` model choice persists: ${failures} FAILURE(S)`)
process.exit(1)
