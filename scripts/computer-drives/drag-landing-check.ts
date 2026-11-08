#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const FINDER = 'com.apple.Finder'
const DISTANCES = [110, 314]
const GRIP_BELOW_TOP = 5
const TITLE_BAR = 28
const TOLERANCE = 1

if (process.platform !== 'darwin' || !process.argv.includes('--live')) {
  console.log('SKIP: pass --live on macOS, on an idle screen with a Finder window open, to drag it by its title bar and read where it lands')
  process.exit(0)
}
const home = mkdtempSync(join(tmpdir(), 'drag-landing-'))
process.env.MERCURY_CONFIG_DIR = home
process.on('exit', () => {
  try {
    removeScratch(home)
  } catch {
  }
})
if (process.env.MERCURY_DESKTOP_DRIVER !== 'fake') delete process.env.MERCURY_DESKTOP_DRIVER
const { resolveDesktopDriver } = await import('../../src/services/desktop/resolveDriver.ts')
const { resolveDesktopPackDir } = await import('../../src/services/desktop/pack.ts')
type DesktopBounds = import('../../src/services/desktop/driver.ts').DesktopBounds

function cannot(words: string): never {
  console.log(`CANNOT RUN: ${words}`)
  process.exit(2)
}
const round = (n: number): number => Math.round(n * 100) / 100
const point = (x: number, y: number): string => `(${round(x)}, ${round(y)}) pt`
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const sameFrame = (a: DesktopBounds, b: DesktopBounds): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

const resolved = resolveDesktopDriver()
if (resolved.state !== 'ok') cannot(resolved.note)
const driver = resolved.driver
const facts = driver.describe()
const pack = facts.kind === 'native' ? resolveDesktopPackDir() : null
console.log(`driver: ${facts.kind} ${facts.version} ${facts.platform} (${facts.source})${pack?.state === 'ok' ? ` · pack ${pack.dir} · addon sha256 ${pack.manifest.addonSha256.slice(0, 16)}…` : ''}`)
const permissions = await driver.permissions()
if (!permissions.ok) cannot(permissions.error.note)
if (permissions.value.session !== 'desktop' || permissions.value.input !== 'granted') cannot(`the driver cannot act here: session ${permissions.value.session}, input ${permissions.value.input}${permissions.value.reason ? ` — ${permissions.value.reason}` : ''}`)

async function finderFrame(): Promise<DesktopBounds> {
  let front = await driver.frontmostApplication()
  if (!front.ok || front.value.identity !== FINDER) {
    execFileSync('/usr/bin/osascript', ['-e', 'tell application "Finder" to activate'], { timeout: 10_000 })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      await pause(150)
      front = await driver.frontmostApplication()
      if (front.ok && front.value.identity === FINDER) break
    }
  }
  if (!front.ok) cannot(front.error.note)
  if (front.value.identity !== FINDER) cannot(`${front.value.name} is in front, not Finder — bring a Finder window to the front`)
  if (front.value.bounds === null) cannot('Finder is in front without a window frame — open a Finder window')
  return front.value.bounds
}

async function settledFrame(): Promise<DesktopBounds> {
  let last: DesktopBounds | null = null
  for (let read = 0; read < 10; read++) {
    await pause(read === 0 ? 250 : 150)
    const front = await driver.frontmostApplication()
    if (!front.ok) cannot(front.error.note)
    if (front.value.identity !== FINDER) cannot(`${front.value.name} came to the front during the check`)
    if (front.value.bounds === null) cannot('the Finder window lost its frame during the check')
    if (last !== null && sameFrame(last, front.value.bounds)) return front.value.bounds
    last = front.value.bounds
  }
  return last ?? cannot('the Finder window never answered a frame')
}

async function dragBy(label: string, before: DesktopBounds, dy: number): Promise<{ frame: DesktopBounds; pass: boolean }> {
  const from = { x: before.x + before.width / 2, y: before.y + GRIP_BELOW_TOP }
  const to = { x: from.x, y: from.y + dy }
  const receipt = await driver.drag(from, to, 'left', new AbortController().signal)
  if (!receipt.ok) cannot(`drag refused: ${receipt.error.note}`)
  const frame = await settledFrame()
  const cursor = await driver.cursor()
  const moved = (frame.y - before.y) * Math.sign(dy)
  const pass = Math.abs(moved - Math.abs(dy)) <= TOLERANCE && Math.abs(frame.x - before.x) <= TOLERANCE
  const drift = frame.x === before.x ? '' : ` · x ${round(before.x)} → ${round(frame.x)}`
  const pointer = cursor.ok ? ` · cursor ${point(cursor.value.x, cursor.value.y)}` : ''
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}: ${point(from.x, from.y)} → ${point(to.x, to.y)} · window y ${round(before.y)} → ${round(frame.y)}${drift} · moved ${round(moved)} of ${Math.abs(dy)} pt${pointer}`)
  return { frame, pass }
}

const displays = await driver.displays()
if (!displays.ok) cannot(displays.error.note)
let frame = await finderFrame()
const grip = { x: frame.x + frame.width / 2, y: frame.y + GRIP_BELOW_TOP }
const display = displays.value.displays.find(d => grip.x >= d.originX && grip.x < d.originX + d.width && grip.y >= d.originY && grip.y < d.originY + d.height)
if (display === undefined) cannot(`the title bar's grip ${point(grip.x, grip.y)} is on no display`)
console.log(`display ${display.index}: ${display.width}×${display.height} pt at (${display.originX}, ${display.originY}) · scale ${display.scale}`)
console.log(`Finder window: ${round(frame.width)}×${round(frame.height)} pt at ${point(frame.x, frame.y)} · grip ${point(grip.x, grip.y)} (${GRIP_BELOW_TOP} pt below the top edge)`)
const room = display.originY + display.height - TITLE_BAR
const farthest = frame.y + GRIP_BELOW_TOP + Math.max(...DISTANCES)
if (farthest > room) cannot(`the title bar would leave the display: y ${round(frame.y)} + ${Math.max(...DISTANCES)} pt reaches ${round(farthest)}, past ${round(room)} — move the Finder window up first`)

let passed = 0
let drags = 0
for (const distance of DISTANCES) {
  for (const dy of [distance, -distance]) {
    drags++
    const result = await dragBy(`drag ${drags} (${dy > 0 ? 'down' : 'back up'} ${Math.abs(dy)} pt)`, frame, dy)
    frame = result.frame
    if (result.pass) passed++
  }
}
const held = await driver.held()
if (held.ok && held.value.buttons.length > 0) {
  await driver.releaseAll()
  console.log(`[FAIL] a button stayed held after the drags: ${held.value.buttons.join(', ')} — released`)
}
const clean = held.ok && held.value.buttons.length === 0
const rehearsal = facts.kind === 'fake' ? ' (the fake driver: a rehearsal of the check, not a reading)' : ''
console.log(`\ndrag landing (${display.scale}x): ${passed} of ${drags} drags landed within ±${TOLERANCE} pt — ${passed === drags && clean ? 'PASS' : 'FAIL'}${rehearsal}`)
process.exit(passed === drags && clean ? 0 : 1)
