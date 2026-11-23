#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ComposeBuffer, { lastComposeCounts } from '../../src/screen/renderer/compose-buffer.js'
import {
  cellAt,
  CharPool,
  createScreen,
  HyperlinkPool,
  type Screen,
  StylePool,
} from '../../src/screen/renderer/cell-grid.js'

const RECORDING = join(import.meta.dirname, 'compose-buffer-recording.json')
const WRITE = process.argv.includes('--write')

type SceneSnapshot = {
  width: number
  height: number
  damage: Screen['damage'] | null
  softWrap: number[]
  noSelect: string[]
  counts: typeof lastComposeCounts
  rows: string[][]
}

function makePools(): { stylePool: StylePool; charPool: CharPool; hyperlinkPool: HyperlinkPool } {
  return {
    stylePool: new StylePool(),
    charPool: new CharPool(),
    hyperlinkPool: new HyperlinkPool(),
  }
}

function snapshot(screen: Screen, stylePool: StylePool): SceneSnapshot {
  const rows: string[][] = []
  const noSelect: string[] = []
  for (let y = 0; y < screen.height; y++) {
    const row: string[] = []
    let ns = ''
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAt(screen, x, y)
      if (!cell) {
        row.push('.')
      } else {
        const sgr = stylePool.transition(stylePool.none, cell.styleId)
        const link = cell.hyperlink ?? ''
        row.push(`${cell.char}|${sgr}|${cell.width}|${link}`)
      }
      ns += screen.noSelect[y * screen.width + x] ? '1' : '0'
    }
    rows.push(row)
    noSelect.push(ns)
  }
  return {
    width: screen.width,
    height: screen.height,
    damage: screen.damage ?? null,
    softWrap: Array.from(screen.softWrap),
    noSelect,
    counts: { ...lastComposeCounts },
    rows,
  }
}

function recordAll(): Record<string, SceneSnapshot> {
  const out: Record<string, SceneSnapshot> = {}
  const { stylePool, charPool, hyperlinkPool } = makePools()

  const newScreen = (w: number, h: number): Screen => createScreen(w, h, stylePool, charPool, hyperlinkPool)
  const buf = new ComposeBuffer({ width: 16, height: 4, stylePool, screen: newScreen(16, 4) })

  {
    buf.write(0, 0, '')
    buf.write(1, 0, 'hello\nworld')
    buf.write(0, 3, 'row3\nrow4-clipped\nrow5-clipped')
    out['write-plain-and-overflow'] = snapshot(buf.get(), stylePool)
  }

  {
    const screen = newScreen(20, 4)
    buf.reset(20, 4, screen)
    buf.write(0, 0, '\x1b[31;1mred\x1b[0m plain e\u0301')
    buf.write(0, 1, '\x1b]8;;https://example.test\x07link\x1b]8;;\x07 tail')
    buf.write(0, 2, 'AB日本語CD')
    buf.write(19, 3, '漢')
    out['write-styles-links-wide-edge'] = snapshot(buf.get(), stylePool)
  }

  {
    const screen = newScreen(20, 4)
    buf.reset(20, 4, screen)
    buf.write(0, 0, '\tA\tB')
    buf.write(18, 1, '\tZ')
    buf.write(0, 2, 'a\x01b\x1b[32mG\x1b(Bc\x1b]0;t\x07d\x1b]0;s\x1b\\e\x1b7f')
    buf.write(0, 3, 'hello שלום 123')
    out['write-tabs-escapes-bidi'] = snapshot(buf.get(), stylePool)
  }

  {
    const screen = newScreen(16, 4)
    buf.reset(16, 4, screen)
    buf.write(1, 0, 'line0\nline1\nline2\nline3', [false, true, true, false])
    out['write-softwrap-unclipped'] = snapshot(buf.get(), stylePool)
  }

  {
    const screen = newScreen(16, 4)
    buf.reset(16, 4, screen)
    buf.clip({ x1: undefined, x2: undefined, y1: 1, y2: 3 })
    buf.write(2, 0, 'first\nsecond\nthird\nfourth', [false, true, true, false])
    buf.unclip()
    out['write-softwrap-vclipped'] = snapshot(buf.get(), stylePool)
  }

  {
    const screen = newScreen(12, 5)
    buf.reset(12, 5, screen)
    buf.fill(0, 0, 0, 2)
    buf.fill(0, 0, 2, 0)
    buf.fill(0, 0, 5, 2)
    buf.fill(2, 1, 6, 3, '\x1b[44m ')
    buf.fill(6, 2, 4, 2, '\x1b[44m ')
    buf.clip({ x1: 3, x2: 9, y1: 1, y2: 4 })
    buf.fill(0, 0, 12, 5, '\x1b[42m ')
    buf.fill(10, 0, 2, 2, '\x1b[41m ')
    buf.unclip()
    out['fill-styled-cached-clipped'] = snapshot(buf.get(), stylePool)
  }

  {
    const screen = newScreen(24, 5)
    buf.reset(24, 5, screen)
    const sample = '\x1b[33m0123\x1b[39m日本語ABC\nsecond line\nthird line'
    buf.clip({ x1: 2, x2: 20, y1: undefined, y2: 4 })
    buf.clip({ x1: undefined, x2: 11, y1: 0, y2: 3 })
    buf.write(2, 0, sample)
    buf.write(2, 1, sample)
    buf.write(12, 0, 'outside-right')
    buf.write(0, 0, 'a')
    buf.write(2, 4, 'outside-bottom')
    buf.unclip()
    buf.write(12, 2, 'outer-clip-ok')
    buf.unclip()
    buf.write(20, 4, 'uncl')
    out['clip-nested-wide-edge-and-cache'] = snapshot(buf.get(), stylePool)
  }

  {
    const srcScreen = newScreen(10, 4)
    const srcBuf = new ComposeBuffer({ width: 10, height: 4, stylePool, screen: srcScreen })
    srcBuf.write(0, 0, '\x1b[36mSRC0123456\x1b[0m')
    srcBuf.write(0, 1, '漢a字b')
    srcBuf.write(0, 2, 'third-row!')
    const src = srcBuf.get()

    const dstScreen = newScreen(14, 5)
    buf.reset(14, 5, dstScreen)
    buf.blit(src, 0, 0, 10, 3)
    buf.clip({ x1: 2, x2: 8, y1: 1, y2: 3 })
    buf.blit(src, 1, 0, 9, 4)
    buf.blit(src, 20, 0, 4, 2)
    buf.unclip()
    out['blit-full-partial-clipped'] = snapshot(buf.get(), stylePool)
  }

  {
    const screen = newScreen(12, 6)
    buf.reset(12, 6, screen)
    for (let y = 0; y < 6; y++) buf.write(0, y, `row-${y}-abcdef`)
    buf.shift(1, 4, -1)
    buf.shift(1, 4, 1)
    buf.shiftRect(1, 4, 2, 9, -1)
    buf.shiftRect(0, 5, 4, 10, 1)
    buf.shiftRect(0, 2, 15, 20, 1)
    out['shift-and-shift-rect'] = snapshot(buf.get(), stylePool)
  }

  {
    const screen = newScreen(12, 5)
    buf.reset(12, 5, screen)
    buf.write(0, 0, 'alpha\nbeta\ngamma\ndelta')
    buf.clear({ x: 1, y: 1, width: 4, height: 2 })
    buf.clear({ x: 4, y: 2, width: 5, height: 3 }, true)
    buf.clear({ x: 20, y: 20, width: 2, height: 2 })
    buf.noSelect({ x: 0, y: 0, width: 4, height: 2 })
    buf.noSelect({ x: 3, y: 2, width: 5, height: 2 })
    out['clear-and-no-select'] = snapshot(buf.get(), stylePool)
  }

  {
    const screen = newScreen(40, 28)
    buf.reset(40, 28, screen)
    for (let y = 0; y < 28; y++) {
      buf.write(0, y, `line-${String(y).padStart(2, '0')}-${'x'.repeat(30)}`)
    }
    const result = buf.get()
    out['high-write-ratio-counts'] = {
      width: result.width,
      height: result.height,
      damage: result.damage ?? null,
      softWrap: [],
      noSelect: [],
      counts: { ...lastComposeCounts },
      rows: [],
    }
  }

  return out
}

const first = JSON.stringify(recordAll(), null, 2) + '\n'
const second = JSON.stringify(recordAll(), null, 2) + '\n'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('prove-compose-buffer-recording — ComposeBuffer recording')
check('two runs in one process produce identical recordings', first === second, 'ComposeBuffer in src/screen/renderer/compose-buffer.ts keeps state between scenes (a pool, cache or reset path) that changes the second run; make reset and get start each scene clean')

if (WRITE) {
  if (failures === 0) {
    writeFileSync(RECORDING, first)
    console.log(`  wrote ${RECORDING} (${first.length} bytes)`)
  }
} else {
  check('stored recording exists', existsSync(RECORDING), `${RECORDING} is missing; restore it from git, or run this script with --write to record it`)
  if (existsSync(RECORDING)) {
    const stored = readFileSync(RECORDING, 'utf8')
    const equal = stored === first
    let detail = ''
    if (!equal) {
      const a = stored.split('\n')
      const b = first.split('\n')
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          detail = `first diff line ${i + 1}: stored=${a[i]} vs now=${b[i]}; if the change in src/screen/renderer/compose-buffer.ts is unintended, fix it there, and if intended, re-record with this script and --write and commit scripts/ink-runtime/compose-buffer-recording.json`
          break
        }
      }
    }
    check('ComposeBuffer output equals the stored recording', equal, detail)
  }
}

if (failures > 0) {
  console.log(`\nRED: prove-compose-buffer-recording (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\ngreen: prove-compose-buffer-recording')
