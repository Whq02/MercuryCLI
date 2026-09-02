#!/usr/bin/env bun
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
const RUNTIME_CWD = join(import.meta.dir, '..', '..')

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { permissionModeSymbol, permissionModeTitle } = (await import(
  '../../src/utils/permissions/PermissionMode.js'
)) as typeof import('../../src/utils/permissions/PermissionMode.js')

const REPO = join(import.meta.dir, '..', '..')
const CONFIG_HOME = resolveProofHome([RUNTIME_CWD])
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(RUNTIME_CWD))
const VSHOT = new URL('./vshot.py', import.meta.url).pathname
const BIN = join(REPO, 'dist', 'mercury.mjs')

const SID = '00000000-aaaa-bbbb-cccc-0000000000c1'
let u = 0
const uuid = () => `00000000-0000-4000-8000-${String(++u).padStart(12, '0')}`

type Line = Record<string, unknown>
const common = (extra: Line): Line => ({
  isSidechain: false,
  userType: 'external',
  entrypoint: 'cli',
  cwd: RUNTIME_CWD,
  sessionId: SID,
  version: '1.0.0-beta.1',
  gitBranch: 'main',
  ...extra,
})

function buildSession(): string {
  const lines: Line[] = [
    common({
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: 'hello' },
      uuid: uuid(),
      timestamp: '2026-06-19T12:00:01.000Z',
    }),
  ]
  if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
  const path = join(PROJECTS, `${SID}.jsonl`)
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}

function shoot(mode: string, cols: number, args: string[]): string {
  const out = `/tmp/permmode-${mode}-${cols}.html`
  const cfg = {
    argv: ['node', BIN, '--resume', SID, ...args],
    sends: [],
    total: 16,
    cols,
    rows: 44,
    out,
    title: `permmode ${mode} @ ${cols}`,
  }
  const cfgPath = `/tmp/vshot-pm-${mode}-${cols}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env: { ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME },
    timeout: vshotBudgetMs(30000),
  })
  return (res.stdout || '') + (res.stderr ? `\n[stderr] ${res.stderr}` : '')
}

const MODES: { mode: string; args: string[]; bypass?: boolean }[] = [
  { mode: 'strategy', args: ['--permission-mode', 'strategy'] },
  { mode: 'apollo', args: ['--permission-mode', 'apollo'] },
  { mode: 'implement', args: ['--permission-mode', 'implement'] },
  { mode: 'flow', args: ['--permission-mode', 'flow'] },
  { mode: 'sovereign', args: ['--dangerously-skip-permissions'], bypass: true },
]

console.log('============================================================')
console.log(' Permission-mode carousel render-verify (modeBand → band)')
console.log('============================================================')

buildSession()
const results: Record<string, string> = {}
for (const cols of [80, 120]) {
  for (const m of MODES) results[`${m.mode}-${cols}`] = shoot(m.mode, cols, m.args)
}

let failures = 0
function expect(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const flat = (s: string) => s.replace(/\s+/g, ' ')

for (const cols of [80, 120]) {
  console.log(`\n── @ ${cols} cols ──`)
  for (const m of MODES) {
    const scr = flat(results[`${m.mode}-${cols}`]!)
    const sym = permissionModeSymbol(m.mode as never)
    const title = permissionModeTitle(m.mode as never).toLowerCase()
    if (m.bypass) {
      expect(
        `${m.mode}: the alarm renders ("${title} on — all tool calls auto-approved")`,
        new RegExp(`${title} on . all tool calls auto.approved`).test(scr),
      )
      expect(
        `${m.mode}: the band glyph == permissionModeSymbol('bypassPermissions') (${JSON.stringify(sym)}) — no hardcoded-glyph drift`,
        scr.includes(`${sym} ${title} on`),
        scr.includes('▸▸ bypass') ? 'STILL renders the legacy ▸▸ (U+25B8) — band/config diverge' : '',
      )
    } else {
      expect(
        `${m.mode}: the band shows "${sym} ${title} on" (symbol+title from the helpers)`,
        scr.includes(`${sym} ${title} on`),
      )
      expect(
        `${m.mode}: the band carries the cycle hint (shift+tab to cycle)`,
        /shift\+tab to cycle/.test(scr),
      )
    }
  }
}

try {
  rmSync(join(PROJECTS, `${SID}.jsonl`))
} catch {
}

console.log('\nHTML written to /tmp/permmode-{strategy,apollo,implement,flow,sovereign}-{80,120}.html')
console.log(
  failures === 0
    ? '\n✅ PERMISSION-MODE RENDER-VERIFY PASS'
    : `\n❌ ${failures} RENDER CHECK(S) FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
