import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod/v4'
import type { ToolEffectOutcome } from '../../kit/tool.js'
import { flagEnabled } from '../../../platform/substrate/flagRegistry.js'
import { lazySchema } from '../../../platform/primitives/lazySchema.js'
import { resolveDesktopDriver } from '../../../integrations/desktop/resolveDriver.js'
import type { DesktopModifier } from '../../../integrations/desktop/driver.js'
import { KEY_CHORD_VOCABULARY, isAppSwitchChord, isKeyChordRefusal, parseKeyChord } from '../keyChord.js'
import type { ScreenMap } from '../screenMap.js'
import { waitConditionRefusal } from '../waitCondition.js'
import type { ActPlan } from './plan.js'

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
  'tree',
  'find',
  'sequence',
  'read',
  'focusApp',
  'file',
  'fill',
  'fields',
] as const
type ComputerAction = (typeof ACTIONS)[number]

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
  'file',
  'fill',
])
export const ASK_ACTIONS: ReadonlySet<string> = new Set([...ACT_ACTIONS, 'tree', 'focusApp'])
export const POINT_ACTIONS: ReadonlySet<string> = new Set(['click', 'doubleClick', 'rightClick', 'move', 'drag', 'scroll', 'file'])
export const READ_ACTIONS: ReadonlySet<string> = new Set(['screenshot', 'wait', 'cursor', 'displays', 'frontmost', 'tree'])
export const FACT_ACTIONS: ReadonlySet<string> = new Set(['cursor', 'displays', 'frontmost'])
const CONTENT_ACTIONS: ReadonlySet<string> = new Set(['screenshot', 'tree', 'find', 'read', 'fields'])
export const TREE_READS: ReadonlySet<string> = new Set(['tree', 'find', 'fields'])
export const FIELD_ROLES = /^(AX)?(TextField|TextArea|SearchField|SecureTextField|ComboBox|PopUpButton|MenuButton|CheckBox|RadioButton|Slider|DateField|TimeField|Incrementor|ToggleButton)(?:$| \()/i

export function carriesScreenContent(input: Input, image: boolean): boolean {
  return image || CONTENT_ACTIONS.has(input.action) || (input.action === 'sequence' && (input.steps ?? []).some(step => CONTENT_ACTIONS.has(step.action)))
}

const MODIFIERS = ['Shift', 'Control', 'Alt', 'Meta'] as const
export type ModelModifier = (typeof MODIFIERS)[number]
export const MODIFIER_KEYS: Readonly<Record<ModelModifier, DesktopModifier>> = {
  Shift: 'shift',
  Control: 'control',
  Alt: 'alt',
  Meta: 'super',
}

export const SETTLE_DEFAULT_MS = 300
export const SETTLE_CAP_MS = 5_000
export const WAIT_DEFAULT_MS = 1_000
export const UNTIL_DEFAULT_MS = 5_000
export const WAIT_CAP_MS = 10_000
export const FILE_DIALOG_MS = 3_000
export const FILE_CLOSE_MS = 8_000
export const FILE_KEY_GAP_MS = 400
export const FIELD_VALUE_CHARS = 300
const HOLD_MIN_MS = 50
export const HOLD_CAP_MS = 5_000
export const TYPE_TEXT_CAP = 4_000
export const TREE_DEPTH_DEFAULT = 12
export const TREE_DEPTH_CAP = 32
export const TREE_LIMIT_DEFAULT = 400
export const TREE_LIMIT_CAP = 2_000

export function computerToolEnabled(): boolean {
  if (!flagEnabled('MERCURY_COMPUTER_USE')) return false
  return resolveDesktopDriver().state === 'ok'
}

const targetSchema = lazySchema(() => z.strictObject({ role: z.string().optional(), name: z.string().optional(), text: z.string().optional(), nth: z.number().int().positive().optional() }))
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
    full: z.boolean().optional(),
    pixels: z.boolean().optional(),
    scale: z.number().min(0.25).max(1).optional(),
    label: z.string().optional(),
    depth: z.number().optional(),
    limit: z.number().optional(),
    target: targetSchema().optional(),
    ref: z.number().int().positive().optional(),
    root: z.union([z.number().int().positive(), targetSchema()]).optional(),
    all: z.boolean().optional(),
    points: z.boolean().optional(),
    clipboard: z.boolean().optional(),
    focusApp: z.strictObject({ name: z.string() }).optional(),
    toTarget: targetSchema().optional(),
    until: z.strictObject({ role: z.string().optional(), name: z.string().optional(), text: z.string().optional(), title: z.string().optional(), url: z.string().optional(), dialog: z.boolean().optional(), focus: z.string().optional(), gone: z.boolean().optional() }).optional(),
    count: z.number().optional(),
    region: z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
    scope: z.enum(['window', 'app']).optional(),
    verify: z.boolean().optional(),
    captcha: z.boolean().optional(),
    path: z.string().optional(),
  }),
)

export type Input = z.infer<ReturnType<typeof baseSchema>> & { steps?: Input[] }
export type SchemaType = z.ZodType<Input>
export const inputSchema = lazySchema((): SchemaType => baseSchema().extend({ steps: z.array(z.lazy(() => inputSchema())).optional() }))
export const modelInputSchema = lazySchema(() => {
  const base = baseSchema()
  const step = base.extend({ action: z.enum(ACTIONS.filter(action => action !== 'sequence')) })
  const f = base.shape
  return base.extend({
    x: f.x.describe('Last-screenshot x; paired with y.'),
    y: f.y.describe('Last-screenshot y; paired with x.'),
    toX: f.toX.describe('drag: destination x.'),
    toY: f.toY.describe('drag: destination y.'),
    dx: f.dx.describe('scroll: horizontal notches (+right).'),
    dy: f.dy.describe('scroll: vertical notches (+down).'),
    text: f.text.describe(`type or fill: ≤${TYPE_TEXT_CAP} chars; newline/tab are the only control chars.`),
    key: f.key.describe(`Key chord: ${KEY_CHORD_VOCABULARY}.`),
    durationMs: f.durationMs.describe(`hold: ${HOLD_MIN_MS}–${HOLD_CAP_MS} ms; wait: default ${WAIT_DEFAULT_MS} (${UNTIL_DEFAULT_MS} with until), max ${WAIT_CAP_MS} ms.`),
    display: f.display.describe('Display index (default front window); applies with capture:true.'),
    settleMs: f.settleMs.describe(`Post-act delay in ms (default ${SETTLE_DEFAULT_MS}, cap ${SETTLE_CAP_MS}); not readiness.`),
    capture: f.capture.describe('Capture after act; sequence captures once at end (screenshot steps in place); wait-until on match; false suppresses.'),
    full: f.full.describe('Capture display instead of front window (including capture:true).'),
    pixels: f.pixels.describe('Terminal pixels instead of accessibility text.'),
    scale: f.scale.describe('Capture scale (default 0.5 window, 1 display/region).'),
    depth: f.depth.describe(`Tree depth (default ${TREE_DEPTH_DEFAULT}, clamped at ${TREE_DEPTH_CAP}; targets default to cap).`),
    limit: f.limit.describe(`Tree rows (default ${TREE_LIMIT_DEFAULT}, clamped at ${TREE_LIMIT_CAP}; targets default to cap).`),
    target: f.target.describe('Exact role/name, substring text; unique match, or 1-based nth.'),
    ref: f.ref.describe('Node id from latest tree/find (stale once the list changes); alternative to target or x/y.'),
    root: f.root.describe('Tree root: ref or target.'),
    all: f.all.describe('Include hidden nodes.'),
    points: f.points.describe('Include node pixel coordinates.'),
    clipboard: f.clipboard.describe('read: clipboard text (separate consent) instead of target/ref.'),
    focusApp: f.focusApp.describe('Focus running app by name or bundle id; capture after.'),
    toTarget: f.toTarget.describe('drag: destination target instead of toX/toY.'),
    until: f.until.describe('wait: text/title/url substring, role/name, dialog:true or focus role; gone waits for removal.'),
    count: f.count.describe('click: 1–3.'),
    region: f.region.describe('Capture box in last-screenshot pixels.'),
    scope: f.scope.describe('Tree scope: window (default); app adds its other windows.'),
    verify: f.verify.describe('Diff trees after act (reports change, not task success).'),
    captcha: f.captcha.describe('Ask operator before acting on a visible challenge.'),
    path: f.path.describe('file: absolute path for native file dialog.'),
    steps: z.array(step).optional().describe('Non-nested sequence; stops on failure or wait-until timeout. Put capture/region/scale/settleMs on sequence.'),
  })
})

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
const TARGET_FIELDS = ['target', 'ref', 'depth', 'limit']
const ACTION_FIELDS: Readonly<Record<ComputerAction, readonly string[]>> = {
  screenshot: ['display', 'label', 'region', 'full', 'pixels', 'scale'],
  click: ['x', 'y', 'modifiers', 'count', ...TARGET_FIELDS, ...ACT_FIELDS],
  doubleClick: ['x', 'y', 'modifiers', ...TARGET_FIELDS, ...ACT_FIELDS],
  rightClick: ['x', 'y', 'modifiers', ...TARGET_FIELDS, ...ACT_FIELDS],
  move: ['x', 'y', ...TARGET_FIELDS, ...ACT_FIELDS],
  drag: ['x', 'y', 'toX', 'toY', 'toTarget', 'modifiers', ...TARGET_FIELDS, ...ACT_FIELDS],
  scroll: ['x', 'y', 'dx', 'dy', 'modifiers', ...TARGET_FIELDS, ...ACT_FIELDS],
  type: ['text', ...ACT_FIELDS],
  key: ['key', ...ACT_FIELDS],
  hold: ['key', 'durationMs', ...ACT_FIELDS],
  wait: ['durationMs', 'until', 'depth', 'limit', 'scope', 'capture', 'region', 'scale', 'label'],
  cursor: [],
  displays: [],
  frontmost: [],
  read: ['target', 'ref', 'clipboard', 'depth', 'limit'],
  focusApp: ['focusApp', 'capture', 'settleMs', 'label'],
  tree: ['depth', 'limit', 'scope', 'pixels', 'root', 'all', 'points'],
  find: ['target', 'depth', 'limit', 'scope', 'root', 'all', 'points'],
  sequence: ['steps', 'settleMs', 'capture', 'region', 'scale', 'label'],
  file: ['x', 'y', 'path', 'durationMs', ...TARGET_FIELDS, ...ACT_FIELDS],
  fill: ['text', ...TARGET_FIELDS, ...ACT_FIELDS],
  fields: ['depth', 'limit', 'scope', 'root', 'all', 'points'],
}

export function permissionAction(input: Input): ComputerAction {
  return input.action === 'read' || input.action === 'find' || input.action === 'fields' || (input.action === 'wait' && input.until !== undefined) ? 'tree' : input.action
}

export function typesKeys(input: Input, plan: ActPlan): boolean {
  return input.action === 'type' || input.action === 'hold' || input.action === 'fill' || input.action === 'file' || (input.action === 'key' && !(plan.chord !== null && isAppSwitchChord(plan.chord)))
}

export const NO_SCREENSHOT = 'no screenshot yet — coordinates are pixels of the last screenshot; take one first'
export const SCREENSHOT_GONE =
  'the last screenshot is no longer in the conversation — coordinates are pixels of a screenshot you can see; take a new one first'
export const SCREENSHOT_UNSEEN =
  'the last screenshot was taken in this same message — you have not seen it; take the screenshot alone, then the region or the act'
export const SCREENSHOT_NOT_RETURNED =
  "screenshot taken by the step but not returned: a failed answer carries no image, so the previous screenshot's coordinates still apply — take the screenshot alone to see it"
export const SCREENSHOT_SUPERSEDED =
  "screenshot taken by an earlier step but not returned: the terminal text below is this answer's content, so the previous screenshot's coordinates still apply — take the screenshot alone to see it"

export function refuse(message: string): { result: false; message: string; errorCode: number } {
  return { result: false, message, errorCode: 1 }
}

export function clamp(value: number, floor: number, cap: number): number {
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
    if (ACT_ACTIONS.has(input.action) && input.capture === true && ['scale', 'full', 'display'].includes(field)) continue
    if (!allowed.includes(field)) return `${input.action} does not take ${field}`
  }
  return null
}

export function tableRefusal(input: Input): string | null {
  const stray = fieldRefusal(input)
  if (stray !== null) return stray
  const action = input.action
  if (!TREE_READS.has(action) && action !== 'read' && input.target === undefined && input.ref === undefined && input.toTarget === undefined && input.until === undefined) {
    for (const field of ['depth', 'limit'] as const) if (input[field] !== undefined) return `${action} does not take ${field}`
  }
  if (input.until !== undefined) {
    const refusal = waitConditionRefusal(input.until)
    if (refusal) return refusal
  }
  for (const ref of [input.ref, typeof input.root === 'number' ? input.root : undefined]) {
    if (ref !== undefined && (!Number.isInteger(ref) || ref < 1)) return 'ref requires a positive row number from tree'
  }
  if (input.ref !== undefined && (input.target !== undefined || input.x !== undefined || input.y !== undefined)) return 'choose ref, target or x/y, not more than one'
  if (action === 'read' && Number(input.clipboard === true) + Number(input.target !== undefined) + Number(input.ref !== undefined) !== 1) return 'read requires one target, ref or clipboard:true'
  if (action === 'focusApp' && (typeof input.focusApp?.name !== 'string' || !input.focusApp.name.trim())) return 'focusApp requires a nonempty application name or bundle id'
  for (const selector of [input.target, input.toTarget, typeof input.root === 'object' ? input.root : undefined]) {
    if (selector === undefined) continue
    if (![selector.role, selector.name, selector.text].some(value => typeof value === 'string' && value.trim() !== '') || [selector.role, selector.name, selector.text].some(value => value !== undefined && (typeof value !== 'string' || value.trim() === ''))) return 'a target needs a nonempty role, name or text — read tree first'
    if (selector.nth !== undefined && (!Number.isInteger(selector.nth) || selector.nth < 1)) return 'target.nth must be a whole number starting at 1'
  }
  if (input.target !== undefined && (input.x !== undefined || input.y !== undefined)) return 'choose target or x/y, not both'
  if (input.toTarget !== undefined && (input.toX !== undefined || input.toY !== undefined)) return 'choose toTarget or toX/toY, not both'
  if (action === 'find' && input.target === undefined) return 'find requires target (role, name or text)'
  if (input.count !== undefined && ![1, 2, 3].includes(input.count)) return 'click count must be 1, 2 or 3'
  if (input.region !== undefined && input.display !== undefined) return 'region uses the last screenshot display — omit display'
  if (input.label !== undefined) {
    if (action === 'wait' && !(input.capture === true || (input.until !== undefined && input.capture !== false))) return 'wait takes label only with a capture'
    if (action === 'sequence' && (input.capture === false || input.steps?.at(-1)?.action === 'screenshot')) return 'sequence takes label only for its final capture — put the label on the screenshot step, or drop capture: false'
  }
  if (action === 'sequence') {
    if (!input.steps?.length) return 'sequence requires nonempty steps'
    for (const [index, step] of input.steps.entries()) {
      const parsed = inputSchema().safeParse(step)
      if (!parsed.success || (!ACT_ACTIONS.has(parsed.data.action) && !['tree', 'find', 'fields', 'wait', 'screenshot', 'read', 'focusApp'].includes(parsed.data.action))) return `sequence step ${index + 1} must be an act, tree, find, fields, wait, screenshot, read or focusApp; no nested sequence`
      if (parsed.data.action !== 'screenshot' && (parsed.data.capture !== undefined || parsed.data.region !== undefined || parsed.data.settleMs !== undefined || parsed.data.scale !== undefined)) return `sequence step ${index + 1}: put capture, region, scale and settleMs on the sequence`
      if (parsed.data.action === 'wait' && parsed.data.label !== undefined) return `sequence step ${index + 1}: a wait step captures nothing — put the label on the sequence`
      const refusal = tableRefusal(parsed.data)
      if (refusal !== null) return `sequence step ${index + 1}: ${refusal}`
    }
  }
  if (POINT_ACTIONS.has(action) && input.target === undefined && input.ref === undefined && !(isNumber(input.x) && isNumber(input.y))) {
    return `${action} requires x and y (pixels of the last screenshot), or target from tree`
  }
  if (action === 'drag' && input.toTarget === undefined && !(isNumber(input.toX) && isNumber(input.toY))) {
    return 'drag requires toX and toY (the end, in the same pixels), or toTarget from tree'
  }
  if (action === 'scroll' && !(isNumber(input.dx) || isNumber(input.dy))) {
    return 'scroll requires dx or dy (wheel notches)'
  }
  if (action === 'type' || action === 'fill') {
    if (typeof input.text !== 'string' || input.text.length === 0) return `${action} requires text (the characters to ${action === 'fill' ? 'set' : 'type'})`
    if (input.text.length > TYPE_TEXT_CAP) {
      return `${action} takes up to ${TYPE_TEXT_CAP} characters — this text is ${input.text.length}; split it`
    }
    const control = controlCharacterOf(input.text)
    if (control !== null) return `${action} refuses the control character ${control} — newline and tab are the only control characters typed`
  }
  if (action === 'fill' && input.target === undefined && input.ref === undefined) return 'fill requires target or ref from tree (the text field to set)'
  if (action === 'file') {
    if (typeof input.path !== 'string' || !isAbsolute(input.path)) return 'file requires path: the absolute path of the file to upload'
    let stat: ReturnType<typeof statSync> | null = null
    try {
      stat = statSync(input.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        return `file: ${input.path}: ${error instanceof Error ? error.message : String(error)}`
      }
      stat = null
    }
    if (stat === null || !stat.isFile()) return `file: ${input.path} is not a file on this machine`
    if (input.durationMs !== undefined && !(isNumber(input.durationMs) && input.durationMs >= 0 && input.durationMs <= WAIT_CAP_MS)) return `file takes durationMs as the milliseconds to wait for the dialog, up to ${WAIT_CAP_MS}`
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
  if (input.display !== undefined && !(Number.isInteger(input.display) && input.display >= 0)) {
    return 'screenshot takes display as a display number from displays'
  }
  if (input.scale !== undefined && !(isNumber(input.scale) && input.scale >= 0.25 && input.scale <= 1)) return 'scale must be between 0.25 and 1'
  if (input.full && input.region) return 'choose full or region, not both'
  if (input.settleMs !== undefined && !(isNumber(input.settleMs) && input.settleMs >= 0)) {
    return `${action} takes settleMs as a number of milliseconds`
  }
  if (TREE_READS.has(action) || action === 'read' || input.ref !== undefined || input.target !== undefined || input.toTarget !== undefined || input.until !== undefined) {
    if (input.depth !== undefined && !(Number.isInteger(input.depth) && input.depth >= 0)) {
      return `tree takes depth as a whole number from 0 to ${TREE_DEPTH_CAP} — ${String(input.depth)} is outside`
    }
    if (input.limit !== undefined && !(Number.isInteger(input.limit) && input.limit >= 1)) {
      return `tree takes limit as a whole number from 1 to ${TREE_LIMIT_CAP} — ${String(input.limit)} is outside`
    }
  }
  return null
}
