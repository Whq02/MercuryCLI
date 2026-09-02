#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
const RUNTIME_CWD = join(import.meta.dir, '..', '..')

const REPO = join(new URL('.', import.meta.url).pathname, '../..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts/ui/vshot.py')
const SID = `00000000-cccc-dddd-eeee-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}

if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — build first (bun run build.ts)')
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'crew-render-home-'))
const FAKE_KEY = 'sk-ant-api03-crewrenderproof0000000000'
writeFileSync(join(home, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true, theme: 'dark', numStartups: 5,
  customApiKeyResponses: { approved: [FAKE_KEY.slice(-20)], rejected: [] },
  projects: { [RUNTIME_CWD]: { hasTrustDialogAccepted: true } },
}))
const PROJECTS = join(home, 'projects', sanitizePath(RUNTIME_CWD))
mkdirSync(PROJECTS, { recursive: true })

const base = (extra: Record<string, unknown>) => ({
  isSidechain: false, userType: 'external', entrypoint: 'cli',
  cwd: RUNTIME_CWD, sessionId: SID,
  version: '1.0.0-beta.1', gitBranch: 'main', ...extra,
})
const lines = [
  base({
    parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
    message: { role: 'user', content: 'first task' },
    timestamp: '2026-06-19T13:00:01.000Z',
  }),
  base({
    parentUuid: '00000000-0000-4000-8000-000000000001', type: 'user',
    uuid: '00000000-0000-4000-8000-000000000002',
    message: { role: 'user', content: 'second task' },
    timestamp: '2026-06-19T13:00:02.000Z',
  }),
]
writeFileSync(join(PROJECTS, `${SID}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')

function capture(cols: number, tag: string, extraEnv: Record<string, string>): string[] | null {
  const grid = `/tmp/crew-board-grid-${tag}-${cols}.json`
  const cfgPath = `/tmp/crew-board-cfg-${tag}-${cols}.json`
  writeFileSync(cfgPath, JSON.stringify({
    argv: ['node', BIN, '--resume', SID],
    sends: [{ atTick: 30, data: '/teammates' }, { atTick: 36, data: '\r' }],
    total: 60, cols, rows: 44, out: grid,
  }))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8', timeout: vshotBudgetMs(90000),
    env: {
      ...process.env,      MERCURY_CONFIG_DIR: home, ANTHROPIC_API_KEY: FAKE_KEY, ...extraEnv,
    },
  })
  if (res.status !== 0) {
    console.error(`✗ vshot failed ${tag}@${cols}: ${res.stderr?.slice(0, 300)}`)
    return null
  }
  const g = JSON.parse(require('node:fs').readFileSync(grid, 'utf-8')) as { grid: Array<Array<{ c: string }>> }
  return g.grid.map(line => line.map(c => c.c).join('').trimEnd())
}

function assertBoard(cols: number, tag: string, extraEnv: Record<string, string>, needles: Array<[RegExp, boolean, string]>): void {
  const rows = capture(cols, tag, extraEnv)
  if (!rows) { failures++; return }
  const text = rows.join('\n')
  for (const [re, want, label] of needles) {
    const hit = re.test(text)
    check(hit === want, `${tag}@${cols}: ${label}`)
  }
}

for (const cols of [120, 80]) {
  assertBoard(cols, 'empty', {}, [
    [/no teammates yet/, true, "honest empty state ('no teammates yet')"],
    [/@atlas/, false, 'retired stub chip @atlas ABSENT (no fabricated instances)'],
    [/@beacon/, false, 'retired stub chip @beacon ABSENT'],
    [/crew is disabled/, false, 'not showing the disabled line while enabled'],
  ])
}
assertBoard(120, 'disabled', { MERCURY_CREW: '0' }, [
  [/crew is disabled \(MERCURY_CREW=0/, true, 'honest disabled line naming the kill'],
  [/no teammates yet/, false, 'empty-state hint suppressed while disabled'],
])

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '✅ crew board render GREEN' : `❌ crew board render RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
