import { z } from 'zod/v4'
import type { ToolEffectOutcome } from '../../kit/tool.js'
import { flagEnabled } from '../../../platform/substrate/flagRegistry.js'
import { lazySchema } from '../../../platform/primitives/lazySchema.js'

export const OPS = [
  'status',
  'open',
  'click',
  'type',
  'scroll',
  'waitFor',
  'back',
  'reload',
  'select',
  'press',
  'hover',
  'viewport',
  'devices',
  'provision',
  'extract',
  'console',
  'info',
  'screenshot',
  'upload',
  'download',
  'close',
] as const

export const ACT_OPS: ReadonlySet<string> = new Set([
  'open',
  'click',
  'type',
  'scroll',
  'back',
  'reload',
  'select',
  'press',
  'hover',
  'upload',
])

export const FRONT_OPS: ReadonlySet<string> = new Set(['click', 'type', 'scroll', 'back', 'reload', 'select', 'press', 'hover', 'screenshot', 'upload'])
export const TABLESS_OPS: ReadonlySet<string> = new Set(['status', 'devices', 'provision', 'download'])
export const TOUCH_OPS: ReadonlySet<string> = new Set(['click', 'type', 'select', 'press', 'upload'])

export const PRESS_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

export const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  '',
  'text',
  'search',
  'url',
  'tel',
  'email',
  'number',
  'password',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
])

export const EXTRACT_CAP = 15_000

export const WAIT_DEFAULT_MS = 10_000
export const WAIT_CAP_MS = 30_000

export function browserToolEnabled(): boolean {
  return flagEnabled('MERCURY_BROWSER')
}

export const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(OPS).describe('Browser operation.'),
    tab: z.string().optional().describe('Named tab (default main)'),
    url: z.string().optional().describe('open: http/https URL'),
    persist: z.boolean().optional().describe('open: no idle close'),
    waitUntil: z
      .enum(['domcontentloaded', 'load', 'networkidle2'])
      .optional()
      .describe('open/reload: default load'),
    selector: z
      .string()
      .optional()
      .describe(
        'CSS, aria/<name>[role="<role>"] (exact name), text/<substring>, xpath/<expr>, or host >>> inner across shadow roots (omit: type uses focus, extract uses page)',
      ),
    frame: z.union([z.number().int().nonnegative(), z.string().min(1)]).optional().describe('Frame index from extract (0 = main) or unique URL substring. Acts use that frame origin, including secret fills.'),
    force: z.boolean().optional().describe('click: DOM click to a covered selector target.'),
    x: z.number().optional().describe('click: viewport x (with y; selector wins if both)'),
    y: z.number().optional().describe('click: viewport y (with x)'),
    text: z.string().optional().describe('type: characters · waitFor: page text'),
    secretRef: z
      .string()
      .optional()
      .describe(
        'type: operator-registered UPPER_SNAKE secret name, with selector. Credential fields require this instead of text; value stays out of the conversation, and each secret-and-origin pairing needs separate approval.',
      ),
    clear: z.boolean().optional().describe('type: clear selector target first'),
    enter: z.boolean().optional().describe('type: press Enter after'),
    dy: z.number().optional().describe('scroll: pixel delta (+down) when no selector'),
    timeoutMs: z
      .number()
      .optional()
      .describe(
        `waitFor/selector deadline in ms (default ${WAIT_DEFAULT_MS}, cap ${WAIT_CAP_MS})`,
      ),
    state: z
      .enum(['visible', 'attached', 'hidden'])
      .optional()
      .describe('waitFor selector: default visible'),
    mode: z
      .enum(['text', 'tree'])
      .optional()
      .describe('extract: default text (innerText); tree = accessibility tree'),
    values: z
      .array(z.string())
      .optional()
      .describe('select: option values (visible-label fallback; multi only on <select multiple>)'),
    key: z
      .string()
      .optional()
      .describe(
        'press: Enter, Escape, Tab, ArrowUp/Down/Left/Right, Backspace, Delete, Home, End, PageUp, PageDown (use type for printable chars)',
      ),
    modifiers: z
      .array(z.enum(['Shift', 'Control', 'Alt', 'Meta']))
      .optional()
      .describe('press: held modifiers'),
    buildId: z
      .string()
      .optional()
      .describe('provision: Chrome-for-Testing build (default stable)'),
    width: z.number().optional().describe('viewport: CSS px (320–3840)'),
    height: z.number().optional().describe('viewport: CSS px (240–2160)'),
    deviceScaleFactor: z.number().optional().describe('viewport: scale 1–3'),
    emulation: z
      .looseObject({})
      .optional()
      .describe('viewport: overrides; omitted stays, null clears, reset restores launch defaults'),
    offset: z
      .number()
      .optional()
      .describe('extract: text window char offset'),
    limit: z.number().optional().describe('console: last N entries (default 50)'),
    fullPage: z.boolean().optional().describe('screenshot: full scroll height (default viewport)'),
    downloadId: z.string().optional().describe('download: wait for this one'),
    files: z.array(z.string()).optional().describe('upload: local paths; [] clears the input'),
    label: z.string().optional().describe('screenshot: filename hint'),
  }),
)

export type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  op: Input['op']
  result: string
  outcome: ToolEffectOutcome
  imagePath?: string
  inlinePath?: string
  inlineMediaType?: string
}
