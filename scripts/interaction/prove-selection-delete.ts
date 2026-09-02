#!/usr/bin/env bun
// ============================================================================
//  scripts/interaction/prove-selection-delete.ts
//  PROOF: a drag-selection lying over the PROMPT INPUT is consumed WHOLE by
//  backspace/delete (the normal-textbox contract) — the operator's report:
//  drag-highlight "sfff" then ⌫ deleted one char at a time.
//
//  The mechanism under test (three seams):
//    • PromptInput's screen→text adapter (inputSelectionRange): ink's screen-
//      cell selection (drag / double-click word) is mapped through the SAME
//      wrap model the click-to-position handler uses, ONLY when both endpoints
//      lie inside the input box's nodeCache rect (stamp-gated; history-search
//      guarded; transcript selections stay pure copy affordances).
//    • useTextInput: backspace/delete consult selectionRange() FIRST — a
//      non-empty range is deleted wholesale, cursor lands at range start, the
//      screen selection is cleared (onSelectionConsumed).
//    • TextInput threads the two props (vim path untouched).
//
//  Legs: structural greps + a REAL PTY end-to-end (the prove-click-expand
//  pattern — no API turn): type sfff → SGR drag across it → one ⌫ → the input
//  is EMPTY (and specifically NOT the one-char-deleted 'sff' regression).
//  Run: ~/.bun/bin/bun run scripts/interaction/prove-selection-delete.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_HOME, cleanupScenario, scenario } from '../ui/renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('structural — the three seams')
{
  // Pins re-cut to the rewritten owners' spellings (each law
  // re-verified in source before the re-cut): the seam is the
  // selectionRange() read at the top of useTextInput's onInput, the adapter
  // is PromptInput's mapSelectionToInputRange, and ONE input box wraps both
  // editors.
  const hook = readFileSync('src/hooks/useTextInput.ts', 'utf8')
  check(
    'useTextInput consumes the range on backspace/delete/raw-DEL',
    /key\.backspace \|\| key\.delete \|\| filtered\.includes\('\\x7f'\)/.test(hook),
  )
  check(
    'the seam sits ABOVE the raw \\x7f DEL-filter branch (a bare-DEL backspace must not 1-by-1 first)',
    hook.indexOf('const r = selectionRange()') !== -1 && hook.indexOf('const r = selectionRange()') < hook.indexOf('handleRawDelBytes(cursor, rawInput)') &&
      hook.indexOf('const r = selectionRange()') < hook.indexOf('const next = routeKey(cursor, filtered, rawInput, key)'),
  )
  check(
    'range delete resets kill/yank accumulators and returns',
    /onSelectionConsumed\?\.\(\)\s*\n\s*resetKillAccumulation\(\)\s*\n\s*resetYankState\(\)/.test(hook) &&
      /commitRangeEdit\(spliceInputRange\(liveValue, r, ''\)\)\s*\n\s*return/.test(hook),
  )
  check('range is bounds-clamped against the live text', hook.includes('end <= liveValue.length'))
  const ti = readFileSync('src/components/TextInput.tsx', 'utf8')
  check(
    'TextInput threads selectionRange + onSelectionConsumed into useTextInput',
    ti.includes('selectionRange: props.selectionRange') &&
      ti.includes('onSelectionConsumed: props.onSelectionConsumed'),
  )
  const pi = readFileSync('src/components/PromptInput/PromptInput.tsx', 'utf8')
  check(
    'PromptInput adapter is history-search guarded (the displayed match is not the input)',
    pi.includes('const mapSelectionToInputRange = ') &&
      /const mapSelectionToInputRange = [\s\S]{0,300}if \(isSearchingHistory\) return null/.test(pi),
  )
  check(
    'adapter requires BOTH endpoints inside the input rect (transcript stays copy-only)',
    pi.includes('if (!inside(state.anchor) || !inside(state.focus)) {'),
  )
  // A bottom-anchored reflow between the drag and the key (a footer notice
  // landing or expiring) moves the box one row under the screen-anchored
  // highlight; the adapter maps against the rect of the gesture's OWN frame
  // (captured at the press), never only the live one — the trace
  // read rect row 36 against selection rows 37 and refused as "outside".
  check(
    "the adapter maps against the rect of the gesture's own frame (a reflow never detaches the highlight)",
    pi.includes('selectionGestureRectRef.current ?? (box ? nodeCache.get(box) : undefined)') &&
      pi.includes('selectionApi.subscribe(() => {'),
  )
  check(
    'consuming clears the screen selection (highlight never outlives the text)',
    pi.includes('onSelectionConsumed={() => selectionApi.clearSelection()}'),
  )
  check(
    'ONE input box carries the rect ref and wraps both editors',
    (pi.match(/ref=\{inputBoxRef\}/g) ?? []).length === 1 &&
      /ref=\{inputBoxRef\}[\s\S]{0,600}VimTextInput[\s\S]{0,600}<TextInput/.test(pi),
  )
  check(
    'vim path untouched (props only on the TextInput branch)',
    !/VimTextInput[^>]*selectionRange/.test(pi),
  )
  // The ordering bridge: the "any key clears the highlight" handler must defer
  // delete-shaped keys to the input seam — clearing first (registration-order
  // dependent) is exactly how the report reproduced.
  check(
    'PromptInput registers the adapter on the selection bridge',
    pi.includes('registerInputSelectionConsumer(() => inputSelectionRangeRef.current())'),
  )
  const skh = readFileSync('src/components/ScrollKeybindingHandler.tsx', 'utf8')
  check(
    'the clear path defers the input-consumable key set (delete-shaped + printable + bare ←/→ — interaction-finish slice 7 widened it beyond ⌫; a printable used to lose its selection to this clear and append at the cursor)',
    skh.includes('peekInputSelectionRange()') &&
      skh.includes("const deleteShaped = key_0.backspace || key_0.delete || input_0.includes('\\x7f');") &&
      skh.includes('const bareArrow = (key_0.leftArrow || key_0.rightArrow) && !key_0.shift && !key_0.ctrl && !key_0.meta;') &&
      /if \(\(deleteShaped \|\| bareArrow \|\| printable\) && peekInputSelectionRange\(\)\) \{\s*\n\s*return;/.test(skh),
  )
  const bridge = readFileSync('src/utils/cockpit/inputSelectionBridge.ts', 'utf8')
  check(
    'the bridge peek never throws into key handling',
    bridge.includes('catch') && bridge.includes('return null'),
  )
}

section('end-to-end — a real PTY drag + ⌫ (no API)')
{
  const drive = (
    tag: string,
    extraSends: Array<{ atTick: number; data: string }>,
    total: number,
  ): string[] | null => {
    const cfg = scenario('resume-2turn', 80, 40)
    cfg.sends = [{ atTick: 34, data: 'sfff' }, ...extraSends]
    cfg.total = total
    const gridPath = `/tmp/sel-del-${tag}-${process.pid}.json`
    const cfgPath = `/tmp/sel-del-${tag}-cfg-${process.pid}.json`
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
    const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
      encoding: 'utf8',
      timeout: vshotBudgetMs(120_000),
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: CONFIG_HOME,
      },
    })
    if (res.status !== 0) {
      check(`${tag}: PTY capture ran`, false, res.stderr?.slice(0, 200) ?? '')
      return null
    }
    const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Array<Array<{ c: string }>> }).grid
    return grid.map(r => r.map(c => c.c).join(''))
  }

  // Leg 1 — locate the typed text (same fixture/size ⇒ stable coords).
  const before = drive('before', [], 44)
  let row0 = -1
  let colStart0 = -1
  if (before) {
    for (let r = 0; r < before.length; r++) {
      const line = before[r]!
      if (line.includes('❯') && line.includes('sfff')) {
        row0 = r
        colStart0 = line.indexOf('sfff')
        break
      }
    }
    check('typed text lands in the input row', row0 >= 0, row0 >= 0 ? `row ${row0} col ${colStart0}` : 'not found')
  }

  if (row0 >= 0) {
    // Leg 2 — drag across the 4 cells, release, one backspace. SGR coords are
    // 1-based; motion frames carry the 0x20 bit (prove-click-expand's format).
    const y = row0 + 1
    const x1 = colStart0 + 1
    const x2 = colStart0 + 4
    const drag =
      `\x1b[<0;${x1};${y}M` +
      `\x1b[<32;${x1 + 1};${y}M` +
      `\x1b[<32;${x2};${y}M` +
      `\x1b[<0;${x2};${y}m`
    const after = drive(
      'after',
      [
        { atTick: 40, data: drag },
        { atTick: 46, data: '\x7f' },
      ],
      56,
    )
    if (after) {
      const inputRow = after[row0] ?? ''
      check('one ⌫ removed the WHOLE selection', !inputRow.includes('sfff'), inputRow.trim().slice(0, 40))
      check(
        "specifically NOT the 1-by-1 regression ('sff' remnant)",
        !inputRow.includes('sff'),
        inputRow.trim().slice(0, 40),
      )
      const anywhere = after.some(l => l.includes('sfff'))
      check('the typed text is gone from the screen', !anywhere)
    }
  }
  cleanupScenario('resume-2turn')
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` ❌ prove-selection-delete: ${failures} failure(s)`)
  process.exit(1)
}
console.log(' ✅ selection-delete — drag-select + ⌫ collapses the range (E2E)')
