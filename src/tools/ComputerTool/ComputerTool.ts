import { writeFileSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod/v4'
import { buildTool, type ToolEffect, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { imageDimensionsFromHeader } from '../FileReadTool/imageProcessorJs.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import { modelReceivesImageBlocks } from '../../utils/model/capabilities.js'
import { getEngineModel, normalizeModelStringForAPI } from '../../utils/model/model.js'
import { sleep } from '../../utils/sleep.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/permissions.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import { ruleSentence } from '../../utils/permissions/ruleReason.js'
import type { PermissionDecision, PermissionRule, ToolPermissionContext } from '../../types/permissions.js'
import { classifyModelRoute, providerDisplayName } from '../../services/providers/routeLaw.js'
import { rememberDesktopPermissions, resolveDesktopDriver } from '../../services/desktop/resolveDriver.js'
import type {
  DesktopAnswer,
  DesktopApplication,
  DesktopDriver,
  DesktopError,
  DesktopModifier,
  DesktopPoint,
  DesktopTree,
  DesktopTreeLimits,
  DesktopBounds,
} from '../../services/desktop/driver.js'
import {
  DESKTOP_SHOTS_KEEP,
  appApproved,
  approveApp,
  consumeCheckedAct,
  desktopPostureRefusal,
  imageRefusedFor,
  noteCheckedActApp,
  noteScreenshot,
  noteTurnHome,
  pruneDesktopShots,
  screenOf,
  screenshotPath,
  setDrivingApp,
  setScreen,
  turnKeyOf,
  type DesktopJudgedApp,
} from '../../services/desktop/desktopSession.js'
import { claimDesktop, desktopClaimBusyNote, renewDesktopClaim } from '../../services/desktop/desktopClaim.js'
import { screenshotVisibleInContext } from '../../services/desktop/screenshotRetention.js'
import { readComputerGrant } from '../../services/desktop/computerGrant.js'
import { computerAccessPinnedToAsk, savedComputerAccess } from '../../services/desktop/computerAccess.js'
import { resolveComputerAccess } from '../../substrate/startupMenu.js'
import { postureBypassesAsks } from '../../utils/permissions/decision/engine.js'
import { getSessionId } from '../../bootstrap/state.js'
import { COMPUTER_TOOL_NAME } from '../../services/desktop/toolName.js'
import type { AssistantMessage, Message } from '../../types/message.js'
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
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { regionRefusal, sameWindow, settledCapture, targetMatches, targetPoint, targetWords, treeObservation, verificationWords, pageContentNote, type CaptureRegion } from './fastRoad.js'
import { CAPTCHA_HANDOFF, namesCaptcha, treeNamesCaptcha } from './captcha.js'
import { OPERATOR_TYPING_REFUSAL, operatorIsTyping, waitForOperatorPause } from './operatorPause.js'

export { COMPUTER_TOOL_NAME }

const ACTIONS = [
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
  'tree',
  'find',
  'sequence',
] as const
type ComputerAction = (typeof ACTIONS)[number]

const ACT_ACTIONS: ReadonlySet<string> = new Set([
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
const ASK_ACTIONS: ReadonlySet<string> = new Set([...ACT_ACTIONS, 'tree'])
const POINT_ACTIONS: ReadonlySet<string> = new Set(['click', 'doubleClick', 'rightClick', 'move', 'drag', 'scroll'])
const READ_ACTIONS: ReadonlySet<string> = new Set(['screenshot', 'wait', 'cursor', 'displays', 'frontmost', 'tree'])
const FACT_ACTIONS: ReadonlySet<string> = new Set(['cursor', 'displays', 'frontmost'])

const MODIFIERS = ['Shift', 'Control', 'Alt', 'Meta'] as const
type ModelModifier = (typeof MODIFIERS)[number]
const MODIFIER_KEYS: Readonly<Record<ModelModifier, DesktopModifier>> = {
  Shift: 'shift',
  Control: 'control',
  Alt: 'alt',
  Meta: 'super',
}

const SETTLE_DEFAULT_MS = 300
const SETTLE_CAP_MS = 5_000
const WAIT_DEFAULT_MS = 1_000
const WAIT_CAP_MS = 10_000
const HOLD_MIN_MS = 50
export const HOLD_CAP_MS = 5_000
export const TYPE_TEXT_CAP = 4_000
export const TREE_DEPTH_DEFAULT = 8
export const TREE_DEPTH_CAP = 32
export const TREE_LIMIT_DEFAULT = 200
export const TREE_LIMIT_CAP = 2_000

export function computerToolEnabled(): boolean {
  if (!flagEnabled('MERCURY_COMPUTER_USE')) return false
  return resolveDesktopDriver().state === 'ok'
}

const targetSchema = lazySchema(() => z.strictObject({ role: z.string().optional(), name: z.string().optional(), text: z.string().optional() }))
const baseSchema = lazySchema(() =>
  z.strictObject({
    action: z.enum(ACTIONS),
    x: z.number().optional(),
    y: z.number().optional(),
    toX: z.number().optional(),
    toY: z.number().optional(),
    dx: z.number().optional(),
    dy: z.number().optional(),
    text: z.string().optional(),
    key: z.string().optional(),
    modifiers: z.array(z.enum(MODIFIERS)).optional(),
    durationMs: z.number().optional(),
    display: z.number().optional(),
    settleMs: z.number().optional(),
    capture: z.boolean().optional(),
    label: z.string().optional(),
    depth: z.number().optional(),
    limit: z.number().optional(),
    target: targetSchema().optional().describe('role/name exact; text substring; unique match'),
    toTarget: targetSchema().optional(),
    until: targetSchema().optional(),
    count: z.number().optional(),
    region: z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
    scope: z.enum(['window', 'app']).optional(),
    verify: z.boolean().optional(),
    captcha: z.boolean().optional(),
  }),
)

export type Input = z.infer<ReturnType<typeof baseSchema>> & { steps?: Input[] }
type SchemaType = z.ZodType<Input>
const inputSchema = lazySchema((): SchemaType => baseSchema().extend({ steps: z.array(z.lazy(() => inputSchema())).optional() }))

export type Output = {
  action: Input['action']
  result: string
  outcome: ToolEffectOutcome
  imagePath?: string
  inlinePath?: string
  inlineMediaType?: string
  screen?: ScreenMap
}

const ACT_FIELDS = ['settleMs', 'capture', 'region', 'label', 'verify']
const TARGET_FIELDS = ['target', 'depth', 'limit']
const ACTION_FIELDS: Readonly<Record<ComputerAction, readonly string[]>> = {
  screenshot: ['display', 'label', 'region'],
  click: ['x', 'y', 'modifiers', 'count', ...TARGET_FIELDS, ...ACT_FIELDS],
  doubleClick: ['x', 'y', 'modifiers', ...TARGET_FIELDS, ...ACT_FIELDS],
  rightClick: ['x', 'y', 'modifiers', ...TARGET_FIELDS, ...ACT_FIELDS],
  move: ['x', 'y', ...TARGET_FIELDS, ...ACT_FIELDS],
  drag: ['x', 'y', 'toX', 'toY', 'toTarget', 'modifiers', ...TARGET_FIELDS, ...ACT_FIELDS],
  scroll: ['x', 'y', 'dx', 'dy', 'modifiers', ...TARGET_FIELDS, ...ACT_FIELDS],
  type: ['text', ...ACT_FIELDS],
  key: ['key', ...ACT_FIELDS],
  hold: ['key', 'durationMs', ...ACT_FIELDS],
  wait: ['durationMs', 'until', 'depth', 'limit', 'scope', 'capture', 'region'],
  cursor: [],
  displays: [],
  frontmost: [],
  tree: ['depth', 'limit', 'scope'],
  find: ['target', 'depth', 'limit', 'scope'],
  sequence: ['steps', 'settleMs', 'capture', 'region'],
}

function permissionAction(input: Input): ComputerAction {
  return input.action === 'find' || (input.action === 'wait' && input.until !== undefined) ? 'tree' : input.action
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
    if (field === 'action' || field === 'captcha' || value === undefined) continue
    if (!allowed.includes(field)) return `${input.action} does not take ${field}`
  }
  return null
}

function tableRefusal(input: Input): string | null {
  if (input.captcha === true) return CAPTCHA_HANDOFF
  const stray = fieldRefusal(input)
  if (stray !== null) return stray
  const action = input.action
  if (action !== 'tree' && action !== 'find' && input.target === undefined && input.toTarget === undefined && input.until === undefined) {
    for (const field of ['depth', 'limit'] as const) if (input[field] !== undefined) return `${action} does not take ${field}`
  }
  for (const selector of [input.target, input.toTarget, input.until]) {
    if (selector !== undefined && (Object.keys(selector).length === 0 || Object.values(selector).some(value => typeof value !== 'string' || value.trim() === ''))) return 'a target needs a nonempty role, name or text — read tree first'
  }
  if (input.target !== undefined && (input.x !== undefined || input.y !== undefined)) return 'choose target or x/y, not both'
  if (input.toTarget !== undefined && (input.toX !== undefined || input.toY !== undefined)) return 'choose toTarget or toX/toY, not both'
  if (action === 'find' && input.target === undefined) return 'find requires target (role, name or text)'
  if (input.count !== undefined && ![1, 2, 3].includes(input.count)) return 'click count must be 1, 2 or 3'
  if (input.region !== undefined && input.display !== undefined) return 'region uses the last screenshot display — omit display'
  if (action === 'sequence') {
    if (!input.steps?.length) return 'sequence requires nonempty steps'
    for (const [index, step] of input.steps.entries()) {
      const parsed = inputSchema().safeParse(step)
      if (!parsed.success || (!ACT_ACTIONS.has(parsed.data.action) && !['tree', 'find', 'wait'].includes(parsed.data.action))) return `sequence step ${index + 1} must be an act, tree, find or wait; no nested sequence`
      if (parsed.data.capture !== undefined || parsed.data.region !== undefined || parsed.data.settleMs !== undefined) return `sequence step ${index + 1}: put capture, region and settleMs on the sequence`
      const refusal = tableRefusal(parsed.data)
      if (refusal !== null) return `sequence step ${index + 1}: ${refusal}`
    }
  }
  if (POINT_ACTIONS.has(action) && input.target === undefined && !(isNumber(input.x) && isNumber(input.y))) {
    return `${action} requires x and y (pixels of the last screenshot), or target from tree`
  }
  if (action === 'drag' && input.toTarget === undefined && !(isNumber(input.toX) && isNumber(input.toY))) {
    return 'drag requires toX and toY (the end, in the same pixels), or toTarget from tree'
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
  if (action === 'tree' || action === 'find' || input.target !== undefined || input.toTarget !== undefined || input.until !== undefined) {
    if (input.depth !== undefined && !(Number.isInteger(input.depth) && input.depth >= 0 && input.depth <= TREE_DEPTH_CAP)) {
      return `tree takes depth as a whole number from 0 to ${TREE_DEPTH_CAP} — ${String(input.depth)} is outside`
    }
    if (input.limit !== undefined && !(Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= TREE_LIMIT_CAP)) {
      return `tree takes limit as a whole number from 1 to ${TREE_LIMIT_CAP} — ${String(input.limit)} is outside`
    }
  }
  return null
}

interface ActPlan {
  point: DesktopPoint | null
  target: DesktopPoint | null
  chord: KeyChord | null
  modifiers: DesktopModifier[]
  beforeTree?: DesktopTree
  observe?: DesktopBounds
}

type Framed = { ok: true; point: DesktopPoint } | { ok: false; text: string }

function framePixel(map: ScreenMap | null, messages: readonly Message[], x: number, y: number): Framed {
  if (map === null) return { ok: false, text: NO_SCREENSHOT }
  if (map.toolUseId !== '' && !screenshotVisibleInContext(messages, map.toolUseId)) return { ok: false, text: SCREENSHOT_GONE }
  const point = pointOfPixel(map, x, y)
  if (isPixelOutside(point)) {
    return {
      ok: false,
      text: `(${x}, ${y}) is outside the last screenshot (${point.imageWidth}×${point.imageHeight} px) — ${map.region ? `coordinates refer to this region (origin ${map.originX},${map.originY} pt); take a full screenshot to return` : 'take a screenshot and use its pixels'}`,
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
    if (input.target === undefined) {
      const framed = framePixel(map, messages, input.x!, input.y!)
      if (!framed.ok) return { refusal: `${input.action} refused: ${framed.text}` }
      point = framed.point
    }
    if (input.action === 'drag' && input.toTarget === undefined) {
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
  return { point, target, chord, modifiers, ...(point ? { observe: { x: point.x - 24, y: point.y - 24, width: 48, height: 48 } } : {}) }
}

async function resolveActTargets(driver: DesktopDriver, input: Input, front: DesktopApplication, plan: ActPlan, signal: AbortSignal): Promise<string | null> {
  if (namesCaptcha(front.title ?? '')) return CAPTCHA_HANDOFF
  if (plan.chord !== null && isAppSwitchChord(plan.chord)) return null
  const fullReach = input.target !== undefined || input.toTarget !== undefined || input.verify === true
  const tree = await driver.accessibilityTree(front, { depth: input.depth ?? (fullReach ? TREE_DEPTH_CAP : TREE_DEPTH_DEFAULT), count: input.limit ?? (fullReach ? TREE_LIMIT_CAP : TREE_LIMIT_DEFAULT), scope: 'window' }, signal)
  if (!tree.ok) return input.target !== undefined || input.toTarget !== undefined ? faultText(input.action, tree.error) : null
  if (treeNamesCaptcha(tree.value)) return CAPTCHA_HANDOFF
  plan.beforeTree = tree.value
  for (const [selector, field] of [[input.target, 'point'], [input.toTarget, 'target']] as const) {
    if (selector === undefined) continue
    const point = targetPoint(tree.value, selector)
    if ('refusal' in point) return `${input.action} refused: ${point.refusal}${pageContentNote(tree.value) ? `; ${pageContentNote(tree.value)}` : ''}`
    plan[field] = point
    const frame = targetMatches(tree.value, selector)[0]?.frame
    if (field === 'point' && frame) plan.observe = frame
  }
  return null
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
  const own = await driver.ownTerminalApplication(front)
  const action = input.action
  if (!own.ok || own.value === null) {
    if (action === 'type' || action === 'hold' || (action === 'key' && !(plan.chord !== null && isAppSwitchChord(plan.chord)))) return `${action} refused: the terminal running this session could not be identified — keep the cockpit attached in a supported terminal before sending keystrokes`
    return null
  }
  if (own.value.identity !== front.identity) return null
  if (own.value.tty) {
    const current = await driver.frontmostApplication()
    if (!current.ok || current.value.identity !== front.identity || current.value.windowId !== front.windowId) {
      return `${action} refused: the front window changed while checking terminal ownership by tty — nothing done; take a screenshot and re-issue`
    }
  }
  const windowKnown = own.value.windowId != null && front.windowId != null
  if (windowKnown && own.value.windowId !== front.windowId) {
    for (const point of [plan.point, plan.target]) {
      if (point === null || (front.bounds !== null && insideBounds(point, front.bounds))) continue
      if (own.value.bounds === null) return `${action} refused: the point is outside the target window and the terminal running this session has unknown bounds — keep the act inside the target window`
      if (insideBounds(point, own.value.bounds)) return `${action} refused: ${pixelWordsOf(input, point, plan)} is inside the window of the terminal running this session`
    }
    return null
  }
  const windowCheck = windowKnown && own.value.tty ? '\nWindow ownership checked by tty.' : ''
  const unknownWindow = 'the terminal application running this session is in front, but its window identity is unknown — all windows of this application remain protected; switch to another application first'
  if (!windowKnown && (action === 'type' || action === 'hold' || (action === 'key' && !(plan.chord !== null && isAppSwitchChord(plan.chord))))) {
    return `${action} refused: ${unknownWindow}`
  }
  if (action === 'type' || action === 'hold') {
    return `${action} refused: the application in front is the terminal running this session — a keystroke there would land in this conversation; switch to the target application first${windowCheck}`
  }
  if (action === 'key') {
    if (plan.chord !== null && isAppSwitchChord(plan.chord)) return null
    return `key refused: the terminal running this session is in front — only the application switch chord (${switchChordWords()}) is allowed there; switch to the target application first${windowCheck}`
  }
  const points = [plan.point, plan.target].filter((point): point is DesktopPoint => point !== null)
  if (front.bounds === null) {
    if (!windowKnown) return `${action} refused: ${unknownWindow}; the front window's bounds are also unknown`
    return `${action} refused: the terminal running this session is in front and its window bounds are unknown — switch to the target application first${windowCheck}`
  }
  for (const point of points) {
    if (insideBounds(point, front.bounds)) {
      const pixel = pixelWordsOf(input, point, plan)
      if (!windowKnown) return `${action} refused: ${pixel} is inside the front window; ${unknownWindow}`
      return `${action} refused: ${pixel} is inside the window of the terminal running this session${windowCheck}`
    }
  }
  return null
}

function startWords(input: Input): string {
  return input.target ? targetWords(input.target) : `(${input.x}, ${input.y})`
}

function endWords(input: Input): string {
  return input.toTarget ? targetWords(input.toTarget) : `(${input.toX}, ${input.toY})`
}

function pixelWordsOf(input: Input, point: DesktopPoint, plan: ActPlan): string {
  if (plan.target !== null && point === plan.target) return `${endWords(input)}`
  return `${startWords(input)}`
}

function modifierWords(modifiers: readonly ModelModifier[] | undefined): string {
  return modifiers && modifiers.length > 0 ? ` +${modifiers.join('+')}` : ''
}

function actDetail(input: Input): string {
  switch (input.action) {
    case 'click':
    case 'doubleClick':
    case 'rightClick':
    case 'move':
      return ` ${startWords(input)}${modifierWords(input.modifiers)}`
    case 'drag':
      return ` ${startWords(input)} → ${endWords(input)}${modifierWords(input.modifiers)}`
    case 'scroll':
      return ` by ${input.dx ?? 0}, ${input.dy ?? 0} at ${startWords(input)}${modifierWords(input.modifiers)}`
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
      const count = input.action === 'doubleClick' ? 2 : input.action === 'click' ? (input.count ?? 1) as 1 | 2 | 3 : 1
      if ((await run.step(driver.click(plan.point!, button, count, signal))) === null) return run.failed()
      if (!(await run.up(plan.modifiers))) return run.failed()
      return { ok: true, words: `${input.action} ${startWords(input)}${input.count && input.count > 1 ? ` ×${input.count}` : ''}${modifierWords(input.modifiers)} → ${pointWords(plan.point!)}` }
    }
    case 'move': {
      if ((await run.step(driver.mouseMove(plan.point!, signal))) === null) return run.failed()
      return { ok: true, words: `move ${startWords(input)} → ${pointWords(plan.point!)}` }
    }
    case 'drag': {
      if (!(await run.down(plan.modifiers))) return run.failed()
      if ((await run.step(driver.drag(plan.point!, plan.target!, 'left', signal))) === null) return run.failed()
      if (!(await run.up(plan.modifiers))) return run.failed()
      return {
        ok: true,
        words: `drag ${startWords(input)} → ${endWords(input)}${modifierWords(input.modifiers)} · ${pointWords(plan.point!)} → ${pointWords(plan.target!)}`,
      }
    }
    case 'scroll': {
      if (!(await run.down(plan.modifiers))) return run.failed()
      if ((await run.step(driver.scroll(plan.point!, input.dx ?? 0, input.dy ?? 0, signal))) === null) return run.failed()
      if (!(await run.up(plan.modifiers))) return run.failed()
      return {
        ok: true,
        words: `scroll ${startWords(input)} by ${input.dx ?? 0}, ${input.dy ?? 0}${modifierWords(input.modifiers)} → ${pointWords(plan.point!)}`,
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

function treeLimitsOf(input: Input): DesktopTreeLimits {
  const targeted = input.action === 'find' || input.until !== undefined
  return { depth: input.depth ?? (targeted ? TREE_DEPTH_CAP : TREE_DEPTH_DEFAULT), count: input.limit ?? (targeted ? TREE_LIMIT_CAP : TREE_LIMIT_DEFAULT), scope: input.scope ?? 'window' }
}

function treeWords(app: DesktopApplication, tree: DesktopTree, limits: { depth: number; count: number }, map: ScreenMap | null): string {
  const deepest = tree.elements.reduce((most, element) => Math.max(most, element.depth), 0)
  const lines: string[] = [
    `tree: ${app.name} (${app.identity}) — ${tree.elements.length} element${tree.elements.length === 1 ? '' : 's'} to depth ${deepest} (limit ${limits.count}, depth ${limits.depth}) · frames @x,y w×h in screen points${map !== null ? '; (x, y) px is the element\'s centre in the last screenshot' : ''}`,
  ]
  for (const element of tree.elements) {
    const parts = [element.role]
    if (element.title !== null) parts.push(JSON.stringify(element.title))
    if (element.value !== null) parts.push(`value=${JSON.stringify(element.value)}`)
    const frame = element.frame
    if (element.focused === true) parts.push('[focused]')
    if (frame !== null) {
      parts.push(`@${Math.round(frame.x)},${Math.round(frame.y)} ${Math.round(frame.width)}×${Math.round(frame.height)}`)
      if (map !== null) {
        const pixel = pixelOfPoint(map, { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 })
        if (pixelOnScreen(map, pixel)) parts.push(`· (${pixel.x}, ${pixel.y}) px`)
      }
    }
    lines.push(`${'  '.repeat(element.depth)}${parts.join(' ')}`)
  }
  lines.push(tree.scope === undefined ? 'scope not reported by this driver' : `scope ${tree.scope}`)
  const pageNote = pageContentNote(tree)
  if (pageNote) lines.push(pageNote)
  if (tree.truncated) {
    lines.push(`truncated: the tree goes on past ${tree.reason !== null ? tree.reason : `the limit of ${limits.count} elements or depth ${limits.depth}`} — raise limit or depth to read more, or act on what is shown`)
  }
  return lines.join('\n')
}

async function factsLine(driver: DesktopDriver, map: ScreenMap | null): Promise<string> {
  return `${await cursorWords(driver, map)} · ${await frontmostWords(driver)}`
}

type Shot =
  | { ok: true; line: string; imagePath: string; inlinePath?: string; inlineMediaType?: string; screen: ScreenMap }
  | { ok: false; aborted: boolean; text: string }

function toolUseIdOfParent(parent: AssistantMessage | undefined): string | null {
  const content = (parent as { message?: { content?: unknown } } | undefined)?.message?.content
  if (!Array.isArray(content)) return null
  for (const block of [...content].reverse()) {
    const typed = block as { type?: unknown; name?: unknown; id?: unknown }
    if (typed.type === 'tool_use' && typed.name === COMPUTER_TOOL_NAME && typeof typed.id === 'string') return typed.id
  }
  return null
}

async function takeScreenshot(
  owner: OwnerKey,
  driver: DesktopDriver,
  context: ToolUseContext,
  toolUseId: string,
  wanted: number | undefined,
  label: string | undefined,
  signal: AbortSignal,
  region?: CaptureRegion,
  settleMs = 0,
  observe?: DesktopBounds,
): Promise<Shot> {
  const displays = await driver.displays()
  if (!displays.ok) return { ok: false, aborted: false, text: faultText('screenshot', displays.error) }
  const list = displays.value.displays
  if (list.length === 0) return { ok: false, aborted: false, text: 'screenshot failed: no display is attached' }
  const map = screenOf(owner)
  if (region !== undefined) {
    const refusal = regionRefusal(region, map)
    if (refusal !== null) return { ok: false, aborted: false, text: refusal }
    const frame = framePixel(map, context.messages ?? [], region.x, region.y)
    if (!frame.ok) return { ok: false, aborted: false, text: frame.text }
  }
  let index = region !== undefined ? map?.display : wanted
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
  let captured: Awaited<ReturnType<typeof settledCapture>>
  try {
    captured = await settledCapture(driver, display, signal, settleMs, region, map, observe)
  } catch (error) {
    return { ok: false, aborted: signal.aborted, text: `screenshot failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const capture = captured.capture
  const file = screenshotPath(label ?? `display-${display.index}`)
  writeFileSync(file, capture.png)
  pruneDesktopShots(dirname(file), DESKTOP_SHOTS_KEEP)
  let image = { width: capture.width, height: capture.height }
  let inlinePath: string | undefined
  let inlineMediaType: string | undefined
  const model = context.options?.engineModel ?? getEngineModel()
  if (modelReceivesImageBlocks(model)) {
    try {
      const resized = await maybeResizeAndDownsampleImageBuffer(capture.png, capture.png.length, 'png', { role: 'tool-result', model })
      const bytes = resized.buffer
      const header = imageDimensionsFromHeader(bytes)
      if (header === null) throw new Error('the inline screenshot has no readable dimensions')
      if (signal.aborted) return { ok: false, aborted: true, text: '' }
      image = { width: header.width, height: header.height }
      if (!bytes.equals(capture.png)) {
        inlinePath = `${file}.inline`
        writeFileSync(inlinePath, bytes)
        inlineMediaType = `image/${resized.mediaType}`
      }
    } catch (error) {
      return { ok: false, aborted: signal.aborted, text: `screenshot could not be prepared for the model: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const screen = screenMapOfCapture(toolUseId, capture, captured.points, image)
  if (region) screen.region = true
  const changedFrame = map !== null && ['displayId', 'originX', 'originY', 'pointWidth', 'pointHeight', 'imageWidth', 'imageHeight'].some(key => map[key as keyof ScreenMap] !== screen[key as keyof ScreenMap])
  const scale = `scale ${(screen.imageWidth / screen.pointWidth).toFixed(3)} px/pt${image.width !== capture.width || image.height !== capture.height ? ' (resized for the model route)' : ' (native capture pixels)'}`
  const frameWords = `${scale}${changedFrame ? '; frame changed: display, region or route image limits changed — previous coordinates do not apply' : ''}${region ? `; coordinates now refer to this region (origin ${screen.originX},${screen.originY} pt); take a full screenshot to return` : ''}`
  setScreen(owner, screen)
  noteScreenshot(owner, screen.toolUseId, file)
  const line = `screenshot: ${file} — display ${display.index} (${screenMapSizeWords(screen)}) · ${frameWords} · ${await factsLine(driver, screen)}${captured.settled ? ` · ${captured.settled}` : ''}`
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

function imageRefusalText(model: string, route: string | null, error: string): string {
  const where = route !== null ? providerDisplayName(route) : 'its'
  return `the model on the ${where} route refused the image: ${error} — ${model} cannot drive the screen until the route carries images; switch to a model that receives images (/model)`
}

async function routeRefusal(model: string): Promise<string | null> {
  const verdict = classifyModelRoute(model)
  const route = verdict.kind === 'route' ? verdict.route : null
  if (!modelReceivesImageBlocks(model)) return textOnlyRefusal(model, route)
  if (route === 'openai') {
    const { imagesSupportedForModel } = await import('../../services/providers/openai/openaiCallModel.js')
    if (!imagesSupportedForModel(model)) return textOnlyRefusal(model, route)
  }
  const refused = imageRefusedFor(normalizeModelStringForAPI(model))
  if (refused !== null) return imageRefusalText(model, route, refused)
  return null
}

function ruleFor(permissionContext: ToolPermissionContext | undefined, content: string): PermissionRule | null {
  if (!permissionContext) return null
  for (const behavior of ['deny', 'ask', 'allow'] as const) {
    const rule = getRuleByContentsForToolName(permissionContext, COMPUTER_TOOL_NAME, behavior).get(content)
    if (rule) return rule
  }
  return null
}

function ruleVerdict(permissionContext: ToolPermissionContext | undefined, content: string): 'deny' | 'ask' | 'allow' | null {
  return ruleFor(permissionContext, content)?.ruleBehavior ?? null
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
    return `Drive the operator's screen. Read tree first; screenshot for pixels. Coordinates are pixels of the last screenshot; renew after compaction or a frame change. target:{role?,name?,text?}: role/name exact, text substring, one match required. Acts resolve at the tree caps unless depth/limit is given.

screenshot(display?,label?,region?) captures under the cursor. region:{x,y,width,height} crops the last screenshot's pixels and becomes the coordinate frame; a full screenshot returns.
click(x,y OR target,count? 1–3,modifiers?) · doubleClick · rightClick · move (hover). drag also takes toX,toY OR toTarget. scroll takes dx/dy wheel notches, positive down/right. Modifiers: Shift/Control/Alt/Meta.
type(text): up to ${TYPE_TEXT_CAP} chars; only newline/tab controls. key(key) taps; hold(key,durationMs) holds 50–${HOLD_CAP_MS}ms. Keys: ${KEY_CHORD_VOCABULARY}.
action:"tree" (depth?, limit?) — read-only: role, title, value and frame; a cut is said; no clipboard, no input. Marks focus. scope:window by default; scope:app includes other windows/menus. Budgets ${TREE_DEPTH_DEFAULT}/${TREE_LIMIT_DEFAULT}, caps ${TREE_DEPTH_CAP}/${TREE_LIMIT_CAP}. find(target) filters it.
wait(durationMs?,until?) pauses or polls the tree for a target (default ${WAIT_DEFAULT_MS}, cap ${WAIT_CAP_MS}ms). capture:false skips the image. cursor/displays/frontmost are cheap facts.
sequence(steps:[acts,tree,find,wait]) checks each step just as alone; first failure stops; no nesting. Set capture/region/settleMs on the sequence, not steps; one final screenshot.
Acts take label and verify:true for a tree change check (not task confirmation; no blind retry). capture:false skips capture/settle. settleMs caps matching-frame waits (${SETTLE_DEFAULT_MS} default, ${SETTLE_CAP_MS} max); target-local stability is not whole-page readiness. Use wait-until for that.

The first act in an application asks; later acts ride its grant. Other reads never ask; tree asks like an act. find/wait-until use tree's permission. Sovereign runs without asks. One session drives at a time. Never type into this session's terminal: only the application-switch chord is allowed there; clicks stay outside its window. esc/ctrl+c interrupts and releases input. Acts pause for operator typing, refusing if it continues.
Never solve a captcha: send captcha:true for a visual challenge and hand it to the operator; named tree challenges also refuse. Screenshots leave saved history.`
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
    return input?.action !== 'sequence' && READ_ACTIONS.has(input ? permissionAction(input) : '')
  },
  requiresUserInteraction() {
    return computerAccessPinnedToAsk()
  },
  interruptBehavior() {
    return 'cancel' as const
  },
  async validateInput(input: Input, context: ToolUseContext) {
    if (!flagEnabled('MERCURY_COMPUTER_USE')) {
      return refuse("the Computer tool is off — MERCURY_COMPUTER_USE=0 in this session's environment removes it; unset it before the session starts")
    }
    const posture = desktopPostureRefusal(context)
    if (posture !== null && context.agentId) return refuse(posture)
    const model = context?.options?.engineModel ?? getEngineModel()
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
    const posture = desktopPostureRefusal(context)
    if (posture !== null && !context.agentId) return denied(posture, 'desktop session policy')
    if (input.captcha === true) return denied(CAPTCHA_HANDOFF, 'captcha handoff')
    if (!ASK_ACTIONS.has(permissionAction(input))) return { behavior: 'allow' as const, updatedInput: input }
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
    const home = noteTurnHome(owner, turnKeyOf(context), { identity: app.identity, name: app.name })
    const plan = planOf(owner, context, input)
    if (isPlanRefusal(plan)) return denied(plan.refusal, 'the act has no screenshot frame')
    const terminal = permissionAction(input) === 'tree' ? null : await ownTerminalRefusal(driver, input, app, plan)
    if (terminal !== null) return denied(terminal, 'the own-terminal guard refused the act')
    const permissionContext = (context as Partial<ToolUseContext> | undefined)?.getAppState?.()
      ?.toolPermissionContext as ToolPermissionContext | undefined
    const content = `app:${app.identity}`
    const ruled = ruleVerdict(permissionContext, content)
    if (ruled === 'deny') {
      return denied(ruleSentence(`Driving ${app.name} (${app.identity})`, 'deny', ruleFor(permissionContext, content)!), `${content} carries a deny rule`)
    }
    noteCheckedActApp(owner, input.action, { identity: app.identity, name: app.name })
    if (ruled === 'allow' || (ruled === null && appApproved(owner, app.identity))) {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    const access = resolveComputerAccess(savedComputerAccess(), permissionContext !== undefined && postureBypassesAsks(permissionContext))
    const opened = access.value === 'full' || (access.value === 'permissive' && home.identity === app.identity)
    if (ruled === null && (opened || readComputerGrant(String(getSessionId())) !== null)) {
      noteCheckedActApp(owner, input.action, { identity: app.identity, name: app.name }, true)
      return { behavior: 'allow' as const, updatedInput: input }
    }
    return {
      behavior: 'ask' as const,
      message: `Computer ${input.action}${actDetail(input)} in ${app.name} (${app.identity}) — first act in this application this session (${permissionAction(input) === 'tree' ? 'reads its accessibility tree: the controls with their titles, values and frames' : 'drives your mouse and keyboard'})`,
      decisionReason: {
        type: 'safetyCheck' as const,
        reason: `${app.name} (${app.identity}) is in front of the operator's screen; the first act there needs the operator's own consent`,
        operatorOnly: true,
      },
      suggestions: suggestionForExactCommand(COMPUTER_TOOL_NAME, content),
    }
  },
  async call(input: Input, context: ToolUseContext, canUseTool?: CanUseToolFn, parentAssistantMessage?: AssistantMessage): Promise<{ data: Output; effect: ToolEffect }> {
    const startedAt = Date.now()
    const owner = ownerFromToolUseContext((context ?? {}) as { owner?: OwnerKey; agentId?: string })
    const signal = context.abortController?.signal ?? new AbortController().signal
    const toolUseId = context.toolUseId ?? toolUseIdOfParent(parentAssistantMessage) ?? ''
    let result: string
    let outcome: ToolEffectOutcome = 'no-change'
    let imagePath: string | undefined
    let inlinePath: string | undefined
    let inlineMediaType: string | undefined
    let screen: ScreenMap | undefined
    let claimedForAct = false
    const posture = desktopPostureRefusal(context)
    if (posture !== null) {
      result = `policy denial: ${posture}`
      outcome = 'failed'
      return finish()
    }
    const resolution = resolveDesktopDriver()
    if (resolution.state === 'unavailable') {
      result = `no desktop driver: ${resolution.note}${resolution.remedy ? ` — ${resolution.remedy}` : ''}`
      outcome = 'failed'
      return finish()
    }
    const driver = resolution.driver
    const permissions = await driver.permissions()
    if (permissions.ok) rememberDesktopPermissions(permissions.value)
    const takeShot = (wanted: number | undefined, label: string | undefined, settleMs = 0, observe?: DesktopBounds): Promise<Shot> =>
      takeScreenshot(owner, driver, context, toolUseId, wanted, label, signal, input.region, settleMs, observe)
    const adoptShot = (shot: Extract<Shot, { ok: true }>): void => {
      imagePath = shot.imagePath
      inlinePath = shot.inlinePath
      inlineMediaType = shot.inlineMediaType
      screen = shot.screen
    }
    try {
      const invalid = tableRefusal(input)
      const badRegion = input.region === undefined ? null : regionRefusal(input.region, screenOf(owner))
      if (invalid !== null || badRegion !== null) {
        result = invalid ?? badRegion!
        outcome = 'failed'
        return finish()
      }
      if (input.action === 'sequence') {
        const steps = input.steps!.map(step => inputSchema().parse(step))
        const lines: string[] = []
        let completed = 0
        for (const step of steps) {
          if (signal.aborted) {
            await driver.releaseAll()
            result = `sequence ${completed}/${steps.length} completed · ${interruptedText('sequence')}`
            outcome = 'failed'
            return finish()
          }
          let decision: PermissionDecision = await ComputerTool.checkPermissions(step, context)
          if (decision.behavior !== 'deny') {
            if (!canUseTool || !parentAssistantMessage) {
              result = `sequence ${completed}/${steps.length} completed · a permission host is required for ${step.action}; run that act separately`
              outcome = 'failed'
              return finish()
            }
            decision = await canUseTool(ComputerTool, step, context, parentAssistantMessage, toolUseId)
          }
          if (decision.behavior !== 'allow') {
            result = `sequence ${completed}/${steps.length} completed · ${'message' in decision ? decision.message : 'permission not granted'}; nothing further done`
            outcome = 'failed'
            return finish()
          }
          const answer = await ComputerTool.call(ACT_ACTIONS.has(step.action) || step.action === 'wait' ? { ...step, capture: false } : step, context, canUseTool, parentAssistantMessage)
          lines.push(answer.data.result)
          if (answer.data.outcome !== 'succeeded') {
            result = `sequence ${completed}/${steps.length} completed\n${lines.join('\n')}`
            outcome = 'failed'
            return finish()
          }
          completed++
        }
        outcome = 'succeeded'
        result = `sequence ${completed}/${steps.length} completed\n${lines.join('\n')}`
        if (input.capture !== false) {
          const shot = await takeShot(undefined, undefined, clamp(input.settleMs ?? SETTLE_DEFAULT_MS, 0, SETTLE_CAP_MS))
          if (shot.ok) {
            adoptShot(shot)
            result += `\n${shot.line}`
          } else {
            result += `\n${shot.aborted ? interruptedAfterActText('sequence') : shot.text}`
            if (shot.aborted) outcome = 'failed'
          }
        }
        return finish()
      }
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
        const checked = consumeCheckedAct(owner, input.action)
        const judged: DesktopJudgedApp | null = checked?.app ?? null
        const viaGrant = checked?.viaGrant === true
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
        const atAct = await driver.frontmostApplication()
        if (!atAct.ok || atAct.value.identity !== front.value.identity || atAct.value.windowId !== front.value.windowId || JSON.stringify(atAct.value.bounds) !== JSON.stringify(front.value.bounds)) {
          result = `${input.action} refused: the front window changed before the act — nothing done; take a screenshot and re-issue`
          outcome = 'failed'
          return finish()
        }
        if (!(await waitForOperatorPause(driver, signal))) {
          if (signal.aborted) await driver.releaseAll()
          result = signal.aborted ? interruptedText(input.action) : `${input.action} refused: ${OPERATOR_TYPING_REFUSAL}`
          outcome = 'failed'
          return finish()
        }
        const targeting = await resolveActTargets(driver, input, front.value, plan, signal)
        const resolvedTerminal = targeting === null ? await ownTerminalRefusal(driver, input, front.value, plan) : null
        if (targeting !== null || resolvedTerminal !== null) {
          result = targeting ?? resolvedTerminal!
          outcome = 'failed'
          return finish()
        }
        if (await operatorIsTyping(driver)) {
          result = `${input.action} refused: ${OPERATOR_TYPING_REFUSAL}`
          outcome = 'failed'
          return finish()
        }
        const claim = await claimDesktop(signal, live)
        if (!claim.held) {
          result = claim.aborted === true ? interruptedText(input.action) : `computer refused: ${desktopClaimBusyNote(claim.holder)}`
          outcome = 'failed'
          return finish()
        }
        claimedForAct = true
        const ready = await driver.frontmostApplication()
        if (!ready.ok || !sameWindow(ready.value, front.value)) {
          result = `${input.action} refused: the front window changed before the act — nothing done; take a screenshot and re-issue`
          outcome = 'failed'
          return finish()
        }
        setDrivingApp(live)
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
        if (!viaGrant) approveApp(owner, judged ?? live)
        outcome = 'succeeded'
        let observed = treeObservation(plan.beforeTree)
        if (input.verify) {
          const after = await driver.frontmostApplication()
          if (!after.ok || !sameWindow(after.value, front.value)) observed += ' · verification: front window changed — read tree in the application now in front'
          else {
            const tree = await driver.accessibilityTree(after.value, { depth: TREE_DEPTH_CAP, count: TREE_LIMIT_CAP, scope: 'window' }, signal)
            const current = await driver.frontmostApplication()
            observed = !current.ok || !sameWindow(current.value, after.value) ? 'verification unknown: front window changed while reading — take a screenshot' : verificationWords(plan.beforeTree, tree.ok ? tree.value : undefined)
          }
        }
        if (observed) act.words += ` · ${observed}`
        if (input.label) act.words += ` · ${input.label}`
        if (input.capture === false) {
          result = `${act.words} · ${await factsLine(driver, screenOf(owner))}`
          return finish()
        }
        if (signal.aborted) {
          await driver.releaseAll()
          result = interruptedAfterActText(input.action)
          outcome = 'failed'
          return finish()
        }
        const shot = await takeShot(undefined, input.label, clamp(input.settleMs ?? SETTLE_DEFAULT_MS, 0, SETTLE_CAP_MS), input.region ? undefined : plan.observe)
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
      const turnFront = await driver.frontmostApplication()
      if (turnFront.ok) noteTurnHome(owner, turnKeyOf(context), { identity: turnFront.value.identity, name: turnFront.value.name })
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
          if (input.until !== undefined) {
            const checked = consumeCheckedAct(owner, 'wait')
            if (!turnFront.ok || (checked !== null && checked.app.identity !== turnFront.value.identity)) {
              result = 'wait refused: the application changed since the permission check — re-issue for the application in front'
              outcome = 'failed'
              break
            }
            const app = turnFront.value
            const deadline = Date.now() + pause
            const waitingSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(pause))])
            let matched = false
            let pageNote = ''
            while (!waitingSignal.aborted) {
              const before = await driver.frontmostApplication()
              if (!before.ok || !sameWindow(before.value, app)) {
                result = 'wait refused: the front window changed while waiting — re-issue'
                outcome = 'failed'
                return finish()
              }
              if (waitingSignal.aborted) break
              const tree = await driver.accessibilityTree(app, treeLimitsOf(input), waitingSignal)
              if (waitingSignal.aborted) break
              const after = await driver.frontmostApplication()
              if (waitingSignal.aborted) break
              if (!tree.ok || !after.ok || !sameWindow(after.value, app)) {
                result = !tree.ok ? faultText('wait', tree.error) : 'wait refused: the front window changed while reading — re-issue'
                outcome = 'failed'
                return finish()
              }
              if (checked?.viaGrant !== true) approveApp(owner, { identity: app.identity, name: app.name })
              if (treeNamesCaptcha(tree.value)) {
                result = CAPTCHA_HANDOFF
                outcome = 'failed'
                return finish()
              }
              pageNote = pageContentNote(tree.value)
              if (targetMatches(tree.value, input.until).length > 0) { matched = true; break }
              if (Date.now() >= deadline) break
              await sleep(Math.min(100, Math.max(0, deadline - Date.now())), signal)
            }
            if (!matched) {
              result = signal.aborted ? interruptedText('wait') : `wait timed out after ${pause}ms: ${targetWords(input.until)} not found — ${pageNote || 'read tree and check the target'}`
              outcome = 'failed'
              break
            }
          } else await sleep(pause, signal)
          if (input.capture === false && !signal.aborted) {
            result = `wait ${input.until ? `found ${targetWords(input.until)}` : `${pause}ms`} · ${await factsLine(driver, screenOf(owner))}`
            outcome = 'succeeded'
            break
          }
          if (signal.aborted) {
            result = interruptedText('wait')
            outcome = 'failed'
            break
          }
          const shot = await takeShot(undefined, undefined)
          if (!shot.ok) {
            result = shot.aborted ? interruptedText('wait') : `wait ${input.until ? `found ${targetWords(input.until)}` : `${pause}ms`} · ${shot.text}`
            outcome = 'failed'
            break
          }
          adoptShot(shot)
          result = `wait ${input.until ? `found ${targetWords(input.until)}` : `${pause}ms`} · ${shot.line}`
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
        case 'find':
        case 'tree': {
          const checked = consumeCheckedAct(owner, input.action)
          const judged: DesktopJudgedApp | null = checked?.app ?? null
          if (!turnFront.ok) {
            result = faultText('tree', turnFront.error)
            outcome = 'failed'
            break
          }
          const app = turnFront.value
          if (judged !== null && judged.identity !== app.identity) {
            result = `tree refused: the screen moved from ${judged.name} (${judged.identity}) to ${app.name} (${app.identity}) between the permission check and the read — nothing read; re-issue`
            outcome = 'failed'
            break
          }
          const limits = treeLimitsOf(input)
          const tree = await driver.accessibilityTree(app, limits, signal)
          if (!tree.ok) {
            result = tree.error.kind === 'aborted' ? interruptedText('tree') : faultText('tree', tree.error)
            outcome = 'failed'
            break
          }
          const after = await driver.frontmostApplication()
          if (!after.ok || !sameWindow(after.value, app)) {
            result = `${input.action} refused: the front window changed while reading — re-issue`
            outcome = 'failed'
            break
          }
          if (checked?.viaGrant !== true) approveApp(owner, judged ?? { identity: app.identity, name: app.name })
          const shown = input.action === 'find' ? { ...tree.value, elements: targetMatches(tree.value, input.target!) } : tree.value
          result = treeWords(app, shown, limits, screenOf(owner))
          if (treeNamesCaptcha(tree.value)) result += `\n${CAPTCHA_HANDOFF}`
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
      if (claimedForAct && !signal.aborted) renewDesktopClaim()
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
    if (output.imagePath && modelReceivesImageBlocks(getEngineModel())) {
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
      output.imagePath && !modelReceivesImageBlocks(getEngineModel())
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
