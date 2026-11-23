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
  const { spliceInputRange, expandRangeToChips } = await import('../../src/screen/composer/text-input/inputRange.ts')
  const plain = spliceInputRange('hello world', { start: 6, end: 11 }, 'there')
  check('replaces the range and lands the cursor after the insert', plain.text === 'hello there' && plain.cursorOffset === 11, `got ${JSON.stringify(plain)}; fix spliceInputRange in src/screen/composer/text-input/inputRange.ts`)
  const del = spliceInputRange('hello world', { start: 5, end: 11 }, '')
  check('empty insert = range delete', del.text === 'hello' && del.cursorOffset === 5, `got ${JSON.stringify(del)}; fix spliceInputRange in src/screen/composer/text-input/inputRange.ts`)
  const clamped = spliceInputRange('abc', { start: 1, end: 99 }, 'Z')
  check('out-of-range clamps, never throws', clamped.text === 'aZ' && clamped.cursorOffset === 2, `got ${JSON.stringify(clamped)}; clamp the range in spliceInputRange (src/screen/composer/text-input/inputRange.ts)`)
  const chipText = 'see [Pasted text #3 +12 lines] here'
  const expanded = expandRangeToChips(chipText, { start: 10, end: 14 })
  check(
    'a partial chip overlap expands to the WHOLE reference token',
    expanded.start === 4 && expanded.end === 30,
    `${JSON.stringify(expanded)}; fix expandRangeToChips in src/screen/composer/text-input/inputRange.ts so a partial overlap widens to the whole chip`,
  )
  const chipSplice = spliceInputRange(chipText, { start: 10, end: 14 }, 'X')
  check('the splice can never split a chip', chipSplice.text === 'see X here', `${chipSplice.text}; spliceInputRange must widen the range with expandRangeToChips (src/screen/composer/text-input/inputRange.ts)`)
  const imageChip = spliceInputRange('a [Image #2] b', { start: 3, end: 5 }, '')
  check('image chips are atomic too', imageChip.text === 'a  b', `${JSON.stringify(imageChip.text)}; make expandRangeToChips (src/screen/composer/text-input/inputRange.ts) treat [Image #N] as a chip`)
  const outside = expandRangeToChips(chipText, { start: 0, end: 3 })
  check('a range clear of chips is untouched', outside.start === 0 && outside.end === 3, `got ${JSON.stringify(outside)}; expandRangeToChips (src/screen/composer/text-input/inputRange.ts) must leave a range clear of chips as is`)
}


console.log('\n── §3 the REAL binary: burst-undo · redo · receipts ─────────')
function composerCapture(
  tag: string,
  sends: Array<Record<string, unknown> & { data: string }>,
  total: number,
  early?: { readyText?: string; stableTicks?: number },
): string[] | null {
  const cfg = scenario('cockpit-short', 120, 40)
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
  cleanupScenario('cockpit-short')
  if (res.status !== 0) {
    check(`${tag}: PTY capture ran`, false, `${res.stderr?.slice(0, 200) ?? ''} scripts/ui/vshot.py exited ${res.status}; rerun it with ${cfgPath} to see why`)
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
      `${a.find(l => l.includes('alpha')) ?? '(draft missing)'}; one undo must drop only the last typing burst, see the chat:undo handler in src/screen/composer/useComposerKeybindings.ts`,
    )
    check('the ↶ receipt showed', a.some(l => l.includes('undid')), `no 'undid' row; the undo handler in src/screen/composer/useComposerKeybindings.ts posts the 'undid the last edit' notification`)
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
      `${b.find(l => l.includes('alpha')) ?? '(draft missing)'}; redo must restore the undone burst, see the chat:redo handler in src/screen/composer/useComposerKeybindings.ts`,
    )
    check('the ↷ receipt showed', b.some(l => l.includes('redid')), `no 'redid' row; the redo handler in src/screen/composer/useComposerKeybindings.ts posts the 'redid the last edit' notification`)
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
      `${c.find(l => l.includes('alpha')) ?? '(draft missing)'}; a second undo must unwind the next burst too, see the chat:undo handler in src/screen/composer/useComposerKeybindings.ts`,
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
      `${d.find(l => l.includes('pasted')) ?? ''}; undo must restore the empty draft after a first-edit paste, see the chat:undo handler in src/screen/composer/useComposerKeybindings.ts`,
    )
    check('the paste-undo ↶ receipt showed', d.some(l => l.includes('undid')), `no 'undid' row; the undo handler in src/screen/composer/useComposerKeybindings.ts posts the 'undid the last edit' notification`)
  }
}

console.log()
if (failures > 0) {
  console.log(`❌ COMPOSER-EDITING PROOF RED (${failures})`)
  process.exit(1)
}
console.log('✅ COMPOSER-EDITING PROOF PASS')
