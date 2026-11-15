
import { readFileSync, writeFileSync } from 'node:fs'
import { metadataRefusal, metadataSafeAddresses } from '../WebFetchTool/privateHost.js'
import { basename, join } from 'node:path'
import type { ElementHandle, Frame, Page, Protocol, SerializedAXNode } from 'puppeteer-core'
import { z } from 'zod/v4'
import { buildTool, getEmptyToolPermissionContext, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { readImageWithTokenBudget } from '../FileReadTool/FileReadTool.js'
import { imageDimensionsOfBase64 } from '../../utils/imageResizer.js'
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
  BROWSER_FINISH_BOUND_MS,
  BROWSER_PROTOCOL_TIMEOUT_MS,
  CONSOLE_RING_CAP,
  MAIN_TAB,
  NAVIGATION_CAP_MS,
  activeSession,
  approveWebOrigin,
  approvedOriginList,
  bringTabToFront,
  browserSessionCap,
  browserTabs,
  browserTransfers,
  beginBrowserActivity,
  closeBrowserSessionDetailed,
  consumeCheckedActOrigin,
  driverVersion,
  emulatedPageOf,
  endedTab,
  ensureBrowserSession,
  firstNavigation,
  isBrowserErrorPage,
  liveBrowserSessionCensus,
  noteCheckedActOrigin,
  noteEmulatedPage,
  originApproved,
  originOf,
  approveSecretPairing,
  pageKitOf,
  popupInFlight,
  popupsSettled,
  screenshotPath,
  secretPairingApproved,
  sessionGoneAt,
  sessionOfFrame,
  type CheckedTarget,
} from '../../services/browser/browserSession.js'
import {
  EMULATION_FIELD_WORDS,
  applyEmulation,
  carryEmulation,
  deviceNames,
  emulationActive,
  emulationLines,
  emulationSummary,
  heldDevice,
  inheritEmulation,
  notePlainSize,
  parseEmulation,
  type EmulationOutcome,
} from '../../services/browser/browserEmulation.js'
import {
  BROWSER_SECRET_REF_GRAMMAR,
  resolveBrowserSecret,
  scrubSecretFromText,
} from '../../services/browser/browserSecrets.js'
import type { Transfer } from '../../services/browser/browserTransfers.js'
import { dropStagedUpload, resolveUploadSources, stageUploads, uploadSourcesChanged, type UploadSource } from '../../services/browser/browserUploads.js'
import { APPROVAL_RULE_LINE, INSTALLED_NOT_DRIVEN } from '../../services/browser/browserWords.js'
import { ensureScratchpadDir } from '../../utils/scratchpad.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { checkReadPermissionForTool, checkUncPathPermission, getScratchpadDir } from '../../utils/permissions/filesystem.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/permissions.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import { ruleSentence } from '../../utils/permissions/ruleReason.js'
import type { PermissionDecision, PermissionDecisionReason, PermissionRule, ToolPermissionContext } from '../../types/permissions.js'
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
  'upload',
])

const FRONT_OPS: ReadonlySet<string> = new Set(['click', 'type', 'scroll', 'back', 'reload', 'select', 'press', 'hover', 'screenshot', 'upload'])
const TABLESS_OPS: ReadonlySet<string> = new Set(['status', 'devices', 'provision', 'download'])
const TOUCH_OPS: ReadonlySet<string> = new Set(['click', 'type', 'select', 'press', 'upload'])

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

function noSessionWords(owner: OwnerKey, tab: string = MAIN_TAB): string {
  const open = browserTabs(owner).map(live => live.tab)
  if (open.length === 0) return sessionGoneAt(owner) === null ? NO_SESSION : BROWSER_GONE
  const ended = endedTab(owner, tab)
  return `${ended === null ? `no tab ${tab}` : `tab ${tab} ${ended}`} — op:"open" with tab:"${tab}" opens it; open: ${open.join(', ')}`
}

export function driverFailureWords(op: string, message: string, policy?: string): string | null {
  if (/Node is either not clickable or not an Element/i.test(message)) {
    return `${op} refused: the target is not a clickable element. Use op:"scroll" to bring it into view or op:"waitFor" until the route settles, then extract the page again.`
  }
  if (/net::ERR_BLOCKED_BY_CLIENT/.test(message)) {
    return `${op} refused: the browser blocked this request${policy === undefined ? ' and did not report which policy' : ` under its ${policy} policy`}. Use op:"console" for the request details; ask the operator before changing browser policy.`
  }
  if (/net::ERR_INVALID_AUTH_CREDENTIALS/.test(message)) {
    return `${op} failed: ${message} — the site asks for basic credentials: op:"viewport" with emulation.credentials sets them, then op:"reload"`
  }
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
const PAGE_CRASHED_ERROR = 'PageCrashedError'
const CRASH_OPEN_OPS: ReadonlySet<string> = new Set(['status', 'devices', 'provision', 'open', 'reload', 'close', 'console'])

function pageCrashedError(): Error {
  const err = new Error('the page crashed (its process exited mid-op)')
  err.name = PAGE_CRASHED_ERROR
  return err
}

function crashedWords(s: LiveSession, named: boolean, op?: string): string {
  return `${op === undefined ? '' : `${op}: `}${named ? `tab ${s.tab}` : 'the page'} crashed (its process exited${op === undefined ? '' : ' mid-op'}) — op:"reload" loads it again with its form values and script state gone; op:"close"${named ? ` with tab:"${s.tab}" drops it` : ' ends the session'}`
}

const RECOVERED_NOTE = '\n  note: the page had crashed and this is a fresh load: form values and script state are gone; history, cookies and stored data stay'

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
  const onCrash = (): void => life.abort(pageCrashedError())
  if (outer?.aborted) life.abort(outer.reason)
  else outer?.addEventListener('abort', onOuter, { once: true })
  if (s.browser.connected) s.browser.on('disconnected', onGone)
  else onGone()
  s.page.on('error', onCrash)
  return {
    signal: life.signal,
    browser: s.browser,
    release: (): void => {
      outer?.removeEventListener('abort', onOuter)
      s.browser.off('disconnected', onGone)
      if (typeof s.page.off === 'function') s.page.off('error', onCrash)
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

async function tabLine(live: LiveSession): Promise<string> {
  const title = live.crashed ? '' : await Promise.race([live.page.title().catch(() => ''), bounded(1000).then(() => '')])
  const vp = live.page.viewport()
  const device = heldDevice(live.page)?.device
  const facts = [`page ${live.serial}`, `viewport ${vp?.width}x${vp?.height}`, device ? `device ${device}` : '', live.persist ? 'persist' : 'idle lease', live.crashed ? 'crashed' : ''].filter(Boolean)
  return `${live.tab}: ${pageWhere(live)}${title ? ` — ${title}` : ''} (${facts.join('; ')})`
}

async function statusReport(owner: OwnerKey, input: Input): Promise<string> {
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
  const tabs = browserTabs(owner)
  const live = tabs.length === 1 && tabs[0]!.tab === MAIN_TAB ? tabs[0]! : null
  if (tabs.length === 0 || live !== null) {
    lines.push(
      live
        ? `session: OPEN at ${live.page.url()} (viewport ${live.page.viewport()?.width}x${live.page.viewport()?.height}${live.crashed ? '; crashed' : ''})`
        : 'session: none',
    )
  } else {
    const first = Math.min(Math.max(Math.floor(input.offset ?? 0), 0), tabs.length)
    const shown = tabs.slice(first, first + Math.max(Math.floor(input.limit ?? 50), 1))
    lines.push(`session: OPEN — ${tabs.length} tab${tabs.length === 1 ? '' : 's'}${first > 0 ? `, from ${first}` : ''}`)
    for (const tab of shown) lines.push(`  ${await tabLine(tab)}`)
    if (first + shown.length < tabs.length) lines.push(`  … ${tabs.length - first - shown.length} more — continue with offset: ${first + shown.length}`)
  }
  if (tabs.some(tab => tab.sandboxDowngraded)) lines.push('  sandbox: DISABLED (running as uid 0 — container mode; --no-sandbox appended)')
  const grants = approvedOriginList(owner)
  if (grants.length > 0) lines.push(`approved origins (this session): ${grants.join(' · ')}`)
  lines.push(APPROVAL_RULE_LINE)
  const others = liveBrowserSessionCensus().filter(row => row.owner !== owner)
  if (others.length > 0) {
    const cap = browserSessionCap()
    lines.push(
      `other live sessions: ${others.length} (${others.map(o => o.lane).join(', ')}); ${cap === null ? '' : `cap: ${cap} children per parent session, plus the lead slot; `}idle lease: 5 minutes; grants never cross owners`,
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
          ? '  (frame content below: use frame with its index or URL substring to target it)'
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

function targetSurface(s: LiveSession, frame: Input['frame']): Page | Frame {
  if (frame === undefined || frame === 0) return s.page
  const children = s.page.frames().filter(f => f.parentFrame() !== null)
  const matches = typeof frame === 'number' ? children.filter((_, i) => i + 1 === frame) : children.filter(f => f.url().includes(frame))
  if (matches.length !== 1) throw new Error(`frame ${JSON.stringify(frame)} matched ${matches.length} child frames; extract lists their indices and URLs`)
  return matches[0]!
}

async function targetOrigin(s: LiveSession, frame: Input['frame']): Promise<string> {
  const surface = targetSurface(s, frame)
  if (surface === s.page) return originOf(surface.url())
  const realm = (surface as Frame & { isolatedRealm(): Pick<Frame, 'evaluate'> }).isolatedRealm()
  const origin = await realm.evaluate(() => window.origin)
  return origin === 'null' ? 'opaque:' : originOf(origin)
}

function sendOrigin(s: LiveSession): string {
  const here = originOf(s.page.url())
  return here.startsWith('http') || s.navFailure.last === null ? here : originOf(s.navFailure.last.url)
}

function frameListing(s: LiveSession): string {
  const frames = s.page.frames().filter(f => f.parentFrame() !== null)
  return frames.length ? `\nFrames: ${frames.map((f, i) => `${i + 1} = ${f.url()}`).join('; ')}` : ''
}

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
  return `${op} failed: ${failed ? `${failed.errorText} at ${failed.url}` : `${wanted} did not load`} — the browser shows its own error page (${s.page.url()}), not the site; ${
    failed?.errorText === 'net::ERR_INVALID_AUTH_CREDENTIALS'
      ? 'the site asks for basic credentials (op:"viewport" with emulation.credentials sets them)'
      : 'the server is down or refusing connections'
  }`
}

function viewportWords(s: LiveSession): string {
  const vp = s.page.viewport()
  return `viewport: ${vp?.width}x${vp?.height}${vp?.deviceScaleFactor ? ` @${vp.deviceScaleFactor}x` : ''}${vp?.isMobile ? ' mobile' : ''}${vp?.hasTouch ? ' touch' : ''}${vp?.isLandscape ? ' landscape' : ''}`
}

function bytesWords(n: number): string {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export const DOWNLOADS_NOT_FOLLOWED = 'downloads are not followed here; fetch the file with WebFetch or Bash instead'

const namedTransfers = new WeakSet<Transfer>()

function transferWords(transfer: Transfer): string {
  namedTransfers.add(transfer)
  if (transfer.state === 'complete') {
    return `saved to ${transfer.path} (${bytesWords(transfer.bytes ?? 0)}, ${transfer.type ?? 'type unknown'}, suggested name ${transfer.name}, from ${transfer.url}, sha256 ${transfer.sha256}) — download ${transfer.id}, in the session scratchpad`
  }
  if (transfer.state === 'failed') return `download ${transfer.id} failed: ${transfer.failure} (${transfer.name} from ${transfer.url})`
  const idle = Math.floor((Date.now() - transfer.movedAt) / 1000)
  return `download ${transfer.id} is still arriving (${bytesWords(transfer.received)}${transfer.total !== null ? ` of ${bytesWords(transfer.total)}` : ''} of ${transfer.name} from ${transfer.url}${idle >= 5 ? `; no new bytes for ${idle} s` : ''}) — op:"download" with downloadId:"${transfer.id}" waits for it`
}

function downloadWords(notice: NonNullable<LiveSession['downloads']['last']>): string {
  if (notice.transfer !== null) return `a download — ${transferWords(notice.transfer)}`
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
  s.navWatch.frames = 0
  return { at: Date.now(), ringMark: s.consoleRing.length, popups: s.popups.count, downloads: s.downloads.count, url: s.page.url() }
}

function bounded(ms: number): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    ;(t as { unref?: () => void }).unref?.()
  })
}

async function settleAfterAct(s: LiveSession, deadline: number, marks: ActMarks): Promise<void> {
  if (s.popups.count === marks.popups && !popupInFlight(s)) {
    await Promise.race([
      s.page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)))).catch(() => undefined),
      bounded(1000),
      new Promise<void>(wake => s.popups.waiters.push(wake)),
    ])
  }
  await popupsSettled(s)
  const until = Date.now() + deadline
  while ((s.navWatch.pendingUrl !== null || s.navWatch.frames > 0) && Date.now() < until) {
    await Promise.race([new Promise<void>(wake => s.navWatch.waiters.push(wake)), bounded(until - Date.now())])
  }
  if (s.navWatch.abortedAt >= marks.at && s.downloads.count === marks.downloads) {
    await Promise.race([new Promise<void>(wake => s.downloads.waiters.push(wake)), bounded(1000)])
  }
  const download = s.downloads.last
  if (download !== null && s.downloads.count > marks.downloads) await Promise.race([download.transfer?.done ?? download.done, bounded(1000)])
}

function downloadVia(input: Input): 'open' | 'click' | null {
  if (input.op !== 'download' || (input.downloadId !== undefined && input.downloadId !== '')) return null
  if (input.url !== undefined && input.url !== '') return 'open'
  if (input.selector !== undefined && input.selector !== '') return 'click'
  return null
}

function downloadAct(input: Input): Input {
  const via = downloadVia(input)
  return via === null ? input : { ...input, op: via, timeoutMs: undefined }
}

async function downloadSought(s: LiveSession, before: number, timeoutMs: number | undefined, signal: AbortSignal | undefined): Promise<string> {
  s.touched = true
  if (s.downloads.count > before) return ''
  const budget = Math.min(Math.max(timeoutMs ?? WAIT_DEFAULT_MS, 250), WAIT_CAP_MS)
  const interrupted = await new Promise<boolean>(resolve => {
    const stop = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve(false)
    }, budget)
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop, { once: true })
    s.downloads.waiters.push(() => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      resolve(false)
    })
  })
  const began = s.downloads.last
  if (s.downloads.count === before || began === null) {
    return `\n  note: ${interrupted ? 'the wait for a download was interrupted' : `no download has begun in ${budget >= 1000 ? `${Math.round(budget / 1000)} s` : `${budget} ms`}`} — this tab stays followed: one that begins later is saved and named in the next answer on it`
  }
  await Promise.race([began.transfer?.done ?? began.done, bounded(1000)])
  return `\n  note: the page started ${downloadWords(began)}`
}

const CHOOSER_WAIT_MS = 2000

interface HeldFile {
  name: string
  size: number
  type: string
}

function heldWords(files: readonly HeldFile[]): string {
  const shown = files.slice(0, 5).map(file => `${file.name} (${bytesWords(file.size)}, ${file.type === '' ? 'type unknown' : file.type})`)
  return `${fileCount(files.length)} — ${shown.join(', ')}${files.length > shown.length ? ` and ${files.length - shown.length} more` : ''}`
}

const HELD_FILES = `function () { return Array.from(this.files || []).map(function (file) { return { name: file.webkitRelativePath || file.name, size: file.size, type: file.type } }) }`

async function sendUpload(
  s: LiveSession,
  input: Input,
  checked: UploadSource[] | null,
  rules: ToolPermissionContext | undefined,
  judgedOrigin: string | null,
  stagingRoot: () => string,
  signal: AbortSignal,
): Promise<{ words: string; outcome: ToolEffectOutcome }> {
  const refused = (why: string): { words: string; outcome: ToolEffectOutcome } => ({ words: `upload refused: ${why} — nothing sent`, outcome: 'failed' })
  const selector = input.selector!
  const given = input.files ?? []
  const resolved = resolveUploadSources(given)
  if ('refusal' in resolved) return refused(resolved.refusal)
  for (const source of resolved.sources) {
    for (const member of source.members) {
      const decision = checkReadPermissionForTool({ name: 'Read', getPath: () => member.path }, input, rules ?? getEmptyToolPermissionContext())
      if (decision.behavior === 'deny') return refused(decision.message)
    }
  }
  const changed = checked === null ? null : uploadSourcesChanged(checked, resolved.sources.filter(source => checked.some(seen => seen.given === source.given)))
  if (changed !== null) return refused(`${changed}; re-issue to have what is there now judged`)
  s.nav.seen = s.nav.seq
  const marks = markAct(s)
  const deadline = actDeadline(input)
  const after = async (words: string): Promise<{ words: string; outcome: ToolEffectOutcome }> => {
    await settleAfterAct(s, deadline, marks)
    const moved = s.page.url() === marks.url ? '' : `\n  note: the page then navigated to ${pageWhere(s)} (from ${marks.url})`
    return { words: `${words}${moved}${actConsequences(s, marks)}`, outcome: 'succeeded' }
  }
  const target = await resolveReadTarget(s, selector, deadline, signal, input.frame)
  const facts = await target.evaluate(el => {
    const field = el instanceof HTMLInputElement && el.type === 'file' ? el : null
    return {
      file: field !== null,
      multiple: field?.multiple === true,
      folder: field?.webkitdirectory === true,
      disabled: field !== null && (field.disabled || field.closest('fieldset:disabled') !== null),
      held: field?.files?.length ?? 0,
    }
  })
  const folder = resolved.sources.find(source => source.folder)
  if (facts.file) {
    if (facts.disabled) return refused(`${selector} is disabled`)
    if (given.length === 0) {
      await (target as ElementHandle<HTMLInputElement>).uploadFile()
      return after(`upload: ${selector} cleared at ${pageWhere(s)} (it held ${facts.held === 0 ? 'no file' : fileCount(facts.held)})`)
    }
    if (folder !== undefined && !facts.folder) return refused(`${folder.given} is a folder and ${selector} is not a folder input (webkitdirectory); name its files`)
    if (!facts.multiple && resolved.sources.length > 1) return refused(`${selector} takes one ${facts.folder ? 'folder' : 'file'} (it has no multiple attribute) and ${resolved.sources.length} were given`)
    const staged = await stageUploads(resolved.sources, stagingRoot(), signal)
    try {
      await (target as ElementHandle<HTMLInputElement>).uploadFile(...staged.paths)
    } catch (err) {
      await dropStagedUpload(staged.dir)
      throw err
    }
    const read = (): Promise<HeldFile[]> =>
      target.evaluate(el => Array.from((el as HTMLInputElement).files ?? []).map(file => ({ name: file.webkitRelativePath || file.name, size: file.size, type: file.type })))
    let held = await read()
    for (const until = Date.now() + Math.min(deadline, 5000); held.length < staged.files && Date.now() < until; held = await read()) await bounded(25)
    return after(`upload: ${selector} holds ${heldWords(held)} at ${pageWhere(s)} (set on the page; nothing reaches the site until the page sends it)`)
  }
  if (given.length === 0) return refused(`an empty list clears a file input, and ${selector} is not one`)
  const cdp = pageKitOf(s.page)?.cdp ?? null
  if (cdp === null) return refused('this page has no protocol session of its own to carry a drop or a file chooser')
  const handle = await resolveActTarget(s, selector, deadline, signal, input.frame)
  await handle.scrollIntoView()
  await settleBoundingBox(handle, deadline)
  const staged = await stageUploads(resolved.sources, stagingRoot(), signal)
  let delivered = false
  try {
    const point = await pickTargetPoint(s, handle)
    const realm = (handle.frame as Frame & { isolatedRealm(): Pick<Frame, 'evaluateHandle'> }).isolatedRealm()
    const probe = await realm.evaluateHandle(() => {
      const state: { over: Event | null; dropped: Event | null; taken: boolean | null; stop: () => void } = { over: null, dropped: null, taken: null, stop: () => {} }
      const over = (event: Event): void => {
        state.over = event
      }
      const dropped = (event: Event): void => {
        state.dropped = event
      }
      const last = (event: Event): void => {
        state.taken = event.defaultPrevented
        if (!event.defaultPrevented) event.preventDefault()
      }
      window.addEventListener('dragover', over, true)
      window.addEventListener('drop', dropped, true)
      window.addEventListener('drop', last, false)
      state.stop = () => {
        window.removeEventListener('dragover', over, true)
        window.removeEventListener('drop', dropped, true)
        window.removeEventListener('drop', last, false)
      }
      return state
    })
    const drag = (type: 'dragEnter' | 'dragOver' | 'drop' | 'dragCancel'): Promise<void> =>
      cdp.send('Input.dispatchDragEvent', { type, x: point.x, y: point.y, data: { items: [], files: staged.paths, dragOperationsMask: 1 } })
    let accepted: boolean | null = null
    let taken: boolean | null = null
    try {
      await drag('dragEnter')
      for (let round = 0; round < 3 && accepted === null; round++) {
        await drag('dragOver')
        accepted = await probe.evaluate(state => (state.over === null ? null : state.over.defaultPrevented))
        if (accepted === null) await bounded(40)
      }
      if (accepted === true) {
        await drag('drop')
        taken = await probe.evaluate(state => state.taken ?? (state.dropped === null ? null : state.dropped.defaultPrevented))
      } else {
        await drag('dragCancel')
      }
    } finally {
      await probe.evaluate(state => state.stop()).catch(() => undefined)
      await probe.dispose().catch(() => undefined)
    }
    if (accepted === true) {
      if (taken !== true) {
        return { words: `upload: ${selector} accepted the drag and did not take the drop — the page received nothing`, outcome: 'failed' }
      }
      delivered = true
      const names = resolved.sources.map(source => `${basename(source.path)}${source.folder ? ` (a folder of ${fileCount(source.members.length)})` : ` (${bytesWords(source.members[0]!.size)})`}`)
      return after(`upload: ${fileCount(staged.files)} dropped on ${selector} at ${pageWhere(s)} and taken by the page — ${names.join(', ')} (whether the site accepted them is the page’s to show)`)
    }
    const covered = await clickGate(s, handle)
    if (covered !== null) return refused(`${selector} took no dropped file, and a click to open its file chooser is refused: ${covered}`)
    let opened: Protocol.Page.FileChooserOpenedEvent | null = null
    let wake = (): void => {}
    const onOpen = (event: Protocol.Page.FileChooserOpenedEvent): void => {
      opened = event
      wake()
    }
    const own = sessionOfFrame(s.page, handle.frame) ?? cdp
    own.on('Page.fileChooserOpened', onOpen)
    await own.send('Page.enable')
    await own.send('Page.setInterceptFileChooserDialog', { enabled: true })
    try {
      const at = await pickTargetPoint(s, handle)
      await humanClickPoint(s, at.x, at.y)
      if (opened === null) {
        await Promise.race([
          new Promise<void>(resolve => {
            wake = resolve
          }),
          bounded(Math.min(deadline, CHOOSER_WAIT_MS)),
        ])
      }
      const chooser = opened as Protocol.Page.FileChooserOpenedEvent | null
      if (chooser === null) {
        return { words: `upload: ${selector} is not a file input, took no dropped file and opened no file chooser when clicked — the click went through and nothing was sent`, outcome: 'failed' }
      }
      if (chooser.backendNodeId === undefined) {
        return { words: `upload: ${selector} asks for a file through the page’s own file picker (showOpenFilePicker), which cannot be filled — nothing sent; a file input or a drop zone takes files`, outcome: 'failed' }
      }
      const node = await own.send('DOM.resolveNode', { backendNodeId: chooser.backendNodeId })
      const objectId = node.object.objectId!
      const call = async <T>(body: string): Promise<T> => (await own.send('Runtime.callFunctionOn', { objectId, functionDeclaration: body, returnByValue: true })).result.value as T
      const cancel = (): Promise<unknown> => call('function () { this.dispatchEvent(new Event("cancel", { bubbles: true })) }').catch(() => undefined)
      const owning = s.page.frames().find(frame => (frame as { _id?: string })._id === chooser.frameId)
      const chooserOrigin = owning === undefined ? null : originOf(owning.url())
      if (judgedOrigin !== null && chooserOrigin !== judgedOrigin) {
        await cancel()
        return refused(`the file chooser that ${selector} opened belongs to a frame of ${chooserOrigin ?? 'another page'}, which this permission check did not judge`)
      }
      const field = await call<{ multiple: boolean; folder: boolean; desc: string }>(
        'function () { return { multiple: this.multiple === true, folder: this.webkitdirectory === true, desc: this.tagName.toLowerCase() + (this.id ? "#" + this.id : "") } }',
      )
      if (folder !== undefined && !field.folder) {
        await cancel()
        return refused(`${folder.given} is a folder and ${field.desc}, which ${selector} opens a chooser for, is not a folder input (webkitdirectory); name its files`)
      }
      if (!field.multiple && resolved.sources.length > 1) {
        await cancel()
        return refused(`${field.desc}, which ${selector} opens a chooser for, takes one ${field.folder ? 'folder' : 'file'} (it has no multiple attribute) and ${resolved.sources.length} were given`)
      }
      await own.send('DOM.setFileInputFiles', { files: staged.paths, backendNodeId: chooser.backendNodeId })
      delivered = true
      let held = await call<HeldFile[]>(HELD_FILES)
      for (const until = Date.now() + Math.min(deadline, 5000); held.length < staged.files && Date.now() < until; held = await call<HeldFile[]>(HELD_FILES)) await bounded(25)
      return after(`upload: ${field.desc} holds ${heldWords(held)}, chosen through the file chooser that ${selector} opened at ${pageWhere(s)} (set on the page; nothing reaches the site until the page sends it)`)
    } finally {
      own.off('Page.fileChooserOpened', onOpen)
      await own.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined)
    }
  } finally {
    if (!delivered) await dropStagedUpload(staged.dir)
  }
}

async function errorPageSettled(s: LiveSession): Promise<void> {
  if (s.navFailure.last === null || isBrowserErrorPage(s.page.url())) return
  await Promise.race([new Promise<void>(wake => s.navWatch.waiters.push(wake)), bounded(1000)])
}

function firstRequestWords(s: LiveSession): string {
  return `tab ${s.tab}: its first request was not armed with the presented browser identity; the page stayed open`
}
async function popupWords(owner: OwnerKey, s: LiveSession, since: number): Promise<string> {
  await popupsSettled(s)
  const fresh = s.popups.count - since
  if (fresh <= 0) return ''
  const notes: string[] = []
  for (const popup of s.popups.log.slice(-fresh)) {
    const kept = popup.tab === null ? null : activeSession(owner, popup.tab)
    if (kept === null) {
      notes.push(
        popup.tab === null
          ? `the page opened a new tab (${popup.url}) that could not be kept; it was closed. op:"open" that URL follows it (a new origin will ask).`
          : `the page opened a new tab (${popup.url}), kept as tab ${popup.tab}, which has closed since`,
      )
      continue
    }
    const origin = originOf(kept.page.url())
    const carried = await inheritEmulation(s.page, kept.page, kept.openedBy?.posted !== true).catch(() => null)
    if (carried !== null) noteEmulatedPage(owner, emulationActive(kept.page) ? kept.page : null, kept.tab)
    notes.push(
      `the page opened a new tab — kept as tab ${kept.tab} at ${pageWhere(kept)}${origin.startsWith('http') && !originApproved(owner, origin) ? ' (its origin is not approved: acts there will ask)' : ''}; pass tab:"${kept.tab}" to use it${
        carried === null ? '' : `; the emulation came with it (${emulationSummary(kept.page) || 'nothing'})${carried.reloaded ? ', and it was reloaded for mobile or touch' : ''}`
      }`,
    )
    if (pageKitOf(kept.page)?.firstRequestUnarmed) notes.push(firstRequestWords(kept))
    for (const line of [...(carried?.failures ?? []), ...(carried?.notes ?? [])]) notes.push(`tab ${kept.tab}: ${line}`)
  }
  return notes.map(n => `\n  note: ${n}`).join('')
}

function actConsequences(s: LiveSession, marks: ActMarks): string {
  const notes: string[] = []
  if (s.downloads.count > marks.downloads && s.downloads.last !== null) {
    notes.push(`the link is ${downloadWords(s.downloads.last)}`)
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
    return `; ${children.length} child frame(s) present (${urls}); set frame to an index from extract or a unique URL substring`
  } catch {
    return ''
  }
}

function checkedTarget(s: LiveSession, surface: Page | Frame): CheckedTarget {
  return { tab: s.tab, page: s.page, frame: surface === s.page ? null : (surface as Frame) }
}

function replacedSinceCheck(op: string, s: LiveSession, bound: CheckedTarget | null, surface: Page | Frame): string | null {
  if (bound === null || bound.tab !== s.tab) return null
  if (bound.page !== s.page) {
    return `${op} refused: tab ${s.tab} holds another page than the one the permission check saw — nothing done; re-issue to act on the page that is there now`
  }
  if (bound.frame !== (surface === s.page ? null : surface)) {
    return `${op} refused: the frame is another one than the permission check saw — nothing done; re-issue to act on the frame that is there now`
  }
  return null
}

async function actOriginGate(owner: OwnerKey, s: LiveSession, input: Input): Promise<string | null> {
  const op = input.op
  const checked = consumeCheckedActOrigin(owner, op)
  const live = (await targetOrigin(s, input.frame))
  const bound = checked?.bound ?? null
  const replaced = replacedSinceCheck(op, s, bound, targetSurface(s, input.frame))
  if (replaced !== null) return replaced
  const judged = checked !== null && (bound === null || bound.tab === s.tab) ? checked.origin : null
  if (judged !== null && judged !== live) {
    return `${op} refused: the page moved from ${judged} to ${live} between the permission check and the act — nothing done; re-issue to ask for the new origin`
  }
  approveWebOrigin(owner, judged ?? live)
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
  return `${selector} lives inside a child frame (${frameUrl}); set frame to its index from extract or a unique URL substring`
}

async function resolveActTarget(
  s: LiveSession,
  selector: string,
  deadline: number,
  signal?: AbortSignal,
  frame?: Input['frame'],
): Promise<ElementHandle<Element>> {
  const surface = targetSurface(s, frame)
  const framed = frame === undefined ? await framedOnly(s, selector) : null
  if (framed !== null) throw new Error(framedTargetWords(selector, framed))
  try {
    return (await surface
      .locator(selector)
      .setTimeout(deadline)
      .setVisibility('visible')
      .waitHandle({ signal })) as ElementHandle<Element>
  } catch (err) {
    if (isDriverTimeout(err)) {
      const attached = await surface.$(selector).catch(() => null)
      const framedLate = attached || frame !== undefined ? null : await framedOnly(s, selector)
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
  frame?: Input['frame'],
): Promise<ElementHandle<Element>> {
  try {
    const handle = await targetSurface(s, frame).waitForSelector(selector, { timeout: deadline, signal })
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
  if (handle.frame.parentFrame() !== null) return base
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
  const disabled = await isDisabledTarget(handle)
  if (disabled) return 'the target is disabled'
  const point = await handle.clickablePoint()
  let current: ElementHandle<Element> | null = handle
  while (current !== null) {
    const frame: Frame = current.frame
    const container: ElementHandle<HTMLIFrameElement> | null = await frame.frameElement()
    const box = container ? await container.boundingBox() : null
    const border = container ? await container.evaluate(el => ({ x: el.clientLeft, y: el.clientTop })) : { x: 0, y: 0 }
    const x = point.x - (box?.x ?? 0) - border.x
    const y = point.y - (box?.y ?? 0) - border.y
    const occluder = await current.evaluate((el, px, py) => {
      let hit = document.elementFromPoint(px, py)
      while (hit?.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(px, py)
        if (!inner || inner === hit) break
        hit = inner
      }
      if (hit && (hit === el || el.contains(hit))) return null
      if (!hit) return 'the viewport edge'
      const id = hit.id ? `#${hit.id}` : ''
      const cls = typeof hit.className === 'string' && hit.className.trim() !== '' ? `.${hit.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')}` : ''
      return `${hit.tagName.toLowerCase()}${id}${cls}`
    }, x, y)
    if (occluder) return `the click point (${Math.round(point.x)}, ${Math.round(point.y)}) is covered by ${occluder}; click the covering element to dismiss it, or scroll the target into view; after reading the overlay, force: true dispatches a DOM click to the target`
    current = container
  }
  return null
}

async function probeEditableTarget(s: LiveSession, requested: ElementHandle<Element> | null, frame?: Input['frame']) {
  return await targetSurface(s, frame).evaluate(el => {
    let active: Element | null = document.activeElement
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
    if (!active || active === document.body) return null
    const a = active as HTMLInputElement
    const tag = a.tagName.toLowerCase()
    const autocomplete = (a.getAttribute('autocomplete') ?? '').toLowerCase()
    const held = document.hasFocus() && (el === null || el === active || el.contains(active) || (el.shadowRoot?.contains(active) ?? false))
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

function sentByEmulation(input: Input): { words: string; headers: boolean; username?: string; secretRef?: string } | null {
  const emulation = input?.emulation as { headers?: unknown; credentials?: unknown } | undefined
  const headers = emulation?.headers !== undefined && emulation.headers !== null
  const credentials = emulation?.credentials !== undefined && emulation.credentials !== null
  if (!headers && !credentials) return null
  const secretRef = credentials ? (emulation!.credentials as { secret?: unknown }).secret : undefined
  const username = credentials ? (emulation!.credentials as { username?: string }).username : undefined
  return {
    words: [headers ? 'extra headers sent on every request, including other origins' : '', credentials ? `basic credentials for ${username}` : ''].filter(Boolean).join(' and '),
    headers,
    username,
    ...(typeof secretRef === 'string' ? { secretRef } : {}),
  }
}

function actDetail(input: Input): string {
  switch (input.op) {
    case 'viewport':
      return ` with ${sentByEmulation(input)?.words ?? 'emulation'}`
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
    case 'upload':
      return ` ${(input.files ?? []).length === 1 ? input.files![0] : fileCount((input.files ?? []).length)} to ${input.selector}`
    default:
      return ''
  }
}

function fileCount(n: number): string {
  return n === 1 ? '1 file' : `${n} files`
}

const checkedUploads = new Map<OwnerKey, { call: string; sources: UploadSource[] }>()

function uploadCall(input: Input): string {
  return JSON.stringify([input.tab ?? MAIN_TAB, input.frame ?? null, input.selector ?? '', input.files ?? []])
}

function takeCheckedUpload(owner: OwnerKey, input: Input): UploadSource[] | null {
  const noted = checkedUploads.get(owner)
  checkedUploads.delete(owner)
  return noted !== undefined && noted.call === uploadCall(input) ? noted.sources : null
}

interface SourceAsk {
  message: string
  decisionReason: PermissionDecisionReason
}

function judgeUploadSources(owner: OwnerKey, input: Input, context: ToolPermissionContext | undefined): { deny: PermissionDecision } | { ask: SourceAsk } | null {
  checkedUploads.delete(owner)
  const rules = context ?? getEmptyToolPermissionContext()
  const given = input.files ?? []
  const shares = given.map(file => checkUncPathPermission(file, rules))
  const refusedShare = shares.find(decision => decision?.behavior === 'deny')
  if (refusedShare) return { deny: refusedShare }
  const asks = shares.flatMap(decision => (decision?.behavior === 'ask' ? [decision] : []))
  const shareAsks = asks.length
  const resolved = resolveUploadSources(given.filter((_, index) => shares[index]?.behavior !== 'ask'))
  if (!('refusal' in resolved)) {
    const judged = resolved.sources.flatMap(source => source.members.map(member => checkReadPermissionForTool({ name: 'Read', getPath: () => member.path }, input, rules)))
    const denied = judged.find(decision => decision.behavior === 'deny')
    if (denied !== undefined) return { deny: denied }
    checkedUploads.set(owner, { call: uploadCall(input), sources: resolved.sources })
    asks.push(...judged.flatMap(decision => (decision.behavior === 'ask' ? [decision] : [])))
  }
  const first = asks[0]
  if (first === undefined) return null
  const message = [...new Set(asks.map(decision => decision.message))].join('\n')
  const reason = first.decisionReason
  return {
    ask: {
      message,
      decisionReason:
        shareAsks > 0 && asks.length > shareAsks && reason?.type === 'safetyCheck'
          ? { ...reason, reason: message }
          : reason !== undefined && (reason.type === 'rule' || reason.type === 'safetyCheck') ? reason : { type: 'safetyCheck', reason: message, operatorOnly: false },
    },
  }
}

export const BrowserTool = buildTool({
  name: 'Browser',
  searchHint: 'drive an isolated web browser; inspect pages and capture screenshots',
  searchKeywords: [
    'playwright', 'puppeteer', 'selenium', 'end-to-end', 'e2e', 'automation', 'test', 'verify',
    'web app', 'frontend UI journey', 'localhost dev server', 'website', 'fill', 'submit', 'form',
    'log in', 'page', 'reproduce', 'UI bug', 'click', 'type', 'scroll', 'wait', 'selector', 'text',
    'navigation', 'extract', 'render', 'accessibility tree', 'DOM', 'console errors', 'screenshot',
    'headless', 'chrome', 'edge', 'chromium', 'provenance', 'status',
    'emulate', 'emulation', 'mobile', 'device', 'iphone', 'android', 'responsive', 'timezone', 'locale',
    'geolocation', 'offline', 'throttle', 'dark mode', 'tab', 'tabs', 'several pages', 'popup', 'new window',
  ],
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
      'emulate a phone or tablet, a timezone, a locale, a slow or offline network',
      'work in several browser tabs side by side',
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
  keepEmptyInputs: ['files'],
  maxResultSizeChars: 20_000,
  async description() {
    return 'Drive a headless Chrome for Testing from the managed cache (or an operator-pinned browser; installed browsers are never driven) with full provenance: navigate, click, type, scroll, wait on events, extract text or the accessibility tree, read the console, screenshot'
  },
  wireDescription() {
    return 'Drive one isolated browser session per agent through the bundled driver. Returns page observations, action results and screenshots. Opening a new origin or first acting on a crossed-to origin asks; reads never ask. Grants belong to this agent and end with its session.'
  },
  async prompt() {
    const cap = browserSessionCap()
    return `## Operations
status reports browser resolution (operator pin, then managed Chrome-for-Testing), versions, session state and open tabs without launching. Installed browsers are not driven.
open launches on first use and navigates (${NAVIGATION_CAP_MS / 1000}s deadline). tab picks the page an op uses: main unless named, a new name opens another, without url a blank one; persist keeps it past the idle lease.
click checks actionability; a tab that an act opens is kept and named in the answer (popup, popup-2).
type focuses a selector target (editable inputs, textarea, contenteditable).
waitFor watches a selector, case-insensitive whitespace-normalized text, or navigation when neither is given (returns immediately if navigation already finished during the prior act).
viewport resizes the surface (initial 1280×800); a plain resize keeps an active device. Its emulation, kept by the page until reset with sizes as given, takes ${EMULATION_FIELD_WORDS}; devices lists the names.
back, reload, scroll, select, press and hover act on history or elements; info reports URL, title, approval state and emulation.
extract returns ${EXTRACT_CAP}-char windows of text or indented role/name/state rows, including iframe content and frame indices/URLs.
console returns a ${CONSOLE_RING_CAP}-entry ring of logs, page/HTTP/request errors, navigation dividers and dialogs (dialogs auto-dismiss; beforeunload auto-accepts).
screenshot saves a PNG artifact and attaches an image when supported.
upload sets files (local paths; an empty list clears) on a file input, a control that opens a file chooser or a drop zone, by selector; each file meets Read's decision, the page its origin's act approval; the answer says what the page holds.
download with url or selector opens or clicks and waits timeoutMs for a file to begin, with downloadId waits for that transfer (call again to go on), alone lists them; a download is saved in the session scratchpad when an act starts it (named in that answer) or it begins later on a tab that was clicked, typed in, selected, pressed or given download (named in the next answer there).
close ends the session, or with tab that tab alone (${BROWSER_PROTOCOL_TIMEOUT_MS / 1000}s protocol deadline; ${BROWSER_CLOSE_BOUND_MS / 1000}s close bound). provision asks before installing Chrome-for-Testing.

## Targeting
Selector actions wait for visibility; scoped extract waits for attachment (reads hidden content). Frame click, scroll and screenshot require selectors; coordinate clicks stay in the main viewport.

## Session lifetime
${cap === null ? '' : `Cap: ${cap} child browsers per session plus a reserved lead slot; `}5 minutes idle closes a browser (active ops do not expire; completion renews the lease; tabs opened with persist stay). The driver needs node >= 22.12.`
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
      (input?.op === 'viewport' && sentByEmulation(input) === null) ||
      input?.op === 'devices' ||
      (input?.op === 'download' && downloadVia(input) === null)
    )
  },
  interruptBehavior() {
    return 'cancel' as const
  },
  async checkPermissions(asked: Input, context: ToolUseContext) {
    const input = downloadAct(asked)
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
    const sent = input.op === 'viewport' ? sentByEmulation(input) : null
    if (!ACT_OPS.has(input.op) && sent === null) return { behavior: 'allow' as const, updatedInput: asked }
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
    const inTab = input.tab === undefined ? '' : ` in tab ${input.tab}`
    const sources = input.op === 'upload' ? judgeUploadSources(owner, input, permissionContext) : null
    if (sources !== null && 'deny' in sources) return sources.deny
    const sourceAsk = sources === null ? null : sources.ask
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
        return { behavior: 'allow' as const, updatedInput: asked }
      }
      return {
        behavior: 'ask' as const,
        message: `Browser open: ${input.url ?? '(no url)'}${inTab} — first visit to ${target} this session (drives a real headless browser)`,
        suggestions: suggestionForExactCommand('Browser', `origin:${target}`),
      }
    }
    const s = activeSession(owner, input.tab ?? MAIN_TAB)
    if (!s || (s.crashed && !CRASH_OPEN_OPS.has(input.op))) return { behavior: 'allow' as const, updatedInput: asked }
    let origin: string
    let bound: CheckedTarget
    try {
      origin = sent === null ? (await targetOrigin(s, input.frame)) : sendOrigin(s)
      bound = checkedTarget(s, sent === null ? targetSurface(s, input.frame) : s.page)
    } catch { return { behavior: 'allow' as const, updatedInput: asked } }
    const ruled = ruleVerdict(`origin:${origin}`)
    if (ruled === 'deny') {
      return {
        behavior: 'deny' as const,
        message: ruleSentence(`Browsing ${origin}`, 'deny', ruleFor(`origin:${origin}`)!),
        decisionReason: { type: 'other' as const, reason: `origin:${origin} carries a deny rule` },
      }
    }
    const secret =
      input.op === 'type' && typeof input.secretRef === 'string'
        ? {
            ref: input.secretRef,
            nonWeb: `secret fills only land on real web origins — the page is ${origin} content`,
            nonWebReason: `secret fill refused on non-web scheme ${origin}`,
            deed: `Filling the secret ${input.secretRef} on ${origin}`,
            ask: `Browser fill secret ${input.secretRef} into ${origin}${inTab} (target ${input.selector ?? ''}) — the value never enters the conversation; approve exactly this secret-origin pairing`,
            reason: `filling registered secret ${input.secretRef} into ${origin} needs the operator's own consent for the pairing`,
          }
        : sent?.secretRef !== undefined
          ? {
              ref: sent.secretRef,
              nonWeb: `credentials answer a real web origin only — the page is ${origin} content`,
              nonWebReason: `credentials refused on non-web scheme ${origin}`,
              deed: `Answering ${origin} with the secret ${sent.secretRef}`,
              ask: `Browser answer basic authentication on ${origin}${inTab} with secret ${sent.secretRef} as ${sent.username}${sent.headers ? '; extra headers sent on every request, including other origins' : ''} — the value never enters the conversation; approve exactly this secret-origin pairing`,
              reason: `answering ${origin} with registered secret ${sent.secretRef} needs the operator's own consent for the pairing`,
            }
          : null
    if (secret !== null) {
      if (!origin.startsWith('http')) {
        return {
          behavior: 'deny' as const,
          message: secret.nonWeb,
          decisionReason: { type: 'other' as const, reason: secret.nonWebReason },
        }
      }
      const pairing = `secret:${secret.ref}@${origin}`
      const pairingRuled = ruleVerdict(pairing)
      if (pairingRuled === 'deny') {
        return {
          behavior: 'deny' as const,
          message: ruleSentence(secret.deed, 'deny', ruleFor(pairing)!),
          decisionReason: { type: 'other' as const, reason: `${pairing} carries a deny rule` },
        }
      }
      noteCheckedActOrigin(owner, input.op, origin, bound)
      if (pairingRuled === 'allow' || secretPairingApproved(owner, secret.ref, origin)) {
        return { behavior: 'allow' as const, updatedInput: asked }
      }
      return {
        behavior: 'ask' as const,
        message: secret.ask,
        decisionReason: {
          type: 'safetyCheck' as const,
          reason: secret.reason,
          operatorOnly: true,
        },
        suggestions: suggestionForExactCommand('Browser', pairing),
      }
    }
    const sourcesAsk = {
      behavior: 'ask' as const,
      message: `Browser ${input.op}${actDetail(input)} on ${origin}${inTab} — ${sourceAsk?.message ?? ''}`,
      decisionReason: sourceAsk?.decisionReason,
      suggestions: [],
    }
    if (ruled === 'allow' || (ruled === null && origin.startsWith('http') && originApproved(owner, origin))) {
      noteCheckedActOrigin(owner, input.op, origin, bound)
      return sourceAsk === null ? { behavior: 'allow' as const, updatedInput: asked } : sourcesAsk
    }
    if (!origin.startsWith('http')) {
      if (origin === 'about:' || origin === 'chrome-error:') {
        noteCheckedActOrigin(owner, input.op, origin, bound)
        return sourceAsk === null ? { behavior: 'allow' as const, updatedInput: asked } : sourcesAsk
      }
      noteCheckedActOrigin(owner, input.op, origin, bound)
      return {
        behavior: 'ask' as const,
        message: `Browser ${input.op}${actDetail(input)} on a NON-WEB page (${origin})${inTab} — page-conjured content, not an approved web origin${sourceAsk === null ? '' : `\n${sourceAsk.message}`}`,
        decisionReason: {
          type: 'safetyCheck' as const,
          reason: `the top frame is ${origin} content the page itself conjured`,
          operatorOnly: true,
        },
        suggestions: sourceAsk === null ? suggestionForExactCommand('Browser', `origin:${origin}`) : [],
      }
    }
    noteCheckedActOrigin(owner, input.op, origin, bound)
    const unloaded = sent !== null && !originOf(s.page.url()).startsWith('http')
    return {
      behavior: 'ask' as const,
      message: `${sent?.headers ? `Browser viewport on ${origin}${inTab} with ${sent.words}` : `Browser ${input.op}${actDetail(input)} on ${origin}${inTab}`} — ${unloaded ? 'its address did not load' : 'reached by navigation'}, not yet approved this session${sourceAsk === null ? '' : `\n${sourceAsk.message}`}`,
      decisionReason: {
        type: 'safetyCheck' as const,
        reason: unloaded ? `${origin} did not load, and no page of it is approved` : `${origin} was reached by navigation, not requested by the operator`,
        operatorOnly: true,
      },
      suggestions: sourceAsk === null ? suggestionForExactCommand('Browser', `origin:${origin}`) : [],
    }
  },
  async validateInput(asked: Input) {
    if (!browserToolEnabled()) {
      return { result: false as const, message: 'the Browser tool is disabled (MERCURY_BROWSER=0)', errorCode: 1 }
    }
    if (asked.op === 'download' && [asked.downloadId, asked.url, asked.selector].filter(given => given !== undefined && given !== '').length > 1) {
      return { result: false as const, message: 'download takes one of downloadId, url or selector', errorCode: 1 }
    }
    const input = downloadAct(asked)
    if (input.tab !== undefined && (input.tab.trim() === '' || input.tab !== input.tab.trim() || /[\r\n]/.test(input.tab))) {
      return { result: false as const, message: 'tab takes a name on one line with no space around it', errorCode: 1 }
    }
    if (input.persist === true && input.op !== 'open') {
      return { result: false as const, message: 'persist requires op open', errorCode: 1 }
    }
    if (asked.downloadId !== undefined && asked.downloadId !== '' && asked.op !== 'download') {
      return { result: false as const, message: 'downloadId requires op download', errorCode: 1 }
    }
    if (asked.files !== undefined && asked.files.length > 0 && asked.op !== 'upload') {
      return { result: false as const, message: 'files requires op upload', errorCode: 1 }
    }
    if (asked.op === 'upload' && (!asked.selector || asked.files === undefined)) {
      return { result: false as const, message: 'upload requires selector and files (an empty list clears a file input)', errorCode: 1 }
    }
    if (input.op === 'open' && !(input.url === undefined && input.tab !== undefined) && (!input.url || !/^https?:\/\//.test(input.url))) {
      return { result: false as const, message: openSchemeRefusal(input.url), errorCode: 1 }
    }
    if (input.frame !== undefined && (!['click', 'type', 'scroll', 'waitFor', 'select', 'hover', 'extract', 'screenshot', 'upload'].includes(input.op) || (['click', 'scroll', 'screenshot'].includes(input.op) && !input.selector) || (input.op === 'waitFor' && !input.selector && input.text === undefined))) {
      return { result: false as const, message: 'frame requires a selector act/read, a type target, or a selector/text wait', errorCode: 1 }
    }
    if (input.force === true && (input.op !== 'click' || !input.selector)) {
      return { result: false as const, message: 'force requires click with a selector', errorCode: 1 }
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
    if (input.emulation !== undefined) {
      if (input.op !== 'viewport') return { result: false as const, message: 'emulation requires op viewport', errorCode: 1 }
      const parsed = parseEmulation(input.emulation)
      if ('refusal' in parsed) return { result: false as const, message: parsed.refusal, errorCode: 1 }
      const ref = parsed.request.credentials?.secret
      if (ref !== undefined && !BROWSER_SECRET_REF_GRAMMAR.test(ref)) {
        return {
          result: false as const,
          message: `emulation.credentials.secret "${ref}" does not match the name grammar (UPPER_SNAKE, letter-led, up to 64 chars)`,
          errorCode: 1,
        }
      }
    }
    if (input.op === 'viewport' && input.emulation === undefined && (typeof input.width !== 'number' || typeof input.height !== 'number')) {
      return { result: false as const, message: 'viewport requires width and height (CSS px)', errorCode: 1 }
    }
    return { result: true as const }
  },
  async call(asked: Input, context: ToolUseContext) {
    const input = downloadAct(asked)
    const startedAt = Date.now()
    const owner = ownerFromToolUseContext((context ?? {}) as { owner?: OwnerKey; agentId?: string })
    const tab = input.tab ?? MAIN_TAB
    const releaseActivity = beginBrowserActivity(owner)
    const sessionAtEntry = activeSession(owner, tab)
    const networkMark = sessionAtEntry?.networkRefusal?.count ?? 0
    const downloadsAtEntry = sessionAtEntry?.downloads.count ?? 0
    let result: string
    let outcome: ToolEffectOutcome = 'no-change'
    let imagePath: string | undefined
    let inlinePath: string | undefined
    let inlineMediaType: string | undefined
    let secretInPlay: { value: string; ref: string } | null = null
    let life = null as OpLife | null
    const signalFor = (s: LiveSession): AbortSignal => (life ??= openOpLife(s, context.abortController?.signal)).signal
    const acted = new Map<LiveSession, number>()
    const acting = (s: LiveSession): void => {
      if (acted.has(s)) return
      acted.set(s, s.popups.count)
      s.acting++
      s.actOp = input.op
      if (TOUCH_OPS.has(input.op)) s.touched = true
    }
    const crashedAtEntry = sessionAtEntry?.crashed === true
    try {
      if (sessionAtEntry !== null && ACT_OPS.has(input.op)) acting(sessionAtEntry)
      if (sessionAtEntry !== null && !crashedAtEntry && FRONT_OPS.has(input.op)) await bringTabToFront(sessionAtEntry)
      switch (crashedAtEntry && !CRASH_OPEN_OPS.has(input.op) ? 'crashed' : input.op) {
        case 'crashed': {
          result = crashedWords(sessionAtEntry!, input.tab !== undefined)
          outcome = 'failed'
          break
        }
        case 'status': {
          result = await statusReport(owner, input)
          break
        }
        case 'open': {
          if (input.url !== undefined) await metadataSafeAddresses(input.url)
          const target = input.url === undefined ? null : originOf(input.url)
          const held = target === null ? sessionAtEntry : null
          const s =
            held ??
            (await ensureBrowserSession(owner, {
              signal: context.abortController?.signal,
              tab,
              births: true,
              downloads: {
                home: join(getScratchpadDir((context as { agentId?: string } | undefined)?.agentId), 'browser-downloads'),
                staging: join(getScratchpadDir((context as { agentId?: string } | undefined)?.agentId), 'browser-uploads'),
                claim: () => {
                  ensureScratchpadDir((context as { agentId?: string } | undefined)?.agentId)
                },
              },
              ...(target === null ? {} : { origin: target }),
            }))
          if ('state' in s) {
            result =
              s.state === 'unavailable'
                ? `browser unavailable: ${s.note}\n  Report this block to the operator or use op:"provision" — do NOT hand-build a browser harness.`
                : `browser session refused: ${s.note}`
            outcome = 'failed'
            break
          }
          if (input.persist !== undefined) s.persist = input.persist
          if (input.url !== undefined) acting(s)
          const lease =
            input.persist === undefined
              ? ''
              : `\n  note: tab ${tab} ${input.persist ? 'is kept past the 5-minute idle lease, until op:"close" or the session ends' : 'closes with the 5-minute idle lease again'}`
          await bringTabToFront(s)
          const earlier = emulatedPageOf(owner, tab)
          let environment = ''
          if (earlier !== null && earlier !== s.page) {
            if (earlier === sessionAtEntry?.page) {
              const carried = await carryEmulation(earlier, s.page)
              if (carried !== null) {
                environment = [
                  `\n  note: this page is in another browser; the emulation came with it before it loaded (${emulationSummary(s.page) || 'nothing'})`,
                  ...carried.failures.map(line => `\n  note: ${line}`),
                ].join('')
              }
            } else {
              environment = `\n  note: ${browserTabs(owner).length > 1 ? `the earlier page of tab ${tab} is gone` : 'the earlier browser is gone'} and its emulation with it (${emulationSummary(earlier)}) — this page starts at the launch baseline`
            }
            noteEmulatedPage(owner, emulationActive(s.page) ? s.page : null, tab)
          }
          if (input.url === undefined) {
            result = `open: tab ${tab} ${held === null ? `is a blank page (${s.resolution.source}: ${s.resolution.label})` : `stays at ${pageWhere(s)} — no url, nothing was loaded`}${environment}${lease}`
            outcome = held === null || input.persist !== undefined ? 'succeeded' : 'no-change'
            break
          }
          s.nav.seen = s.nav.seq
          const ringMark = s.consoleRing.length
          const openMarks = markAct(s)
          let response: Awaited<ReturnType<typeof s.page.goto>>
          try {
            response = await firstNavigation(
              s,
              input.url!,
              () =>
                s.page.goto(input.url!, {
                  waitUntil: input.waitUntil ?? 'load',
                  timeout: Math.min(Math.max(input.timeoutMs ?? 30_000, 1000), NAVIGATION_CAP_MS),
                  signal: signalFor(s),
                }),
              signalFor(s),
            )
          } catch (err) {
            const message = (err as Error).message
            if (!/net::ERR_ABORTED/.test(message)) {
              await errorPageSettled(s)
              throw relayNamedFailure(s, input.url!, err)
            }
            await settleAfterAct(s, 1000, openMarks)
            if (s.downloads.count === openMarks.downloads || s.downloads.last === null) throw err
            const arrived = s.downloads.last.transfer
            if (arrived === null || arrived.state === 'failed') {
              result = `open failed: ${input.url} is ${downloadWords(s.downloads.last)}`
              outcome = 'failed'
              break
            }
            approveWebOrigin(owner, input.url!)
            result = `open: ${input.url} is ${downloadWords(s.downloads.last)}\n  note: the tab stays at ${pageWhere(s)}`
            outcome = 'succeeded'
            break
          }
          s.touched = false
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
          result = `open: ${s.page.url()}${statusBit} — ${await s.page.title()} (${s.resolution.source}: ${s.resolution.label})${environment}${
            landed !== target && landed.startsWith('http')
              ? `\n  note: landed on ${landed} (a redirect crossed origins — acts there will ask)`
              : ''
          }${census}${lease}${crashedAtEntry && s === sessionAtEntry ? RECOVERED_NOTE : ''}`
          if (s === sessionAtEntry) s.crashed = false
          outcome = 'succeeded'
          break
        }
        case 'click': {
          const s = activeSession(owner, tab)
          if (!s) {
            result = noSessionWords(owner, tab)
            outcome = 'failed'
            break
          }
          const originGate = await actOriginGate(owner, s, input)
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
            const handle = await resolveActTarget(s, input.selector, deadline, signalFor(s), input.frame)
            await handle.scrollIntoView()
            await settleBoundingBox(handle, deadline)
            const refusal = await clickGate(s, handle)
            if (refusal !== null && !(input.force === true && refusal.includes('covered by'))) {
              result = `click ${input.selector} refused: ${refusal} — nothing clicked`
              outcome = 'failed'
              break
            }
            if (input.force === true && refusal !== null) await handle.evaluate(el => (el as HTMLElement).click())
            else {
              const pt = await pickTargetPoint(s, handle)
              await humanClickPoint(s, pt.x, pt.y)
            }
            target = `${input.selector}${input.force === true && refusal !== null ? ' (forced DOM click)' : ''}`
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
        case 'upload': {
          const s = activeSession(owner, tab)
          if (!s) {
            result = noSessionWords(owner, tab)
            outcome = 'failed'
            break
          }
          const checked = takeCheckedUpload(owner, input)
          const judgedOrigin = await targetOrigin(s, input.frame).catch(() => null)
          const originGate = await actOriginGate(owner, s, input)
          if (originGate !== null) {
            result = originGate
            outcome = 'failed'
            break
          }
          const agentId = (context as { agentId?: string } | undefined)?.agentId
          const rules = (context as Partial<ToolUseContext> | undefined)?.getAppState?.()?.toolPermissionContext as ToolPermissionContext | undefined
          const sent = await sendUpload(s, input, checked, rules, judgedOrigin, () => join(ensureScratchpadDir(agentId), 'browser-uploads'), signalFor(s))
          result = sent.words
          outcome = sent.outcome
          break
        }
        case 'type': {
          const s = activeSession(owner, tab)
          if (!s) {
            result = noSessionWords(owner, tab)
            outcome = 'failed'
            break
          }
          const originGate = await actOriginGate(owner, s, input)
          if (originGate !== null) {
            result = originGate
            outcome = 'failed'
            break
          }
          s.nav.seen = s.nav.seq
          if (typeof input.secretRef === 'string') {
            const secretOrigin = (await targetOrigin(s, input.frame))
            const requested = await resolveActTarget(s, input.selector!, actDeadline(input), signalFor(s), input.frame)
            if (await isDisabledTarget(requested)) {
              result = `type refused: ${input.selector} is disabled — nothing filled`
              outcome = 'failed'
              break
            }
            await requested.focus()
            const probe = await probeEditableTarget(s, requested, input.frame)
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
              await targetSurface(s, input.frame).evaluate(() => {
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
            const stillHeld = await probeEditableTarget(s, requested, input.frame)
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
            const entered = input.enter === true && (resolved.origin === undefined || (await targetOrigin(s, input.frame)) === resolved.origin)
            if (entered) await s.page.keyboard.press('Enter')
            approveSecretPairing(owner, input.secretRef, resolved.origin ?? (await targetOrigin(s, input.frame)))
            result = `type: filled secret ${input.secretRef} into ${probe.desc}${entered ? ' + Enter' : ''} at ${pageWhere(s)}`
            outcome = 'succeeded'
            break
          }
          const targetName = input.selector ?? '(focused element)'
          let requested: ElementHandle<Element> | null = null
          if (input.selector) {
            requested = await resolveActTarget(s, input.selector, actDeadline(input), signalFor(s), input.frame)
            if (await isDisabledTarget(requested)) {
              result = `type refused: ${input.selector} is disabled — nothing typed`
              outcome = 'failed'
              break
            }
            await requested.focus()
          }
          const probe = await probeEditableTarget(s, requested, input.frame)
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
                ? `type refused: ${probe.desc} is a file input — op:"upload" with files sets it`
                : ['checkbox', 'radio', 'submit', 'button', 'reset', 'image'].includes(probe.type)
                  ? `type refused: ${probe.desc} is type=${probe.type} — use op:"click" to operate it`
                  : `type refused: ${probe.desc} is type=${probe.type}, not a text-bearing input — nothing typed`
            outcome = 'failed'
            break
          }
          if (input.clear === true) {
            await targetSurface(s, input.frame).evaluate(() => {
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
          const credNow = await targetSurface(s, input.frame).evaluate(() => {
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
          if (input.frame !== undefined && !(await probeEditableTarget(s, requested, input.frame))?.held) {
            result = 'type refused mid-act: focus left the target frame; nothing typed'
            outcome = 'failed'
            break
          }
          await humanTypeText(s, input.text!)
          if (input.enter === true) await s.page.keyboard.press('Enter')
          let valueLen: number | null = null
          try {
            valueLen = await targetSurface(s, input.frame).evaluate(() => {
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
          const s = activeSession(owner, tab)
          if (!s) {
            result = noSessionWords(owner, tab)
            outcome = 'failed'
            break
          }
          const originGate = await actOriginGate(owner, s, input)
          if (originGate !== null) {
            result = originGate
            outcome = 'failed'
            break
          }
          s.nav.seen = s.nav.seq
          if (input.selector) {
            const handle = await resolveActTarget(s, input.selector, actDeadline(input), signalFor(s), input.frame)
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
          const s = activeSession(owner, tab)
          if (!s) {
            result = noSessionWords(owner, tab)
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
              await targetSurface(s, input.frame).waitForSelector(input.selector, {
                timeout: deadline,
                signal: signalFor(s),
                ...(state === 'visible' ? { visible: true } : state === 'hidden' ? { hidden: true } : {}),
              })
              const landedState =
                state === 'hidden' ? 'hidden/gone' : state === 'visible' ? 'present and visible' : 'present (attached)'
              result = `waitFor selector ${input.selector}: ${landedState} after ${Date.now() - t0}ms at ${pageWhere(s)}`
            } else if (input.text !== undefined) {
              await targetSurface(s, input.frame).waitForFunction(
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
          const s = activeSession(owner, tab)
          if (!s) {
            result = noSessionWords(owner, tab)
            outcome = 'failed'
            break
          }
          const originGate = await actOriginGate(owner, s, input)
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
          const s = activeSession(owner, tab)
          if (!s) {
            result = noSessionWords(owner, tab)
            outcome = 'failed'
            break
          }
          const originGate = await actOriginGate(owner, s, input)
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
          result = `reload: ${s.page.url()}${reloadStatus} — ${await s.page.title()}${crashedAtEntry ? RECOVERED_NOTE : ''}`
          s.crashed = false
          outcome = 'succeeded'
          break
        }
        case 'select': {
          const s = activeSession(owner, tab)
          if (!s) {
            result = noSessionWords(owner, tab)
            outcome = 'failed'
            break
          }
          const originGate = await actOriginGate(owner, s, input)
          if (originGate !== null) {
            result = originGate
            outcome = 'failed'
            break
          }
          s.nav.seen = s.nav.seq
          const handle = await resolveActTarget(s, input.selector!, actDeadline(input), signalFor(s), input.frame)
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
          const s = activeSession(owner, tab)
          if (!s) {
            result = noSessionWords(owner, tab)
            outcome = 'failed'
            break
          }
          if (!PRESS_KEYS.has(input.key ?? '')) {
            result = `press refused: "${input.key}" is not in the key allowlist [${[...PRESS_KEYS].join(', ')}] — printable characters go through op:"type" (where credential fields refuse)`
            outcome = 'failed'
            break
          }
          const originGate = await actOriginGate(owner, s, input)
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
          const s = activeSession(owner, tab)
          if (!s) {
            result = noSessionWords(owner, tab)
            outcome = 'failed'
            break
          }
          const originGate = await actOriginGate(owner, s, input)
          if (originGate !== null) {
            result = originGate
            outcome = 'failed'
            break
          }
          s.nav.seen = s.nav.seq
          const handle = await resolveActTarget(s, input.selector!, actDeadline(input), signalFor(s), input.frame)
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
          const s = activeSession(owner, tab)
          if (!s) {
            result = noSessionWords(owner, tab)
            outcome = 'failed'
            break
          }
          if (input.emulation !== undefined) signalFor(s).throwIfAborted()
          const held = heldDevice(s.page)
          if (input.emulation === undefined && held === null) {
            const width = Math.min(Math.max(Math.floor(input.width!), 320), 3840)
            const height = Math.min(Math.max(Math.floor(input.height!), 240), 2160)
            const dsf =
              input.deviceScaleFactor !== undefined ? Math.min(Math.max(input.deviceScaleFactor, 1), 3) : undefined
            await s.page.setViewport({ width, height, ...(dsf !== undefined ? { deviceScaleFactor: dsf } : {}) })
            notePlainSize(s.page, width, height, dsf)
            const vp = s.page.viewport()
            result = `viewport: ${vp?.width}x${vp?.height}${vp?.deviceScaleFactor ? ` @${vp.deviceScaleFactor}x` : ''} at ${pageWhere(s)}`
            outcome = 'succeeded'
            break
          }
          let applied: EmulationOutcome
          if (input.emulation === undefined) {
            applied = await applyEmulation(s.page, {}, {
              width: Math.min(Math.max(Math.floor(input.width!), 320), 3840),
              height: Math.min(Math.max(Math.floor(input.height!), 240), 2160),
              ...(input.deviceScaleFactor !== undefined ? { scale: Math.min(Math.max(input.deviceScaleFactor, 1), 3) } : {}),
            })
          } else {
            const parsed = parseEmulation(input.emulation)
            if ('refusal' in parsed) {
              result = `viewport refused: ${parsed.refusal}`
              outcome = 'failed'
              break
            }
            let answers = ''
            if (sentByEmulation(input) !== null) {
              const checked = consumeCheckedActOrigin(owner, input.op)
              const replaced = replacedSinceCheck(input.op, s, checked?.bound ?? null, s.page)
              if (replaced !== null) {
                result = replaced
                outcome = 'failed'
                break
              }
              const judged = checked !== null && (checked.bound === null || checked.bound.tab === s.tab) ? checked.origin : null
              answers = sendOrigin(s)
              if (judged !== null && judged !== answers) {
                result = `viewport refused: the page moved from ${judged} to ${answers} between the permission check and the act — nothing done; re-issue to ask for the new origin`
                outcome = 'failed'
                break
              }
              approveWebOrigin(owner, answers)
              const credentials = parsed.request.credentials
              if (credentials !== undefined && credentials !== null) {
                if (!answers.startsWith('http')) {
                  result = `viewport refused: credentials answer a web origin, and this page is ${answers} content — op:"open" the site first (it fails while the site asks for credentials), set them, then op:"reload"`
                  outcome = 'failed'
                  break
                }
                if (credentials.secret !== undefined) {
                  const resolved = resolveBrowserSecret(credentials.secret, { origin: answers })
                  if (resolved.state !== 'ok') {
                    result = `viewport refused: ${resolved.note}`
                    outcome = 'failed'
                    break
                  }
                  secretInPlay = { value: resolved.value, ref: credentials.secret }
                }
              }
            }
            applied = await applyEmulation(
              s.page,
              parsed.request,
              {
                ...(input.width !== undefined ? { width: input.width } : {}),
                ...(input.height !== undefined ? { height: input.height } : {}),
                ...(input.deviceScaleFactor !== undefined ? { scale: input.deviceScaleFactor } : {}),
              },
              answers,
            )
            const paired = parsed.request.credentials?.secret
            if (paired !== undefined && applied.refusal === undefined && !applied.failures.some(line => line.startsWith('credentials'))) {
              approveSecretPairing(owner, paired, answers)
            }
          }
          if (applied.refusal !== undefined) {
            result = `viewport refused: ${applied.refusal} — nothing changed`
            outcome = 'failed'
            break
          }
          if (applied.reloaded) s.nav.seen = s.nav.seq
          noteEmulatedPage(owner, emulationActive(s.page) ? s.page : null, tab)
          const kept =
            input.emulation === undefined && held !== null
              ? [
                  held.device === null
                    ? 'kept: the emulated mobile, touch and orientation'
                    : `kept: device ${held.device} with its mobile, touch${input.deviceScaleFactor === undefined ? ', scale' : ''} and user agent`,
                ]
              : []
          const state =
            input.emulation?.reset === true && applied.lines.length === 0 && applied.failures.length === 0
              ? ['emulation: none, the launch baseline is restored']
              : []
          const stale = applied.stale ? ['note: this document was fetched before the user agent changed; op:"reload" asks the server again'] : []
          result = [
            `${viewportWords(s)} at ${pageWhere(s)}${applied.reloaded ? ' (the page was reloaded: mobile or touch changed)' : ''}`,
            ...[...kept, ...state, ...(input.emulation === undefined ? [] : applied.lines), ...applied.failures, ...stale, ...applied.notes.map(note => `note: ${note}`)].map(line => `  ${line}`),
          ].join('\n')
          outcome = applied.failures.length > 0 ? 'failed' : 'succeeded'
          break
        }
        case 'devices': {
          const names = await deviceNames()
          result = `devices: ${names.length} profiles in puppeteer-core ${driverVersion()} — pass one as emulation.device with op:"viewport"\n${names.join(', ')}`
          break
        }
        case 'extract': {
          const s = activeSession(owner, tab)
          if (!s) {
            result = noSessionWords(owner, tab)
            outcome = 'failed'
            break
          }
          const scope = input.selector ?? 'body'
          const where = input.frame === undefined ? pageWhere(s) : targetSurface(s, input.frame).url()
          const root = input.selector ? await resolveReadTarget(s, input.selector, actDeadline(input), signalFor(s), input.frame) : null
          if ((input.mode ?? 'text') === 'text') {
            const text = root
              ? await root.evaluate(deepTextOf)
              : await targetSurface(s, input.frame).$eval('body', deepTextOf)
            result = capExtract(`extract text (${scope}) at ${where}`, `${frameListing(s)}\n${text}`, input.offset ?? 0)
          } else {
            const surface = targetSurface(s, input.frame) as Page | (Frame & Pick<Page, 'accessibility'>)
            const snapshot = await surface.accessibility.snapshot({ includeIframes: true, ...(root ? { root } : {}) })
            result = capExtract(`extract tree (${scope}) at ${where}`, `${frameListing(s)}\n${serializeAxTree(snapshot)}`, input.offset ?? 0)
          }
          break
        }
        case 'console': {
          const s = activeSession(owner, tab)
          if (!s) {
            result = noSessionWords(owner, tab)
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
          const s = activeSession(owner, tab)
          if (!s) {
            result = noSessionWords(owner, tab)
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
          const active = emulationLines(s.page)
          result = [
            `url: ${s.page.url()}`,
            `title: ${await s.page.title()}`,
            `origin: ${origin}${approval}`,
            viewportWords(s),
            ...(active.length > 0 ? ['emulation:', ...active.map(line => `  ${line}`)] : []),
            ...(pageKitOf(s.page)?.firstRequestUnarmed ? [`note: ${firstRequestWords(s)}`] : []),
          ].join('\n')
          break
        }
        case 'screenshot': {
          const s = activeSession(owner, tab)
          if (!s) {
            result = noSessionWords(owner, tab)
            outcome = 'failed'
            break
          }
          const file = screenshotPath(input.label ?? new URL(s.page.url()).hostname)
          if (input.selector) {
            const handle = await resolveActTarget(s, input.selector, actDeadline(input), signalFor(s), input.frame)
            await handle.screenshot({ path: file as `${string}.png` })
          } else {
            await s.page.screenshot({ path: file as `${string}.png`, fullPage: input.fullPage === true })
          }
          imagePath = file
          let sizeNote = ''
          const saved = imageDimensionsOfBase64(readFileSync(file).subarray(0, 48).toString('base64'))
          let shown = saved
          if (modelReceivesImageBlocks(getEngineModel())) {
            try {
              const img = await readImageWithTokenBudget(file)
              const inlineBytes = Math.floor((img.file.base64.length * 3) / 4)
              if (img.file.originalSize > inlineBytes * 1.2) {
                inlinePath = `${file}.inline`
                writeFileSync(inlinePath, Buffer.from(img.file.base64, 'base64'))
                inlineMediaType = img.file.type
                sizeNote = ` (inlined copy downscaled to the image budget: ${(img.file.originalSize / 1024).toFixed(0)}KB on disk, ~${(inlineBytes / 1024).toFixed(0)}KB inlined)`
                shown = imageDimensionsOfBase64(img.file.base64) ?? shown
              }
            } catch {
            }
          }
          const vp = s.page.viewport()
          const ratio = vp?.deviceScaleFactor || (
            !input.selector && !input.fullPage && saved !== null && vp?.width
              ? saved.width / vp.width
              : await s.page.evaluate(() => window.devicePixelRatio).catch(() => null)
          )
          let scaleNote = ''
          if (saved !== null && shown !== null && ratio !== null && ratio > 0) {
            const horizontal = Number((saved.width / ratio / shown.width).toPrecision(6))
            const vertical = Number((saved.height / ratio / shown.height).toPrecision(6))
            if (horizontal !== 1 || vertical !== 1) {
              const factor = horizontal === vertical ? `${horizontal} CSS px` : `${horizontal} CSS px horizontally, ${vertical} vertically`
              scaleNote = ` — the image is ${shown.width}x${shown.height} px for ${Math.round(saved.width / ratio)}x${Math.round(saved.height / ratio)} CSS px: 1 image px = ${factor}`
            }
          }
          result = `screenshot: ${file}${input.selector ? ` (element ${input.selector})` : ''} (${pageWhere(s)}, viewport ${vp?.width}x${vp?.height})${sizeNote}${scaleNote}`
          outcome = 'succeeded'
          break
        }
        case 'download': {
          const all = browserTransfers(owner)
          if (input.downloadId !== undefined && input.downloadId !== '') {
            const wanted = all.find(transfer => transfer.id === input.downloadId)
            if (wanted === undefined) {
              result = `no download ${input.downloadId} — op:"download" without downloadId lists the ${all.length} of this session`
              outcome = 'failed'
              break
            }
            if (wanted.state === 'pending') {
              const outer = context.abortController?.signal
              const deadline = Math.min(Math.max(input.timeoutMs ?? WAIT_DEFAULT_MS, 250), WAIT_CAP_MS)
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, deadline)
                const stop = (): void => {
                  clearTimeout(timer)
                  reject(outer?.reason ?? new Error('interrupted'))
                }
                if (outer?.aborted) stop()
                else outer?.addEventListener('abort', stop, { once: true })
                void wanted.done.then(() => {
                  clearTimeout(timer)
                  outer?.removeEventListener('abort', stop)
                  resolve()
                })
              })
            }
            result = `download: ${transferWords(wanted)}`
            outcome = wanted.state === 'failed' ? 'failed' : wanted.state === 'complete' ? 'succeeded' : 'no-change'
            break
          }
          const first = Math.min(Math.max(Math.floor(input.offset ?? 0), 0), all.length)
          const shown = all.slice(first, first + Math.max(Math.floor(input.limit ?? 50), 1))
          const count = (state: Transfer['state']): number => all.filter(transfer => transfer.state === state).length
          result =
            all.length === 0
              ? 'downloads: none — a download that an act starts is saved in the session scratchpad and named in that act’s answer'
              : [
                  `downloads: ${all.length} (${count('complete')} complete, ${count('pending')} arriving, ${count('failed')} failed)${first > 0 ? `, from ${first}` : ''}`,
                  ...shown.map(transfer => `  tab ${transfer.tab}: ${transferWords(transfer)}`),
                  ...(first + shown.length < all.length ? [`  … ${all.length - first - shown.length} more — continue with offset: ${first + shown.length}`] : []),
                ].join('\n')
          break
        }
        case 'close': {
          const closed = await closeBrowserSessionDetailed(owner, input.tab)
          if (closed.open.length > 0) {
            result = closed.closed.length === 0 ? `no tab ${tab} — open: ${closed.open.join(', ')}` : `tab ${tab} closed — open: ${closed.open.join(', ')}`
            outcome = closed.closed.length === 0 ? 'no-change' : 'succeeded'
            break
          }
          const several = closed.closed.length > 1 ? `, ${closed.closed.length} tabs: ${closed.closed.join(', ')}` : ''
          result =
            closed.outcome === 'closed'
              ? `session closed (browser reaped${several}; origin approvals wiped)`
              : closed.outcome === 'killed'
                ? `session closed — the browser did not answer within ${BROWSER_CLOSE_BOUND_MS / 1000}s and its process was ended (origin approvals wiped${several})`
                : closed.outcome === 'unfinished'
                  ? `session closed — the browser did not finish quitting within ${BROWSER_FINISH_BOUND_MS / 1000}s and its process was ended (origin approvals wiped${several})`
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
      const chainText = errorChainText(e)
      const crashedMidOp = sessionAtEntry !== null && !crashedAtEntry && !goneMidOp && (e.name === PAGE_CRASHED_ERROR || sessionAtEntry.crashed)
      const blockedUrl = /net::ERR_BLOCKED_BY_CLIENT at (\S+)/.exec(chainText)?.[1] ?? input.url
      const blocked = blockedUrl === undefined ? undefined : activeSession(owner, tab)?.policyBlocks.get(blockedUrl.split('?')[0]!)
      result =
        interrupted || (e.name === 'AbortError' && !goneMidOp)
          ? `${input.op} interrupted by the operator — the wait was released, nothing further was done`
          : goneMidOp
            ? browserGoneMidOpWords(input.op)
            : crashedMidOp
              ? crashedWords(sessionAtEntry!, input.tab !== undefined, input.op)
              : (driverFailureWords(input.op, chainText, blocked !== undefined && blocked.at >= startedAt ? blocked.reason : undefined) ?? `${input.op} failed: ${e.message}`)
      outcome = 'failed'
    }
    try {
      const sought = input === asked || outcome === 'failed' ? null : activeSession(owner, tab)
      if (sought !== null) {
        result = `${result!}${await downloadSought(sought, sought === sessionAtEntry ? downloadsAtEntry : 0, asked.timeoutMs, context.abortController?.signal)}`
      }
      for (const [s, since] of acted) result = `${result!}${await popupWords(owner, s, since)}`
    } finally {
      for (const s of acted.keys()) s.acting--
      life?.release()
      releaseActivity()
    }
    if (secretInPlay !== null) {
      result = scrubSecretFromText(result!, secretInPlay.value, secretInPlay.ref)
    }
    const sessionAtExit = activeSession(owner, tab)
    if (input.op === 'open' && sessionAtExit !== null && pageKitOf(sessionAtExit.page)?.firstRequestUnarmed) result += `\n  note: ${firstRequestWords(sessionAtExit)}`
    const refusedNetwork = sessionAtExit?.networkRefusal
    const refusalMark = sessionAtExit === sessionAtEntry ? networkMark : 0
    if (refusedNetwork !== undefined && refusedNetwork.count > refusalMark) {
      result = `${input.op} refused: ${refusedNetwork.last}`
      outcome = 'failed'
    }
    if (sessionAtExit !== null && !TABLESS_OPS.has(input.op)) {
      for (const late of sessionAtExit.downloads.late.splice(0)) {
        if (typeof late === 'string') result += `\n  note: ${late}`
        else if (!namedTransfers.has(late)) result += `\n  note: ${late.startedAt >= startedAt ? 'the page started a download' : 'a download began after the last act'} — ${transferWords(late)}`
      }
    }
    if (input.tab !== undefined && !TABLESS_OPS.has(input.op)) {
      if (input.op === 'open' && outcome === 'failed') {
        result += sessionAtExit === null ? `\n  note: tab ${tab} is not open` : `\n  note: tab ${tab} stays open at ${pageWhere(sessionAtExit)}`
      }
      if (!(result!.split('\n')[0] ?? '').includes(`tab ${tab}`)) result = `[${tab}] ${result!}`
    }
    const output: Output = {
      op: asked.op,
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
        operation: `browser.${asked.op}`,
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
