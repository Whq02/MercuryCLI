#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import ScreenInstance from '../../src/screen/renderer/screenInstance.js'
import { Text } from '../../src/screen/themedRenderer.js'
import { RESIZE_SETTLE_MS } from '../../src/screen/renderer/constants.js'
import { settle } from '../lib/settingsPopupHarness.js'

class Output extends EventEmitter {
  isTTY = true
  columns = 269
  rows = 68
  writes: string[] = []
  write(bytes: string): boolean {
    this.writes.push(bytes)
    return true
  }
}

async function shrink(program: string): Promise<string> {
  process.env.TERM_PROGRAM = program
  const out = new Output()
  const ink = new ScreenInstance({ stdout: out as never, stderr: out as never, stdin: new PassThrough() as never, patchConsole: false, exitOnCtrlC: false })
  try {
    ink.setAltScreenActive(true, false)
    ink.render(createElement(Text, null, 'right edge '.repeat(24)))
    await settle(250)
    out.writes.length = 0
    for (const columns of [211, 154, 116, 78, 72]) {
      out.columns = columns
      out.rows = 23
      out.emit('resize')
    }
    await settle(RESIZE_SETTLE_MS + 250)
    return out.writes.join('')
  } finally {
    ink.unmount()
    await ink.waitUntilExit()
  }
}

process.env.MERCURY_NO_SYNC_OUTPUT = '1'
for (const program of ['Apple_Terminal', 'iTerm.app']) {
  const bytes = await shrink(program)
  const erase = '\x1b[2J'
  const whole = '\x1b[H\x1b[0m'
  const count = bytes.split(erase).length - 1
  const correct = bytes.split(whole).length === 2 && (program === 'Apple_Terminal' ? count === 1 && bytes.indexOf(erase) !== -1 && bytes.indexOf(whole) !== -1 && bytes.indexOf(erase) < bytes.indexOf(whole) : count === 0)
  if (!correct) {
    console.error(`${program}: ${count} display erases, ${bytes.split(whole).length - 1} whole frames; in src/screen/renderer/instance/resize.ts erase the alternate screen once before the settled overwrite on an Apple Terminal shrink only`)
    process.exitCode = 1
  } else console.log(`${program}: settled shrink repainted with ${count} display erases`)
}
