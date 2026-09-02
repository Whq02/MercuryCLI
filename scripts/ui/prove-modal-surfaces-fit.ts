#!/usr/bin/env bun
// ============================================================================
//  prove-modal-surfaces-fit — a surface taller than the slot keeps its
//  footer; the help grid never clips a row; the usage grid's headings share
//  a row; a closed login says so; the turn counter counts what was sent.
//
//  The modal slot bounds its pane to the terminal and clips the overflow at
//  the BOTTOM — every command-center body taller than the slot (the /help
//  general tab at 30 rows, /logins with its readiness block, the /accounts
//  board) took its own footer off screen, so the operator lost the one line
//  that says how to leave. Laws:
//    · inside a modal the shell's body is a scroll box capped at the slot's
//      rows minus the shell chrome, registered as the slot's scroll target,
//      PageUp/PageDown page it while it overflows — header + footer pinned;
//    · the help grid picks its column count from the width it HAS and the
//      rows it HOLDS (a fixed floor let a 100-col pane clip "$EDITOR");
//    · the usage tab's containers own the spacing (a per-section top margin
//      put the Anthropic heading a row above its grid siblings);
//    · esc out of /logins reads as a close, never an interruption;
//    · ⤳N counts operator prompts — never slash echoes, tool results, meta.
//  THE SCREEN: the built binary at 100x30 — /logins shows its footer and
//  PageDown reveals the readiness tail; the /help general tab keeps every
//  row whole in two columns with its footer on screen.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-modal-surfaces-fit.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { resolveProofHome } from '../lib/proofHome.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')

const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-modal-fit-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-dummy0000000000'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

console.log('============================================================')
console.log(' modal surfaces fit — footer pinned · grid whole · grid aligned')
console.log('============================================================')

section('⤳N counts operator prompts')
{
  const { countOperatorTurns, isOperatorTurn } = await import('../../src/utils/messages/operatorTurns.ts')
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
    user('<local-command-stdout>Login closed — no credential changed</local-command-stdout>'),
    user('hi, stream the plan'),
    user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]),
    user('and the corpus numbers'),
  ]
  check('two slash commands + one tool round + two prompts ⇒ ⤳2', countOperatorTurns(messages) === 2, String(countOperatorTurns(messages)))
}

section('mechanism pins')
{
  const shell = read('src/components/mercury-ui/components.tsx')
  check('inside a modal the shell body is a ScrollBox capped at the slot rows minus its chrome', shell.includes('<ScrollBox ref={bodyRef} flexDirection="column" maxHeight={bodyCap}>') && shell.includes('slotRows - (5 + (specimen ? 1 : 0))'))
  check('the body registers as the slot\'s scroll target', shell.includes('modalScrollRef.current = bodyRef.current'))
  check('PageUp/PageDown page an overflowing body', /key\.pageUp \|\| key\.pageDown/.test(shell) && shell.includes('body.scrollBy('))
  check('outside a modal the body renders unbounded (byte-identical inline)', /\{insideModal \? \([\s\S]{0,200}\) : \(\s*children\s*\)\}/.test(shell))

  const usage = read('src/components/Settings/Usage.tsx')
  check('the stacked usage layout owns its spacing (gap, no per-section margin)', usage.includes('<Box flexDirection="column" gap={1}>'))
  check('no usage section root carries a top margin before its heading', !/marginTop=\{1\}>\s*\n\s*<Text bold>/.test(usage))

  const help = read('src/components/PromptInput/PromptInputHelpMenu.tsx')
  check('the help grid derives its 3-column floor from its rows', help.includes('const need3 =') && help.includes('widest(groupGlobal)'))
  check('…and its 2-column floor', help.includes('const need2 = Math.max(widest(groupPrefixes), widest(groupChat)) + colGap + widest(groupGlobal)'))
  check('the grid takes the container width the caller knows', help.includes('(availableColumns ?? columns) - 2 * (paddingX ?? 0)'))
  const general = read('src/components/HelpV2/General.tsx')
  check('the /help general tab hands the shell interior to the grid', general.includes('availableColumns={Math.max(20, columns - 4)}'))

  const figures = await import('../../src/constants/figures.ts')
  const ladder = [figures.EFFORT_LOW, figures.EFFORT_MEDIUM, figures.EFFORT_HIGH, figures.EFFORT_XHIGH, figures.EFFORT_MAX]
  check('no effort glyph is the band separator (`· · low` read as a doubled separator)', ladder.every(g => g !== '·'))
  check('the effort ladder glyphs are distinct', new Set(ladder).size === ladder.length)

  const login = read('src/commands/login/login.tsx')
  check('a closed login says so', login.includes("onDone('Login closed — no credential changed', chain)") && !login.includes('Login interrupted'))
  check('the login footer says esc closes (not cancels)', login.includes('footer="esc back · from the menu, esc closes login"'))
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
    // No turn is ever sent; the Anthropic base points at a closed port so
    // nothing can leave the box.
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  }
  const capture = (name: string, sends: unknown[], total: number): { text: string; marks: Record<string, string>; status: number | null; stderr: string } => {
    const grid = join(SCRATCH, `${name}.json`)
    const cfgPath = join(SCRATCH, `${name}-vshot.json`)
    writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], sends, total, cols: 100, rows: 30, out: grid, title: `${name} @100x30` }))
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
      // THE LANDING RULE (line 4, signed (b)): ↵ on the face's New Session first.
      { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 60, data: '/logins', awaitText: 'Type a prompt', minTick: 5 },
      { afterPrevTicks: 4, data: '\r' },
      { requireAwait: true, awaitText: 'Provider readiness', awaitStableTicks: 3, mark: 'top', data: '' },
      { afterPrevTicks: 4, data: '\u001b[6~' },
      { requireAwait: true, awaitText: 'OpenAI-compatible', awaitStableTicks: 3, mark: 'paged', data: '' },
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
    const r = capture('help', [
      // THE LANDING RULE (line 4, signed (b)): ↵ on the face's New Session first.
      { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 60, data: '/help', awaitText: 'Type a prompt', minTick: 5 },
      { afterPrevTicks: 4, data: '\r' },
      { requireAwait: true, awaitText: 'Shortcuts', awaitStableTicks: 3, mark: 'open', data: '' },
      { afterPrevTicks: 4, data: '\u001b' },
    ], 60)
    check('/help drive delivered every send', r.status === 0, `exit ${r.status}: ${r.stderr.trim().slice(-200)}`)
    const open = r.marks.open ?? ''
    const rows = open.split('\n')
    check('/help at 100x30: "$EDITOR" reads whole (no clipped column)', open.includes('to edit in $EDITOR'))
    const twoColumns = rows.some(row => row.includes('! for bash mode') && row.includes('for command palette'))
    check('/help at 100x30: two columns — the palette row shares a line with "! for bash mode"', twoColumns)
    // The frame is the diagnosis when the column verdict reds: print it.
    if (!twoColumns) console.log(rows.map(row => `      │${row.trimEnd()}`).join('\n'))
    check('/help at 100x30: the footer close hint is on screen', open.includes('esc close'))
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ modal surfaces fit' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
