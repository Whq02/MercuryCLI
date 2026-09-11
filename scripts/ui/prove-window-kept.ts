#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADMITTED, check, childEnv, DIST, endLeg, FACE_READY, finish, joined, printFrame, productNode, requireCaptureDriver, ROOT, scratch, startLeg } from '../computer/computerDriveKit.ts'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.ts'

const argOf = (name: string): string | undefined => process.argv.slice(2).find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
const dist = argOf('--dist') ?? DIST
const node = argOf('--node') ?? productNode()
const buildLabel = argOf('--label') ?? 'this tree'
const sizeList = (argOf('--sizes') ?? '80x21,111x35,120x40').split(',').map(s => { const [c, r] = s.split('x').map(Number); return { cols: c!, rows: r! } })
const stage = argOf('--stage') === 'chat' ? 'chat' : 'card'
const poison = process.argv.includes('--poison')
const HOME_READY = stage === 'chat' ? ADMITTED : FACE_READY
const extraEnv: Record<string, string | undefined> = { MERCURY_DESKTOP_DRIVER: 'none' }
for (const pair of process.argv.slice(2).filter(a => a.startsWith('--env=')).map(a => a.slice(6))) {
  const eq = pair.indexOf('=')
  extraEnv[pair.slice(0, eq)] = pair.slice(eq + 1) === '' ? undefined : pair.slice(eq + 1)
}
const driver = requireCaptureDriver('window-kept')
const SHIFT_RIGHT = '\x1b[1;2C'
const SHIFT_LEFT = '\x1b[1;2D'
const TO_CONCOURSE = stage === 'chat' ? SHIFT_LEFT : SHIFT_RIGHT
const FROM_CONCOURSE = stage === 'chat' ? SHIFT_RIGHT : SHIFT_LEFT
const CONCOURSE_READY = 'coordinator'
const ERASE_SCREEN = '\x1b[2J'
const ERASE_SCROLLBACK = '\x1b[3J'
const ALT_ENTER = '\x1b[?1049h'
const ALT_LEAVE = '\x1b[?1049l'
const ALT47_ENTER = '\x1b[?47h'
const ALT47_LEAVE = '\x1b[?47l'

type Frame = { tick: number; bytes: Buffer }
type Mark = { label: string; atTick: number; cols: number; rows: number; grid: Array<Array<{ c: string }>> }
type Stage = { cols: number; rows: number; untilTick: number }
type Payload = { marks?: Mark[]; stages?: Stage[]; endReason?: string }
type WipeCounts = { erase: number; scrollback: number; altEnter: number; altLeave: number; fullRewrites: number; tallestRow: number; sync: number; ground: number; groundReset: number; hide: number; show: number; bytes: number }

function readTee(path: string): Frame[] {
  const tee = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
  const frames: Frame[] = []
  let off = 0
  while (off + 8 <= tee.length) {
    const tick = tee.readUInt32BE(off)
    const len = tee.readUInt32BE(off + 4)
    off += 8
    frames.push({ tick, bytes: tee.subarray(off, off + len) })
    off += len
  }
  return frames
}

const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1
const CONTROL_SEQUENCE = /\x1b\[[0-9;:?<>=]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]|[\r\n]/g

function textOffsetOf(bytes: string, needle: string): number {
  let text = ''
  const origin: number[] = []
  let last = 0
  for (const m of bytes.matchAll(CONTROL_SEQUENCE)) {
    for (let i = last; i < m.index!; i++) { origin.push(i); text += bytes[i] }
    last = m.index! + m[0].length
  }
  for (let i = last; i < bytes.length; i++) { origin.push(i); text += bytes[i] }
  const at = text.indexOf(needle)
  return at < 0 ? -1 : origin[at]!
}

function afterFirstPaintOf(bytes: string, needle: string): string | null {
  const textAt = textOffsetOf(bytes, needle)
  if (textAt < 0) return null
  const erase = bytes.lastIndexOf(ERASE_SCREEN, textAt)
  return bytes.slice((erase < 0 ? textAt : erase) + ERASE_SCREEN.length)
}

function fullRewritesIn(bytes: string, rows: number): number {
  let count = 0
  for (const chunk of bytes.split('\x1b[H').slice(1)) {
    const seen = new Set<number>([1])
    for (const m of chunk.matchAll(/\x1b\[(\d+)(?:;\d+)?H/g)) seen.add(Number(m[1]))
    for (const m of chunk.matchAll(/\x1b\[(\d+)d/g)) seen.add(Number(m[1]))
    if (seen.size >= Math.max(1, rows - 1)) count += 1
  }
  return count
}

function tallestRowIn(bytes: string): number {
  let tallest = 0
  for (const m of bytes.matchAll(/\x1b\[(\d+)(?:;\d+)?H/g)) tallest = Math.max(tallest, Number(m[1]))
  for (const m of bytes.matchAll(/\x1b\[(\d+)d/g)) tallest = Math.max(tallest, Number(m[1]))
  return tallest
}

function wipeCounts(bytes: string, rows: number): WipeCounts {
  return {
    erase: countOf(bytes, ERASE_SCREEN),
    scrollback: countOf(bytes, ERASE_SCROLLBACK),
    altEnter: countOf(bytes, ALT_ENTER) + countOf(bytes, ALT47_ENTER),
    altLeave: countOf(bytes, ALT_LEAVE) + countOf(bytes, ALT47_LEAVE),
    fullRewrites: fullRewritesIn(bytes, rows),
    tallestRow: tallestRowIn(bytes),
    sync: countOf(bytes, '\x1b[?2026h'),
    ground: countOf(bytes, '\x1b]11;'),
    groundReset: countOf(bytes, '\x1b]111'),
    hide: countOf(bytes, '\x1b[?25l'),
    show: countOf(bytes, '\x1b[?25h'),
    bytes: bytes.length,
  }
}

const bytesIn = (frames: Frame[], from: number, to: number): string =>
  Buffer.concat(frames.filter(f => f.tick >= from && f.tick < to).map(f => f.bytes)).toString('latin1')

const isWiped = (c: WipeCounts): boolean => c.erase + c.scrollback + c.altEnter + c.altLeave > 0
const describe = (c: WipeCounts): string => `2J=${c.erase} 3J=${c.scrollback} alt-enter=${c.altEnter} alt-leave=${c.altLeave} full-rewrites=${c.fullRewrites} tallest-row=${c.tallestRow} sync=${c.sync} ground=${c.ground}/${c.groundReset} hide/show=${c.hide}/${c.show} bytes=${c.bytes}`

type Journey = { size: { cols: number; rows: number }; resize: boolean }
const journeys: Journey[] = sizeList.map(size => ({ size, resize: size.cols >= 120 && size.rows >= 40 }))
const table: string[] = []
console.log(`window-kept artifacts: ${scratch} (build: ${buildLabel}, dist: ${dist})`)
for (const journey of journeys) {
  const { cols, rows } = journey.size
  const tag = `window-kept-${cols}x${rows}`
  const leg = await startLeg(tag, [{ kind: 'text', text: 'Finished.' }], null)
  const out = join(scratch, `${tag}.json`)
  const log = join(scratch, `${tag}-engine.log`)
  const tee = join(scratch, `${tag}.tee.bin`)
  const cfgPath = join(scratch, `${tag}-config.json`)
  const gate = { requireAwait: true, minTick: 3, awaitStableTicks: 5, awaitSettleTicks: 2 }
  const sends = [
    ...(stage === 'chat' ? [
      { ...gate, awaitText: FACE_READY, data: '\r', mark: 'face' },
      { ...gate, awaitText: ADMITTED, awaitSettleTicks: 4, data: TO_CONCOURSE, mark: 'card' },
    ] : [
      { ...gate, awaitText: FACE_READY, data: TO_CONCOURSE, mark: 'card' },
    ]),
    { ...gate, awaitText: CONCOURSE_READY, awaitStableTicks: 0, awaitSettleTicks: 6, data: FROM_CONCOURSE, mark: 'concourse' },
    { ...gate, awaitText: HOME_READY, data: '', mark: 'back' },
    ...(journey.resize ? [
      { ...gate, awaitText: HOME_READY, awaitStableTicks: 6, data: '', mark: 'small' },
      { ...gate, awaitText: HOME_READY, awaitStableTicks: 6, data: '', mark: 'large' },
    ] : []),
  ]
  const resizes = [
    ...(poison ? [{ afterMark: 'card', afterMs: 150, cols: cols - 1, rows }] : []),
    ...(journey.resize ? [
      { afterMark: 'back', afterMs: 400, cols: 80, rows: 24 },
      { afterMark: 'small', afterMs: 400, cols: 120, rows: 40 },
    ] : []),
  ]
  writeFileSync(cfgPath, JSON.stringify({ argv: [node, dist], cwd: ROOT, cols, rows, sends, resizes, total: 500, readyText: [HOME_READY], readySettleTicks: 2, out }))
  writeFileSync(log, '')
  writeFileSync(tee, '')
  try {
    const child = spawn(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { cwd: ROOT, env: childEnv(leg, { ...extraEnv, VSHOT_TEE: tee }), stdio: ['ignore', 'pipe', 'pipe'] })
    let engineOutput = ''
    child.stdout.on('data', chunk => { engineOutput += String(chunk) })
    child.stderr.on('data', chunk => { engineOutput += String(chunk) })
    const status = await new Promise<number | null>(resolve => {
      const wall = setTimeout(() => { engineOutput += '\ncapture deadline exceeded\n'; child.kill('SIGKILL') }, vshotBudgetMs(150_000))
      child.once('error', error => { engineOutput += `\n${String(error)}\n` })
      child.once('close', code => { clearTimeout(wall); resolve(code) })
    })
    writeFileSync(log, engineOutput)
    check(`${tag}: the journey ran as written (engine exit 0)`, status === 0, `exit=${status}; engine output: ${log}`)
    if (status !== 0) { console.error(engineOutput.slice(-1500)); continue }
    const payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
    const marks = new Map((payload.marks ?? []).map(mark => [mark.label, mark]))
    const stages = payload.stages ?? []
    const labels = ['card', 'concourse', 'back', ...(journey.resize ? ['small', 'large'] : [])]
    check(`${tag}: every mark exists`, labels.every(label => marks.has(label)), `missing: ${labels.filter(label => !marks.has(label)).join(', ')}`)
    if (!labels.every(label => marks.has(label))) continue
    const rowsAt = (label: string): string[] => (marks.get(label)?.grid ?? []).map(row => row.map(c => c.c).join('').trimEnd())
    for (const label of labels) printFrame(`${tag} ${label} (${marks.get(label)!.cols}x${marks.get(label)!.rows})`, rowsAt(label))
    check(`${tag}: the ${stage} is up at the card mark`, joined(rowsAt('card')).includes(HOME_READY))
    check(`${tag}: the Concourse is up at the concourse mark`, joined(rowsAt('concourse')).includes(CONCOURSE_READY) && !joined(rowsAt('concourse')).includes(HOME_READY))
    check(`${tag}: the ${stage} is back at the back mark`, joined(rowsAt('back')).includes(HOME_READY) && !joined(rowsAt('back')).includes(CONCOURSE_READY))
    const frames = readTee(tee)
    check(`${tag}: the tee recorded the pty bytes`, frames.length > 0, tee)
    const cardTick = marks.get('card')!.atTick
    const beforeCard = bytesIn(frames, 0, cardTick)
    const cardNeedle = Buffer.from(FACE_READY, 'utf8').toString('latin1')
    const afterFirstPaint = afterFirstPaintOf(beforeCard, cardNeedle)
    check(`${tag}: the boot card's first paint is in the tee`, afterFirstPaint !== null)
    const windows: Array<{ event: string; bytes: string; rows: number }> = [
      { event: 'splash to card (after the card first paints)', bytes: afterFirstPaint ?? beforeCard, rows },
      { event: 'shift-right into the Concourse', bytes: bytesIn(frames, cardTick, marks.get('concourse')!.atTick), rows },
      { event: 'shift-left back to the card', bytes: bytesIn(frames, marks.get('concourse')!.atTick, marks.get('back')!.atTick), rows },
    ]
    if (journey.resize) {
      const settled = poison ? stages.slice(1) : stages
      check(`${tag}: both resizes were applied`, settled.length === 2, `${settled.length} stages`)
      const small = marks.get('small')!
      const large = marks.get('large')!
      const first = settled[0]
      const second = settled[1]
      if (first !== undefined && second !== undefined) {
        check(`${tag}: the marks after each resize came after the resize`, first.untilTick < small.atTick && second.untilTick < large.atTick && small.atTick <= second.untilTick, `stages ${first.untilTick},${second.untilTick} marks ${small.atTick},${large.atTick}`)
        check(`${tag}: the small mark is at 80x24 and the large mark at 120x40`, small.cols === 80 && small.rows === 24 && large.cols === 120 && large.rows === 40)
        windows.push({ event: 'resize 120x40 to 80x24', bytes: bytesIn(frames, first.untilTick, small.atTick), rows: 24 })
        windows.push({ event: 'resize 80x24 to 120x40', bytes: bytesIn(frames, second.untilTick, large.atTick), rows: 40 })
      }
    }
    const splashCounts = wipeCounts(beforeCard.slice(0, beforeCard.length - (afterFirstPaint ?? '').length), rows)
    table.push(`${buildLabel} · ${cols}x${rows} · before the card's first paint (the splash and the takeover, informational): ${describe(splashCounts)}`)
    for (const window of windows) {
      const counts = wipeCounts(window.bytes, window.rows)
      table.push(`${buildLabel} · ${cols}x${rows} · ${window.event}: ${describe(counts)}`)
      const resizeWindow = window.event.startsWith('resize')
      check(`${tag} ${window.event}: no frame addresses a row below the terminal's last row (${window.rows})`, counts.tallestRow <= window.rows, describe(counts))
      if (resizeWindow) {
        check(`${tag} ${window.event}: exactly one contained erase, no scrollback erase, no alternate-screen switch`, counts.erase === 1 && counts.scrollback === 0 && counts.altEnter === 0 && counts.altLeave === 0, describe(counts))
      } else {
        check(`${tag} ${window.event}: the window is kept (no erase, no alternate-screen switch)`, !isWiped(counts), describe(counts))
      }
    }
  } finally {
    await endLeg(leg)
  }
}
console.log('\nwipe counts per event:')
for (const line of table) console.log(`  ${line}`)
finish('window-kept')
