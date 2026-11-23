#!/usr/bin/env bun
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
      check(`${tag}: PTY capture ran`, false, `${res.stderr?.slice(0, 200) ?? ''} (run scripts/ui/vshot.py on the config it was given to see why the capture failed)`)
      return null
    }
    const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Array<Array<{ c: string }>> }).grid
    return grid.map(r => r.map(c => c.c).join(''))
  }

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
    check('typed text lands in the input row', row0 >= 0, row0 >= 0 ? `row ${row0} col ${colStart0}` : 'not found; the resume-2turn scenario in scripts/ui/renderScenarios.ts did not show the typed text on a row with the prompt, so check its sends and ticks')
  }

  if (row0 >= 0) {
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
      check('one ⌫ removed the WHOLE selection', !inputRow.includes('sfff'), `${inputRow.trim().slice(0, 40)} (the range-delete branch of onInputOf in src/screen/composer/text-input/keys.ts must splice the whole selected range on one backspace)`)
      check(
        "specifically NOT the 1-by-1 regression ('sff' remnant)",
        !inputRow.includes('sff'),
        `${inputRow.trim().slice(0, 40)} (the range-delete branch of onInputOf in src/screen/composer/text-input/keys.ts must splice the whole selected range, not one character)`,
      )
      const anywhere = after.some(l => l.includes('sfff'))
      check('the typed text is gone from the screen', !anywhere, 'the typed text is still on screen after the drag and backspace; see the range-delete branch of onInputOf in src/screen/composer/text-input/keys.ts')
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
