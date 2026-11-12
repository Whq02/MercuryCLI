#!/usr/bin/env bun
// gate-watch: src/ink/frame-writer.ts src/ink/ink.tsx src/ink/frame.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { AlternateScreen } from '../../src/ink/components/AlternateScreen.js'
import Box from '../../src/ink/components/Box.js'
import Text from '../../src/ink/components/Text.js'
import { appendChildNode, createNode } from '../../src/ink/dom.js'
import { emptyFrame } from '../../src/ink/frame.js'
import { FrameWriter } from '../../src/ink/frame-writer.js'
import Ink from '../../src/ink/ink.js'
import instances from '../../src/ink/instances.js'
import createRenderer from '../../src/ink/renderer.js'
import { buildDom, makeContext } from './frameHarness.js'

const ROOT = join(import.meta.dir, '..', '..')
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

console.log('§1 FrameWriter carries no empty reset() method and Ink makes no writer.reset() calls')
{
  const writerSrc = readFileSync(join(ROOT, 'src/ink/frame-writer.ts'), 'utf8')
  const inkSrc = readFileSync(join(ROOT, 'src/ink/ink.tsx'), 'utf8')
  check(
    'FrameWriter.prototype has no reset member',
    !('reset' in FrameWriter.prototype),
    Object.getOwnPropertyNames(FrameWriter.prototype).join(', '),
  )
  check(
    'src/ink/frame-writer.ts declares no reset() method',
    !/\breset\s*\(/.test(writerSrc),
  )
  check(
    'src/ink/ink.tsx calls writer.reset() nowhere',
    !/\bwriter\.reset\s*\(/.test(inkSrc),
  )
}

console.log('\n§2 Inline scrollback boundary (flushedRows) and alt/main reset roads behave identically without writer.reset()')
{
  const ctx = makeContext()
  const writer = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const makeInlineFrame = (lineCount: number) => {
    const root = createNode('ink-root')
    appendChildNode(
      root,
      buildDom({
        kind: 'box',
        style: { flexDirection: 'column', width: 40 },
        children: Array.from({ length: lineCount }, (_, i) => ({ kind: 'text' as const, text: `line ${i}` })),
      }),
    )
    root.layoutNode!.calculateLayout(40, undefined)
    const render = createRenderer(root, ctx.stylePool)
    return render({
      frontFrame: emptyFrame(5, 40, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
      backFrame: emptyFrame(5, 40, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
      isTTY: true,
      terminalWidth: 40,
      terminalRows: 5,
      altScreen: false,
      prevFrameContaminated: false,
    }).frame
  }

  const blank = emptyFrame(5, 40, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  const eight = makeInlineFrame(8)
  writer.render(blank, eight, false)
  const flushed = (writer as unknown as { flushedRows: number }).flushedRows
  check('growing 8 inline rows in a 5-row viewport cedes 3 rows to scrollback', flushed === 3, String(flushed))

  const six = makeInlineFrame(6)
  const afterResetDiff = writer.render(blank, six, false)
  const flushedAfter = (writer as unknown as { flushedRows: number }).flushedRows
  check(
    'rendering from an empty base after resetLineCount/SIGCONT preserves flushedRows=3 and emits no clear',
    flushedAfter === 3 && afterResetDiff.every(patch => patch.type !== 'clear' && patch.type !== 'clearTerminal'),
    JSON.stringify({ flushedAfter, patches: afterResetDiff.map(p => p.type) }),
  )
}

{
  class Out extends EventEmitter {
    isTTY = true
    columns = 40
    rows = 10
    bytes = ''
    write(chunk: string): boolean {
      this.bytes += chunk
      return true
    }
  }
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    readableLength: 0,
    setRawMode() { return this },
    setEncoding() { return this },
    read() { return null },
    ref() { return this },
    unref() { return this },
    pause() { return this },
    resume() { return this },
  }) as unknown as NodeJS.ReadStream

  const out = new Out()
  const err = new Out()
  const ink = new Ink({
    stdout: out as unknown as NodeJS.WriteStream,
    stdin,
    stderr: err as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  instances.set(out as unknown as NodeJS.WriteStream, ink)
  const h = React.createElement
  ink.render(h(AlternateScreen, { mouseTracking: false }, h(Box, { width: 40, height: 10 }, h(Text, null, 'alt active'))))
  await new Promise<void>(resolve => setTimeout(resolve, 450))
  const altText = ink.lastFrameText()
  ink.render(h(Box, { flexDirection: 'column', width: 40 }, h(Text, null, 'back on main')))
  await new Promise<void>(resolve => setTimeout(resolve, 120))
  const mainText = ink.lastFrameText()
  ink.resetLineCount()
  ink.onRender()
  check(
    'alt-screen entry, exit to main screen, and resetLineCount all paint cleanly',
    altText.includes('alt active') && mainText.includes('back on main') && out.bytes.includes('back on main'),
    JSON.stringify({ altText, mainText }),
  )
  ;(ink as unknown as { isTTY: boolean }).isTTY = false
  ink.unmount()
  instances.delete(out as unknown as NodeJS.WriteStream)
}

console.log(`\nprove-writer-reset-removed: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
