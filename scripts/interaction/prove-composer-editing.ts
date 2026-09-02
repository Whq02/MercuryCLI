#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_HOME, cleanupScenario, scenario } from '../ui/renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' composer editing — splice · timeline · undo/redo (PTY)')
console.log('============================================================')

console.log('\n── §1 the ONE chip-safe splice ──────────────────────────────')
{
  const { spliceInputRange, expandRangeToChips } = await import('../../src/utils/inputRange.ts')
  const plain = spliceInputRange('hello world', { start: 6, end: 11 }, 'there')
  check('replaces the range and lands the cursor after the insert', plain.text === 'hello there' && plain.cursorOffset === 11)
  const del = spliceInputRange('hello world', { start: 5, end: 11 }, '')
  check('empty insert = range delete', del.text === 'hello' && del.cursorOffset === 5)
  const clamped = spliceInputRange('abc', { start: 1, end: 99 }, 'Z')
  check('out-of-range clamps, never throws', clamped.text === 'aZ' && clamped.cursorOffset === 2)
  const chipText = 'see [Pasted text #3 +12 lines] here'
  const expanded = expandRangeToChips(chipText, { start: 10, end: 14 })
  check(
    'a partial chip overlap expands to the WHOLE reference token',
    expanded.start === 4 && expanded.end === 30,
    JSON.stringify(expanded),
  )
  const chipSplice = spliceInputRange(chipText, { start: 10, end: 14 }, 'X')
  check('the splice can never split a chip', chipSplice.text === 'see X here', chipSplice.text)
  const imageChip = spliceInputRange('a [Image #2] b', { start: 3, end: 5 }, '')
  check('image chips are atomic too', imageChip.text === 'a  b', JSON.stringify(imageChip.text))
  const outside = expandRangeToChips(chipText, { start: 0, end: 3 })
  check('a range clear of chips is untouched', outside.start === 0 && outside.end === 3)
}

console.log('\n── §2 contracts pinned in source ────────────────────────────')
{
  const read = (p: string): string => readFileSync(join(import.meta.dir, '..', '..', p), 'utf8')
  const buf = read('src/hooks/useInputBuffer.ts')
  check('buffer exposes the bidirectional API', ['pushToBuffer', 'pushAtomic', 'undo', 'redo', 'canUndo', 'canRedo', 'clearBuffer'].every(k => buf.includes(k)))
  check('a new edit truncates the forward branch', buf.includes('if (redoStackRef.current.length > 0) redoStackRef.current = []'))
  check('entries carry text + cursor + paste metadata together', buf.includes('pastedContents: Record<number, PastedContent>'))
  const pi = read('src/components/PromptInput/PromptInput.tsx')
  check('undo/redo receive the LIVE state (pending edits never skipped)', pi.includes('undo({ text: input, cursorOffset, pastedContents })') && pi.includes('redo({ text: input, cursorOffset, pastedContents })'))
  check('insertions are atomic transactions', pi.includes('pushAtomic(input, cursorOffset, pastedContents);\n    const range = inputSelectionRangeRef.current();'))
  check('external-editor return is one atomic edit', /ATOMIC edit — one undo restores\n        \/\/ the pre-editor draft whole\./.test(pi) || pi.includes('pushAtomic(input, cursorOffset, pastedContents);\n        trackAndSetInput(result.content);'))
  check('the session switch resets the timeline', pi.includes('bufferSessionRef') && pi.includes('clearBuffer();'))
  check('range edits record an atomic boundary (onBeforeRangeEdit)', pi.includes('onBeforeRangeEdit={() => pushAtomic(input, cursorOffset, pastedContents)}'))
  const uti = read('src/hooks/useTextInput.ts')
  check('useTextInput routes ALL range edits through the one splice', (uti.match(/spliceInputRange\(/g) ?? []).length >= 2 && !/cursor\.text\.slice\(0, r\.start\) \+ cursor\.text\.slice\(r\.end\)/.test(uti))
  check('←/→ collapse the selection to its edges', uti.includes('setOffset(key.leftArrow ? r.start : r.end)'))
  check('esc clears the selection, never the draft', uti.includes('if (key.escape) {\n            onSelectionConsumed?.()\n            return\n          }'))
  const graph = read('src/keybindings/actionGraph.ts')
  const schema = read('src/keybindings/schema.ts')
  const defaults = read('src/keybindings/defaultBindings.ts')
  const help = read('src/components/PromptInput/PromptInputHelpMenu.tsx')
  check('chat:redo registered in schema + defaults + help', graph.includes("'chat:redo'") && schema.includes("export { KEYBINDING_ACTIONS } from './actionGraph.js'") && defaults.includes("'ctrl+x ctrl+r': 'chat:redo'") && help.includes('to redo'))
  check('ctrl+z is never advertised for redo', !defaults.includes("ctrl+z': 'chat:redo") && !help.includes('ctrl + z to redo'))
  const shutdown = read('src/utils/gracefulShutdown.ts')
  const installerStart = shutdown.indexOf('export const setupGracefulShutdown')
  const crashHandlerAt = shutdown.indexOf("process.on('uncaughtException'")
  const installer = installerStart >= 0 && crashHandlerAt > installerStart ? shutdown.slice(installerStart, crashHandlerAt) : ''
  check(
    'the stream-gone handlers are armed inside the shutdown installer, ahead of the crash handler',
    shutdown.includes("import { registerProcessOutputErrorHandlers } from './process.js'") && installer.includes('registerProcessOutputErrorHandlers()'),
  )
  const entry = read('src/main.tsx')
  const init = read('src/entrypoints/init.ts')
  check(
    'the interactive boot reaches that installer (main → init → setupGracefulShutdown)',
    entry.includes("import { init } from './entrypoints/init.js'") && entry.includes('await init()') && init.includes('setupGracefulShutdown()'),
  )
}

console.log('\n── §3 the REAL binary: burst-undo · redo · receipts ─────────')
function composerCapture(
  tag: string,
  sends: Array<Record<string, unknown> & { data: string }>,
  total: number,
  early?: { readyText?: string; stableTicks?: number },
): string[] | null {
  const cfg = scenario('companion-cockpit', 120, 40)
  const gridPath = `/tmp/composer-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/composer-${tag}-cfg-${process.pid}.json`
  writeFileSync(
    cfgPath,
    JSON.stringify({
      ...cfg,
      sends,
      total,
      ...(early?.readyText ? { readyText: early.readyText } : {}),
      ...(early?.stableTicks ? { stableTicks: early.stableTicks } : {}),
      out: gridPath,
    }),
  )
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(150_000),
    env: {
      ...process.env,
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  cleanupScenario('companion-cockpit')
  if (res.status !== 0) {
    check(`${tag}: PTY capture ran`, false, res.stderr?.slice(0, 200) ?? '')
    try {
      const g = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: { c: string }[][] }).grid
      console.log(g.slice(-6).map(r => `      | ${r.map(c => c.c).join('').trimEnd()}`).join('\n'))
    } catch {
    }
    return null
  }
  const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: { c: string }[][] }).grid
  return grid.map(r => r.map(c => c.c).join(''))
}
{
  const a = composerCapture(
    'undo',
    [
      { awaitText: '❯', minTick: 3, atTick: 40, data: 'alpha burst' },
      { afterPrevTicks: 14, data: ' two' },
      { afterPrevTicks: 10, data: '\x1f' },
    ],
    90,
    { readyText: 'undid' },
  )
  if (a) {
    check(
      'one undo unwinds exactly the last burst (draft = alpha burst)',
      a.some(l => l.includes('alpha burst') && !l.includes('alpha burst two')),
      a.find(l => l.includes('alpha')) ?? '(draft missing)',
    )
    check('the ↶ receipt showed', a.some(l => l.includes('undid')))
  }
  const b = composerCapture(
    'redo',
    [
      { awaitText: '❯', minTick: 3, atTick: 40, data: 'alpha burst' },
      { afterPrevTicks: 14, data: ' two' },
      { afterPrevTicks: 8, data: '\x1f' },
      { afterPrevTicks: 8, data: '\x18' },
      { afterPrevTicks: 3, data: '\x12' },
    ],
    100,
    { readyText: 'redid' },
  )
  if (b) {
    check(
      'redo restored the undone burst exactly (alpha burst two)',
      b.some(l => l.includes('alpha burst two')),
      b.find(l => l.includes('alpha')) ?? '(draft missing)',
    )
    check('the ↷ receipt showed', b.some(l => l.includes('redid')))
  }
  const c = composerCapture(
    'undo2',
    [
      { awaitText: '❯', minTick: 3, atTick: 40, data: 'alpha burst' },
      { afterPrevTicks: 14, data: ' two' },
      { afterPrevTicks: 10, data: '\x1f' },
      { afterPrevTicks: 12, data: ' three' },
      { afterPrevTicks: 12, data: '\x1f' },
    ],
    120,
    { stableTicks: 4 },
  )
  if (c) {
    check(
      'the SECOND undo unwinds too (draft = alpha burst, not …three)',
      c.some(l => l.includes('alpha burst') && !l.includes('three') && !l.includes('two')),
      c.find(l => l.includes('alpha')) ?? '(draft missing)',
    )
  }
  const d = composerCapture(
    'paste-undo',
    [
      { awaitRaw: '\u001b[?2004h', minTick: 2, atTick: 40, data: '' },
      { awaitText: '❯', minTick: 2, atTick: 45, data: '' },
      { afterPrevTicks: 1, data: '\x1b[200~pasted alpha content\x1b[201~' },
      { afterPrevTicks: 14, data: '\x1f' },
    ],
    90,
    { readyText: 'undid' },
  )
  if (d) {
    check(
      'undo after a FIRST-edit paste restores the empty draft',
      !d.some(l => l.includes('pasted alpha content')),
      d.find(l => l.includes('pasted')) ?? '',
    )
    check('the paste-undo ↶ receipt showed', d.some(l => l.includes('undid')))
  }
}

console.log()
if (failures > 0) {
  console.log(`❌ COMPOSER-EDITING PROOF RED (${failures})`)
  process.exit(1)
}
console.log('✅ COMPOSER-EDITING PROOF PASS')
