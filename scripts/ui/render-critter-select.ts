#!/usr/bin/env bun
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { encodeTranscriptLine } from '../../src/utils/sessionStorage/vnext.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
const RUNTIME_CWD = join(import.meta.dir, '..', '..')

const REPO = join(import.meta.dir, '..', '..')
const CONFIG_HOME = resolveProofHome([RUNTIME_CWD])
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(RUNTIME_CWD))
const VSHOT = new URL('./vshot.py', import.meta.url).pathname
const BIN = join(REPO, 'dist', 'mercury.mjs')
const SID = '00000000-aaaa-bbbb-cccc-0000000c121e'

function buildSession(): string {
  const line = {
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: RUNTIME_CWD,
    sessionId: SID,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    parentUuid: null,
    type: 'user',
    message: { role: 'user', content: 'boot into the repl' },
    uuid: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-06-19T10:00:01.000Z',
  }
  if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
  const path = join(PROJECTS, `${SID}.jsonl`)
  const { line: encoded } = encodeTranscriptLine(path, line)
  writeFileSync(path, encoded)
  return path
}

function shoot(cols: number): string {
  const out = `/tmp/critter-select-${cols}.html`
  const cfg = {
    argv: ['node', BIN, '--resume', SID],
    sends: [
      { atTick: 30, data: '/critter' },
      { atTick: 38, data: '\r' },
      { atTick: 50, data: '\x1b[B' },
    ],
    total: 64,
    cols,
    rows: 44,
    out,
    title: `critter-select @ ${cols}`,
  }
  const cfgPath = `/tmp/vshot-critter-${cols}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env = {
    ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    MERCURY_CRITTER: 'crab',
  }
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env,
    timeout: vshotBudgetMs(30000),
  })
  return (res.stdout || '') + (res.stderr ? `\n[stderr] ${res.stderr}` : '')
}

console.log('============================================================')
console.log(' /critter render-verify (drive the panel → vshot @ 80 / 120)')
console.log('============================================================')

buildSession()
const results: Record<number, string> = {}
for (const cols of [80, 120]) results[cols] = shoot(cols)

let failures = 0
function expect(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

for (const cols of [80, 120]) {
  const scr = results[cols]!
  const lines = scr.split('\n')
  console.log(`\n── @ ${cols} cols ──`)
  expect('the picker mounted (Session theme header visible)', /Session theme/.test(scr))
  expect('all four critters listed', ['crab', 'octopus', 'jellyfish', 'clam'].every(n => scr.includes(n)))
  const rowEnvHits = lines.filter(
    l => /\b(crab|octopus|jellyfish|clam)\b/.test(l) && /MERCURY_CRITTER=/.test(l) && !/this session/.test(l),
  )
  expect('no per-row env tail (≤1 name+MERCURY_CRITTER= line — the preview key)', rowEnvHits.length <= 1, `${rowEnvHits.length} line(s)`)
  expect('the launch affordance is advertised', /↵ \/ click launch/.test(scr))
  expect('the live-switch note is present', /switches live/.test(scr))
  const html = readFileSync(`/tmp/critter-select-${cols}.html`, 'utf-8')
  expect('the critter eye-white bg (#EDE8DD) renders in the sprite', /ede8dd/i.test(html))
}

{
  const scr80 = results[80]!
  const tooWide = scr80.split('\n').filter(l => l.replace(/\s+$/, '').length > 80)
  expect('80-col: no rendered line exceeds 80 columns', tooWide.length === 0, `${tooWide.length} over-wide line(s)`)
  const recordLine = scr80
    .split('\n')
    .some(l => /^\s*│?\s*jellyfish\s*│?\s*$/.test(l))
  expect('80-col: the focused critter record is intact (bare-name record line present)', recordLine)
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ /critter RENDER-VERIFY PASS — holds at 80 + 120')
else console.log(`❌ ${failures} /critter RENDER CHECK(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
