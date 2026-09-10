import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { ansiToPng } from '../../utils/ansiToPng.js'
import {
  desktopAbortedAnswer,
  displaysFingerprint,
  isDesktopKey,
  type DesktopActReceipt,
  type DesktopAnswer,
  type DesktopApplication,
  type DesktopBounds,
  type DesktopButton,
  type DesktopCapture,
  type DesktopCursor,
  type DesktopDisplay,
  type DesktopDisplays,
  type DesktopDriver,
  type DesktopDriverFacts,
  type DesktopError,
  type DesktopGrant,
  type DesktopHeld,
  type DesktopModifier,
  type DesktopPermissions,
  type DesktopPoint,
  type DesktopSessionKind,
  type DesktopTypeOptions,
} from './driver.js'

export interface FakeSceneSwitch {
  afterActs: number
  frontmost: DesktopApplication
}

export interface FakeScene {
  displays: DesktopDisplay[]
  frontmost: DesktopApplication
  cursor: DesktopPoint
  lines: string[]
  switches: FakeSceneSwitch[]
  holdMs: number
  ownTerminal: DesktopApplication | null
  permissions: DesktopPermissions
}

export const FAKE_DRIVER_VERSION = 'fixture'

export const FAKE_SCENE_DEFAULT: FakeScene = {
  displays: [{ index: 0, id: 'fixture-1', originX: 0, originY: 0, width: 1440, height: 900, scale: 2, primary: true }],
  frontmost: { identity: 'com.example.TextEdit', name: 'TextEdit', pid: 4200, title: 'Untitled', bounds: { x: 100, y: 100, width: 800, height: 600 } },
  cursor: { x: 720, y: 450 },
  lines: ['Untitled — TextEdit', 'The quick brown fox jumps over the lazy dog.', 'A second line of the document.'],
  switches: [],
  holdMs: 0,
  ownTerminal: { identity: 'com.example.Terminal', name: 'Terminal', pid: 4100, title: 'mercury', bounds: { x: 0, y: 700, width: 1440, height: 200 } },
  permissions: { session: 'desktop', screenCapture: 'granted', input: 'granted', reason: null },
}

export type FakeActKind =
  | 'capture'
  | 'mouseMove'
  | 'mouseDown'
  | 'mouseUp'
  | 'click'
  | 'drag'
  | 'scroll'
  | 'keyTap'
  | 'keyDown'
  | 'keyUp'
  | 'typeText'
  | 'releaseAll'

export type FakeActOutcome = 'done' | 'aborted'

export interface FakeAct {
  act: FakeActKind
  at: number
  outcome: FakeActOutcome
  detail: Record<string, unknown>
}

export type FakeSceneRead = { state: 'ok'; scene: FakeScene } | { state: 'unavailable'; note: string }

export type FakeDesktopDriverResolution = { state: 'ok'; driver: FakeDesktopDriver } | { state: 'unavailable'; note: string }

const SESSION_KINDS: readonly DesktopSessionKind[] = ['desktop', 'no-display', 'wayland', 'locked', 'service', 'unknown']
const GRANTS: readonly DesktopGrant[] = ['granted', 'denied', 'not-required', 'unknown']
const BUTTONS: readonly DesktopButton[] = ['left', 'right', 'middle']
const MODIFIERS: readonly DesktopModifier[] = ['shift', 'control', 'alt', 'super']
const SCENE_ACTS: ReadonlySet<FakeActKind> = new Set(['mouseMove', 'mouseDown', 'mouseUp', 'click', 'drag', 'scroll', 'keyTap', 'keyDown', 'keyUp', 'typeText'])
const GRANT_REMEDY = 'the fake driver reads its grants from the scene: set permissions.screenCapture and permissions.input to granted and permissions.session to desktop'
const CANVAS_BACKGROUND = Buffer.from([30, 30, 30, 255])
const TYPE_GAP_DEFAULT_MS = 4

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isText = (value: unknown): value is string => typeof value === 'string'

function boundsProblem(value: unknown, at: string): string | null {
  if (value === null) return null
  if (!isRecord(value)) return `${at} must be null or a record with x, y, width and height`
  for (const field of ['x', 'y', 'width', 'height']) {
    if (!finiteNumber(value[field])) return `${at}.${field} must be a finite number`
  }
  return null
}

function applicationProblem(value: unknown, at: string): string | null {
  if (!isRecord(value)) return `${at} must be a record with identity, name, pid, title and bounds`
  if (!isText(value.identity) || value.identity === '') return `${at}.identity must be a non-empty string`
  if (!isText(value.name) || value.name === '') return `${at}.name must be a non-empty string`
  if (!(value.pid === null || value.pid === undefined || finiteNumber(value.pid))) return `${at}.pid must be a number or null`
  if (!(value.title === null || value.title === undefined || isText(value.title))) return `${at}.title must be a string or null`
  return boundsProblem(value.bounds ?? null, `${at}.bounds`)
}

function displayProblem(value: unknown, at: string, position: number): string | null {
  if (!isRecord(value)) return `${at} must be a display record`
  if (value.index !== position) return `${at}.index must be ${position} (the position in the list)`
  if (!isText(value.id) || value.id === '') return `${at}.id must be a non-empty string`
  for (const field of ['originX', 'originY']) {
    if (!finiteNumber(value[field])) return `${at}.${field} must be a finite number`
  }
  for (const field of ['width', 'height', 'scale']) {
    const number = value[field]
    if (!finiteNumber(number) || number <= 0) return `${at}.${field} must be a positive number`
  }
  if (typeof value.primary !== 'boolean') return `${at}.primary must be true or false`
  return null
}

export function fakeSceneProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'the scene must be a JSON object'
  if (value.displays !== undefined) {
    if (!Array.isArray(value.displays) || value.displays.length === 0) return 'displays must be a non-empty list'
    for (let i = 0; i < value.displays.length; i++) {
      const problem = displayProblem(value.displays[i], `displays[${i}]`, i)
      if (problem !== null) return problem
    }
  }
  if (value.frontmost !== undefined) {
    const problem = applicationProblem(value.frontmost, 'frontmost')
    if (problem !== null) return problem
  }
  if (value.cursor !== undefined) {
    if (!isRecord(value.cursor) || !finiteNumber(value.cursor.x) || !finiteNumber(value.cursor.y)) return 'cursor must be a record with finite x and y'
  }
  if (value.lines !== undefined) {
    if (!Array.isArray(value.lines) || !value.lines.every(isText)) return 'lines must be a list of strings'
  }
  if (value.switches !== undefined) {
    if (!Array.isArray(value.switches)) return 'switches must be a list'
    for (let i = 0; i < value.switches.length; i++) {
      const entry: unknown = value.switches[i]
      if (!isRecord(entry)) return `switches[${i}] must be a record with afterActs and frontmost`
      if (!finiteNumber(entry.afterActs) || entry.afterActs < 0 || !Number.isInteger(entry.afterActs)) return `switches[${i}].afterActs must be a whole number`
      const problem = applicationProblem(entry.frontmost, `switches[${i}].frontmost`)
      if (problem !== null) return problem
    }
  }
  if (value.holdMs !== undefined) {
    if (!finiteNumber(value.holdMs) || value.holdMs < 0) return 'holdMs must be a number of milliseconds, zero or more'
  }
  if (value.ownTerminal !== undefined && value.ownTerminal !== null) {
    const problem = applicationProblem(value.ownTerminal, 'ownTerminal')
    if (problem !== null) return problem
  }
  if (value.permissions !== undefined) {
    const permissions = value.permissions
    if (!isRecord(permissions)) return 'permissions must be a record with session, screenCapture, input and reason'
    if (!isText(permissions.session) || !(SESSION_KINDS as readonly string[]).includes(permissions.session)) return `permissions.session must be one of ${SESSION_KINDS.join(', ')}`
    for (const field of ['screenCapture', 'input']) {
      const grant = permissions[field]
      if (!isText(grant) || !(GRANTS as readonly string[]).includes(grant)) return `permissions.${field} must be one of ${GRANTS.join(', ')}`
    }
    if (!(permissions.reason === null || permissions.reason === undefined || isText(permissions.reason))) return 'permissions.reason must be a string or null'
  }
  return null
}

function applicationFrom(value: Record<string, unknown>): DesktopApplication {
  const bounds = value.bounds
  return {
    identity: value.identity as string,
    name: value.name as string,
    pid: finiteNumber(value.pid) ? value.pid : null,
    title: isText(value.title) ? value.title : null,
    bounds: isRecord(bounds) ? { x: bounds.x as number, y: bounds.y as number, width: bounds.width as number, height: bounds.height as number } : null,
  }
}

function sceneFrom(value: Record<string, unknown>): FakeScene {
  const base = structuredClone(FAKE_SCENE_DEFAULT)
  if (Array.isArray(value.displays)) {
    base.displays = (value.displays as Array<Record<string, unknown>>).map(d => ({
      index: d.index as number,
      id: d.id as string,
      originX: d.originX as number,
      originY: d.originY as number,
      width: d.width as number,
      height: d.height as number,
      scale: d.scale as number,
      primary: d.primary as boolean,
    }))
  }
  if (isRecord(value.frontmost)) base.frontmost = applicationFrom(value.frontmost)
  if (isRecord(value.cursor)) base.cursor = { x: value.cursor.x as number, y: value.cursor.y as number }
  if (Array.isArray(value.lines)) base.lines = [...(value.lines as string[])]
  if (Array.isArray(value.switches)) {
    base.switches = (value.switches as Array<Record<string, unknown>>).map(s => ({ afterActs: s.afterActs as number, frontmost: applicationFrom(s.frontmost as Record<string, unknown>) }))
  }
  if (finiteNumber(value.holdMs)) base.holdMs = value.holdMs
  if (value.ownTerminal === null) base.ownTerminal = null
  else if (isRecord(value.ownTerminal)) base.ownTerminal = applicationFrom(value.ownTerminal)
  if (isRecord(value.permissions)) {
    base.permissions = {
      session: value.permissions.session as DesktopSessionKind,
      screenCapture: value.permissions.screenCapture as DesktopGrant,
      input: value.permissions.input as DesktopGrant,
      reason: isText(value.permissions.reason) ? value.permissions.reason : null,
    }
  }
  return base
}

export function readFakeScene(path: string): FakeSceneRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { state: 'unavailable', note: `the scene file ${path} cannot be read (${(error as Error).message})` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { state: 'unavailable', note: `the scene file ${path} is not JSON (${(error as Error).message})` }
  }
  const problem = fakeSceneProblem(parsed)
  if (problem !== null) return { state: 'unavailable', note: `the scene file ${path} is malformed: ${problem}` }
  return { state: 'ok', scene: sceneFrom(parsed as Record<string, unknown>) }
}

export function readFakeActLog(path: string): FakeAct[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as FakeAct)
}

export function fakeDesktopDriverFromEnvironment(): FakeDesktopDriverResolution {
  const scenePath = (flagEnv('MERCURY_DESKTOP_FAKE_SCENE') ?? '').trim()
  const logPath = (flagEnv('MERCURY_DESKTOP_FAKE_LOG') ?? '').trim()
  const log = logPath === '' ? null : logPath
  if (scenePath === '') return { state: 'ok', driver: new FakeDesktopDriver(FAKE_SCENE_DEFAULT, log) }
  const read = readFakeScene(scenePath)
  if (read.state === 'unavailable') return { state: 'unavailable', note: `MERCURY_DESKTOP_FAKE_SCENE: ${read.note}` }
  return { state: 'ok', driver: new FakeDesktopDriver(read.scene, log) }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = (CRC_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(type, 4, 'ascii')
  chunk.set(data, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length)
  return chunk
}

function encodePng(pixels: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc(height * (1 + stride))
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride)
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 1 })), pngChunk('IEND', new Uint8Array(0))])
}

export function pngDimensions(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

interface DecodedPng {
  width: number
  height: number
  pixels: Buffer
}

function decodePng(png: Buffer): DecodedPng {
  const size = pngDimensions(png)
  if (size === null) throw new Error('the glyph image is not a PNG')
  const parts: Buffer[] = []
  let offset = 8
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') parts.push(png.subarray(offset + 8, offset + 8 + length))
    if (type === 'IEND') break
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(parts))
  const stride = size.width * 4
  const pixels = Buffer.alloc(size.width * size.height * 4)
  for (let y = 0; y < size.height; y++) {
    const row = y * (1 + stride)
    if (raw[row] !== 0) throw new Error('the glyph image uses a row filter the fake driver does not read')
    raw.copy(pixels, y * stride, row + 1, row + 1 + stride)
  }
  return { width: size.width, height: size.height, pixels }
}

function composeCapture(text: string, width: number, height: number, scale: number): Buffer {
  const glyphs = decodePng(ansiToPng(text, { scale: Math.max(1, Math.round(scale)) }))
  const canvas = Buffer.alloc(width * height * 4)
  canvas.fill(CANVAS_BACKGROUND)
  const rows = Math.min(glyphs.height, height)
  const rowBytes = Math.min(glyphs.width, width) * 4
  for (let y = 0; y < rows; y++) glyphs.pixels.copy(canvas, y * width * 4, y * glyphs.width * 4, y * glyphs.width * 4 + rowBytes)
  return encodePng(canvas, width, height)
}

const answer = <T>(value: T): DesktopAnswer<T> => ({ ok: true, value })
const refusal = <T>(error: DesktopError): DesktopAnswer<T> => ({ ok: false, error })
const inputError = (note: string): DesktopError => ({ kind: 'input', note })
const grantHolds = (grant: DesktopGrant): boolean => grant === 'granted' || grant === 'not-required'
const inside = (point: DesktopPoint, bounds: DesktopBounds): boolean =>
  point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height
const pointError = (point: DesktopPoint): DesktopError | null =>
  isRecord(point) && finiteNumber(point.x) && finiteNumber(point.y) ? null : inputError(`a point needs finite x and y, not ${JSON.stringify(point)}`)
const buttonError = (button: DesktopButton): DesktopError | null => (BUTTONS.includes(button) ? null : inputError(`no such button: ${String(button)}`))
const keyError = (key: string): DesktopError | null => (isDesktopKey(key) ? null : inputError(`no such key: ${key}`))

export class FakeDesktopDriver implements DesktopDriver {
  readonly kind = 'fake' as const
  readonly acts: FakeAct[] = []
  private readonly scene: FakeScene
  private readonly logPath: string | null
  private cursorAt: DesktopPoint
  private sceneActs = 0
  private captures = 0
  private heldButtons: DesktopButton[] = []
  private heldKeys: string[] = []
  private closed = false

  constructor(scene: FakeScene, log: string | null) {
    this.scene = structuredClone(scene)
    this.logPath = log
    this.cursorAt = { ...this.scene.cursor }
  }

  describe(): DesktopDriverFacts {
    return { kind: 'fake', version: FAKE_DRIVER_VERSION, platform: `${process.platform}-${process.arch}`, source: 'fake' }
  }

  async permissions(): Promise<DesktopAnswer<DesktopPermissions>> {
    return answer({ ...this.scene.permissions })
  }

  async requestPermissions(): Promise<DesktopAnswer<DesktopPermissions>> {
    return answer({ ...this.scene.permissions })
  }

  async displays(): Promise<DesktopAnswer<DesktopDisplays>> {
    const displays = this.scene.displays.map(d => ({ ...d }))
    return answer({ displays, fingerprint: displaysFingerprint(displays) })
  }

  async capture(display: number, signal: AbortSignal): Promise<DesktopAnswer<DesktopCapture>> {
    if (this.closed) return refusal({ kind: 'unavailable', note: 'the fake desktop driver is closed' })
    const permissions = this.scene.permissions
    if (permissions.session !== 'desktop') return refusal({ kind: 'session', note: permissions.reason ?? `the session is ${permissions.session}, not a desktop` })
    if (!grantHolds(permissions.screenCapture)) return refusal({ kind: 'permission', note: `screen capture is not granted — ${permissions.reason ?? permissions.screenCapture}`, remedy: GRANT_REMEDY })
    const record = Number.isInteger(display) ? this.scene.displays[display] : undefined
    if (record === undefined) return refusal({ kind: 'display', note: `no display ${display} — the scene has ${this.scene.displays.length}` })
    if ((await this.hold(signal)) === 'aborted') {
      this.record('capture', 'aborted', { display })
      return desktopAbortedAnswer()
    }
    const width = Math.round(record.width * record.scale)
    const height = Math.round(record.height * record.scale)
    let png: Buffer
    try {
      png = composeCapture([...this.scene.lines, `acts ${this.sceneActs} · captures ${this.captures}`].join('\n'), width, height, record.scale)
    } catch (error) {
      return refusal({ kind: 'defect', note: `the fake driver could not paint the capture: ${(error as Error).message}` })
    }
    this.captures += 1
    const size = pngDimensions(png) ?? { width, height }
    this.record('capture', 'done', { display, width: size.width, height: size.height })
    return answer({
      png,
      width: size.width,
      height: size.height,
      scale: record.scale,
      display: record.index,
      displayId: record.id,
      originX: record.originX,
      originY: record.originY,
      capturedAt: Date.now(),
    })
  }

  async frontmostApplication(): Promise<DesktopAnswer<DesktopApplication>> {
    let current = this.scene.frontmost
    for (const s of this.scene.switches) if (s.afterActs <= this.sceneActs) current = s.frontmost
    return answer({ ...current, bounds: current.bounds ? { ...current.bounds } : null })
  }

  async ownTerminalApplication(): Promise<DesktopAnswer<DesktopApplication | null>> {
    const terminal = this.scene.ownTerminal
    return answer(terminal ? { ...terminal, bounds: terminal.bounds ? { ...terminal.bounds } : null } : null)
  }

  async cursor(): Promise<DesktopAnswer<DesktopCursor>> {
    return answer({ x: this.cursorAt.x, y: this.cursorAt.y, display: this.displayAt(this.cursorAt) })
  }

  async mouseMove(to: DesktopPoint, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    const problem = pointError(to)
    if (problem !== null) return refusal(problem)
    return this.act('mouseMove', { to: { ...to } }, signal, () => {
      this.cursorAt = { ...to }
      return { act: 'move', at: { ...to }, completedAt: Date.now() }
    })
  }

  async mouseDown(button: DesktopButton, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    const problem = buttonError(button)
    if (problem !== null) return refusal(problem)
    return this.act('mouseDown', { button }, signal, () => {
      if (!this.heldButtons.includes(button)) this.heldButtons.push(button)
      return { act: 'down', at: { ...this.cursorAt }, completedAt: Date.now() }
    })
  }

  async mouseUp(button: DesktopButton, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    const problem = buttonError(button)
    if (problem !== null) return refusal(problem)
    return this.act('mouseUp', { button }, signal, () => {
      this.heldButtons = this.heldButtons.filter(b => b !== button)
      return { act: 'up', at: { ...this.cursorAt }, completedAt: Date.now() }
    })
  }

  async click(at: DesktopPoint, button: DesktopButton, count: 1 | 2 | 3, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    const problem = pointError(at) ?? buttonError(button)
    if (problem !== null) return refusal(problem)
    if (count !== 1 && count !== 2 && count !== 3) return refusal(inputError(`a click count is 1, 2 or 3, not ${String(count)}`))
    return this.act('click', { at: { ...at }, button, count }, signal, () => {
      this.cursorAt = { ...at }
      return { act: 'click', at: { ...at }, completedAt: Date.now() }
    })
  }

  async drag(from: DesktopPoint, to: DesktopPoint, button: DesktopButton, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    const problem = pointError(from) ?? pointError(to) ?? buttonError(button)
    if (problem !== null) return refusal(problem)
    const gate = this.actGate()
    if (gate !== null) return refusal(gate)
    this.cursorAt = { ...from }
    if (!this.heldButtons.includes(button)) this.heldButtons.push(button)
    const outcome = await this.hold(signal)
    this.heldButtons = this.heldButtons.filter(b => b !== button)
    if (outcome === 'aborted') {
      this.record('drag', 'aborted', { from: { ...from }, to: { ...to }, button })
      return desktopAbortedAnswer()
    }
    this.cursorAt = { ...to }
    this.sceneActs += 1
    this.record('drag', 'done', { from: { ...from }, to: { ...to }, button })
    const receipt: DesktopActReceipt = { act: 'drag', at: { ...to }, completedAt: Date.now() }
    return answer(receipt)
  }

  async scroll(at: DesktopPoint, deltaX: number, deltaY: number, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    const problem = pointError(at)
    if (problem !== null) return refusal(problem)
    if (!finiteNumber(deltaX) || !finiteNumber(deltaY)) return refusal(inputError(`scroll deltas must be finite numbers, not ${String(deltaX)}, ${String(deltaY)}`))
    return this.act('scroll', { at: { ...at }, deltaX, deltaY }, signal, () => {
      this.cursorAt = { ...at }
      return { act: 'scroll', at: { ...at }, completedAt: Date.now() }
    })
  }

  async keyTap(key: string, modifiers: DesktopModifier[], signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    const problem = keyError(key)
    if (problem !== null) return refusal(problem)
    for (const modifier of modifiers) if (!MODIFIERS.includes(modifier)) return refusal(inputError(`no such modifier: ${String(modifier)}`))
    return this.act('keyTap', { key, modifiers: [...modifiers] }, signal, () => ({ act: 'keyTap', at: null, completedAt: Date.now() }))
  }

  async keyDown(key: string, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    const problem = keyError(key)
    if (problem !== null) return refusal(problem)
    return this.act('keyDown', { key }, signal, () => {
      if (!this.heldKeys.includes(key)) this.heldKeys.push(key)
      return { act: 'keyDown', at: null, completedAt: Date.now() }
    })
  }

  async keyUp(key: string, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    const problem = keyError(key)
    if (problem !== null) return refusal(problem)
    return this.act('keyUp', { key }, signal, () => {
      this.heldKeys = this.heldKeys.filter(k => k !== key)
      return { act: 'keyUp', at: null, completedAt: Date.now() }
    })
  }

  async typeText(text: string, options: DesktopTypeOptions, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    if (!isText(text)) return refusal(inputError('the text to type must be a string'))
    if (text === '') {
      const receipt: DesktopActReceipt = { act: 'type', at: null, completedAt: Date.now() }
      return answer(receipt)
    }
    const gapMs = options.gapMs ?? TYPE_GAP_DEFAULT_MS
    return this.act('typeText', { text, gapMs }, signal, () => ({ act: 'type', at: null, completedAt: Date.now() }))
  }

  async held(): Promise<DesktopAnswer<DesktopHeld>> {
    return answer({ buttons: [...this.heldButtons], keys: [...this.heldKeys] })
  }

  async releaseAll(): Promise<DesktopAnswer<DesktopHeld>> {
    const released: DesktopHeld = { buttons: [...this.heldButtons].reverse(), keys: [...this.heldKeys].reverse() }
    this.heldButtons = []
    this.heldKeys = []
    this.record('releaseAll', 'done', { buttons: [...released.buttons], keys: [...released.keys] })
    return answer(released)
  }

  async close(): Promise<void> {
    await this.releaseAll()
    this.closed = true
  }

  private displayAt(point: DesktopPoint): number | null {
    for (const d of this.scene.displays) {
      if (inside(point, { x: d.originX, y: d.originY, width: d.width, height: d.height })) return d.index
    }
    return null
  }

  private actGate(): DesktopError | null {
    if (this.closed) return { kind: 'unavailable', note: 'the fake desktop driver is closed' }
    const permissions = this.scene.permissions
    if (permissions.session !== 'desktop') return { kind: 'session', note: permissions.reason ?? `the session is ${permissions.session}, not a desktop` }
    if (!grantHolds(permissions.input)) return { kind: 'permission', note: `input control is not granted — ${permissions.reason ?? permissions.input}`, remedy: GRANT_REMEDY }
    return null
  }

  private async act(kind: FakeActKind, detail: Record<string, unknown>, signal: AbortSignal, body: () => DesktopActReceipt): Promise<DesktopAnswer<DesktopActReceipt>> {
    const gate = this.actGate()
    if (gate !== null) return refusal(gate)
    if ((await this.hold(signal)) === 'aborted') {
      this.record(kind, 'aborted', detail)
      return desktopAbortedAnswer()
    }
    const receipt = body()
    if (SCENE_ACTS.has(kind)) this.sceneActs += 1
    this.record(kind, 'done', detail)
    return answer(receipt)
  }

  private hold(signal: AbortSignal): Promise<FakeActOutcome> {
    if (signal.aborted) return Promise.resolve('aborted')
    if (this.scene.holdMs <= 0) return Promise.resolve('done')
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const onAbort = (): void => {
        if (timer !== null) clearTimeout(timer)
        resolve('aborted')
      }
      timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve('done')
      }, this.scene.holdMs)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private record(act: FakeActKind, outcome: FakeActOutcome, detail: Record<string, unknown>): void {
    const entry: FakeAct = { act, at: this.acts.length + 1, outcome, detail }
    this.acts.push(entry)
    if (this.logPath === null) return
    mkdirSync(dirname(this.logPath), { recursive: true })
    appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`)
  }
}
