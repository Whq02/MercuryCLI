#!/usr/bin/env bun
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
const RUNTIME_CWD = join(import.meta.dir, '..', '..')

const REPO = join(import.meta.dir, '..', '..')
const CONFIG_HOME = resolveProofHome([RUNTIME_CWD])
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(RUNTIME_CWD))
const VSHOT = join(import.meta.dir, 'vshot.py')
const BIN = join(REPO, 'dist', 'mercury.mjs')

const SID = '00000000-aaaa-bbbb-cccc-0000000000f3'
let u = 0
const uuid = () => `00000000-0000-4000-8000-${String(++u).padStart(12, '0')}`

type Line = Record<string, unknown>
const common = (extra: Line): Line => ({
  isSidechain: false,
  entrypoint: 'cli',
  cwd: RUNTIME_CWD,
  sessionId: SID,
  version: '1.0.0-beta.1',
  gitBranch: 'main',
  ...extra,
})

function buildSession(): string {
  const lines: Line[] = []
  let prev: string | null = null
  const push = (l: Line) => {
    lines.push(l)
    prev = l.uuid as string
  }
  push(
    common({
      parentUuid: prev,
      type: 'user',
      message: { role: 'user', content: 'first task' },
      uuid: uuid(),
      timestamp: '2026-06-19T12:00:01.000Z',
    }),
  )
  push(
    common({
      parentUuid: prev,
      type: 'user',
      message: { role: 'user', content: 'second task' },
      uuid: uuid(),
      timestamp: '2026-06-19T12:00:02.000Z',
    }),
  )
  if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
  const path = join(PROJECTS, `${SID}.jsonl`)
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}

const FUTURE = Math.floor(Date.now() / 1000) + 4 * 3600
const USAGE_SEED = `5h=0.58@${FUTURE},7d=0.31@${FUTURE}`

function shoot(cols: number): string {
  const out = `/tmp/hframe-${cols}.html`
  const cfg = {
    argv: ['node', BIN, '--resume', SID],
    sends: [],
    total: 45,
    cols,
    rows: 44,
    out,
    title: `hframe @ ${cols}`,
  }
  const cfgPath = `/tmp/vshot-hf-${cols}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env: {
      ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME,
      MERCURY_HELM_HOME: '0',
      MERCURY_SUBSTRATE: '0',
      MERCURY_USAGE_SEED: USAGE_SEED,
    },
    timeout: vshotBudgetMs(30000),
  })
  return (res.stdout || '') + (res.stderr ? `\n[stderr] ${res.stderr}` : '')
}

console.log('============================================================')
console.log(' MercuryFrame ordered-shed render-verify (64→120 cols)')
console.log('============================================================')

buildSession()
const COLS = [64, 70, 80, 90, 100, 120]
const results: Record<number, string> = {}
for (const c of COLS) results[c] = shoot(c)

let failures = 0
function expect(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function frameRow(raw: string): string {
  const line = raw.split('\n').find(l => l.includes('▖▟▆▙▗') && l.includes('│')) ?? ''
  return line.replace(/\s+/g, ' ')
}
const has5hGauge = (s: string) => /5h [█░]{2,4} \d+%/.test(s)
const has5hAny = (s: string) => /5h .{0,6}\d+%/.test(s)
const has7d = (s: string) => /7d .{0,6}\d+%/.test(s)

for (const c of COLS) {
  const scr = frameRow(results[c]!)
  const full = results[c]!.replace(/\s+/g, ' ')
  console.log(`\n── @ ${c} cols ──`)

  expect(`@${c}: the model name survives (the identity spine)`, /Opus|Sonnet|Fable|Haiku|claude-/.test(scr))

  if (c >= 120) {
    expect(`@${c}: the 5h usage chip survives at full width (live vital)`, has5hAny(scr))
    expect(`@${c}: the 5h chip is the mini-gauge form (5h ██░░ NN%)`, has5hGauge(scr))
  }

  if (c < 100) {
    expect(`@${c}: the 7d window is shed (hard gate, cols < 100)`, !has7d(scr))
  } else if (c >= 120) {
    expect(`@${c}: the 7d window rides at full width (cols >= 100 gate + room to escape truncation)`, has7d(scr))
  }


  if (c >= 70) {
    expect(`@${c}: the session tab-strip renders (this session, cols >= 70)`, /this session/.test(full))
  } else {
    expect(`@${c}: the session tab-strip is shed (cols < 70)`, !/this session/.test(full))
  }
}

{
  expect(
    'ordered shed: the 5h vital rides at full width (120 — the live vital is kept when there is room)',
    has5hAny(frameRow(results[120]!)),
  )
}

try {
  rmSync(join(PROJECTS, `${SID}.jsonl`))
} catch {
}

console.log('\nHTML written to /tmp/hframe-{64,70,80,90,100,120}.html')
console.log(
  failures === 0
    ? '\n✅ MERCURYFRAME SHED RENDER-VERIFY PASS'
    : `\n❌ ${failures} RENDER CHECK(S) FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
