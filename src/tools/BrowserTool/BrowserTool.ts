
import { readFileSync, writeFileSync } from 'node:fs'
import type { ElementHandle, SerializedAXNode } from 'puppeteer-core'
import { z } from 'zod/v4'
import { buildTool, type ToolEffectOutcome, type ToolUseContext } from '../../Tool.js'
import { canAnswerAsks, getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { readImageWithTokenBudget } from '../FileReadTool/FileReadTool.js'
import { modelReceivesImageBlocks } from '../../utils/model/capabilities.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import {
  browserVersionOf,
  detectInstalledBrowsers,
  driverNodeGate,
  listManagedBrowsers,
  resolveBrowser,
} from '../../services/browser/browserResolver.js'
import {
  CONSOLE_RING_CAP,
  activeSession,
  approveWebOrigin,
  approvedOriginList,
  browserSessionCap,
  closeBrowserSession,
  consumeCheckedActOrigin,
  driverVersion,
  ensureBrowserSession,
  liveBrowserSessionCensus,
  noteCheckedActOrigin,
  originApproved,
  originOf,
  approveSecretPairing,
  screenshotPath,
  secretPairingApproved,
} from '../../services/browser/browserSession.js'
import {
  BROWSER_SECRET_REF_GRAMMAR,
  resolveBrowserSecret,
  scrubSecretFromText,
} from '../../services/browser/browserSecrets.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { getRuleByContentsForToolName } from '../../utils/permissions/permissions.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import type { ToolPermissionContext } from '../../types/permissions.js'
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
        'click/type/scroll/waitFor/extract: the element target — CSS, or aria/<name>[role="<role>"] (role + EXACT full accessible name; extract mode:"tree" prints these), text/<substring> (rendered-text substring), xpath/<expr>, or `host >>> inner` piercing shadow roots (type: the focused element when omitted; extract: whole page when omitted)',
      ),
    x: z.number().optional().describe('click: viewport x for a point click (with y; selector wins when both given)'),
    y: z.number().optional().describe('click: viewport y for a point click (with x)'),
    text: z.string().optional().describe('type: the characters to type · waitFor: the page text to await'),
    secretRef: z
      .string()
      .optional()
      .describe(
        'type: fill an operator-registered named secret INSTEAD of text (UPPER_SNAKE name; requires selector; only credential-shaped targets accept it) — the value never enters the conversation; the ask names the secret + origin pairing',
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
      .describe('extract: start the text window at this char — the header names chars A-B of N; page a long extract'),
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

const NO_SESSION = 'no open session — use op:"open" first'

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
      ? `installed: ${installed.map(b => `${b.label} (${b.executablePath})`).join(' · ')}`
      : 'installed: none found at the standard locations',
  )
  const managed = listManagedBrowsers()
  lines.push(
    managed.length
      ? `managed cache: ${managed
          .map(m => `Chrome for Testing ${m.buildId} (${(m.sizeBytes / 1024 / 1024).toFixed(0)} MB)`)
          .join(' · ')} — remove with /browser remove <buildId>`
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
  const walk = (n: SerializedAXNode, depth: number): void => {
    const head = [n.role, n.name ? JSON.stringify(n.name) : ''].filter(Boolean).join(' ')
    const state: string[] = []
    if (n.value !== undefined && n.value !== '') state.push(`value=${JSON.stringify(String(n.value))}`)
    if (n.checked !== undefined) state.push(`checked=${String(n.checked)}`)
    if (n.disabled === true) state.push('disabled')
    if (n.focused === true) state.push('focused')
    const token =
      n.name && ACTIONABLE_ROLES.has(n.role) && /^[^"[\]]+$/.test(n.name)
        ? `  → aria/${n.name}[role="${n.role}"]`
        : ''
    lines.push(`${'  '.repeat(depth)}${head}${state.length > 0 ? ` [${state.join(' ')}]` : ''}${token}`)
    for (const child of n.children ?? []) walk(child, depth + 1)
  }
  walk(node, 0)
  return lines.join('\n')
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

async function resolveActTarget(
  s: LiveSession,
  selector: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<ElementHandle<Element>> {
  try {
    return (await s.page
      .locator(selector)
      .setTimeout(deadline)
      .setVisibility('visible')
      .waitHandle({ signal })) as ElementHandle<Element>
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') {
      const attached = await s.page.$(selector).catch(() => null)
      throw new Error(
        attached
          ? `${selector} is present but never became visible within the ${deadline}ms deadline (hidden or zero-sized — acts need a visible target; waitFor state:"attached" can read its arrival)`
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
    if ((err as Error).name === 'TimeoutError') {
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
    return 'Drive a real Chromium-family browser (installed or managed-cache) with full provenance: navigate, click, type, scroll, wait on events, extract text or the accessibility tree, read the console, screenshot'
  },
  async prompt() {
    return `Drive a REAL browser through the bundled puppeteer-core driver: one owned headless session PER AGENT (launched on first open, reaped on close/exit — concurrent agents each drive their own, they never share a page), full provenance on every act.

op:"status" — the resolution verdict (operator pin > installed browser > managed Chrome-for-Testing cache > precise unavailable) with driver/browser versions, the managed-cache inventory, the live-session state and the session's approved origins. Never launches a browser SESSION (the version line runs the resolved binary with --version, briefly).
op:"open" (url, waitUntil?, timeoutMs?) — navigate to an http(s) URL (settles on load by default — networkidle2 for busy SPAs, domcontentloaded for speed; timeoutMs reaches 90s for a cold dev-server compile). The result names the HTTP status and a one-line page census (body-text length, page errors since the navigation) — 0 chars means the app is still rendering: waitFor a selector or text before extract/screenshot.
op:"click" (selector, or x+y) — click an element or a viewport point. Selector clicks AUTO-WAIT (present AND visible, bounded by timeoutMs) and gate on actionability: a disabled target or one covered by another element refuses BY NAME (naming the occluder) instead of reporting a click that landed nowhere. A click that starts a navigation reports both URLs; follow with op:"waitFor" (navigation) to let it settle.
op:"type" (text, selector?, clear?, enter?) — type into the selector-named element (auto-waited, focused first — the tool verifies focus actually LANDED there, shadow roots resolved) or the currently focused element. Only TEXT-BEARING targets accept text (text/search/url/tel/email/number/date-family inputs, textarea, contenteditable); checkboxes/radios/buttons refuse naming op:"click", file inputs refuse naming the uploads deferral, readOnly refuses by name. Credential-shaped fields ALWAYS refuse plain text naming the matched shape (password inputs, one-time-code/cc-* autocomplete, password/otp/secret/api-key-shaped names) — text characters never land in a credential field, and the probe re-runs immediately before the keystrokes so a focus trap cannot reroute them. The ONE road into a credential field is secretRef: the operator registers a named secret out-of-band (a MERCURY_BROWSER_SECRET_<NAME> env var, or the browser-secrets file in the config home, owner-only mode) and op:"type" with secretRef:"NAME" + selector fills it — the value NEVER enters this conversation (no echo, no length readback, errors scrubbed), the fill lands ONLY on credential-shaped targets (the exact complement of the text law), and the ask names the secret + origin pairing for the operator to approve (an approved origin alone never covers a secret fill). Use it to drive a login journey on a TEST account. clear selects the WHOLE value and deletes it first (selector targets only); enter presses Enter after.
op:"scroll" (selector, or dy) — scroll an element into view, or by dy pixels (positive = down).
op:"waitFor" (selector | text | neither = navigation; state?, timeoutMs?) — EVENT-driven waiting, never a clock spin, bounded by a deadline (default ${WAIT_DEFAULT_MS}ms, cap ${WAIT_CAP_MS}ms); a miss fails naming the deadline. Selector waits default to VISIBLE (a pre-rendered hidden modal is not "present"); state:"attached" waits for DOM presence only, state:"hidden" waits for the element to be hidden or gone (the spinner-vanished wait). Text waits match case-insensitively with whitespace normalized. A navigation wait whose navigation already landed during the previous act (a synchronous link or form submit) returns immediately naming the landed URL — no lost-navigation race. Prefer this over any fixed pause.
op:"back" / op:"reload" — history navigation / reload the current page.
op:"select" (selector, values) — choose <select> options by value, falling back to visible label; the result names what is selected NOW. A native dropdown cannot be driven by click — always use select.
op:"press" (key, modifiers?) — press a NAVIGATION/EDIT key (Enter, Escape, Tab, arrows, Backspace, Delete, Home/End, PageUp/PageDown; Shift/Control/Alt/Meta as modifiers). Printable characters are deliberately not pressable — type owns them, and refuses credential fields.
op:"hover" (selector) — hover an element (menus and controls that render on hover).
op:"viewport" (width, height, deviceScaleFactor?) — resize the render surface (session default 1280x800 desktop; deviceScaleFactor 2 = retina screenshots). A read — no origin ask; info and status report the active viewport.
op:"extract" (mode: "text"|"tree", selector?, offset?) — the page as readable text (innerText) or as an accessibility-tree projection (indented role "name" [state] lines; the tree INCLUDES iframe content — selectors do not reach into frames, a named deferral the miss diagnosis spells out). Output beyond ${EXTRACT_CAP} chars truncates HONESTLY naming chars A-B of N — offset pages the window (the tail is always reachable), selector narrows the scope.
op:"console" (limit?) — the page's bounded truth ring (last ${CONSOLE_RING_CAP} entries, newest last): console logs (object arguments resolve to JSON with source location), page errors WITH their stack head, NETWORK failures and 4xx/5xx responses as kind "net" (method + path + status — query strings, headers and bodies are never recorded), navigation dividers, and dialogs. "why is this page broken" reads from here. JS dialogs (alert/confirm/prompt) are auto-DISMISSED and beforeunload auto-accepted — a dialog can never wedge the session — and each lands in the ring as kind "dialog" with its text; choosing a dialog's answer is a named deferral.
op:"info" — current URL, title and the origin's approval state; cheap facts, no side effects.
op:"screenshot" (fullPage?, selector?, label?) — capture the page, the full scroll height, or ONE element (selector) to a PNG artifact; the path is printed for the operator. The image itself is attached to the result only when your engine takes image input; on a text-only engine the result says the image was NOT sent and names the file (never a silent drop).
op:"close" — end the session (the browser child is reaped; origin approvals die with the session).

SELECTORS: every selector door takes CSS by default, PLUS four forms the bundled driver resolves everywhere: aria/<name>[role="<role>"] (role + accessible name — the exact two fields extract mode:"tree" prints, so a tree line \`button "Save"\` is addressable as aria/Save[role="button"]; interactive tree rows print that token ready to copy; the name match is the EXACT full accessible name), text/<substring> (substring of rendered text), xpath/<expr>, and the >>> deep combinator that pierces shadow roots (my-widget >>> input). Read with extract mode:"tree", then act with the selector the tree handed you — never guess a CSS class on an app you have not read.

AUTO-WAIT: selector acts (click/type/scroll) resolve with a bounded present-AND-VISIBLE wait (default ${WAIT_DEFAULT_MS}ms, cap ${WAIT_CAP_MS}ms, timeoutMs overrides) — a late-rendered element needs no waitFor first, and a miss refuses naming the deadline and whether the element was absent or merely hidden. Scoped reads (extract selector) wait for ATTACHED only — hidden content is readable, not actable.

A click that opens a NEW TAB is named in the result and the ring; the tab is closed unadopted (one owned page) — op:"open" its URL follows it under the normal origin ask.

PERMISSIONS: the FIRST visit to an origin asks ${getIsNonInteractiveSession() && !canAnswerAsks() ? 'for approval by URL — in this headless session no one can answer, so an unapproved origin is refused unless the tool was pre-approved at launch with --allowed-tools Browser or the run started in a permission mode that does not stop here' : 'the operator by URL'}; once approved, opening and acting anywhere on that origin rides the grant for the rest of the session. A navigation that CROSSES to an unapproved origin (a link click, a redirect) re-asks before the next act there. Reads (status/waitFor/extract/console/info/screenshot) never ask. Sessions and origin approvals are PER AGENT: an approval granted in one agent's session never authorizes another agent, and concurrent browser children are capped — a launch past the cap refuses naming the live count (finish or close another session, or the operator raises MERCURY_BROWSER_MAX_SESSIONS). A secret fill (type + secretRef) is its OWN consent class: the ask names the exact secret + origin pairing, an approved origin never covers it, and the approval rides per pairing for the session.

Downloads are NEVER implicit: the driven session DENIES page-initiated downloads at the protocol level (fetch a file with WebFetch or Bash instead), and the one consented download road is provisioning the engine itself — op:"provision" (buildId?) plans a Chrome-for-Testing install and ASKS the operator with the exact build, measured disk cost and cache path before any bytes move (/browser install is the same road by hand). When nothing resolves, provision instead of dead-ending — never hand-roll a headless-Chrome harness. File uploads stay OUT of scope (a named deferral). The driver needs node >= 22.12; on an older runtime drive ops refuse by name while status stays live.`
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
    if (input.op === 'provision') {
      try {
        const { planBrowserInstall } = await import('../../services/browser/browserInstall.js')
        const plan = await planBrowserInstall(input.buildId)
        return {
          behavior: 'ask' as const,
          message: `Browser provision: download ${plan.consentLine}`,
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
    const ruleVerdict = (content: string): 'deny' | 'ask' | 'allow' | null => {
      if (!permissionContext) return null
      for (const behavior of ['deny', 'ask', 'allow'] as const) {
        if (getRuleByContentsForToolName(permissionContext, 'Browser', behavior).has(content)) return behavior
      }
      return null
    }
    if (input.op === 'open') {
      const target = originOf(input.url ?? '')
      const ruled = ruleVerdict(`origin:${target}`)
      if (ruled === 'deny') {
        return {
          behavior: 'deny' as const,
          message: `Browser is denied for origin:${target} by a permission rule`,
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
        message: `Browser is denied for origin:${origin} by a permission rule`,
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
          message: `Browser is denied for ${pairing} by a permission rule`,
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
          classifierApprovable: false,
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
          classifierApprovable: false,
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
        classifierApprovable: false,
      },
      suggestions: suggestionForExactCommand('Browser', `origin:${origin}`),
    }
  },
  toAutoClassifierInput(input: Input) {
    const bits = [
      input.op,
      input.url,
      input.selector,
      typeof input.x === 'number' && typeof input.y === 'number' ? `(${input.x}, ${input.y})` : undefined,
      input.text !== undefined ? `${input.text.length} chars` : undefined,
      input.secretRef !== undefined ? `secret:${input.secretRef}` : undefined,
    ].filter(Boolean)
    return `browser ${bits.join(' ')}`
  },
  async validateInput(input: Input) {
    if (!browserToolEnabled()) {
      return { result: false as const, message: 'the Browser tool is disabled (MERCURY_BROWSER=0)', errorCode: 1 }
    }
    if (input.op === 'open' && (!input.url || !/^https?:\/\//.test(input.url))) {
      return { result: false as const, message: 'open requires an http(s) url', errorCode: 1 }
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
    let result: string
    let outcome: ToolEffectOutcome = 'no-change'
    let imagePath: string | undefined
    let inlinePath: string | undefined
    let inlineMediaType: string | undefined
    let secretInPlay: { value: string; ref: string } | null = null
    try {
      switch (input.op) {
        case 'status': {
          result = statusReport(owner)
          break
        }
        case 'open': {
          const s = await ensureBrowserSession(owner, { signal: context.abortController?.signal })
          if ('state' in s) {
            result =
              s.state === 'unavailable'
                ? `browser unavailable: ${s.note}\n  Report this block to the operator or use op:"provision" — do NOT hand-build a browser harness.`
                : `browser session refused: ${s.note}`
            outcome = 'failed'
            break
          }
          s.nav.seen = s.nav.seq
          const target = originOf(input.url!)
          const ringMark = s.consoleRing.length
          const response = await s.page.goto(input.url!, {
            waitUntil: input.waitUntil ?? 'load',
            timeout: Math.min(Math.max(input.timeoutMs ?? 30_000, 1000), 90_000),
            signal: context.abortController?.signal,
          })
          approveWebOrigin(owner, input.url!)
          const landed = originOf(s.page.url())
          const status = response === null ? null : response.status()
          const statusBit =
            status === null ? '' : status >= 400 ? ` — HTTP ${status} ${response!.statusText()}` : ` [${status}]`
          const textLen = await s.page
            .evaluate(() => (document.body?.innerText ?? '').trim().length)
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
            result = NO_SESSION
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
          const popupsBefore = s.popups.count
          let target: string
          if (input.selector) {
            const deadline = actDeadline(input)
            const handle = await resolveActTarget(s, input.selector, deadline, context.abortController?.signal)
            await handle.scrollIntoView()
            await settleBoundingBox(handle, deadline)
            const refusal = await clickGate(s, handle)
            if (refusal !== null) {
              result = `click ${input.selector} refused: ${refusal} — nothing clicked`
              outcome = 'failed'
              break
            }
            await handle.click()
            target = input.selector
          } else {
            await s.page.mouse.click(input.x!, input.y!)
            target = `(${input.x}, ${input.y})`
          }
          const after = s.page.url()
          const popupsAfter = s.popups.count
          result =
            after === before
              ? `click ${target} at ${after}`
              : `click ${target} — navigated to ${after} (from ${before}; waitFor settles late loads)`
          if (popupsAfter > popupsBefore) {
            result += `\n  note: the click opened a new tab (${s.popups.last}) — this session drives ONE page; the tab was closed unadopted. op:"open" that URL follows it (a new origin will ask).`
          }
          outcome = 'succeeded'
          break
        }
        case 'type': {
          const s = activeSession(owner)
          if (!s) {
            result = NO_SESSION
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
            const resolved = resolveBrowserSecret(input.secretRef)
            if (resolved.state !== 'ok') {
              result = `type refused: ${resolved.note}`
              outcome = 'failed'
              break
            }
            secretInPlay = { value: resolved.value, ref: input.secretRef }
            const requested = await resolveActTarget(
              s,
              input.selector!,
              actDeadline(input),
              context.abortController?.signal,
            )
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
            await s.page.keyboard.type(resolved.value)
            if (input.enter === true) await s.page.keyboard.press('Enter')
            approveSecretPairing(owner, input.secretRef, originOf(s.page.url()))
            result = `type: filled secret ${input.secretRef} into ${probe.desc}${input.enter === true ? ' + Enter' : ''} at ${s.page.url()}`
            outcome = 'succeeded'
            break
          }
          const targetName = input.selector ?? '(focused element)'
          let requested: ElementHandle<Element> | null = null
          if (input.selector) {
            requested = await resolveActTarget(s, input.selector, actDeadline(input), context.abortController?.signal)
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
          await s.page.keyboard.type(input.text!)
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
          } at ${s.page.url()}`
          outcome = 'succeeded'
          break
        }
        case 'scroll': {
          const s = activeSession(owner)
          if (!s) {
            result = NO_SESSION
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
            const handle = await resolveActTarget(s, input.selector, actDeadline(input), context.abortController?.signal)
            await handle.evaluate(el => (el as HTMLElement).scrollIntoView({ block: 'center' }))
            const yNow = await s.page.evaluate(() => window.scrollY)
            result = `scroll: ${input.selector} into view (scrollY ${Math.round(yNow)}) at ${s.page.url()}`
          } else {
            const yNow = await s.page.evaluate(delta => {
              window.scrollBy(0, delta)
              return window.scrollY
            }, input.dy!)
            result = `scroll: by ${input.dy} (scrollY now ${Math.round(yNow)}) at ${s.page.url()}`
          }
          outcome = 'succeeded'
          break
        }
        case 'waitFor': {
          const s = activeSession(owner)
          if (!s) {
            result = NO_SESSION
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
                signal: context.abortController?.signal,
                ...(state === 'visible' ? { visible: true } : state === 'hidden' ? { hidden: true } : {}),
              })
              const landedState =
                state === 'hidden' ? 'hidden/gone' : state === 'visible' ? 'present and visible' : 'present (attached)'
              result = `waitFor selector ${input.selector}: ${landedState} after ${Date.now() - t0}ms at ${s.page.url()}`
            } else if (input.text !== undefined) {
              await s.page.waitForFunction(
                (needle: string) => {
                  const norm = (x: string): string => x.replace(/\s+/g, ' ').trim().toLowerCase()
                  return norm(document.body?.innerText ?? '').includes(norm(needle))
                },
                { timeout: deadline, polling: 'raf', signal: context.abortController?.signal },
                input.text,
              )
              result = `waitFor text "${preview(input.text)}": present after ${Date.now() - t0}ms at ${s.page.url()}`
            } else if (s.nav.seq > s.nav.seen) {
              await s.page
                .waitForFunction(() => document.readyState !== 'loading', {
                  timeout: deadline,
                  polling: 'raf',
                  signal: context.abortController?.signal,
                })
                .catch(() => {})
              result = `waitFor navigation: already landed at ${s.page.url()} (${Date.now() - t0}ms — the navigation completed during the previous act)`
            } else {
              await s.page.waitForNavigation({
                waitUntil: 'domcontentloaded',
                timeout: deadline,
                signal: context.abortController?.signal,
              })
              result = `waitFor navigation: landed ${s.page.url()} after ${Date.now() - t0}ms`
            }
          } catch (err) {
            if ((err as Error).name === 'TimeoutError') {
              result = `waitFor ${waited}: deadline ${deadline}ms exceeded (the event never arrived) at ${s.page.url()}`
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
            result = NO_SESSION
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
              signal: context.abortController?.signal,
            })
          } catch (err) {
            if (!(err as Error).message.includes('History entry to navigate to not found')) throw err
          }
          const after = s.page.url()
          if (response === null && after === before) {
            result = 'back: no earlier history entry'
            break
          }
          const backStatus = response === null ? '' : ` [${response.status()}]`
          result = `back: ${after}${backStatus} — ${await s.page.title()}`
          outcome = 'succeeded'
          break
        }
        case 'reload': {
          const s = activeSession(owner)
          if (!s) {
            result = NO_SESSION
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
          const reloadResponse = await s.page.reload({
            waitUntil: input.waitUntil ?? 'load',
            timeout: Math.min(Math.max(input.timeoutMs ?? 30_000, 1000), 90_000),
            signal: context.abortController?.signal,
          })
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
            result = NO_SESSION
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
          const handle = await resolveActTarget(s, input.selector!, actDeadline(input), context.abortController?.signal)
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
          result = `select ${input.selector} (by ${via}): now ${chosen} at ${s.page.url()}`
          outcome = 'succeeded'
          break
        }
        case 'press': {
          const s = activeSession(owner)
          if (!s) {
            result = NO_SESSION
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
          for (const m of mods) await s.page.keyboard.down(m)
          try {
            await s.page.keyboard.press(input.key! as Parameters<typeof s.page.keyboard.press>[0])
          } finally {
            for (const m of [...mods].reverse()) await s.page.keyboard.up(m)
          }
          result = `press ${[...mods, input.key].join('+')} at ${s.page.url()}`
          outcome = 'succeeded'
          break
        }
        case 'hover': {
          const s = activeSession(owner)
          if (!s) {
            result = NO_SESSION
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
          const handle = await resolveActTarget(s, input.selector!, actDeadline(input), context.abortController?.signal)
          await handle.hover()
          result = `hover ${input.selector} at ${s.page.url()}`
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
            result = NO_SESSION
            outcome = 'failed'
            break
          }
          const width = Math.min(Math.max(Math.floor(input.width!), 320), 3840)
          const height = Math.min(Math.max(Math.floor(input.height!), 240), 2160)
          const dsf =
            input.deviceScaleFactor !== undefined ? Math.min(Math.max(input.deviceScaleFactor, 1), 3) : undefined
          await s.page.setViewport({ width, height, ...(dsf !== undefined ? { deviceScaleFactor: dsf } : {}) })
          const vp = s.page.viewport()
          result = `viewport: ${vp?.width}x${vp?.height}${vp?.deviceScaleFactor ? ` @${vp.deviceScaleFactor}x` : ''} at ${s.page.url()}`
          outcome = 'succeeded'
          break
        }
        case 'extract': {
          const s = activeSession(owner)
          if (!s) {
            result = NO_SESSION
            outcome = 'failed'
            break
          }
          const scope = input.selector ?? 'body'
          const root = input.selector ? await resolveReadTarget(s, input.selector, actDeadline(input)) : null
          if ((input.mode ?? 'text') === 'text') {
            const text = root
              ? await root.evaluate(el => (el as HTMLElement).innerText)
              : await s.page.$eval('body', el => (el as HTMLElement).innerText)
            result = capExtract(`extract text (${scope}) at ${s.page.url()}`, text, input.offset ?? 0)
          } else {
            const snapshot = await s.page.accessibility.snapshot({ includeIframes: true, ...(root ? { root } : {}) })
            result = capExtract(`extract tree (${scope}) at ${s.page.url()}`, serializeAxTree(snapshot), input.offset ?? 0)
          }
          break
        }
        case 'console': {
          const s = activeSession(owner)
          if (!s) {
            result = NO_SESSION
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
                  ...slice.map(e => `${new Date(e.at).toISOString().slice(11, 23)} ${e.kind}: ${e.text}`),
                ].join('\n')
          break
        }
        case 'info': {
          const s = activeSession(owner)
          if (!s) {
            result = NO_SESSION
            outcome = 'failed'
            break
          }
          const origin = originOf(s.page.url())
          const approval = origin.startsWith('http')
            ? originApproved(owner, origin)
              ? ' (approved this session)'
              : ' (NOT approved — acts will ask)'
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
            result = NO_SESSION
            outcome = 'failed'
            break
          }
          const file = screenshotPath(input.label ?? new URL(s.page.url()).hostname)
          if (input.selector) {
            const handle = await resolveActTarget(s, input.selector, actDeadline(input), context.abortController?.signal)
            await handle.screenshot({ path: file as `${string}.png` })
          } else {
            await s.page.screenshot({ path: file as `${string}.png`, fullPage: input.fullPage === true })
          }
          imagePath = file
          let sizeNote = ''
          if (modelReceivesImageBlocks(getMainLoopModel())) {
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
          result = `screenshot: ${file}${input.selector ? ` (element ${input.selector})` : ''} (${s.page.url()}, viewport ${vp?.width}x${vp?.height})${sizeNote}`
          outcome = 'succeeded'
          break
        }
        case 'close': {
          const closed = await closeBrowserSession(owner)
          result = closed ? 'session closed (browser reaped; origin approvals wiped)' : 'no open session'
          outcome = closed ? 'succeeded' : 'no-change'
          break
        }
      }
    } catch (err) {
      const e = err as Error
      result =
        e.name === 'AbortError' || context.abortController?.signal.aborted === true
          ? `${input.op} interrupted by the operator — the wait was released, nothing further was done`
          : `${input.op} failed: ${e.message}`
      outcome = 'failed'
    }
    if (secretInPlay !== null) {
      result = scrubSecretFromText(result!, secretInPlay.value, secretInPlay.ref)
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
