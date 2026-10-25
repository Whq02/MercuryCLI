
import { readFileSync, writeFileSync } from 'node:fs'
import { metadataRefusal, metadataSafeAddresses } from '../WebFetchTool/privateHost.js'
import type { ElementHandle, SerializedAXNode } from 'puppeteer-core'
import { z } from 'zod/v4'
import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import { canAnswerAsks, getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { readImageWithTokenBudget } from '../FileReadTool/FileReadTool.js'
import { modelReceivesImageBlocks } from '../../utils/model/capabilities.js'
import { getEngineModel } from '../../utils/model/model.js'
import {
  browserVersionOf,
  detectInstalledBrowsers,
  driverNodeGate,
  listManagedBrowsers,
  resolveBrowser,
} from '../../services/browser/browserResolver.js'
import {
  BROWSER_CLOSE_BOUND_MS,
  BROWSER_PROTOCOL_TIMEOUT_MS,
  CONSOLE_RING_CAP,
  NAVIGATION_CAP_MS,
  activeSession,
  approveWebOrigin,
  approvedOriginList,
  browserSessionCap,
  closeBrowserSessionDetailed,
  consumeCheckedActOrigin,
  driverVersion,
  ensureBrowserSession,
  isBrowserErrorPage,
  liveBrowserSessionCensus,
  noteCheckedActOrigin,
  originApproved,
  originOf,
  approveSecretPairing,
  screenshotPath,
  secretPairingApproved,
  sessionGoneAt,
} from '../../services/browser/browserSession.js'
import {
  BROWSER_SECRET_REF_GRAMMAR,
  resolveBrowserSecret,
  scrubSecretFromText,
} from '../../services/browser/browserSecrets.js'
import { APPROVAL_RULE_LINE, INSTALLED_NOT_DRIVEN } from '../../services/browser/browserWords.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/permissions.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import { ruleSentence } from '../../utils/permissions/ruleReason.js'
import type { PermissionRule, ToolPermissionContext } from '../../types/permissions.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const OPS = [
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
  'provision',
  'extract',
  'console',
  'info',
  'screenshot',
  'close',
] as const

const ACT_OPS: ReadonlySet<string> = new Set([
  'open',
  'click',
  'type',
  'scroll',
  'back',
  'reload',
  'select',
  'press',
  'hover',
])

const PRESS_KEYS: ReadonlySet<string> = new Set([
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

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
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

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z
      .enum(OPS)
      .describe(
        'status · open · click · type · scroll · waitFor · back · reload · select · press · hover · viewport · provision · extract · console · info · screenshot · close',
      ),
    url: z.string().optional().describe('open: the URL to navigate to (http/https)'),
    waitUntil: z
      .enum(['domcontentloaded', 'load', 'networkidle2'])
      .optional()
      .describe('open/reload: the navigation settle condition (default load; networkidle2 for busy SPAs)'),
    selector: z
      .string()
      .optional()
      .describe(
        'click/type/scroll/waitFor/extract: the element target — CSS, or aria/<name>[role="<role>"] (role + the exact full accessible name; extract mode:"tree" prints these), text/<substring> (rendered-text substring), xpath/<expr>, or `host >>> inner` piercing shadow roots (type: the focused element when omitted; extract: whole page when omitted)',
      ),
    x: z.number().optional().describe('click: viewport x for a point click (with y; selector wins when both given)'),
    y: z.number().optional().describe('click: viewport y for a point click (with x)'),
    text: z.string().optional().describe('type: the characters to type · waitFor: the page text to await'),
    secretRef: z
      .string()
      .optional()
      .describe(
        'type: fill an operator-registered named secret instead of text (UPPER_SNAKE name; requires selector; only credential-shaped targets accept it) — the value never enters the conversation; the ask names the secret + origin pairing',
      ),
    clear: z.boolean().optional().describe('type: clear the field first (selector targets only)'),
    enter: z.boolean().optional().describe('type: press Enter after typing'),
    dy: z.number().optional().describe('scroll: pixel delta (positive scrolls down) when no selector is given'),
    timeoutMs: z
      .number()
      .optional()
      .describe(
        `waitFor + selector acts/reads (click/type/scroll/extract): deadline in ms (default ${WAIT_DEFAULT_MS}, cap ${WAIT_CAP_MS}) — a miss fails by name`,
      ),
    state: z
      .enum(['visible', 'attached', 'hidden'])
      .optional()
      .describe(
        'waitFor selector: the awaited condition — visible (default), attached (in the DOM even if hidden), hidden (hidden OR gone: the spinner-vanished wait)',
      ),
    mode: z
      .enum(['text', 'tree'])
      .optional()
      .describe('extract: text = innerText (default) · tree = accessibility-tree projection'),
    values: z
      .array(z.string())
      .optional()
      .describe('select: option values to choose (visible-label fallback); multiple only on a multiple select'),
    key: z
      .string()
      .optional()
      .describe(
        'press: a navigation/edit key — Enter, Escape, Tab, ArrowUp/Down/Left/Right, Backspace, Delete, Home, End, PageUp, PageDown (printable characters go through type)',
      ),
    modifiers: z
      .array(z.enum(['Shift', 'Control', 'Alt', 'Meta']))
      .optional()
      .describe('press: modifiers held around the key'),
    buildId: z
      .string()
      .optional()
      .describe('provision: pin an exact Chrome-for-Testing build (default: current stable; the ask names it)'),
    width: z.number().optional().describe('viewport: CSS px width (320-3840)'),
    height: z.number().optional().describe('viewport: CSS px height (240-2160)'),
    deviceScaleFactor: z.number().optional().describe('viewport: 1-3 (2 = retina screenshots)'),
    offset: z
      .number()
      .optional()
      .describe('extract: start the text window at this char — the header names the chars shown of N; page a long extract'),
    limit: z.number().optional().describe('console: last N entries (default 50)'),
    fullPage: z.boolean().optional().describe('screenshot: capture the full scroll height (default viewport)'),
    label: z.string().optional().describe('screenshot: artifact filename hint'),
  }),
)

type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  op: Input['op']
  result: string
  outcome: ToolEffectOutcome
  imagePath?: string
  inlinePath?: string
  inlineMediaType?: string
}

export function openSchemeRefusal(url: string | undefined): string {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url ?? '')?.[1]?.toLowerCase()
  if (scheme === undefined) return `open requires an http(s) url — "${url ?? ''}" has no scheme`
  if (scheme === 'file') return 'open requires an http(s) url — serve the folder first (the Service tool or a loopback server); file:// is not supported'
  return `open requires an http(s) url — ${scheme}: is not a web scheme this tool opens (${scheme}:// is not supported; the browser's own pages and non-web protocols stay closed)`
}

const NO_SESSION = 'no open session — use op:"open" first'
const BROWSER_GONE = 'the browser is gone (its process exited) — op:"open" starts a new one'

function noSessionWords(owner: OwnerKey): string {
  return sessionGoneAt(owner) === null ? NO_SESSION : BROWSER_GONE
}

export function driverFailureWords(op: string, message: string): string | null {
  if (/protocolTimeout|timed out\. Increase the 'protocolTimeout'/.test(message)) {
    return `${op}: the browser did not answer within ${BROWSER_PROTOCOL_TIMEOUT_MS / 1000}s — its process may be gone; op:"close" ends the session, op:"open" starts a new one`
  }
  if (/Target closed|Connection closed|Session closed|Protocol error.*detached|Navigating frame was detached|browser has disconnected/i.test(message)) {
    return browserGoneMidOpWords(op)
  }
  return null
}

function relayNamedFailure(s: LiveSession, url: string, err: unknown): unknown {
  const last = s.navFailure.last
  const message = (err as Error)?.message
  if (last === null || typeof message !== 'string' || !/^net::ERR_[A-Z_]+ at /.test(message)) return err
  const q = url.indexOf('?')
  const spelled = q === -1 ? url : `${url.slice(0, q)}?…`
  if (last.url !== spelled || message.startsWith(`${last.errorText} at `)) return err
  const named = new Error(`${last.errorText} at ${url}`)
  named.name = (err as Error).name
  return named
}

export function browserGoneMidOpWords(op: string): string {
  return `${op}: the browser is gone (its process exited mid-op) — op:"open" starts a new one`
}

export function isDriverTimeout(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown } | null
  if (!e || typeof e !== 'object') return false
  if (e.name === 'TimeoutError') return true
  const message = typeof e.message === 'string' ? e.message : ''
  return /Timed out after waiting \d+ms|Waiting failed: \d+ms exceeded|Navigation timeout of \d+ ?ms exceeded/.test(message)
}

export function errorChainText(err: unknown): string {
  const parts: string[] = []
  let cursor: unknown = err
  for (let depth = 0; depth < 8 && cursor !== undefined && cursor !== null; depth++) {
    const e = cursor as { message?: unknown; cause?: unknown }
    parts.push(typeof e.message === 'string' ? e.message : String(cursor))
    cursor = e.cause
  }
  return parts.join(' <- ')
}

const BROWSER_GONE_ERROR = 'BrowserGoneError'

function browserGoneError(): Error {
  const err = new Error('the browser is gone (its process exited mid-op)')
  err.name = BROWSER_GONE_ERROR
  return err
}

interface OpLife {
  signal: AbortSignal
  browser: LiveSession['browser']
  release: () => void
}

function openOpLife(s: LiveSession, outer: AbortSignal | undefined): OpLife {
  const life = new AbortController()
  const onOuter = (): void => life.abort(outer?.reason)
  const onGone = (): void => life.abort(browserGoneError())
  if (outer?.aborted) life.abort(outer.reason)
  else outer?.addEventListener('abort', onOuter, { once: true })
  if (s.browser.connected) s.browser.on('disconnected', onGone)
  else onGone()
  return {
    signal: life.signal,
    browser: s.browser,
    release: (): void => {
      outer?.removeEventListener('abort', onOuter)
      s.browser.off('disconnected', onGone)
    },
  }
}

export function localClock(at: number): string {
  const d = new Date(at)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

function preview(text: string, cap = 40): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text
}

function statusReport(owner: OwnerKey): string {
  const lines: string[] = []
  const gate = driverNodeGate()
  lines.push(`driver: puppeteer-core ${driverVersion()} (bundled)${gate.ok ? '' : ` — DRIVE OPS GATED: ${gate.note}`}`)
  const resolution = resolveBrowser()
  if (resolution.state === 'ok') {
    const version = browserVersionOf(resolution.executablePath)
    lines.push(
      `resolution: ${resolution.source} — ${resolution.label}${version ? ` (${version})` : ''}`,
      `  executable: ${resolution.executablePath}`,
    )
  } else {
    lines.push(`resolution: UNAVAILABLE — ${resolution.note}`, ...resolution.remedies.map(r => `  remedy: ${r}`))
  }
  const installed = detectInstalledBrowsers()
  lines.push(
    installed.length
      ? `installed: ${installed.map(b => `${b.label} (${b.executablePath})`).join(' · ')} — ${INSTALLED_NOT_DRIVEN}`
      : 'installed: none found at the standard locations',
  )
  const managed = listManagedBrowsers()
  lines.push(
    managed.length
      ? `managed cache: ${managed
          .map(m => `Chrome for Testing ${m.buildId} (${(m.sizeBytes / 1024 / 1024).toFixed(0)} MB)`)
          .join(' · ')} — remove one with /browser remove ${managed[0]!.buildId}`
      : 'managed cache: empty — /browser install is the explicit consented download path',
  )
  const live = activeSession(owner)
  lines.push(
    live
      ? `session: OPEN at ${live.page.url()} (viewport ${live.page.viewport()?.width}x${live.page.viewport()?.height})`
      : 'session: none',
  )
  if (live?.sandboxDowngraded) lines.push('  sandbox: DISABLED (running as uid 0 — container mode; --no-sandbox appended)')
  const grants = approvedOriginList(owner)
  if (grants.length > 0) lines.push(`approved origins (this session): ${grants.join(' · ')}`)
  lines.push(APPROVAL_RULE_LINE)
  const others = liveBrowserSessionCensus().filter(row => row.owner !== owner)
  if (others.length > 0) {
    lines.push(
      `other live sessions: ${others.length} of ${browserSessionCap()} cap (${others.map(o => o.lane).join(', ')}) — grants never cross owners`,
    )
  }
  return lines.join('\n')
}

const ACTIONABLE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
])

function serializeAxTree(node: SerializedAXNode | null): string {
  if (!node) return '(empty accessibility tree)'
  const lines: string[] = []
  const walk = (n: SerializedAXNode, depth: number, framed: boolean): void => {
    const head = [n.role, n.name ? JSON.stringify(n.name) : ''].filter(Boolean).join(' ')
    const state: string[] = []
    if (n.value !== undefined && n.value !== '') state.push(`value=${JSON.stringify(String(n.value))}`)
    if (n.checked !== undefined) state.push(`checked=${String(n.checked)}`)
    if (n.disabled === true) state.push('disabled')
    if (n.focused === true) state.push('focused')
    const isFrame = n.role === 'Iframe'
    const token =
      !framed && n.name && ACTIONABLE_ROLES.has(n.role) && /^[^"[\]]+$/.test(n.name)
        ? `  → aria/${n.name}[role="${n.role}"]`
        : isFrame
          ? '  (frame content below: selectors do not reach into it — screenshot and click by x/y, or open its URL)'
          : ''
    lines.push(`${'  '.repeat(depth)}${head}${state.length > 0 ? ` [${state.join(' ')}]` : ''}${token}`)
    for (const child of n.children ?? []) walk(child, depth + 1, framed || isFrame)
  }
  walk(node, 0, false)
  return lines.join('\n')
}

function deepTextOf(root: Element): string {
  const own = (root as HTMLElement).innerText ?? ''
  const parts: string[] = []
  const walk = (scope: Element | ShadowRoot): void => {
    for (const el of Array.from(scope.querySelectorAll('*'))) {
      const shadow = (el as Element).shadowRoot
      if (!shadow) continue
      const text = Array.from(shadow.children)
        .map(c => (c as HTMLElement).innerText ?? '')
        .join('\n')
        .trim()
      const tag = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`
      if (text !== '') parts.push(`[shadow root of ${tag}]\n${text}`)
      walk(shadow)
    }
  }
  walk(root)
  return parts.length === 0 ? own : `${own.trim()}\n${parts.join('\n')}`
}

function capExtract(header: string, body: string, offset = 0): string {
  const clean = body.trim()
  const start = Math.min(Math.max(Math.floor(offset), 0), clean.length)
  if (start === 0 && clean.length <= EXTRACT_CAP) return `${header} — ${clean.length} chars\n${clean}`
  const window = clean.slice(start, start + EXTRACT_CAP)
  const end = start + window.length
  return `${header} — chars ${start}-${end} of ${clean.length}${
    end < clean.length ? `, TRUNCATED to ${EXTRACT_CAP} (continue with offset: ${end}, or narrow with selector)` : ''
  }\n${window}`
}

type LiveSession = NonNullable<ReturnType<typeof activeSession>>

function errorPageWords(s: LiveSession): string {
  const failed = s.navFailure.last
  return failed
    ? `the browser's own error page — ${failed.errorText} at ${failed.url}; the site did not load`
    : "the browser's own error page — the site did not load"
}

function pageWhere(s: LiveSession): string {
  const url = s.page.url()
  return isBrowserErrorPage(url) ? `${url} (${errorPageWords(s)})` : url
}

function failedNavigationWords(op: string, s: LiveSession, wanted: string): string {
  const failed = s.navFailure.last
  return `${op} failed: ${failed ? `${failed.errorText} at ${failed.url}` : `${wanted} did not load`} — the browser shows its own error page (${s.page.url()}), not the site; the server is down or refusing connections`
}

function bytesWords(n: number): string {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export const DOWNLOADS_NOT_FOLLOWED = 'downloads are not followed here; fetch the file with WebFetch or Bash instead'

function downloadWords(notice: NonNullable<LiveSession['downloads']['last']>): string {
  const facts = [notice.type, notice.bytes !== null ? bytesWords(notice.bytes) : null, `saves as ${notice.filename}`].filter(
    (f): f is string => f !== null && f !== '',
  )
  return `a download (${facts.join(', ')}) — ${DOWNLOADS_NOT_FOLLOWED}`
}

interface ActMarks {
  at: number
  ringMark: number
  popups: number
  downloads: number
  url: string
}

function markAct(s: LiveSession): ActMarks {
  return { at: Date.now(), ringMark: s.consoleRing.length, popups: s.popups.count, downloads: s.downloads.count, url: s.page.url() }
}

function bounded(ms: number): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    ;(t as { unref?: () => void }).unref?.()
  })
}

async function settleAfterAct(s: LiveSession, deadline: number, marks: ActMarks): Promise<void> {
  await Promise.race([
    s.page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)))).catch(() => undefined),
    bounded(1000),
  ])
  if (s.navWatch.pendingUrl !== null) {
    await Promise.race([new Promise<void>(wake => s.navWatch.waiters.push(wake)), bounded(deadline)])
  }
  if (s.navWatch.abortedAt >= marks.at && s.downloads.count === marks.downloads) {
    await Promise.race([new Promise<void>(wake => s.downloads.waiters.push(wake)), bounded(1000)])
  }
  const download = s.downloads.last
  if (download !== null && s.downloads.count > marks.downloads) await Promise.race([download.done, bounded(1000)])
}

function actConsequences(s: LiveSession, marks: ActMarks): string {
  const notes: string[] = []
  if (s.downloads.count > marks.downloads && s.downloads.last !== null) {
    notes.push(`the link is ${downloadWords(s.downloads.last)}`)
  }
  if (s.popups.count > marks.popups) {
    notes.push(
      `the page opened a new tab (${s.popups.last}) — this session drives ONE page; the tab was closed unadopted. op:"open" that URL follows it (a new origin will ask).`,
    )
  }
  for (const entry of s.consoleRing.slice(marks.ringMark)) {
    if (entry.kind === 'dialog') notes.push(`the page opened a dialog: ${entry.text}`)
  }
  return notes.map(n => `\n  note: ${n}`).join('')
}

function framesDiagnosis(s: LiveSession): string {
  try {
    const children = s.page.frames().filter(f => f.parentFrame() !== null)
    if (children.length === 0) return ''
    const urls = children
      .slice(0, 3)
      .map(f => f.url().split('?')[0])
      .join(', ')
    return ` — NOTE: ${children.length} child frame(s) present (${urls}); selectors act on the MAIN frame (per-frame targeting is a named deferral, but extract mode:"tree" projects framed content)`
  } catch {
    return ''
  }
}

function actOriginGate(owner: OwnerKey, s: LiveSession, op: string): string | null {
  const judged = consumeCheckedActOrigin(owner, op)
  const live = originOf(s.page.url())
  if (judged !== null && judged !== live) {
    return `${op} refused: the page moved from ${judged} to ${live} between the permission check and the act — nothing done; re-issue to ask for the new origin`
  }
  approveWebOrigin(owner, judged ?? s.page.url())
  return null
}

function actDeadline(input: Input): number {
  return Math.min(Math.max(input.timeoutMs ?? WAIT_DEFAULT_MS, 250), WAIT_CAP_MS)
}

async function framedOnly(s: LiveSession, selector: string): Promise<string | null> {
  try {
    const children = s.page.frames().filter(f => f.parentFrame() !== null)
    if (children.length === 0) return null
    if ((await s.page.$(selector)) !== null) return null
    for (const frame of children) {
      if ((await frame.$(selector).catch(() => null)) !== null) return frame.url().split('?')[0] ?? frame.url()
    }
    return null
  } catch {
    return null
  }
}

function framedTargetWords(selector: string, frameUrl: string): string {
  return `${selector} lives inside a child frame (${frameUrl}) — selectors act on the main frame and do not reach into frames; op:"screenshot" then click by x/y, or op:"open" the frame's URL to drive it directly`
}

async function resolveActTarget(
  s: LiveSession,
  selector: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<ElementHandle<Element>> {
  const framed = await framedOnly(s, selector)
  if (framed !== null) throw new Error(framedTargetWords(selector, framed))
  try {
    return (await s.page
      .locator(selector)
      .setTimeout(deadline)
      .setVisibility('visible')
      .waitHandle({ signal })) as ElementHandle<Element>
  } catch (err) {
    if (isDriverTimeout(err)) {
      const attached = await s.page.$(selector).catch(() => null)
      const framedLate = attached ? null : await framedOnly(s, selector)
      throw new Error(
        attached
          ? `${selector} is present but never became visible within the ${deadline}ms deadline (hidden or zero-sized — acts need a visible target; waitFor state:"attached" can read its arrival)`
          : framedLate !== null
            ? framedTargetWords(selector, framedLate)
            : `no element for selector ${selector} within the ${deadline}ms deadline (the act auto-waits; the element never appeared)${framesDiagnosis(s)}`,
      )
    }
    throw err
  }
}

async function resolveReadTarget(
  s: LiveSession,
  selector: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<ElementHandle<Element>> {
  try {
    const handle = await s.page.waitForSelector(selector, { timeout: deadline, signal })
    if (!handle) throw new Error(`no element for selector ${selector} within the ${deadline}ms deadline`)
    return handle as ElementHandle<Element>
  } catch (err) {
    if (isDriverTimeout(err)) {
      throw new Error(`no element for selector ${selector} within the ${deadline}ms deadline${framesDiagnosis(s)}`)
    }
    throw err
  }
}

async function settleBoundingBox(handle: ElementHandle<Element>, deadline: number): Promise<void> {
  const cap = Math.min(deadline, 2000)
  const t0 = Date.now()
  for (;;) {
    const stable = await handle.evaluate(async el => {
      const a = el.getBoundingClientRect()
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
      const b = el.getBoundingClientRect()
      return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
    })
    if (stable || Date.now() - t0 > cap) return
  }
}

async function isDisabledTarget(handle: ElementHandle<Element>): Promise<boolean> {
  return handle.evaluate(
    el => (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true' || el.closest('fieldset:disabled') !== null,
  )
}

const HUMAN_MOVE_BUDGET_MS = 80
const HUMAN_CLICK_DWELL_MIN_MS = 18
const HUMAN_CLICK_DWELL_MAX_MS = 38
const HUMAN_CLICK_HOLD_MIN_MS = 14
const HUMAN_CLICK_HOLD_MAX_MS = 32
const HUMAN_TYPE_BUDGET_MS = 400

function humanCursorPath(
  start: { x: number; y: number },
  end: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const origin =
    Math.hypot(end.x - start.x, end.y - start.y) < 2
      ? { x: Math.max(2, end.x - 18), y: Math.max(2, end.y - 12) }
      : start
  const dx = end.x - origin.x
  const dy = end.y - origin.y
  const dist = Math.max(1, Math.hypot(dx, dy))
  const steps = Math.min(20, Math.max(8, Math.round(Math.log2(dist / 12 + 1) * 4)))
  const nx = -dy / dist
  const ny = dx / dist
  const side = (Math.round(origin.x + end.y) & 1) === 0 ? 1 : -1
  const spread = Math.min(72, Math.max(6, dist * (0.12 + Math.random() * 0.08))) * side
  const p1 = {
    x: origin.x + dx * 0.3 + nx * spread * 0.85,
    y: origin.y + dy * 0.3 + ny * spread * 0.85,
  }
  const p2 = {
    x: origin.x + dx * 0.72 + nx * spread * 1.05,
    y: origin.y + dy * 0.72 + ny * spread * 1.05,
  }
  const points: Array<{ x: number; y: number }> = []
  for (let i = 1; i <= steps; i++) {
    if (i === steps) {
      points.push({ x: end.x, y: end.y })
      continue
    }
    const t = i / steps
    const u = t * t * (3 - 2 * t)
    const mt = 1 - u
    const x = mt * mt * mt * origin.x + 3 * mt * mt * u * p1.x + 3 * mt * u * u * p2.x + u * u * u * end.x
    const y = mt * mt * mt * origin.y + 3 * mt * mt * u * p1.y + 3 * mt * u * u * p2.y + u * u * u * end.y
    points.push({ x: Math.max(0, x), y: Math.max(0, y) })
  }
  return points
}

async function humanMoveTo(s: LiveSession, to: { x: number; y: number }): Promise<void> {
  const from = s.cursor ?? { x: 160, y: 120 }
  const points = humanCursorPath(from, to)
  const stepWaitMs = Math.max(2, Math.floor(HUMAN_MOVE_BUDGET_MS / points.length))
  for (const pt of points) {
    await s.page.mouse.move(pt.x, pt.y)
    s.cursor = { x: pt.x, y: pt.y }
    await bounded(Math.max(1, stepWaitMs + Math.floor((Math.random() - 0.5) * 2)))
  }
}

async function pickTargetPoint(
  s: LiveSession,
  handle: ElementHandle<Element>,
): Promise<{ x: number; y: number }> {
  const base = await handle.clickablePoint()
  const box = await handle.boundingBox().catch(() => null)
  if (!box || box.width < 10 || box.height < 10) return base
  const jx = base.x + (Math.random() - 0.5) * Math.min(8, box.width * 0.2)
  const jy = base.y + (Math.random() - 0.5) * Math.min(6, box.height * 0.2)
  const safe = await s.page
    .evaluate(
      (el, x, y) => {
        let hit = document.elementFromPoint(x, y)
        while (hit?.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(x, y)
          if (!inner || inner === hit) break
          hit = inner
        }
        return Boolean(hit && (hit === el || el.contains(hit)))
      },
      handle,
      jx,
      jy,
    )
    .catch(() => false)
  return safe ? { x: jx, y: jy } : base
}

async function humanClickPoint(s: LiveSession, x: number, y: number): Promise<void> {
  await humanMoveTo(s, { x, y })
  const dwellMs =
    HUMAN_CLICK_DWELL_MIN_MS +
    Math.floor(Math.random() * (HUMAN_CLICK_DWELL_MAX_MS - HUMAN_CLICK_DWELL_MIN_MS + 1))
  await bounded(dwellMs)
  await s.page.mouse.down()
  const holdMs =
    HUMAN_CLICK_HOLD_MIN_MS +
    Math.floor(Math.random() * (HUMAN_CLICK_HOLD_MAX_MS - HUMAN_CLICK_HOLD_MIN_MS + 1))
  await bounded(holdMs)
  await s.page.mouse.up()
}

async function humanTypeText(s: LiveSession, text: string): Promise<void> {
  const chars = Array.from(text)
  if (chars.length === 0) return
  const maxMeanMs = Math.max(2, Math.min(20, Math.floor(HUMAN_TYPE_BUDGET_MS / Math.max(chars.length, 1))))
  const minKeyMs = Math.max(1, Math.floor(maxMeanMs * 0.45))
  const spanMs = Math.max(2, maxMeanMs - minKeyMs)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    await s.page.keyboard.type(ch)
    if (i + 1 < chars.length) {
      const boundaryBoost = /[\s.,;!?-]/.test(ch) ? Math.min(8, Math.ceil(spanMs * 0.5)) : 0
      const wave = (i * 7 + ch.charCodeAt(0)) % (spanMs + 1)
      const jitter = Math.floor(Math.random() * Math.max(2, Math.ceil(spanMs * 0.5)))
      const delayMs = Math.min(
        maxMeanMs + boundaryBoost,
        minKeyMs + Math.floor((wave + jitter) / 2) + boundaryBoost,
      )
      await bounded(delayMs)
    }
  }
}

async function clickGate(s: LiveSession, handle: ElementHandle<Element>): Promise<string | null> {
  const disabled = await handle.evaluate(
    el => (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
  )
  if (disabled) return 'the target is disabled'
  const point = await handle.clickablePoint()
  const occluder = await s.page.evaluate(
    (el, x, y) => {
      let hit = document.elementFromPoint(x, y)
      while (hit?.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y)
        if (!inner || inner === hit) break
        hit = inner
      }
      if (!hit || hit === el || el.contains(hit)) return null
      const id = hit.id ? `#${hit.id}` : ''
      const cls =
        typeof hit.className === 'string' && hit.className.trim() !== ''
          ? `.${hit.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')}`
          : ''
      return `${hit.tagName.toLowerCase()}${id}${cls}`
    },
    handle,
    point.x,
    point.y,
  )
  if (occluder) {
    return `the click point (${Math.round(point.x)}, ${Math.round(point.y)}) is covered by ${occluder} — dismiss or scroll past it first`
  }
  return null
}

async function probeEditableTarget(s: LiveSession, requested: ElementHandle<Element> | null) {
  return await s.page.evaluate(el => {
    let active: Element | null = document.activeElement
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
    if (!active || active === document.body) return null
    const a = active as HTMLInputElement
    const tag = a.tagName.toLowerCase()
    const autocomplete = (a.getAttribute('autocomplete') ?? '').toLowerCase()
    const held = el === null || el === active || el.contains(active) || (el.shadowRoot?.contains(active) ?? false)
    const credAc = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp'].find(
      t => autocomplete.includes(t),
    )
    const softText = `${a.name ?? ''} ${a.id ?? ''} ${a.getAttribute('aria-label') ?? ''}`
    const softHit = /pass(word|wd)|otp|totp|2fa|one.?time|secret|api.?key|cvv|cvc|\bssn\b|\bpin\b/i.exec(softText)?.[0]
    return {
      desc: `${tag}${a.id ? `#${a.id}` : ''}`,
      tag,
      type: tag === 'input' ? (a.type ?? '') : '',
      readOnly: a.readOnly === true,
      editable: tag === 'input' || tag === 'textarea' || a.isContentEditable,
      credential: a.type === 'password' || credAc !== undefined || softHit !== undefined,
      credentialWhy:
        a.type === 'password'
          ? 'type=password'
          : credAc !== undefined
            ? `autocomplete=${credAc}`
            : softHit !== undefined
              ? `name/label matches "${softHit}"`
              : '',
      held,
    }
  }, requested)
}

function actDetail(input: Input): string {
  switch (input.op) {
    case 'click':
      return ` ${input.selector ?? `(${input.x}, ${input.y})`}`
    case 'type':
      if (input.secretRef !== undefined) return ` secret ${input.secretRef} into ${input.selector ?? '(focused element)'}`
      return ` ${(input.text ?? '').length} chars into ${input.selector ?? '(focused element)'}`
    case 'scroll':
      return ` ${input.selector ?? `by ${input.dy}`}`
    case 'select':
      return ` ${input.selector} ← [${(input.values ?? []).join(', ')}]`
    case 'press':
      return ` ${[...(input.modifiers ?? []), input.key ?? ''].filter(Boolean).join('+')}`
    case 'hover':
      return ` ${input.selector}`
    default:
      return ''
  }
}

export const BrowserTool = buildTool({
  name: 'Browser',
  searchHint:
    'drive a real browser: the native playwright puppeteer selenium alternative for end-to-end e2e browser automation — test and verify a web app or frontend UI journey, open a localhost dev server website, fill and submit a form, log in to a page, reproduce a UI bug, click type scroll, wait for selector text navigation, extract render page text accessibility tree DOM, read console errors, capture a screenshot, headless chrome edge chromium provenance status',
  capability: {
    intents: [
      'test and verify a web app or UI journey end to end in a real browser',
      'fill in and submit a form, log in to a live page',
      'check a localhost dev server page renders and reproduce a UI bug',
      'open a web page in a real browser',
      'click, type into and scroll a live page',
      'wait for a selector, text or navigation event',
      'read a page as text or an accessibility tree',
      'read the page console and errors',
      'capture a screenshot of a web page',
      'check which browser mercury can drive and its provenance',
      'close the driven browser session',
    ],
    units: ['browser-drive'],
    class: 'execution',
    operations: [...OPS],
    execution: { kind: 'browser-session', representation: 'child-execution' },
    evidence: ['artifact'],
    resources: [],
    cancellation: 'cooperative',
    latency: 'interactive',
    gate: 'MERCURY_BROWSER',
    proof: 'scripts/browser/prove-browser-drive.ts',
  },
  maxResultSizeChars: 20_000,
  async description() {
    return 'Drive a headless Chrome for Testing from the managed cache (or an operator-pinned browser; installed browsers are never driven) with full provenance: navigate, click, type, scroll, wait on events, extract text or the accessibility tree, read the console, screenshot'
  },
  async prompt() {
    return `Drive a real browser through the bundled driver: one owned headless session per agent (launched on first open, reaped on close/exit — concurrent agents each drive their own, they never share a page), full provenance on every act.

op:"status" — the resolution verdict (operator pin > managed Chrome-for-Testing cache > unavailable; installed browsers are discovered for information and never driven), driver/browser versions, the live-session state, the session's approved origins and the approval rule; never launches a browser session.
op:"open" (url, waitUntil?, timeoutMs?) — navigate to an http(s) URL (settles on load by default — networkidle2 for busy SPAs, domcontentloaded for speed; timeoutMs reaches 90s for a cold dev-server compile). A page census of 0 body-text chars means the app is still rendering: waitFor a selector or text before extract/screenshot.
op:"click" (selector, or x+y) — click an element or a viewport point. Selector clicks auto-wait (present and visible, bounded by timeoutMs) and gate on actionability: a disabled or covered target refuses instead of clicking nowhere. After a click that starts a navigation, op:"waitFor" (navigation) lets it settle.
op:"type" (text, selector?, clear?, enter?) — type into the selector-named element (auto-waited, focused first, shadow roots resolved) or the currently focused element. Only text-bearing targets accept text (text/search/url/tel/email/number/date-family inputs, textarea, contenteditable); checkboxes/radios/buttons, file inputs and readOnly fields refuse. Credential-shaped fields (password inputs, one-time-code/cc-* autocomplete, password/otp/secret/api-key-shaped names) refuse plain text; the one road into a credential field is secretRef: the operator registers a named secret out-of-band (a MERCURY_BROWSER_SECRET_<NAME> env var, or the browser-secrets file in the config home, owner-only mode) and op:"type" with secretRef:"NAME" + selector fills it — the value never enters this conversation, the fill lands only on credential-shaped targets, and the operator approves the secret + origin pairing (an approved origin alone never covers it).
op:"scroll" (selector, or dy) — scroll an element into view, or by dy pixels (positive = down).
op:"waitFor" (selector | text | neither = navigation; state?, timeoutMs?) — event-driven waiting bounded by a deadline (default ${WAIT_DEFAULT_MS}ms, cap ${WAIT_CAP_MS}ms). Selector waits default to visible (a pre-rendered hidden modal is not "present"); state chooses attached or hidden instead. Text waits match case-insensitively with whitespace normalized. A navigation wait whose navigation already landed during the previous act returns at once. Prefer this over any fixed pause.
op:"back" / op:"reload" — history navigation / reload the current page.
op:"select" (selector, values) — choose <select> options by value, falling back to visible label. A native dropdown cannot be driven by click; select drives it.
op:"press" (key, modifiers?) — press a navigation or edit key (Enter, Escape, Tab, arrows, Backspace, Delete, Home/End, PageUp/PageDown). Printable characters are deliberately not pressable — type owns them, and refuses credential fields.
op:"hover" (selector) — hover an element (menus and controls that render on hover).
op:"viewport" (width, height, deviceScaleFactor?) — resize the render surface (session default 1280x800 desktop). A read — no origin ask.
op:"extract" (mode: "text"|"tree", selector?, offset?) — the page as readable text (innerText) or as an accessibility-tree projection (indented role "name" [state] lines; the tree includes iframe content — selectors do not reach into frames). Output beyond ${EXTRACT_CAP} chars is truncated — offset pages the window, selector narrows the scope.
op:"console" (limit?) — the page's bounded truth ring (last ${CONSOLE_RING_CAP} entries, newest last): console logs, page errors with their stack head, network failures and 4xx/5xx responses (method + path + status), navigation dividers, and dialogs. "why is this page broken" reads from here. JS dialogs are auto-dismissed (beforeunload auto-accepted) and land in the ring with their text; choosing a dialog's answer is not offered.
op:"info" — current URL, title and the origin's approval state; cheap facts, no side effects.
op:"screenshot" (fullPage?, selector?, label?) — capture the page, the full scroll height, or one element (selector) to a PNG artifact; the image is attached to the result only when your engine takes image input, else the result names the file.
op:"close" — end the session (origin approvals die with it). Every op is bounded: a browser that stops answering is given ${BROWSER_PROTOCOL_TIMEOUT_MS / 1000}s per protocol call and close ${BROWSER_CLOSE_BOUND_MS / 1000}s before its process is ended.

Selectors: every selector door takes CSS by default, plus four forms the bundled driver resolves everywhere: aria/<name>[role="<role>"] (role + the exact full accessible name — the two fields extract mode:"tree" prints, so a tree line \`button "Save"\` is addressable as aria/Save[role="button"]), text/<substring> (substring of rendered text), xpath/<expr>, and the >>> deep combinator that pierces shadow roots (my-widget >>> input). Read with extract mode:"tree", then act with the selector the tree handed you — never guess a CSS class on an app you have not read.

Auto-wait: selector acts (click/type/scroll) resolve with a bounded present-and-visible wait (default ${WAIT_DEFAULT_MS}ms, cap ${WAIT_CAP_MS}ms, timeoutMs overrides) — a late-rendered element needs no waitFor first. Scoped reads (extract selector) wait for attached only — hidden content is readable, not actable.

A click that opens a new tab closes it unadopted (one owned page) — op:"open" its URL to follow it.

Permissions: the first visit to an origin asks ${getIsNonInteractiveSession() && !canAnswerAsks() ? 'for approval by URL — in this headless session no one can answer, so an unapproved origin is refused unless the tool was pre-approved at launch with --allowed-tools Browser or the run started in a permission mode that does not stop here' : 'the operator by URL'}; once approved, opening and acting anywhere on that origin rides the grant for the rest of the session. A navigation that crosses to an unapproved origin (a link click, a redirect) re-asks before the next act there. Reads (status/waitFor/extract/console/info/screenshot) never ask — on a crossed-to origin too, so an approved page can lead you to read pages elsewhere: name the origin when you report them, and know the operator approved only the origin they were asked for. Sessions and origin approvals are per agent: an approval granted in one agent's session never authorizes another agent, and concurrent browser children are capped (close another session, or the operator raises MERCURY_BROWSER_MAX_SESSIONS). A secret fill (type + secretRef) is its own consent class, approved per secret + origin pairing for the session.

Downloads are never implicit: the driven session denies page-initiated downloads at the protocol level and the result names what was refused — "the link is a download (<type>, <size>, saves as <name>)" on a click, "open failed: <url> is a download (…)" on an open — ${DOWNLOADS_NOT_FOLLOWED}; the one consented download road is provisioning the engine itself — op:"provision" (buildId?) asks the operator before installing a Chrome-for-Testing build (/browser install is the same road by hand). When nothing resolves, provision instead of dead-ending or hand-rolling a headless-Chrome harness. File uploads stay out of scope. The driver needs node >= 22.12.`
  },
  userFacingName,
  shouldDefer: true,
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  isEnabled() {
    return browserToolEnabled()
  },
  isConcurrencySafe(input: Input) {
    return input?.op === 'status'
  },
  isReadOnly(input: Input) {
    return (
      input?.op === 'status' ||
      input?.op === 'waitFor' ||
      input?.op === 'extract' ||
      input?.op === 'console' ||
      input?.op === 'info' ||
      input?.op === 'viewport'
    )
  },
  interruptBehavior() {
    return 'cancel' as const
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    const refused = input.url === undefined ? null : metadataRefusal(input.url)
    if (refused !== null) return { behavior: 'deny' as const, message: refused, decisionReason: { type: 'other' as const, reason: refused } }
    if (input.op === 'provision') {
      try {
        const { installPlanLines, planBrowserInstall } = await import('../../services/browser/browserInstall.js')
        const plan = await planBrowserInstall(input.buildId)
        const lines = installPlanLines(plan)
        return {
          behavior: 'ask' as const,
          message: `Browser provision: download ${plan.consentLine}`,
          decisionReason: { type: 'other' as const, reason: lines.join('\n') },
          updatedInput: { ...input, buildId: plan.buildId },
        }
      } catch (err) {
        return {
          behavior: 'deny' as const,
          message: `provision cannot plan: ${(err as Error).message} — ask the operator to run /browser install on a connected box, or to install a browser normally`,
          decisionReason: { type: 'other' as const, reason: 'browser provisioning metadata unreachable' },
        }
      }
    }
    if (!ACT_OPS.has(input.op)) return { behavior: 'allow' as const, updatedInput: input }
    const owner = ownerFromToolUseContext((context ?? {}) as { owner?: OwnerKey; agentId?: string })
    const permissionContext = (context as Partial<ToolUseContext> | undefined)?.getAppState?.()
      ?.toolPermissionContext as ToolPermissionContext | undefined
    const ruleFor = (content: string): PermissionRule | null => {
      if (!permissionContext) return null
      for (const behavior of ['deny', 'ask', 'allow'] as const) {
        const rule = getRuleByContentsForToolName(permissionContext, 'Browser', behavior).get(content)
        if (rule) return rule
      }
      return null
    }
    const ruleVerdict = (content: string): 'deny' | 'ask' | 'allow' | null => ruleFor(content)?.ruleBehavior ?? null
    if (input.op === 'open') {
      const target = originOf(input.url ?? '')
      const ruled = ruleVerdict(`origin:${target}`)
      if (ruled === 'deny') {
        return {
          behavior: 'deny' as const,
          message: ruleSentence(`Browsing ${target}`, 'deny', ruleFor(`origin:${target}`)!),
          decisionReason: { type: 'other' as const, reason: `origin:${target} carries a deny rule` },
        }
      }
      if (ruled === 'allow' || (ruled === null && (!target.startsWith('http') || originApproved(owner, target)))) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
      return {
        behavior: 'ask' as const,
        message: `Browser open: ${input.url ?? '(no url)'} — first visit to ${target} this session (drives a real headless browser)`,
        suggestions: suggestionForExactCommand('Browser', `origin:${target}`),
      }
    }
    const s = activeSession(owner)
    if (!s) return { behavior: 'allow' as const, updatedInput: input }
    const origin = originOf(s.page.url())
    const ruled = ruleVerdict(`origin:${origin}`)
    if (ruled === 'deny') {
      return {
        behavior: 'deny' as const,
        message: ruleSentence(`Browsing ${origin}`, 'deny', ruleFor(`origin:${origin}`)!),
        decisionReason: { type: 'other' as const, reason: `origin:${origin} carries a deny rule` },
      }
    }
    if (input.op === 'type' && typeof input.secretRef === 'string') {
      if (!origin.startsWith('http')) {
        return {
          behavior: 'deny' as const,
          message: `secret fills only land on real web origins — the page is ${origin} content`,
          decisionReason: { type: 'other' as const, reason: `secret fill refused on non-web scheme ${origin}` },
        }
      }
      const pairing = `secret:${input.secretRef}@${origin}`
      const pairingRuled = ruleVerdict(pairing)
      if (pairingRuled === 'deny') {
        return {
          behavior: 'deny' as const,
          message: ruleSentence(`Filling the secret ${input.secretRef} on ${origin}`, 'deny', ruleFor(pairing)!),
          decisionReason: { type: 'other' as const, reason: `${pairing} carries a deny rule` },
        }
      }
      noteCheckedActOrigin(owner, input.op, origin)
      if (pairingRuled === 'allow' || secretPairingApproved(owner, input.secretRef, origin)) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
      return {
        behavior: 'ask' as const,
        message: `Browser fill secret ${input.secretRef} into ${origin} (target ${input.selector ?? ''}) — the value never enters the conversation; approve exactly this secret-origin pairing`,
        decisionReason: {
          type: 'safetyCheck' as const,
          reason: `filling registered secret ${input.secretRef} into ${origin} needs the operator's own consent for the pairing`,
          operatorOnly: true,
        },
        suggestions: suggestionForExactCommand('Browser', pairing),
      }
    }
    if (ruled === 'allow' || (ruled === null && origin.startsWith('http') && originApproved(owner, origin))) {
      noteCheckedActOrigin(owner, input.op, origin)
      return { behavior: 'allow' as const, updatedInput: input }
    }
    if (!origin.startsWith('http')) {
      if (origin === 'about:' || origin === 'chrome-error:') {
        noteCheckedActOrigin(owner, input.op, origin)
        return { behavior: 'allow' as const, updatedInput: input }
      }
      noteCheckedActOrigin(owner, input.op, origin)
      return {
        behavior: 'ask' as const,
        message: `Browser ${input.op}${actDetail(input)} on a NON-WEB page (${origin}) — page-conjured content, not an approved web origin`,
        decisionReason: {
          type: 'safetyCheck' as const,
          reason: `the top frame is ${origin} content the page itself conjured`,
          operatorOnly: true,
        },
        suggestions: suggestionForExactCommand('Browser', `origin:${origin}`),
      }
    }
    noteCheckedActOrigin(owner, input.op, origin)
    return {
      behavior: 'ask' as const,
      message: `Browser ${input.op}${actDetail(input)} on ${origin} — reached by navigation, not yet approved this session`,
      decisionReason: {
        type: 'safetyCheck' as const,
        reason: `${origin} was reached by navigation, not requested by the operator`,
        operatorOnly: true,
      },
      suggestions: suggestionForExactCommand('Browser', `origin:${origin}`),
    }
  },
  async validateInput(input: Input) {
    if (!browserToolEnabled()) {
      return { result: false as const, message: 'the Browser tool is disabled (MERCURY_BROWSER=0)', errorCode: 1 }
    }
    if (input.op === 'open' && (!input.url || !/^https?:\/\//.test(input.url))) {
      return { result: false as const, message: openSchemeRefusal(input.url), errorCode: 1 }
    }
    if (input.op === 'click' && !input.selector && !(typeof input.x === 'number' && typeof input.y === 'number')) {
      return { result: false as const, message: 'click requires selector, or both x and y', errorCode: 1 }
    }
    if (input.op === 'type' && input.secretRef !== undefined) {
      if (typeof input.text === 'string') {
        return { result: false as const, message: 'type takes text OR secretRef, never both', errorCode: 1 }
      }
      if (!input.selector) {
        return {
          result: false as const,
          message: 'secretRef requires an explicit selector target (secrets are never aimed at "whatever is focused")',
          errorCode: 1,
        }
      }
      if (!BROWSER_SECRET_REF_GRAMMAR.test(input.secretRef)) {
        return {
          result: false as const,
          message: `secretRef "${input.secretRef}" does not match the name grammar (UPPER_SNAKE, letter-led, up to 64 chars)`,
          errorCode: 1,
        }
      }
    }
    if (input.op === 'type' && input.secretRef === undefined && typeof input.text !== 'string') {
      return { result: false as const, message: 'type requires text (the characters to type) or secretRef', errorCode: 1 }
    }
    if (input.op === 'type' && input.clear === true && !input.selector) {
      return { result: false as const, message: 'clear requires a selector target', errorCode: 1 }
    }
    if (input.op === 'scroll' && !input.selector && typeof input.dy !== 'number') {
      return { result: false as const, message: 'scroll requires selector or dy', errorCode: 1 }
    }
    if (input.op === 'waitFor' && input.selector !== undefined && input.text !== undefined) {
      return {
        result: false as const,
        message: 'waitFor takes selector OR text (or neither, meaning navigation)',
        errorCode: 1,
      }
    }
    if (input.op === 'waitFor' && input.state !== undefined && input.selector === undefined) {
      return {
        result: false as const,
        message: 'waitFor state requires a selector (visibility states describe an element)',
        errorCode: 1,
      }
    }
    if (input.op === 'select' && (!input.selector || !input.values || input.values.length === 0)) {
      return {
        result: false as const,
        message: 'select requires selector and values (option values, or visible labels as the fallback)',
        errorCode: 1,
      }
    }
    if (input.op === 'press' && (!input.key || !PRESS_KEYS.has(input.key))) {
      return {
        result: false as const,
        message: `press takes a key from the allowlist [${[...PRESS_KEYS].join(', ')}] — printable characters go through op:"type" (where credential fields refuse)`,
        errorCode: 1,
      }
    }
    if (input.op === 'hover' && !input.selector) {
      return { result: false as const, message: 'hover requires selector', errorCode: 1 }
    }
    if (input.op === 'viewport' && (typeof input.width !== 'number' || typeof input.height !== 'number')) {
      return { result: false as const, message: 'viewport requires width and height (CSS px)', errorCode: 1 }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext) {
    const startedAt = Date.now()
    const owner = ownerFromToolUseContext((context ?? {}) as { owner?: OwnerKey; agentId?: string })
    const sessionAtEntry = activeSession(owner)
    const networkMark = sessionAtEntry?.networkRefusal?.count ?? 0
    let result: string
    let outcome: ToolEffectOutcome = 'no-change'
    let imagePath: string | undefined
    let inlinePath: string | undefined
    let inlineMediaType: string | undefined
    let secretInPlay: { value: string; ref: string } | null = null
    let life = null as OpLife | null
    const signalFor = (s: LiveSession): AbortSignal => (life ??= openOpLife(s, context.abortController?.signal)).signal
    try {
      switch (input.op) {
        case 'status': {
          result = statusReport(owner)
          break
        }
        case 'open': {
          await metadataSafeAddresses(input.url!)
          const target = originOf(input.url!)
          const s = await ensureBrowserSession(owner, {
            signal: context.abortController?.signal,
            origin: target,
          })
          if ('state' in s) {
            result =
              s.state === 'unavailable'
                ? `browser unavailable: ${s.note}\n  Report this block to the operator or use op:"provision" — do NOT hand-build a browser harness.`
                : `browser session refused: ${s.note}`
            outcome = 'failed'
            break
          }
          s.nav.seen = s.nav.seq
          const ringMark = s.consoleRing.length
          const openMarks = markAct(s)
          let response: Awaited<ReturnType<typeof s.page.goto>>
          try {
            response = await s.page.goto(input.url!, {
              waitUntil: input.waitUntil ?? 'load',
              timeout: Math.min(Math.max(input.timeoutMs ?? 30_000, 1000), NAVIGATION_CAP_MS),
              signal: signalFor(s),
            })
          } catch (err) {
            const message = (err as Error).message
            if (!/net::ERR_ABORTED/.test(message)) throw relayNamedFailure(s, input.url!, err)
            await settleAfterAct(s, 1000, openMarks)
            if (s.downloads.count === openMarks.downloads || s.downloads.last === null) throw err
            result = `open failed: ${input.url} is ${downloadWords(s.downloads.last)}`
            outcome = 'failed'
            break
          }
          approveWebOrigin(owner, input.url!)
          const landed = originOf(s.page.url())
          const status = response === null ? null : response.status()
          const statusBit =
            status === null ? '' : status >= 400 ? ` — HTTP ${status} ${response!.statusText()}` : ` [${status}]`
          const textLen = await s.page
            .$eval('body', deepTextOf)
            .then(text => text.trim().length)
            .catch(() => null)
          const errs = s.consoleRing.slice(ringMark).filter(e => e.kind === 'pageerror').length
          const census =
            textLen === null
              ? ''
              : `\n  page: ${textLen} chars of body text${errs > 0 ? `, ${errs} page error(s) — op:"console" reads them` : ''}${
                  textLen === 0 ? ' (the app may still be rendering — waitFor a selector or text)' : ''
                }`
          result = `open: ${s.page.url()}${statusBit} — ${await s.page.title()} (${s.resolution.source}: ${s.resolution.label})${
            landed !== target && landed.startsWith('http')
              ? `\n  note: landed on ${landed} (a redirect crossed origins — acts there will ask)`
              : ''
          }${census}`
          outcome = 'succeeded'
          break
        }
        case 'click': {
          const s = activeSession(owner)
          if (!s) {
            result = noSessionWords(owner)
            outcome = 'failed'
            break
          }
          const originGate = actOriginGate(owner, s, input.op)
          if (originGate !== null) {
            result = originGate
            outcome = 'failed'
            break
          }
          s.nav.seen = s.nav.seq
          const marks = markAct(s)
          const deadline = actDeadline(input)
          let target: string
          if (input.selector) {
            const handle = await resolveActTarget(s, input.selector, deadline, signalFor(s))
            await handle.scrollIntoView()
            await settleBoundingBox(handle, deadline)
            const refusal = await clickGate(s, handle)
            if (refusal !== null) {
              result = `click ${input.selector} refused: ${refusal} — nothing clicked`
              outcome = 'failed'
              break
            }
            const pt = await pickTargetPoint(s, handle)
            await humanClickPoint(s, pt.x, pt.y)
            target = input.selector
          } else {
            const vp = s.page.viewport()
            if (vp && (input.x! < 0 || input.y! < 0 || input.x! >= vp.width || input.y! >= vp.height)) {
              result = `click (${input.x}, ${input.y}) refused: the point is outside the ${vp.width}x${vp.height} viewport — nothing clicked (op:"scroll" brings a target into view; op:"viewport" resizes)`
              outcome = 'failed'
              break
            }
            await humanClickPoint(s, input.x!, input.y!)
            target = `(${input.x}, ${input.y})`
          }
          await settleAfterAct(s, deadline, marks)
          const after = s.page.url()
          result =
            after === marks.url
              ? `click ${target} at ${pageWhere(s)}`
              : `click ${target} — navigated to ${pageWhere(s)} (from ${marks.url}; waitFor settles late loads)`
          result += actConsequences(s, marks)
          outcome = 'succeeded'
          break
        }
        case 'type': {
          const s = activeSession(owner)
          if (!s) {
            result = noSessionWords(owner)
            outcome = 'failed'
            break
          }
          const originGate = actOriginGate(owner, s, input.op)
          if (originGate !== null) {
            result = originGate
            outcome = 'failed'
            break
          }
          s.nav.seen = s.nav.seq
          if (typeof input.secretRef === 'string') {
            const secretOrigin = originOf(s.page.url())
            const requested = await resolveActTarget(s, input.selector!, actDeadline(input), signalFor(s))
            if (await isDisabledTarget(requested)) {
              result = `type refused: ${input.selector} is disabled — nothing filled`
              outcome = 'failed'
              break
            }
            await requested.focus()
            const probe = await probeEditableTarget(s, requested)
            if (!probe || !probe.held) {
              result = `type refused: focus did not land on ${input.selector}${
                probe ? ` — ${probe.desc} holds focus instead` : ''
              }; nothing filled`
              outcome = 'failed'
              break
            }
            if (!probe.editable || probe.readOnly) {
              result = `type refused: ${probe.desc} is ${probe.readOnly ? 'readOnly' : 'not an editable field'} — nothing filled`
              outcome = 'failed'
              break
            }
            if (!probe.credential) {
              result = `type refused: secretRef fills only credential-shaped targets, and ${probe.desc} is not one — pass text for an ordinary field`
              outcome = 'failed'
              break
            }
            const resolved = resolveBrowserSecret(input.secretRef, { origin: secretOrigin })
            if (resolved.state !== 'ok') {
              result = `type refused: ${resolved.note}`
              outcome = 'failed'
              break
            }
            secretInPlay = { value: resolved.value, ref: input.secretRef }
            if (input.clear === true) {
              await s.page.evaluate(() => {
                let active: Element | null = document.activeElement
                while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
                const el = active as HTMLInputElement | null
                if (!el) return
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.select()
                else {
                  const range = document.createRange()
                  range.selectNodeContents(el)
                  const sel = window.getSelection()
                  sel?.removeAllRanges()
                  sel?.addRange(range)
                }
              })
              await s.page.keyboard.press('Backspace')
            }
            const stillHeld = await probeEditableTarget(s, requested)
            if (!stillHeld || !stillHeld.held) {
              result = `type refused mid-act: focus moved to ${stillHeld ? stillHeld.desc : '(nothing)'} before the fill — nothing filled`
              outcome = 'failed'
              break
            }
            if (resolved.origin !== undefined) {
              const filled = await requested.evaluate((el, origin, value) => {
                let active: Element | null = document.activeElement
                while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
                if (location.origin !== origin || !el.isConnected || active !== el) return false
                const field = el as HTMLInputElement | HTMLTextAreaElement
                if (field.disabled || field.readOnly) return false
                const prototype = el.tagName === 'INPUT' ? HTMLInputElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : null
                if (prototype !== null) {
                  const start = field.selectionStart ?? field.value.length
                  const end = field.selectionEnd ?? start
                  const next = field.value.slice(0, start) + value + field.value.slice(end)
                  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, next)
                } else if ((el as HTMLElement).isContentEditable) {
                  el.textContent = (el.textContent ?? '') + value
                } else return false
                el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText' }))
                return true
              }, resolved.origin, resolved.value)
              if (!filled) {
                result = `type refused mid-act: focus moved to ${stillHeld.desc} before the fill — nothing filled`
                outcome = 'failed'
                break
              }
            } else {
              await humanTypeText(s, resolved.value)
            }
            const entered = input.enter === true && (resolved.origin === undefined || originOf(s.page.url()) === resolved.origin)
            if (entered) await s.page.keyboard.press('Enter')
            approveSecretPairing(owner, input.secretRef, resolved.origin ?? originOf(s.page.url()))
            result = `type: filled secret ${input.secretRef} into ${probe.desc}${entered ? ' + Enter' : ''} at ${pageWhere(s)}`
            outcome = 'succeeded'
            break
          }
          const targetName = input.selector ?? '(focused element)'
          let requested: ElementHandle<Element> | null = null
          if (input.selector) {
            requested = await resolveActTarget(s, input.selector, actDeadline(input), signalFor(s))
            if (await isDisabledTarget(requested)) {
              result = `type refused: ${input.selector} is disabled — nothing typed`
              outcome = 'failed'
              break
            }
            await requested.focus()
          }
          const probe = await probeEditableTarget(s, requested)
          if (input.selector && (!probe || !probe.held)) {
            result = `type refused: focus did not land on ${targetName}${
              probe ? ` — ${probe.desc} holds focus instead` : ''
            }; nothing typed`
            outcome = 'failed'
            break
          }
          if (!probe || !probe.editable) {
            result = `type refused: ${targetName} is not an editable field (input/textarea/contenteditable) — nothing typed`
            outcome = 'failed'
            break
          }
          if (probe.credential) {
            result = `type refused: ${probe.desc} is a credential field (${probe.credentialWhy}) — plain text never types into credential fields; pass secretRef instead (the operator registers the secret out-of-band and the value never enters the conversation)`
            outcome = 'failed'
            break
          }
          if (probe.readOnly) {
            result = `type refused: ${probe.desc} is readOnly — nothing typed`
            outcome = 'failed'
            break
          }
          if (probe.tag === 'input' && !TEXT_INPUT_TYPES.has(probe.type)) {
            result =
              probe.type === 'file'
                ? `type refused: ${probe.desc} is a file input — uploads are OUT of this tool's scope (a named deferral)`
                : ['checkbox', 'radio', 'submit', 'button', 'reset', 'image'].includes(probe.type)
                  ? `type refused: ${probe.desc} is type=${probe.type} — use op:"click" to operate it`
                  : `type refused: ${probe.desc} is type=${probe.type}, not a text-bearing input — nothing typed`
            outcome = 'failed'
            break
          }
          if (input.clear === true) {
            await s.page.evaluate(() => {
              let active: Element | null = document.activeElement
              while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
              const el = active as HTMLInputElement | null
              if (!el) return
              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.select()
              else {
                const range = document.createRange()
                range.selectNodeContents(el)
                const sel = window.getSelection()
                sel?.removeAllRanges()
                sel?.addRange(range)
              }
            })
            await s.page.keyboard.press('Backspace')
          }
          const credNow = await s.page.evaluate(() => {
            let active: Element | null = document.activeElement
            while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
            if (!active || active === document.body) return null
            const a = active as HTMLInputElement
            const autocomplete = (a.getAttribute('autocomplete') ?? '').toLowerCase()
            const credAc = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp'].some(
              t => autocomplete.includes(t),
            )
            const softText = `${a.name ?? ''} ${a.id ?? ''} ${a.getAttribute('aria-label') ?? ''}`
            const soft = /pass(word|wd)|otp|totp|2fa|one.?time|secret|api.?key|cvv|cvc|\bssn\b|\bpin\b/i.test(softText)
            return a.type === 'password' || credAc || soft
              ? `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}`
              : null
          })
          if (credNow !== null) {
            result = `type refused mid-act: focus moved to ${credNow} — a credential field; nothing typed`
            outcome = 'failed'
            break
          }
          await humanTypeText(s, input.text!)
          if (input.enter === true) await s.page.keyboard.press('Enter')
          let valueLen: number | null = null
          try {
            valueLen = await s.page.evaluate(() => {
              let active: Element | null = document.activeElement
              while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
              const el = active as HTMLInputElement | null
              return typeof el?.value === 'string' ? el.value.length : null
            })
          } catch {
          }
          result = `type: ${input.text!.length} chars into ${probe.desc}${input.enter === true ? ' + Enter' : ''}${
            valueLen !== null ? ` (value now ${valueLen} chars)` : ''
          } at ${pageWhere(s)}`
          outcome = 'succeeded'
          break
        }
        case 'scroll': {
          const s = activeSession(owner)
          if (!s) {
            result = noSessionWords(owner)
            outcome = 'failed'
            break
          }
          const originGate = actOriginGate(owner, s, input.op)
          if (originGate !== null) {
            result = originGate
            outcome = 'failed'
            break
          }
          s.nav.seen = s.nav.seq
          if (input.selector) {
            const handle = await resolveActTarget(s, input.selector, actDeadline(input), signalFor(s))
            await handle.evaluate(el => (el as HTMLElement).scrollIntoView({ block: 'center' }))
            const yNow = await s.page.evaluate(() => window.scrollY)
            result = `scroll: ${input.selector} into view (scrollY ${Math.round(yNow)}) at ${pageWhere(s)}`
          } else {
            const yNow = await s.page.evaluate(delta => {
              window.scrollBy(0, delta)
              return window.scrollY
            }, input.dy!)
            result = `scroll: by ${input.dy} (scrollY now ${Math.round(yNow)}) at ${pageWhere(s)}`
          }
          outcome = 'succeeded'
          break
        }
        case 'waitFor': {
          const s = activeSession(owner)
          if (!s) {
            result = noSessionWords(owner)
            outcome = 'failed'
            break
          }
          const deadline = Math.min(Math.max(input.timeoutMs ?? WAIT_DEFAULT_MS, 250), WAIT_CAP_MS)
          const t0 = Date.now()
          const waited = input.selector
            ? `selector ${input.selector}`
            : input.text !== undefined
              ? `text "${preview(input.text)}"`
              : 'navigation'
          try {
            if (input.selector) {
              const state = input.state ?? 'visible'
              await s.page.waitForSelector(input.selector, {
                timeout: deadline,
                signal: signalFor(s),
                ...(state === 'visible' ? { visible: true } : state === 'hidden' ? { hidden: true } : {}),
              })
              const landedState =
                state === 'hidden' ? 'hidden/gone' : state === 'visible' ? 'present and visible' : 'present (attached)'
              result = `waitFor selector ${input.selector}: ${landedState} after ${Date.now() - t0}ms at ${pageWhere(s)}`
            } else if (input.text !== undefined) {
              await s.page.waitForFunction(
                (needle: string) => {
                  const norm = (x: string): string => x.replace(/\s+/g, ' ').trim().toLowerCase()
                  return norm(document.body?.innerText ?? '').includes(norm(needle))
                },
                { timeout: deadline, polling: 'raf', signal: signalFor(s) },
                input.text,
              )
              result = `waitFor text "${preview(input.text)}": present after ${Date.now() - t0}ms at ${pageWhere(s)}`
            } else if (s.nav.seq > s.nav.seen) {
              await s.page
                .waitForFunction(() => document.readyState !== 'loading', {
                  timeout: deadline,
                  polling: 'raf',
                  signal: signalFor(s),
                })
                .catch(() => {})
              result = `waitFor navigation: already landed at ${pageWhere(s)} (${Date.now() - t0}ms — the navigation completed during the previous act)`
            } else {
              await s.page.waitForNavigation({
                waitUntil: 'domcontentloaded',
                timeout: deadline,
                signal: signalFor(s),
              })
              result = `waitFor navigation: landed ${s.page.url()} after ${Date.now() - t0}ms`
            }
          } catch (err) {
            if (isDriverTimeout(err)) {
              result = `waitFor ${waited}: deadline ${deadline}ms exceeded (the event never arrived) at ${pageWhere(s)}`
              outcome = 'failed'
              break
            }
            throw err
          }
          outcome = 'succeeded'
          break
        }
        case 'back': {
          const s = activeSession(owner)
          if (!s) {
            result = noSessionWords(owner)
            outcome = 'failed'
            break
          }
          const originGate = actOriginGate(owner, s, input.op)
          if (originGate !== null) {
            result = originGate
            outcome = 'failed'
            break
          }
          s.nav.seen = s.nav.seq
          const before = s.page.url()
          let response = null
          try {
            response = await s.page.goBack({
              waitUntil: 'domcontentloaded',
              timeout: 15_000,
              signal: signalFor(s),
            })
          } catch (err) {
            if (!(err as Error).message.includes('History entry to navigate to not found')) throw err
          }
          const after = s.page.url()
          if (response === null && after === before) {
            result = 'back: no earlier history entry'
            break
          }
          if (isBrowserErrorPage(after)) {
            result = failedNavigationWords('back', s, 'the earlier page')
            outcome = 'failed'
            break
          }
          const backStatus = response === null ? '' : ` [${response.status()}]`
          const sameDocument = response === null && after.split('#')[0] === before.split('#')[0]
          const pageOrigin =
            response === null
              ? sameDocument
                ? ' (the same page, only its fragment changed; the server was not asked)'
                : " (restored from the browser's cache; the server was not asked)"
              : response.fromCache()
                ? " (served from the browser's cache; the server was not asked)"
                : ''
          result = `back: ${after}${backStatus} — ${await s.page.title()}${pageOrigin}`
          outcome = 'succeeded'
          break
        }
        case 'reload': {
          const s = activeSession(owner)
          if (!s) {
            result = noSessionWords(owner)
            outcome = 'failed'
            break
          }
          const originGate = actOriginGate(owner, s, input.op)
          if (originGate !== null) {
            result = originGate
            outcome = 'failed'
            break
          }
          s.nav.seen = s.nav.seq
          const reloading = s.navFailure.last?.url ?? s.page.url()
          const reloadResponse = await s.page.reload({
            waitUntil: input.waitUntil ?? 'load',
            timeout: Math.min(Math.max(input.timeoutMs ?? 30_000, 1000), NAVIGATION_CAP_MS),
            signal: signalFor(s),
          })
          if (isBrowserErrorPage(s.page.url())) {
            result = failedNavigationWords('reload', s, reloading)
            outcome = 'failed'
            break
          }
          const reloadStatus =
            reloadResponse === null
              ? ''
              : reloadResponse.status() >= 400
                ? ` — HTTP ${reloadResponse.status()} ${reloadResponse.statusText()}`
                : ` [${reloadResponse.status()}]`
          result = `reload: ${s.page.url()}${reloadStatus} — ${await s.page.title()}`
          outcome = 'succeeded'
          break
        }
        case 'select': {
          const s = activeSession(owner)
          if (!s) {
            result = noSessionWords(owner)
            outcome = 'failed'
            break
          }
          const originGate = actOriginGate(owner, s, input.op)
          if (originGate !== null) {
            result = originGate
            outcome = 'failed'
            break
          }
          s.nav.seen = s.nav.seq
          const handle = await resolveActTarget(s, input.selector!, actDeadline(input), signalFor(s))
          const isSelect = await handle.evaluate(el => el.tagName === 'SELECT')
          if (!isSelect) {
            result = `select refused: ${input.selector} is not a <select> element — op:"type" fills text fields, op:"click" toggles checkboxes`
            outcome = 'failed'
            break
          }
          let matched = await handle.select(...input.values!)
          let via = 'value'
          if (matched.length === 0) {
            const byLabel = await handle.evaluate((el, wanted: string[]) => {
              const out: string[] = []
              for (const w of wanted) {
                for (const o of Array.from((el as HTMLSelectElement).options)) {
                  if ((o.label ?? '').trim() === w || (o.textContent ?? '').trim() === w) out.push(o.value)
                }
              }
              return out
            }, input.values!)
            if (byLabel.length > 0) {
              matched = await handle.select(...byLabel)
              via = 'visible label'
            }
          }
          if (matched.length === 0) {
            const options = await handle.evaluate(el =>
              Array.from((el as HTMLSelectElement).options)
                .map(o => `${o.value}="${(o.label ?? '').trim()}"`)
                .join(', '),
            )
            result = `select: no option matched [${input.values!.join(', ')}] on ${input.selector} — options: ${options}`
            outcome = 'failed'
            break
          }
          const chosen = await handle.evaluate(el =>
            Array.from((el as HTMLSelectElement).selectedOptions)
              .map(o => `${o.value} "${(o.label ?? '').trim()}"`)
              .join(', '),
          )
          result = `select ${input.selector} (by ${via}): now ${chosen} at ${pageWhere(s)}`
          outcome = 'succeeded'
          break
        }
        case 'press': {
          const s = activeSession(owner)
          if (!s) {
            result = noSessionWords(owner)
            outcome = 'failed'
            break
          }
          if (!PRESS_KEYS.has(input.key ?? '')) {
            result = `press refused: "${input.key}" is not in the key allowlist [${[...PRESS_KEYS].join(', ')}] — printable characters go through op:"type" (where credential fields refuse)`
            outcome = 'failed'
            break
          }
          const originGate = actOriginGate(owner, s, input.op)
          if (originGate !== null) {
            result = originGate
            outcome = 'failed'
            break
          }
          s.nav.seen = s.nav.seq
          const mods = input.modifiers ?? []
          const pressMarks = markAct(s)
          for (const m of mods) await s.page.keyboard.down(m)
          try {
            await s.page.keyboard.press(input.key! as Parameters<typeof s.page.keyboard.press>[0])
          } finally {
            for (const m of [...mods].reverse()) await s.page.keyboard.up(m)
          }
          await settleAfterAct(s, actDeadline(input), pressMarks)
          result =
            s.page.url() === pressMarks.url
              ? `press ${[...mods, input.key].join('+')} at ${pageWhere(s)}`
              : `press ${[...mods, input.key].join('+')} — navigated to ${pageWhere(s)} (from ${pressMarks.url})`
          result += actConsequences(s, pressMarks)
          outcome = 'succeeded'
          break
        }
        case 'hover': {
          const s = activeSession(owner)
          if (!s) {
            result = noSessionWords(owner)
            outcome = 'failed'
            break
          }
          const originGate = actOriginGate(owner, s, input.op)
          if (originGate !== null) {
            result = originGate
            outcome = 'failed'
            break
          }
          s.nav.seen = s.nav.seq
          const handle = await resolveActTarget(s, input.selector!, actDeadline(input), signalFor(s))
          await handle.scrollIntoView()
          const hoverPt = await pickTargetPoint(s, handle)
          await humanMoveTo(s, hoverPt)
          result = `hover ${input.selector} at ${pageWhere(s)}`
          outcome = 'succeeded'
          break
        }
        case 'provision': {
          const { installManagedBrowser, planBrowserInstall } = await import(
            '../../services/browser/browserInstall.js'
          )
          const buildId = input.buildId ?? (await planBrowserInstall()).buildId
          const installed = await installManagedBrowser(buildId)
          result = `provisioned Chrome for Testing ${installed.buildId} — ${(installed.sizeBytes / 1024 / 1024).toFixed(0)} MB on disk\n  ${installed.executablePath}\n  remove any time: /browser remove ${installed.buildId}`
          outcome = 'succeeded'
          break
        }
        case 'viewport': {
          const s = activeSession(owner)
          if (!s) {
            result = noSessionWords(owner)
            outcome = 'failed'
            break
          }
          const width = Math.min(Math.max(Math.floor(input.width!), 320), 3840)
          const height = Math.min(Math.max(Math.floor(input.height!), 240), 2160)
          const dsf =
            input.deviceScaleFactor !== undefined ? Math.min(Math.max(input.deviceScaleFactor, 1), 3) : undefined
          await s.page.setViewport({ width, height, ...(dsf !== undefined ? { deviceScaleFactor: dsf } : {}) })
          const vp = s.page.viewport()
          result = `viewport: ${vp?.width}x${vp?.height}${vp?.deviceScaleFactor ? ` @${vp.deviceScaleFactor}x` : ''} at ${pageWhere(s)}`
          outcome = 'succeeded'
          break
        }
        case 'extract': {
          const s = activeSession(owner)
          if (!s) {
            result = noSessionWords(owner)
            outcome = 'failed'
            break
          }
          const scope = input.selector ?? 'body'
          const root = input.selector ? await resolveReadTarget(s, input.selector, actDeadline(input), signalFor(s)) : null
          if ((input.mode ?? 'text') === 'text') {
            const text = root
              ? await root.evaluate(deepTextOf)
              : await s.page.$eval('body', deepTextOf)
            result = capExtract(`extract text (${scope}) at ${pageWhere(s)}`, text, input.offset ?? 0)
          } else {
            const snapshot = await s.page.accessibility.snapshot({ includeIframes: true, ...(root ? { root } : {}) })
            result = capExtract(`extract tree (${scope}) at ${pageWhere(s)}`, serializeAxTree(snapshot), input.offset ?? 0)
          }
          break
        }
        case 'console': {
          const s = activeSession(owner)
          if (!s) {
            result = noSessionWords(owner)
            outcome = 'failed'
            break
          }
          const ring = s.consoleRing
          const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), CONSOLE_RING_CAP)
          const slice = ring.slice(-limit)
          result =
            slice.length === 0
              ? `console: empty (the ring keeps the last ${CONSOLE_RING_CAP} console/net/dialog entries)`
              : [
                  `console: last ${slice.length} of ${ring.length} entries (console+net+dialog ring, cap ${CONSOLE_RING_CAP})`,
                  ...slice.map(e => `${localClock(e.at)} ${e.kind}: ${e.text}`),
                ].join('\n')
          break
        }
        case 'info': {
          const s = activeSession(owner)
          if (!s) {
            result = noSessionWords(owner)
            outcome = 'failed'
            break
          }
          const origin = originOf(s.page.url())
          const approval = origin.startsWith('http')
            ? originApproved(owner, origin)
              ? ' (approved this session)'
              : ' (NOT approved — acts will ask)'
            : isBrowserErrorPage(s.page.url())
              ? ` (${errorPageWords(s)})`
              : ''
          const vp = s.page.viewport()
          result = [
            `url: ${s.page.url()}`,
            `title: ${await s.page.title()}`,
            `origin: ${origin}${approval}`,
            `viewport: ${vp?.width}x${vp?.height}${vp?.deviceScaleFactor ? ` @${vp.deviceScaleFactor}x` : ''}`,
          ].join('\n')
          break
        }
        case 'screenshot': {
          const s = activeSession(owner)
          if (!s) {
            result = noSessionWords(owner)
            outcome = 'failed'
            break
          }
          const file = screenshotPath(input.label ?? new URL(s.page.url()).hostname)
          if (input.selector) {
            const handle = await resolveActTarget(s, input.selector, actDeadline(input), signalFor(s))
            await handle.screenshot({ path: file as `${string}.png` })
          } else {
            await s.page.screenshot({ path: file as `${string}.png`, fullPage: input.fullPage === true })
          }
          imagePath = file
          let sizeNote = ''
          if (modelReceivesImageBlocks(getEngineModel())) {
            try {
              const img = await readImageWithTokenBudget(file)
              const inlineBytes = Math.floor((img.file.base64.length * 3) / 4)
              if (img.file.originalSize > inlineBytes * 1.2) {
                inlinePath = `${file}.inline`
                writeFileSync(inlinePath, Buffer.from(img.file.base64, 'base64'))
                inlineMediaType = img.file.type
                sizeNote = ` (inlined copy downscaled to the image budget: ${(img.file.originalSize / 1024).toFixed(0)}KB on disk, ~${(inlineBytes / 1024).toFixed(0)}KB inlined)`
              }
            } catch {
            }
          }
          const vp = s.page.viewport()
          result = `screenshot: ${file}${input.selector ? ` (element ${input.selector})` : ''} (${pageWhere(s)}, viewport ${vp?.width}x${vp?.height})${sizeNote}`
          outcome = 'succeeded'
          break
        }
        case 'close': {
          const closed = await closeBrowserSessionDetailed(owner)
          result =
            closed.outcome === 'closed'
              ? 'session closed (browser reaped; origin approvals wiped)'
              : closed.outcome === 'killed'
                ? `session closed — the browser did not answer within ${BROWSER_CLOSE_BOUND_MS / 1000}s and its process was ended (origin approvals wiped)`
                : closed.outcome === 'gone'
                  ? 'closed (the browser was already gone)'
                  : 'no open session'
          outcome = closed.outcome === 'none' ? 'no-change' : 'succeeded'
          break
        }
      }
    } catch (err) {
      const e = err as Error
      const interrupted = context.abortController?.signal.aborted === true
      const goneMidOp = e.name === BROWSER_GONE_ERROR || (life !== null && !life.browser.connected)
      result =
        interrupted || (e.name === 'AbortError' && !goneMidOp)
          ? `${input.op} interrupted by the operator — the wait was released, nothing further was done`
          : goneMidOp
            ? browserGoneMidOpWords(input.op)
            : (driverFailureWords(input.op, errorChainText(e)) ?? `${input.op} failed: ${e.message}`)
      outcome = 'failed'
    } finally {
      life?.release()
    }
    if (secretInPlay !== null) {
      result = scrubSecretFromText(result!, secretInPlay.value, secretInPlay.ref)
    }
    const sessionAtExit = activeSession(owner)
    const refusedNetwork = sessionAtExit?.networkRefusal
    const refusalMark = sessionAtExit === sessionAtEntry ? networkMark : 0
    if (refusedNetwork !== undefined && refusedNetwork.count > refusalMark) {
      result = `${input.op} refused: ${refusedNetwork.last}`
      outcome = 'failed'
    }
    const output: Output = {
      op: input.op,
      result: result!,
      outcome,
      ...(imagePath !== undefined && { imagePath }),
      ...(inlinePath !== undefined && { inlinePath }),
      ...(inlineMediaType !== undefined && { inlineMediaType }),
    }
    return {
      data: output,
      effect: {
        outcome,
        operation: `browser.${input.op}`,
        changedPaths: imagePath ? [imagePath] : [],
        evidence: output.result.split('\n')[0]?.slice(0, 160) ?? '',
        startedAt,
        completedAt: Date.now(),
      },
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
