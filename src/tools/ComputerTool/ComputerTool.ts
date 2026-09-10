import { writeFileSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod/v4'
import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { readImageWithTokenBudget } from '../FileReadTool/FileReadTool.js'
import { imageDimensionsFromHeader } from '../FileReadTool/imageProcessorJs.js'
import { modelReceivesImageBlocks } from '../../utils/model/capabilities.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { sleep } from '../../utils/sleep.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/permissions.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import type { ToolPermissionContext } from '../../types/permissions.js'
import { classifyModelRoute, providerDisplayName } from '../../services/providers/routeLaw.js'
import { rememberDesktopPermissions, resolveDesktopDriver } from '../../services/desktop/resolveDriver.js'
import type {
  DesktopAnswer,
  DesktopApplication,
  DesktopDriver,
  DesktopError,
  DesktopModifier,
  DesktopPoint,
} from '../../services/desktop/driver.js'
import {
  DESKTOP_SHOTS_KEEP,
  appApproved,
  approveApp,
  consumeCheckedActApp,
  desktopPostureRefusal,
  imageRefusedFor,
  noteCheckedActApp,
  noteScreenshot,
  pruneDesktopShots,
  screenOf,
  screenshotPath,
  setScreen,
  type DesktopJudgedApp,
} from '../../services/desktop/desktopSession.js'
import { claimDesktop, desktopClaimBusyNote } from '../../services/desktop/desktopClaim.js'
import { screenshotVisibleInContext } from '../../services/desktop/screenshotRetention.js'
import { COMPUTER_TOOL_NAME } from '../../services/desktop/toolName.js'
import type { Message } from '../../types/message.js'
import { KEY_CHORD_VOCABULARY, appSwitchChord, isAppSwitchChord, isKeyChordRefusal, parseKeyChord, type KeyChord } from './keyChord.js'
import {
  isPixelOutside,
  pixelOfPoint,
  pixelOnScreen,
  pointOfPixel,
  screenMapOfCapture,
  screenMapSizeWords,
  type ScreenMap,
} from './screenMap.js'
import { renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, userFacingName } from './UI.js'

export { COMPUTER_TOOL_NAME }

export const ACTIONS = [
  'screenshot',
  'click',
  'doubleClick',
  'rightClick',
  'move',
  'drag',
  'scroll',
  'type',
  'key',
  'hold',
  'wait',
  'cursor',
  'displays',
  'frontmost',
] as const
export type ComputerAction = (typeof ACTIONS)[number]

export const ACT_ACTIONS: ReadonlySet<string> = new Set([
  'click',
  'doubleClick',
  'rightClick',
  'move',
  'drag',
  'scroll',
  'type',
  'key',
  'hold',
])
export const POINT_ACTIONS: ReadonlySet<string> = new Set(['click', 'doubleClick', 'rightClick', 'move', 'drag', 'scroll'])
const READ_ACTIONS: ReadonlySet<string> = new Set(['screenshot', 'wait', 'cursor', 'displays', 'frontmost'])
const FACT_ACTIONS: ReadonlySet<string> = new Set(['cursor', 'displays', 'frontmost'])

const MODIFIERS = ['Shift', 'Control', 'Alt', 'Meta'] as const
type ModelModifier = (typeof MODIFIERS)[number]
const MODIFIER_KEYS: Readonly<Record<ModelModifier, DesktopModifier>> = {
  Shift: 'shift',
  Control: 'control',
  Alt: 'alt',
  Meta: 'super',
}

export const SETTLE_DEFAULT_MS = 300
export const SETTLE_CAP_MS = 5_000
export const WAIT_DEFAULT_MS = 1_000
export const WAIT_CAP_MS = 10_000
export const HOLD_MIN_MS = 50
export const HOLD_CAP_MS = 5_000
export const TYPE_TEXT_CAP = 4_000

export function computerToolEnabled(): boolean {
  return flagEnabled('MERCURY_COMPUTER_USE')
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(ACTIONS)
      .describe('screenshot · click · doubleClick · rightClick · move · drag · scroll · type · key · hold · wait · cursor · displays · frontmost'),
    x: z.number().optional().describe('click/doubleClick/rightClick/move/drag/scroll: x in pixels of the last screenshot (drag: the start)'),
    y: z.number().optional().describe('the y of x'),
    toX: z.number().optional().describe('drag: the end x, same pixels'),
    toY: z.number().optional().describe('drag: the end y'),
    dx: z.number().optional().describe('scroll: wheel notches right (negative = left)'),
    dy: z.number().optional().describe('scroll: wheel notches down (negative = up)'),
    text: z.string().optional().describe(`type: the characters to type (up to ${TYPE_TEXT_CAP})`),
    key: z
      .string()
      .optional()
      .describe(`key/hold: one chord — ${KEY_CHORD_VOCABULARY} (cmd+shift+s)`),
    modifiers: z.array(z.enum(MODIFIERS)).optional().describe('click family, drag, scroll: modifiers held around the act'),
    durationMs: z
      .number()
      .optional()
      .describe(`hold: how long the chord stays down (cap ${HOLD_CAP_MS}) · wait: the pause before the screenshot (default ${WAIT_DEFAULT_MS}, cap ${WAIT_CAP_MS})`),
    display: z.number().optional().describe('screenshot: the display number from displays (default: the display under the cursor)'),
    settleMs: z
      .number()
      .optional()
      .describe(`acts: the pause before the screenshot that follows the act (default ${SETTLE_DEFAULT_MS}, cap ${SETTLE_CAP_MS})`),
    capture: z.boolean().optional().describe('acts: false skips the screenshot after the act (default true)'),
    label: z.string().optional().describe('screenshot: a name for the saved file'),
  }),
)

type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>

export type Output = {
  action: Input['action']
  result: string
  outcome: ToolEffectOutcome
  imagePath?: string
  inlinePath?: string
  inlineMediaType?: string
  screen?: ScreenMap
}

const ACTION_FIELDS: Readonly<Record<ComputerAction, readonly string[]>> = {
  screenshot: ['display', 'label'],
  click: ['x', 'y', 'modifiers', 'settleMs', 'capture'],
  doubleClick: ['x', 'y', 'modifiers', 'settleMs', 'capture'],
  rightClick: ['x', 'y', 'modifiers', 'settleMs', 'capture'],
  move: ['x', 'y', 'settleMs', 'capture'],
  drag: ['x', 'y', 'toX', 'toY', 'modifiers', 'settleMs', 'capture'],
  scroll: ['x', 'y', 'dx', 'dy', 'modifiers', 'settleMs', 'capture'],
  type: ['text', 'settleMs', 'capture'],
  key: ['key', 'settleMs', 'capture'],
  hold: ['key', 'durationMs', 'settleMs', 'capture'],
  wait: ['durationMs'],
  cursor: [],
  displays: [],
  frontmost: [],
}

const NO_SCREENSHOT = 'no screenshot yet — coordinates are pixels of the last screenshot; take one first'
const SCREENSHOT_GONE =
  'the last screenshot is no longer in the conversation — coordinates are pixels of a screenshot you can see; take a new one first'

function refuse(message: string): { result: false; message: string; errorCode: number } {
  return { result: false, message, errorCode: 1 }
}

function clamp(value: number, floor: number, cap: number): number {
  return Math.min(Math.max(value, floor), cap)
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function controlCharacterOf(text: string): string | null {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x0a || code === 0x09) continue
    if (code < 0x20 || code === 0x7f) return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return null
}

function fieldRefusal(input: Input): string | null {
  const allowed = ACTION_FIELDS[input.action]
  for (const [field, value] of Object.entries(input)) {
    if (field === 'action' || value === undefined) continue
    if (!allowed.includes(field)) return `${input.action} does not take ${field}`
  }
  return null
}

function tableRefusal(input: Input): string | null {
  const stray = fieldRefusal(input)
  if (stray !== null) return stray
  const action = input.action
  if (POINT_ACTIONS.has(action) && !(isNumber(input.x) && isNumber(input.y))) {
    return `${action} requires x and y (pixels of the last screenshot)`
  }
  if (action === 'drag' && !(isNumber(input.toX) && isNumber(input.toY))) {
    return 'drag requires toX and toY (the end, in the same pixels)'
  }
  if (action === 'scroll' && !(isNumber(input.dx) || isNumber(input.dy))) {
    return 'scroll requires dx or dy (wheel notches)'
  }
  if (action === 'type') {
    if (typeof input.text !== 'string' || input.text.length === 0) return 'type requires text (the characters to type)'
    if (input.text.length > TYPE_TEXT_CAP) {
      return `type takes up to ${TYPE_TEXT_CAP} characters — this text is ${input.text.length}; split it`
    }
    const control = controlCharacterOf(input.text)
    if (control !== null) return `type refuses the control character ${control} — newline and tab are the only control characters typed`
  }
  if (action === 'key' || action === 'hold') {
    if (typeof input.key !== 'string') return `${action} requires key (one chord)`
    const chord = parseKeyChord(input.key)
    if (isKeyChordRefusal(chord)) return `${action} refused: ${chord.reason}`
  }
  if (action === 'hold') {
    if (!isNumber(input.durationMs)) return `hold requires durationMs (${HOLD_MIN_MS}–${HOLD_CAP_MS})`
    if (input.durationMs < HOLD_MIN_MS || input.durationMs > HOLD_CAP_MS) {
      return `hold takes durationMs between ${HOLD_MIN_MS} and ${HOLD_CAP_MS} — ${input.durationMs} is outside`
    }
  }
  if (action === 'wait' && input.durationMs !== undefined && !(isNumber(input.durationMs) && input.durationMs >= 0)) {
    return 'wait takes durationMs as a whole number of milliseconds'
  }
  if (action === 'screenshot' && input.display !== undefined && !(Number.isInteger(input.display) && input.display >= 0)) {
    return 'screenshot takes display as a display number from displays'
  }
  if (input.settleMs !== undefined && !(isNumber(input.settleMs) && input.settleMs >= 0)) {
    return `${action} takes settleMs as a number of milliseconds`
  }
  return null
}

interface ActPlan {
  point: DesktopPoint | null
  target: DesktopPoint | null
  chord: KeyChord | null
  modifiers: DesktopModifier[]
}

type Framed = { ok: true; point: DesktopPoint } | { ok: false; text: string }

function framePixel(map: ScreenMap | null, messages: readonly Message[], x: number, y: number): Framed {
  if (map === null) return { ok: false, text: NO_SCREENSHOT }
  if (map.toolUseId !== '' && !screenshotVisibleInContext(messages, map.toolUseId)) return { ok: false, text: SCREENSHOT_GONE }
  const point = pointOfPixel(map, x, y)
  if (isPixelOutside(point)) {
    return {
      ok: false,
      text: `(${x}, ${y}) is outside the last screenshot (${point.imageWidth}×${point.imageHeight} px) — take a screenshot and use its pixels`,
    }
  }
  return { ok: true, point }
}

function planOf(owner: OwnerKey, context: ToolUseContext, input: Input): ActPlan | { refusal: string } {
  const map = screenOf(owner)
  const messages: readonly Message[] = context.messages ?? []
  let point: DesktopPoint | null = null
  let target: DesktopPoint | null = null
  if (POINT_ACTIONS.has(input.action)) {
    const framed = framePixel(map, messages, input.x!, input.y!)
    if (!framed.ok) return { refusal: `${input.action} refused: ${framed.text}` }
    point = framed.point
    if (input.action === 'drag') {
      const end = framePixel(map, messages, input.toX!, input.toY!)
      if (!end.ok) return { refusal: `drag refused: ${end.text}` }
      target = end.point
    }
  }
  let chord: KeyChord | null = null
  if (input.action === 'key' || input.action === 'hold') {
    const parsed = parseKeyChord(input.key ?? '')
    if (isKeyChordRefusal(parsed)) return { refusal: `${input.action} refused: ${parsed.reason}` }
    chord = parsed
  }
  const modifiers = (input.modifiers ?? []).map(modifier => MODIFIER_KEYS[modifier])
  return { point, target, chord, modifiers }
}

function isPlanRefusal(plan: ActPlan | { refusal: string }): plan is { refusal: string } {
  return 'refusal' in plan
}

function insideBounds(point: DesktopPoint, bounds: { x: number; y: number; width: number; height: number }): boolean {
  return point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height
}

function switchChordWords(): string {
  const chord = appSwitchChord()
  return `${chord.modifiers.map(modifier => (modifier === 'super' ? 'cmd' : modifier)).join('+')}+${chord.key}`
}

async function ownTerminalRefusal(
  driver: DesktopDriver,
  input: Input,
  front: DesktopApplication,
  plan: ActPlan,
): Promise<string | null> {
  const own = await driver.ownTerminalApplication()
  if (!own.ok || own.value === null || own.value.identity !== front.identity) return null
  const action = input.action
  if (action === 'type' || action === 'hold') {
    return `${action} refused: the application in front is the terminal running this session — a keystroke there would land in this conversation; switch to the target application first`
  }
  if (action === 'key') {
    if (plan.chord !== null && isAppSwitchChord(plan.chord)) return null
    return `key refused: the terminal running this session is in front — only the application switch chord (${switchChordWords()}) is allowed there; switch to the target application first`
  }
  const points = [plan.point, plan.target].filter((point): point is DesktopPoint => point !== null)
  if (front.bounds === null) {
    return `${action} refused: the terminal running this session is in front and its window bounds are unknown — switch to the target application first`
  }
  for (const point of points) {
    if (insideBounds(point, front.bounds)) {
      const pixel = pixelWordsOf(input, point, plan)
      return `${action} refused: ${pixel} is inside the window of the terminal running this session`
    }
  }
  return null
}

function pixelWordsOf(input: Input, point: DesktopPoint, plan: ActPlan): string {
  if (plan.target !== null && point === plan.target) return `(${input.toX}, ${input.toY})`
  return `(${input.x}, ${input.y})`
}

function modifierWords(modifiers: readonly ModelModifier[] | undefined): string {
  return modifiers && modifiers.length > 0 ? ` +${modifiers.join('+')}` : ''
}

export function actDetail(input: Input): string {
  switch (input.action) {
    case 'click':
    case 'doubleClick':
    case 'rightClick':
    case 'move':
      return ` (${input.x}, ${input.y})${modifierWords(input.modifiers)}`
    case 'drag':
      return ` (${input.x}, ${input.y}) → (${input.toX}, ${input.toY})${modifierWords(input.modifiers)}`
    case 'scroll':
      return ` by ${input.dx ?? 0}, ${input.dy ?? 0} at (${input.x}, ${input.y})${modifierWords(input.modifiers)}`
    case 'type':
      return ` ${(input.text ?? '').length} chars`
    case 'key':
    case 'hold':
      return ` ${input.key ?? ''}`
    default:
      return ''
  }
}

function faultText(action: string, error: DesktopError): string {
  return `${action} failed: ${error.note}${error.remedy ? ` — ${error.remedy}` : ''}`
}

type ActWords = { ok: true; words: string } | { ok: false; aborted: boolean; text: string }

class ActRun {
  fault: ActWords | null = null
  constructor(
    readonly driver: DesktopDriver,
    readonly action: string,
    readonly signal: AbortSignal,
  ) {}

  async step<T>(answer: Promise<DesktopAnswer<T>>): Promise<T | null> {
    const settled = await answer
    if (settled.ok) return settled.value
    this.fault =
      settled.error.kind === 'aborted'
        ? { ok: false, aborted: true, text: '' }
        : { ok: false, aborted: false, text: faultText(this.action, settled.error) }
    return null
  }

  async down(modifiers: readonly DesktopModifier[]): Promise<boolean> {
    for (const modifier of modifiers) {
      if ((await this.step(this.driver.keyDown(modifier, this.signal))) === null) return false
    }
    return true
  }

  async up(modifiers: readonly DesktopModifier[]): Promise<boolean> {
    for (const modifier of [...modifiers].reverse()) {
      if ((await this.step(this.driver.keyUp(modifier, this.signal))) === null) return false
    }
    return true
  }

  failed(): ActWords {
    return this.fault ?? { ok: false, aborted: false, text: `${this.action} failed: the desktop driver answered nothing` }
  }
}

function pointWords(point: DesktopPoint): string {
  return `(${point.x}, ${point.y}) pt`
}

async function performAct(driver: DesktopDriver, input: Input, plan: ActPlan, signal: AbortSignal): Promise<ActWords> {
  const run = new ActRun(driver, input.action, signal)
  if (signal.aborted) return { ok: false, aborted: true, text: '' }
  switch (input.action) {
    case 'click':
    case 'doubleClick':
    case 'rightClick': {
      if (!(await run.down(plan.modifiers))) return run.failed()
      const button = input.action === 'rightClick' ? 'right' : 'left'
      const count = input.action === 'doubleClick' ? 2 : 1
      if ((await run.step(driver.click(plan.point!, button, count, signal))) === null) return run.failed()
      if (!(await run.up(plan.modifiers))) return run.failed()
      return { ok: true, words: `${input.action} (${input.x}, ${input.y})${modifierWords(input.modifiers)} → ${pointWords(plan.point!)}` }
    }
    case 'move': {
      if ((await run.step(driver.mouseMove(plan.point!, signal))) === null) return run.failed()
      return { ok: true, words: `move (${input.x}, ${input.y}) → ${pointWords(plan.point!)}` }
    }
    case 'drag': {
      if (!(await run.down(plan.modifiers))) return run.failed()
      if ((await run.step(driver.drag(plan.point!, plan.target!, 'left', signal))) === null) return run.failed()
      if (!(await run.up(plan.modifiers))) return run.failed()
      return {
        ok: true,
        words: `drag (${input.x}, ${input.y}) → (${input.toX}, ${input.toY})${modifierWords(input.modifiers)} · ${pointWords(plan.point!)} → ${pointWords(plan.target!)}`,
      }
    }
    case 'scroll': {
      if (!(await run.down(plan.modifiers))) return run.failed()
      if ((await run.step(driver.scroll(plan.point!, input.dx ?? 0, input.dy ?? 0, signal))) === null) return run.failed()
      if (!(await run.up(plan.modifiers))) return run.failed()
      return {
        ok: true,
        words: `scroll (${input.x}, ${input.y}) by ${input.dx ?? 0}, ${input.dy ?? 0}${modifierWords(input.modifiers)} → ${pointWords(plan.point!)}`,
      }
    }
    case 'type': {
      if ((await run.step(driver.typeText(input.text!, {}, signal))) === null) return run.failed()
      return { ok: true, words: `type ${input.text!.length} chars` }
    }
    case 'key': {
      if ((await run.step(driver.keyTap(plan.chord!.key, plan.chord!.modifiers, signal))) === null) return run.failed()
      return { ok: true, words: `key ${input.key}` }
    }
    case 'hold': {
      const chord = plan.chord!
      if (!(await run.down(chord.modifiers))) return run.failed()
      if ((await run.step(driver.keyDown(chord.key, signal))) === null) return run.failed()
      await sleep(input.durationMs!, signal)
      if (signal.aborted) return { ok: false, aborted: true, text: '' }
      if ((await run.step(driver.keyUp(chord.key, signal))) === null) return run.failed()
      if (!(await run.up(chord.modifiers))) return run.failed()
      return { ok: true, words: `hold ${input.key} ${input.durationMs}ms` }
    }
    default:
      return { ok: false, aborted: false, text: `${input.action} is not an act` }
  }
}

function interruptedText(action: string): string {
  return `${action} interrupted by the operator — the act in flight ended, held keys and buttons were released, nothing further was done`
}

function interruptedAfterActText(action: string): string {
  return `${action} interrupted by the operator after the act — no screenshot was taken; held keys and buttons were released, nothing further was done`
}

function applicationWords(app: DesktopApplication): string {
  return `${app.name}${app.title ? ` — ${app.title}` : ''}`
}

async function cursorWords(driver: DesktopDriver, map: ScreenMap | null): Promise<string> {
  const cursor = await driver.cursor()
  if (!cursor.ok) return `cursor unknown (${cursor.error.note})`
  const at = cursor.value
  if (map !== null && (at.display === null || at.display === map.display)) {
    const pixel = pixelOfPoint(map, at)
    if (pixelOnScreen(map, pixel)) return `cursor (${pixel.x}, ${pixel.y})`
  }
  if (map !== null) return `cursor on display ${at.display ?? '?'}`
  return `cursor (${at.x}, ${at.y}) pt${at.display !== null ? ` on display ${at.display}` : ''}`
}

async function frontmostWords(driver: DesktopDriver): Promise<string> {
  const front = await driver.frontmostApplication()
  if (!front.ok) return `frontmost unknown (${front.error.note})`
  return `frontmost ${applicationWords(front.value)}`
}

async function factsLine(driver: DesktopDriver, map: ScreenMap | null): Promise<string> {
  return `${await cursorWords(driver, map)} · ${await frontmostWords(driver)}`
}

type Shot =
  | { ok: true; line: string; imagePath: string; inlinePath?: string; inlineMediaType?: string; screen: ScreenMap }
  | { ok: false; aborted: boolean; text: string }

async function takeScreenshot(
  owner: OwnerKey,
  driver: DesktopDriver,
  context: ToolUseContext,
  wanted: number | undefined,
  label: string | undefined,
  signal: AbortSignal,
): Promise<Shot> {
  const displays = await driver.displays()
  if (!displays.ok) return { ok: false, aborted: false, text: faultText('screenshot', displays.error) }
  const list = displays.value.displays
  if (list.length === 0) return { ok: false, aborted: false, text: 'screenshot failed: no display is attached' }
  let index = wanted
  if (index === undefined) {
    const cursor = await driver.cursor()
    index = cursor.ok && cursor.value.display !== null ? cursor.value.display : (list.find(d => d.primary) ?? list[0]!).index
  }
  const display = list.find(d => d.index === index)
  if (display === undefined) {
    return {
      ok: false,
      aborted: false,
      text: `screenshot failed: display ${index} is not one of the displays — displays lists ${list.map(d => d.index).join(', ')}`,
    }
  }
  const captured = await driver.capture(display.index, signal)
  if (!captured.ok) {
    return captured.error.kind === 'aborted'
      ? { ok: false, aborted: true, text: '' }
      : { ok: false, aborted: false, text: faultText('screenshot', captured.error) }
  }
  const capture = captured.value
  const file = screenshotPath(label ?? `display-${display.index}`)
  writeFileSync(file, capture.png)
  pruneDesktopShots(dirname(file), DESKTOP_SHOTS_KEEP)
  let image = { width: capture.width, height: capture.height }
  let inlinePath: string | undefined
  let inlineMediaType: string | undefined
  if (modelReceivesImageBlocks(context.options?.mainLoopModel ?? getMainLoopModel())) {
    try {
      const inlined = await readImageWithTokenBudget(file)
      const bytes = Buffer.from(inlined.file.base64, 'base64')
      const header = imageDimensionsFromHeader(bytes)
      if (header !== null && (header.width !== image.width || header.height !== image.height || inlined.file.type !== 'image/png')) {
        inlinePath = `${file}.inline`
        writeFileSync(inlinePath, bytes)
        inlineMediaType = inlined.file.type
        image = { width: header.width, height: header.height }
      }
    } catch {
      inlinePath = undefined
    }
  }
  const screen = screenMapOfCapture(context.toolUseId ?? '', capture, display, image)
  setScreen(owner, screen)
  noteScreenshot(owner, screen.toolUseId, file)
  const line = `screenshot: ${file} — display ${display.index} (${screenMapSizeWords(screen)}) · ${await factsLine(driver, screen)}`
  return {
    ok: true,
    line,
    imagePath: file,
    ...(inlinePath !== undefined ? { inlinePath } : {}),
    ...(inlineMediaType !== undefined ? { inlineMediaType } : {}),
    screen,
  }
}

function textOnlyRefusal(model: string, route: string | null): string {
  const where = route !== null ? `on the ${providerDisplayName(route)} route` : 'on its route'
  return `the Computer tool needs a model that receives images; ${model} ${where} receives text only in this release — switch to a model on a route that carries images (/model)`
}

export function imageRefusalText(model: string, route: string | null, error: string): string {
  const where = route !== null ? providerDisplayName(route) : 'its'
  return `the model on the ${where} route refused the image: ${error} — ${model} cannot drive the screen until the route carries images; switch to a model that receives images (/model)`
}

export async function routeRefusal(model: string): Promise<string | null> {
  const verdict = classifyModelRoute(model)
  const route = verdict.kind === 'route' ? verdict.route : null
  if (!modelReceivesImageBlocks(model)) return textOnlyRefusal(model, route)
  if (route === 'openai') {
    const { imagesSupportedForModel } = await import('../../services/providers/openai/openaiCallModel.js')
    if (!imagesSupportedForModel(model)) return textOnlyRefusal(model, route)
  }
  const refused = imageRefusedFor(model)
  if (refused !== null) return imageRefusalText(model, route, refused)
  return null
}

function ruleVerdict(permissionContext: ToolPermissionContext | undefined, content: string): 'deny' | 'ask' | 'allow' | null {
  if (!permissionContext) return null
  for (const behavior of ['deny', 'ask', 'allow'] as const) {
    if (getRuleByContentsForToolName(permissionContext, COMPUTER_TOOL_NAME, behavior).has(content)) return behavior
  }
  return null
}

function denied(message: string, reason: string) {
  return { behavior: 'deny' as const, message, decisionReason: { type: 'other' as const, reason } }
}

export const ComputerTool = buildTool({
  name: COMPUTER_TOOL_NAME,
  searchHint:
    'computer use: see the screen, drive the mouse and keyboard, screenshot the desktop, click type scroll press keys in a desktop application window, control a native app, automate a GUI',
  capability: {
    intents: [
      'see the screen and drive the mouse and keyboard',
      'take a screenshot of the desktop',
      'click, type, scroll or press keys in the application in front',
      'find out which application is in front',
    ],
    units: ['desktop-drive'],
    class: 'execution',
    operations: [...ACTIONS],
    execution: { kind: 'desktop-session', representation: 'child-execution' },
    evidence: ['artifact'],
    resources: [],
    cancellation: 'cooperative',
    latency: 'interactive',
    gate: 'MERCURY_COMPUTER_USE',
    proof: 'scripts/computer/prove-computer-asks.ts',
  },
  maxResultSizeChars: 20_000,
  async description() {
    return "Drive the operator's screen: screenshot, click, type, press keys, scroll and drag in the application in front, on every model route that receives images"
  },
  async prompt() {
    return `Drive the operator's screen through the desktop driver. Coordinates are PIXELS OF THE LAST SCREENSHOT you received — take one before any act, and again after a compaction or when the result says the screenshot is gone. The result of every act carries a fresh screenshot after a short settle (settleMs; capture:false skips it) plus one line: the cursor, the application in front and the display size.

action:"screenshot" (display?, label?) — the display under the cursor, or the numbered one from action:"displays".
action:"click" | "doubleClick" | "rightClick" (x, y, modifiers?) · action:"move" (x, y) · action:"drag" (x, y, toX, toY, modifiers?) · action:"scroll" (x, y, dx?, dy? in wheel notches; positive dy scrolls down).
action:"type" (text) — the characters as typed, up to ${TYPE_TEXT_CAP}; newline and tab are the only control characters. action:"key" (key) — one chord: ${KEY_CHORD_VOCABULARY} (cmd+shift+s). action:"hold" (key, durationMs) — the chord stays down for durationMs (cap ${HOLD_CAP_MS}).
action:"wait" (durationMs?) — pause (default ${WAIT_DEFAULT_MS}, cap ${WAIT_CAP_MS}) then screenshot. action:"cursor" · action:"displays" · action:"frontmost" — cheap facts, no image.

PERMISSIONS: the first act in an application this session asks the operator by the application's name; later acts in it ride the grant; an act that lands in another application asks for that one before the next act there. Reads (screenshot, wait, cursor, displays, frontmost) never ask. Keystrokes never go to the terminal running this session: with that terminal in front, type and hold refuse, key allows only the application switch chord, and clicks must land outside its window. One session drives the desktop at a time; a second is refused naming the first. The operator's esc or ctrl+c ends the act in flight (held keys released) and the turn.

Take a screenshot after acts that change the screen, act on what the latest one shows, and prefer key chords over clicks on menus. Screenshots are not kept in the saved conversation; older ones leave the context as newer ones arrive.`
  },
  userFacingName,
  shouldDefer: true,
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  isEnabled() {
    return computerToolEnabled()
  },
  isConcurrencySafe(input: Input) {
    return FACT_ACTIONS.has(input?.action)
  },
  isReadOnly(input: Input) {
    return READ_ACTIONS.has(input?.action)
  },
  interruptBehavior() {
    return 'cancel' as const
  },
  toAutoClassifierInput(input: Input) {
    return `computer ${input.action}${actDetail(input)}`.trim()
  },
  async validateInput(input: Input, context: ToolUseContext) {
    if (!computerToolEnabled()) {
      return refuse('the Computer tool is off — set MERCURY_COMPUTER_USE=1 before the session starts')
    }
    const posture = desktopPostureRefusal(context)
    if (posture !== null) return refuse(posture)
    const model = context?.options?.mainLoopModel ?? getMainLoopModel()
    const route = await routeRefusal(model)
    if (route !== null) return refuse(route)
    const resolution = resolveDesktopDriver()
    if (resolution.state === 'unavailable') {
      return refuse(`no desktop driver: ${resolution.note}${resolution.remedy ? ` — ${resolution.remedy}` : ''}`)
    }
    const table = tableRefusal(input)
    if (table !== null) return refuse(table)
    return { result: true as const }
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    if (!ACT_ACTIONS.has(input.action)) return { behavior: 'allow' as const, updatedInput: input }
    const owner = ownerFromToolUseContext((context ?? {}) as { owner?: OwnerKey; agentId?: string })
    const resolution = resolveDesktopDriver()
    if (resolution.state !== 'ok') return { behavior: 'allow' as const, updatedInput: input }
    const driver = resolution.driver
    const front = await driver.frontmostApplication()
    if (!front.ok) {
      return denied(
        `Computer ${input.action} refused: the application in front could not be read — ${front.error.note}`,
        'the application in front is unknown',
      )
    }
    const app = front.value
    const plan = planOf(owner, context, input)
    if (isPlanRefusal(plan)) return denied(plan.refusal, 'the act has no screenshot frame')
    const terminal = await ownTerminalRefusal(driver, input, app, plan)
    if (terminal !== null) return denied(terminal, 'the terminal running this session is in front')
    const permissionContext = (context as Partial<ToolUseContext> | undefined)?.getAppState?.()
      ?.toolPermissionContext as ToolPermissionContext | undefined
    const content = `app:${app.identity}`
    const ruled = ruleVerdict(permissionContext, content)
    if (ruled === 'deny') {
      return denied(`Computer is denied for ${content} by a permission rule`, `${content} carries a deny rule`)
    }
    noteCheckedActApp(owner, input.action, { identity: app.identity, name: app.name })
    if (ruled === 'allow' || appApproved(owner, app.identity)) {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    return {
      behavior: 'ask' as const,
      message: `Computer ${input.action}${actDetail(input)} in ${app.name} (${app.identity}) — first act in this application this session (drives your mouse and keyboard)`,
      decisionReason: {
        type: 'safetyCheck' as const,
        reason: `${app.name} is in front of the operator's screen; the first act there needs the operator's own consent`,
        classifierApprovable: false,
      },
      suggestions: suggestionForExactCommand(COMPUTER_TOOL_NAME, content),
    }
  },
  async call(input: Input, context: ToolUseContext) {
    const startedAt = Date.now()
    const owner = ownerFromToolUseContext((context ?? {}) as { owner?: OwnerKey; agentId?: string })
    const signal = context.abortController?.signal ?? new AbortController().signal
    let result: string
    let outcome: ToolEffectOutcome = 'no-change'
    let imagePath: string | undefined
    let inlinePath: string | undefined
    let inlineMediaType: string | undefined
    let screen: ScreenMap | undefined
    const resolution = resolveDesktopDriver()
    if (resolution.state === 'unavailable') {
      result = `no desktop driver: ${resolution.note}${resolution.remedy ? ` — ${resolution.remedy}` : ''}`
      outcome = 'failed'
      return finish()
    }
    const driver = resolution.driver
    const permissions = await driver.permissions()
    if (permissions.ok) rememberDesktopPermissions(permissions.value)
    const takeShot = (wanted: number | undefined, label: string | undefined): Promise<Shot> =>
      takeScreenshot(owner, driver, context, wanted, label, signal)
    const adoptShot = (shot: Extract<Shot, { ok: true }>): void => {
      imagePath = shot.imagePath
      inlinePath = shot.inlinePath
      inlineMediaType = shot.inlineMediaType
      screen = shot.screen
    }
    try {
      if (ACT_ACTIONS.has(input.action)) {
        if (signal.aborted) {
          result = interruptedText(input.action)
          outcome = 'failed'
          return finish()
        }
        const plan = planOf(owner, context, input)
        if (isPlanRefusal(plan)) {
          result = plan.refusal
          outcome = 'failed'
          return finish()
        }
        const judged: DesktopJudgedApp | null = consumeCheckedActApp(owner, input.action)
        const front = await driver.frontmostApplication()
        if (!front.ok) {
          result = faultText(input.action, front.error)
          outcome = 'failed'
          return finish()
        }
        const live: DesktopJudgedApp = { identity: front.value.identity, name: front.value.name }
        if (judged !== null && judged.identity !== live.identity) {
          result = `${input.action} refused: the screen moved from ${judged.name} (${judged.identity}) to ${live.name} (${live.identity}) between the permission check and the act — nothing done; take a screenshot and re-issue`
          outcome = 'failed'
          return finish()
        }
        const terminal = await ownTerminalRefusal(driver, input, front.value, plan)
        if (terminal !== null) {
          result = terminal
          outcome = 'failed'
          return finish()
        }
        const claim = await claimDesktop(signal, live.name)
        if (!claim.held) {
          result = claim.aborted === true ? interruptedText(input.action) : `computer refused: ${desktopClaimBusyNote(claim.holder)}`
          outcome = 'failed'
          return finish()
        }
        let act: ActWords
        try {
          act = await performAct(driver, input, plan, signal)
        } catch (err) {
          await driver.releaseAll()
          throw err
        }
        if (!act.ok) {
          await driver.releaseAll()
          result = act.aborted ? interruptedText(input.action) : act.text
          outcome = 'failed'
          return finish()
        }
        approveApp(owner, judged ?? live)
        outcome = 'succeeded'
        if (input.capture === false) {
          result = `${act.words} · ${await factsLine(driver, screenOf(owner))}`
          return finish()
        }
        await sleep(clamp(input.settleMs ?? SETTLE_DEFAULT_MS, 0, SETTLE_CAP_MS), signal)
        if (signal.aborted) {
          await driver.releaseAll()
          result = interruptedAfterActText(input.action)
          outcome = 'failed'
          return finish()
        }
        const shot = await takeShot(undefined, undefined)
        if (!shot.ok) {
          if (shot.aborted) {
            await driver.releaseAll()
            result = interruptedAfterActText(input.action)
            outcome = 'failed'
            return finish()
          }
          result = `${act.words} · ${shot.text}`
          return finish()
        }
        adoptShot(shot)
        result = `${act.words} · ${shot.line}`
        return finish()
      }
      switch (input.action) {
        case 'screenshot': {
          const shot = await takeShot(input.display, input.label)
          if (!shot.ok) {
            result = shot.aborted ? interruptedText('screenshot') : shot.text
            outcome = 'failed'
            break
          }
          adoptShot(shot)
          result = shot.line
          outcome = 'succeeded'
          break
        }
        case 'wait': {
          const pause = clamp(input.durationMs ?? WAIT_DEFAULT_MS, 0, WAIT_CAP_MS)
          await sleep(pause, signal)
          if (signal.aborted) {
            result = interruptedText('wait')
            outcome = 'failed'
            break
          }
          const shot = await takeShot(undefined, undefined)
          if (!shot.ok) {
            result = shot.aborted ? interruptedText('wait') : `wait ${pause}ms · ${shot.text}`
            outcome = 'failed'
            break
          }
          adoptShot(shot)
          result = `wait ${pause}ms · ${shot.line}`
          outcome = 'succeeded'
          break
        }
        case 'cursor': {
          const cursor = await driver.cursor()
          if (!cursor.ok) {
            result = faultText('cursor', cursor.error)
            outcome = 'failed'
            break
          }
          const map = screenOf(owner)
          const at = cursor.value
          const where = `(${at.x}, ${at.y}) pt${at.display !== null ? ` on display ${at.display}` : ''}`
          if (map !== null && (at.display === null || at.display === map.display)) {
            const pixel = pixelOfPoint(map, at)
            if (pixelOnScreen(map, pixel)) {
              result = `cursor (${pixel.x}, ${pixel.y}) px of the last screenshot · ${where}`
              outcome = 'succeeded'
              break
            }
          }
          result = map !== null ? `cursor ${where} — outside the last screenshot` : `cursor ${where} — no screenshot yet`
          outcome = 'succeeded'
          break
        }
        case 'displays': {
          const displays = await driver.displays()
          if (!displays.ok) {
            result = faultText('displays', displays.error)
            outcome = 'failed'
            break
          }
          const rows = displays.value.displays.map(
            d => `${d.index} — ${d.width}×${d.height} pt at (${d.originX}, ${d.originY}), scale ${d.scale}${d.primary ? ', primary' : ''}`,
          )
          result = rows.length > 0 ? `displays: ${rows.join(' · ')}` : 'displays: none attached'
          outcome = 'succeeded'
          break
        }
        case 'frontmost': {
          const front = await driver.frontmostApplication()
          if (!front.ok) {
            result = faultText('frontmost', front.error)
            outcome = 'failed'
            break
          }
          const app = front.value
          result = `frontmost: ${app.name} (${app.identity})${app.title ? ` — ${app.title}` : ''}`
          outcome = 'succeeded'
          break
        }
        default: {
          result = `${input.action} is not an action of this tool`
          outcome = 'failed'
        }
      }
    } catch (err) {
      const e = err as Error
      result = e.name === 'AbortError' || signal.aborted ? interruptedText(input.action) : `${input.action} failed: ${e.message}`
      outcome = 'failed'
    }
    return finish()

    function finish() {
      const output: Output = {
        action: input.action,
        result: result!,
        outcome,
        ...(imagePath !== undefined && { imagePath }),
        ...(inlinePath !== undefined && { inlinePath }),
        ...(inlineMediaType !== undefined && { inlineMediaType }),
        ...(screen !== undefined && { screen }),
      }
      return {
        data: output,
        effect: {
          outcome,
          operation: `computer.${input.action}`,
          changedPaths: imagePath ? [imagePath] : [],
          evidence: output.result.split('\n')[0]?.slice(0, 160) ?? '',
          startedAt,
          completedAt: Date.now(),
        },
      }
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    if (output.imagePath && modelReceivesImageBlocks(getMainLoopModel())) {
      try {
        const bytes = readFileSync(output.inlinePath ?? output.imagePath)
        const mediaType = (output.inlinePath ? (output.inlineMediaType ?? 'image/png') : 'image/png') as 'image/png'
        return {
          tool_use_id: toolUseId,
          type: 'tool_result' as const,
          content: [
            { type: 'text' as const, text: output.result },
            {
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: mediaType, data: bytes.toString('base64') },
            },
          ],
        }
      } catch {
        return { tool_use_id: toolUseId, type: 'tool_result' as const, content: output.result }
      }
    }
    const text =
      output.imagePath && !modelReceivesImageBlocks(getMainLoopModel())
        ? `${output.result}\n(image not inlined — this model takes no image input; open the file to view it)`
        : output.result
    return {
      tool_use_id: toolUseId,
      type: 'tool_result' as const,
      content: text,
    }
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  extractSearchText({ result }) {
    return result
  },
})
