#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const React = await import('react')
const h = React.createElement
const { default: Ink } = await import('../../src/screen/renderer/screenInstance.tsx')
const { default: instances } = await import('../../src/screen/renderer/instances.ts')
const { Box, Text, useInput } = await import('../../src/screen/themedRenderer.ts')
const { AlternateScreen } = await import('../../src/screen/renderer/elements/AlternateScreen.tsx')
const { resolveAlternateScrollIntent } = await import('../../src/screen/renderer/termio/alternateScrollPolicy.ts')
type ParsedInput = import('../../src/screen/renderer/input/input-decoder.ts').ParsedInput

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok ? ` — to fix, change resolveAlternateScrollIntent in src/screen/renderer/termio/alternateScrollPolicy.ts (section 1) or registerArrowKeyOwner and arrowKeysOwned in src/screen/renderer/screenInstance.tsx (section 2)${detail ? `; got ${detail}` : ''}` : ''}`)
  if (!ok) failures = 1
}

const UP = '\u001b[A'
const DOWN = '\u001b[B'

{
  const arrows = [{ kind: 'key', name: 'up' }, { kind: 'key', name: 'down' }] as unknown as ParsedInput[]
  const windows = { altScreenActive: true, mouseTrackingEnabled: true, elevatedSurfaceActive: false, platform: 'win32', wheelReportingConfirmed: false, scrollableTranscript: true }
  const names = (state: Record<string, unknown>): string => resolveAlternateScrollIntent(arrows, state as never).map(atom => (atom.kind === 'key' ? atom.name : atom.kind)).join(',')
  t('§1 control: on Windows, no wheel report seen yet and nobody owning the arrows, a plain arrow is read as a wheel step', names(windows) === 'wheelup,wheeldown', names(windows))
  t('§1 with the arrows owned they stay arrows there', names({ ...windows, arrowKeysOwned: true }) === 'up,down', names({ ...windows, arrowKeysOwned: true }))
  const native = { altScreenActive: true, mouseTrackingEnabled: false, elevatedSurfaceActive: false, platform: 'linux' }
  t('§1 control: with mouse tracking off a plain arrow is read as a wheel step on every system', names(native) === 'wheelup,wheeldown', names(native))
  t('§1 with the arrows owned they stay arrows there too', names({ ...native, arrowKeysOwned: true }) === 'up,down', names({ ...native, arrowKeysOwned: true }))
}

class Screen extends EventEmitter {
  isTTY = true
  columns = 60
  rows = 10
  write(): boolean {
    return true
  }
}

class Keys extends Readable {
  isTTY = true
  isRaw = false
  constructor() {
    super({ read() {} })
  }
  setRawMode(raw: boolean): this {
    this.isRaw = raw
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
}

const settle = (ms = 80): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

{
  const heard: string[] = []
  function Listener(): React.ReactNode {
    useInput((_input, key) => {
      heard.push(key.upArrow ? 'up' : key.downArrow ? 'down' : key.wheelUp ? 'wheel up' : key.wheelDown ? 'wheel down' : 'other')
    })
    return h(Box, { width: 60, height: 10 }, h(Text, null, 'a pane'))
  }
  const keys = new Keys()
  const screen = new Screen()
  const ink = new Ink({ stdout: screen as never, stdin: keys as never, stderr: new Screen() as never, patchConsole: false, exitOnCtrlC: false })
  instances.set(screen as never, ink)
  ink.render(h(AlternateScreen, { mouseTracking: false }, h(Listener)))
  await settle(250)
  const type = async (bytes: string): Promise<string> => {
    heard.length = 0
    keys.push(bytes)
    await settle()
    return heard.join(',')
  }
  const free = await type(UP + DOWN)
  t('§2 control: mouse tracking off, nobody owns the arrows — the keys arrive as wheel steps', free === 'wheel up,wheel down', free)
  const owner = { up: true }
  const registry = ink as unknown as { registerArrowKeyOwner?: (owns: () => boolean) => () => void; arrowKeysOwned?: () => boolean }
  const release = registry.registerArrowKeyOwner?.(() => owner.up)
  const owned = await type(UP + DOWN)
  t('§2 an owner of the arrows is up: the same two keys arrive as arrows', owned === 'up,down' && registry.arrowKeysOwned?.() === true, owned)
  owner.up = false
  const lowered = await type(UP + DOWN)
  t('§2 the owner says it is down: wheel steps again', lowered === 'wheel up,wheel down' && registry.arrowKeysOwned?.() === false, lowered)
  owner.up = true
  release?.()
  const released = await type(UP + DOWN)
  t('§2 the owner is released: wheel steps again', released === 'wheel up,wheel down' && registry.arrowKeysOwned?.() === false, released)
  const exited = ink.waitUntilExit()
  ink.unmount()
  await exited
  instances.delete(screen as never)
}


console.log(failures === 0 ? 'ARROW KEYS OWNER: ALL PASS' : 'ARROW KEYS OWNER: RED')
process.exit(failures)
