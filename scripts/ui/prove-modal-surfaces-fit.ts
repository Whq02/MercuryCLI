#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')

const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-modal-fit-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-dummy0000000000'

let failures = 0
function failureWhere(label: string): string {
  if (/is a turn|is not$|⤳/.test(label)) return ' — to fix: isOperatorTurn and countOperatorTurns in src/engine/message-shapes/operatorTurns.ts'
  if (/effort/.test(label)) return ' — to fix: the EFFORT_* glyphs in src/screen/theme/rowGlyphs.ts'
  if (/^\/help/.test(label)) return ' — to fix: the /help view in src/commands/help/help.tsx (column layout and footer at 100x30); if a drive did not deliver, run bun run build.ts and rerun'
  if (/delivered every send/.test(label)) return ' — to fix: the drive stopped before its last send; run bun run build.ts, then rerun and read the exit and stderr above'
  return ' — to fix: the /logins modal body, footer and PageDown or arrow scrolling (the view that paints Mercury · logins); the check reads the 100x30 screen of dist/mercury.mjs, so run bun run build.ts first'
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${cond ? '' : failureWhere(label)}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' modal surfaces fit — footer pinned · grid whole · grid aligned')
console.log('============================================================')

section('⤳N counts operator prompts')
{
  const { countOperatorTurns, isOperatorTurn } = await import('../../src/engine/message-shapes/operatorTurns.ts')
  const user = (content: unknown, extra: Record<string, unknown> = {}) =>
    ({ type: 'user', uuid: 'u', timestamp: 't', message: { role: 'user', content }, ...extra }) as never
  check('a typed prompt is a turn', isOperatorTurn(user('hi, stream the plan')))
  check('a text block prompt is a turn', isOperatorTurn(user([{ type: 'text', text: 'hi' }])))
  check('a slash command echo is not', !isOperatorTurn(user('<command-message>model</command-message><command-name>/model</command-name>')))
  check('a local command stdout is not', !isOperatorTurn(user('<local-command-stdout>Kept model as Opus 5</local-command-stdout>')))
  check('a tool result is not', !isOperatorTurn(user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }])))
  check('a meta message is not', !isOperatorTurn(user('context', { isMeta: true })))
  check('an assistant message is not', !isOperatorTurn({ type: 'assistant', message: { role: 'assistant', content: [] } } as never))
  const messages = [
    user('<command-message>logins</command-message><command-name>/logins</command-name>'),
    user('<local-command-stdout>/logins closed — no credential changed</local-command-stdout>'),
    user('hi, stream the plan'),
    user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]),
    user('and the corpus numbers'),
  ]
  check('two slash commands + one tool round + two prompts ⇒ ⤳2', countOperatorTurns(messages) === 2, String(countOperatorTurns(messages)))
}

section('mechanism pins')
{

  const figures = await import('../../src/screen/theme/rowGlyphs.ts')
  const ladder = [figures.EFFORT_LOW, figures.EFFORT_MEDIUM, figures.EFFORT_HIGH, figures.EFFORT_XHIGH, figures.EFFORT_MAX]
  check('no effort glyph is the band separator (`· · low` read as a doubled separator)', ladder.every(g => g !== '·'))
  check('the effort ladder glyphs are distinct', new Set(ladder).size === ladder.length)

}

section('THE SCREEN at 100x30: footers pinned, PageDown pages, the help grid whole')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`  no POSIX pty capture driver on this host (${driver.kind}) — the screen legs cannot run here`)
  failures++
} else if (!existsSync(BIN)) {
  console.error('  dist/mercury.mjs missing — bun run build.ts first')
  failures++
} else {
  const home = resolveProofHome([REPO])
  const env = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CRITTER_IDLE: '0',    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',   MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  }
  const capture = (name: string, sends: unknown[], total: number, readyText?: string): { text: string; marks: Record<string, string>; status: number | null; stderr: string } => {
    const grid = join(SCRATCH, `${name}.json`)
    const cfgPath = join(SCRATCH, `${name}-vshot.json`)
    writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], sends, total, cols: 100, rows: 30, out: grid, title: `${name} @100x30`, ...(readyText === undefined ? {} : { readyText, readySettleTicks: 2 }) }))
    const res = spawnSync(driver.python, [VSHOT, cfgPath], { encoding: 'utf-8', env, timeout: vshotBudgetMs(90_000) })
    const marks: Record<string, string> = {}
    if (existsSync(grid)) {
      const payload = JSON.parse(readFileSync(grid, 'utf8')) as { marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }> }
      for (const m of payload.marks ?? []) marks[m.label] = m.grid.map(row => row.map(c => c.c).join('')).join('\n')
    }
    return { text: res.stdout ?? '', marks, status: res.status, stderr: res.stderr ?? '' }
  }

  {
    const r = capture('logins', [
      { atTick: 40, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 60, data: '/logins', awaitText: 'Type a prompt', minTick: 5 },
      { afterPrevTicks: 4, data: '\r' },
      { requireAwait: true, awaitText: 'Mercury · logins', awaitStableTicks: 3, mark: 'top', data: '' },
      { requireAwait: true, awaitText: 'OpenAI-compatible', awaitPattern: '(?s)(?=.*OpenAI-compatible)(?=.*esc back)', awaitStableTicks: 3, repeatEveryTicks: 3, mark: 'paged', data: '\u001b[6~' },
      { afterPrevTicks: 3, data: '\u001b' },
    ], 70)
    check('/logins drive delivered every send', r.status === 0, `exit ${r.status}: ${r.stderr.trim().slice(-200)}`)
    const top = r.marks.top ?? ''
    const paged = r.marks.paged ?? ''
    check('/logins at 100x30: the footer is on screen with the menu (esc back)', top.includes('esc back') && top.includes('Sign in'))
    check('/logins at 100x30: the readiness tail starts below the fold', !top.includes('OpenAI-compatible'))
    check('PageDown pages the body: the readiness tail lands, the footer stays', paged.includes('OpenAI-compatible') && paged.includes('esc back'))
  }
  {
    const r = capture('logins-wrap', [
      { requireAwait: true, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: 'Type a prompt', minTick: 5, awaitSettleTicks: 2, data: '/logins' },
      { requireAwait: true, awaitText: '❯ /logins', awaitSettleTicks: 2, data: '\r' },
      { requireAwait: true, awaitText: 'Mercury · logins', awaitStableTicks: 3, data: '' },
      { requireAwait: true, awaitText: 'OpenCode Zen', awaitPattern: '❯ OpenCode Zen', awaitStableTicks: 2, repeatEveryTicks: 3, mark: 'last', data: '\u001b[B' },
      { requireAwait: true, awaitText: 'OpenAI — ChatGPT', awaitPattern: '❯ OpenAI — ChatGPT', awaitStableTicks: 3, mark: 'wrapped', data: '' },
      { requireAwait: true, awaitText: 'esc back', awaitSettleTicks: 2, data: '\u001b' },
    ], 150, 'Type a prompt')
    check('/logins wrap drive delivered every send', r.status === 0, `exit ${r.status}: ${r.stderr.trim().slice(-200)}`)
    const last = r.marks.last ?? ''
    const wrapped = r.marks.wrapped ?? ''
    check('↓ walks the list to its last row with the body scrolled to show it', last.includes('❯ OpenCode Zen') && last.includes('esc back'))
    check('↓ on the last row wraps to the first row AND the body scrolls up to show it (a focused row is never off screen)', wrapped.includes('❯ OpenAI — ChatGPT') && wrapped.includes('esc back'))
  }
  {
    const r = capture('help', [
      { atTick: 40, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 60, data: '/help', awaitText: 'Type a prompt', minTick: 5 },
      { afterPrevTicks: 4, data: '\r' },
      { requireAwait: true, awaitText: 'Shortcuts', awaitStableTicks: 3, mark: 'open', data: '' },
      { afterPrevTicks: 4, data: '\u001b' },
    ], 60)
    check('/help drive delivered every send', r.status === 0, `exit ${r.status}: ${r.stderr.trim().slice(-200)}`)
    const open = r.marks.open ?? ''
    const rows = open.split('\n')
    check('/help at 100x30: "$EDITOR" reads whole (no clipped column)', open.includes('to edit in $EDITOR'))
    const bashRow = rows.find(row => row.includes('! for shell mode'))
    const cmdRow = rows.find(row => row.includes('/ for commands'))
    const secondColumn = (row: string | undefined): string => (row ?? '').split(/\s{2,}/).map(s => s.trim()).filter(Boolean)[1] ?? ''
    const twoColumns = /(⇧← |shift\+← |for command palette)/.test(secondColumn(bashRow)) && /(for command palette|to open a file)/.test(secondColumn(cmdRow))
    check('/help at 100x30: two columns — the global column stands beside the prefix rows (the strip row or the palette row heads it)', twoColumns, `bash row: ${JSON.stringify(secondColumn(bashRow))} · commands row: ${JSON.stringify(secondColumn(cmdRow))}`)
    const strays = rows.filter(row => /^\s*│\s{34,}[^\s│]/.test(row) && !/for |to |\/keybindings/.test(row))
    check('/help at 100x30: no row wrapped into a third column line (every global row sits beside a left row or below the last one)', strays.length === 0, strays.map(r => JSON.stringify(r.trim())).join(' · '))
    if (!twoColumns) console.log(rows.map(row => `      │${row.trimEnd()}`).join('\n'))
    check('/help at 100x30: the footer close hint is on screen', open.includes('esc close'))
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ modal surfaces fit' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
