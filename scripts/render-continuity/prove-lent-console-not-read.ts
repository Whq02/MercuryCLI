#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

const { default: Ink } = await import('../../src/ink/ink.tsx')
const { default: instances } = await import('../../src/ink/instances.ts')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

class Screen extends EventEmitter {
  isTTY = true
  columns = 80
  rows = 24
  write(): boolean {
    return true
  }
}

class Console extends Readable {
  isTTY = true
  isRaw = false
  calls: string[] = []
  cookedReadInFlight = false
  injectedEnters = 0
  _handle = {
    reading: false,
    readStart: (): number => {
      this.calls.push(`start ${this.isRaw ? 'raw' : 'cooked'}`)
      if (!this.isRaw) this.cookedReadInFlight = true
      return 0
    },
    readStop: (): number => {
      this.calls.push(`stop ${this.isRaw ? 'raw' : 'cooked'}`)
      this.endRead()
      return 0
    },
  }
  constructor() {
    super({ highWaterMark: 0 })
  }
  private endRead(): void {
    if (!this.cookedReadInFlight) return
    this.cookedReadInFlight = false
    this.injectedEnters++
  }
  override _read(): void {
    if (this._handle.reading) return
    this._handle.reading = true
    this._handle.readStart()
  }
  setRawMode(raw: boolean): this {
    const wasReading = this._handle.reading
    if (wasReading) this.endRead()
    this.isRaw = raw
    this.calls.push(`mode ${raw ? 'raw' : 'cooked'}`)
    if (wasReading && !raw) this.cookedReadInFlight = true
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))

async function lend(platform: NodeJS.Platform): Promise<{ during: { cooked: boolean; reading: boolean; calls: string[] }; after: { enters: number; calls: string[]; reading: boolean; raw: boolean; heard: string } }> {
  const keys = new Console()
  const screen = new Screen()
  const ink = new Ink({ stdout: screen as never, stdin: keys as never, stderr: new Screen() as never, patchConsole: false, exitOnCtrlC: false })
  instances.set(screen as never, ink)
  let heard = ''
  keys.setRawMode(true)
  keys.on('readable', () => {
    for (let chunk = keys.read(); chunk !== null; chunk = keys.read()) heard += String(chunk)
  })
  await tick()
  keys.calls.length = 0
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  let during: { cooked: boolean; reading: boolean; calls: string[] }
  try {
    ink.suspendStdin()
    during = { cooked: keys.cookedReadInFlight, reading: keys._handle.reading, calls: [...keys.calls] }
    keys.calls.length = 0
    ink.resumeStdin()
  } finally {
    Object.defineProperty(process, 'platform', real)
  }
  await tick()
  keys.push('abc')
  await tick()
  const after = { enters: keys.injectedEnters, calls: [...keys.calls], reading: keys._handle.reading, raw: keys.isRaw, heard }
  const exited = ink.waitUntilExit()
  ink.unmount()
  await exited
  instances.delete(screen as never)
  return { during, after }
}

const windows = await lend('win32')
t('§1 on Windows no cooked read of the console is in flight while it is lent', !windows.during.cooked && !windows.during.reading, JSON.stringify(windows.during))
t('§1 the read is stopped while the console is still raw, before the mode leaves it', windows.during.calls.join(' · ') === 'stop raw · mode cooked', windows.during.calls.join(' · '))
t('§1 the hand-back ends no read by an injected Enter', windows.after.enters === 0, `${windows.after.enters} injected`)
t('§1 the read starts again after raw mode is back, once', windows.after.calls.join(' · ') === 'mode raw · start raw' && windows.after.reading && windows.after.raw, windows.after.calls.join(' · '))
t('§1 the keys typed after the hand-back reach the reader', windows.after.heard === 'abc', JSON.stringify(windows.after.heard))

const elsewhere = await lend('darwin')
t('§2 off Windows the lend leaves the reader as it was: no stop, the mode alone moves', elsewhere.during.calls.join(' · ') === 'mode cooked' && elsewhere.during.reading && elsewhere.after.calls.join(' · ') === 'mode raw', `${elsewhere.during.calls.join(' · ')} | ${elsewhere.after.calls.join(' · ')}`)
t('§2 and the keys typed after the hand-back reach the reader', elsewhere.after.heard === 'abc', JSON.stringify(elsewhere.after.heard))

console.log(failures === 0 ? 'LENT CONSOLE: ALL PASS' : 'LENT CONSOLE: RED')
process.exit(failures)
