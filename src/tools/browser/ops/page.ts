import type { ElementHandle, Frame, Page, SerializedAXNode } from 'puppeteer-core'
import {
  browserVersionOf,
  detectInstalledBrowsers,
  driverNodeGate,
  listManagedBrowsers,
  resolveBrowser,
} from '../../../integrations/browser/browserResolver.js'
import {
  MAIN_TAB,
  activeSession,
  approvedOriginList,
  attachedBrowser,
  browserSessionCap,
  browserTabs,
  driverVersion,
  isBrowserErrorPage,
  liveBrowserSessionCensus,
  originApproved,
  originOf,
  refreshAttachedTabs,
  sessionAttached,
} from '../../../integrations/browser/browserSession.js'
import { heldDevice } from '../../../integrations/browser/browserEmulation.js'
import { APPROVAL_RULE_LINE, ATTACHED_RULE_LINE, INSTALLED_NOT_DRIVEN } from '../../../integrations/browser/browserWords.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { withDeadline } from '../../../platform/async/deadline.js'
import { sleep } from '../../../platform/async/sleep.js'
import { EXTRACT_CAP, type Input } from './schema.js'
import { passedOverAs } from '../../../platform/errors/passedOver.js'

export function localClock(at: number): string {
  const d = new Date(at)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

export function preview(text: string, cap = 40): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text
}

export const MISS_LOOK_MS = 1000
export const LAYER_ROOT = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]'
const PAGE_WORDS_CAP = 80

function pageWords(text: string): string {
  return preview(text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' '), PAGE_WORDS_CAP)
}

export function elementName(el: { tag: string; id: string; cls: string }): string {
  const cls = el.cls.split(/\s+/).filter(Boolean).slice(0, 2).join('.')
  return pageWords(`${el.tag}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}`)
}

export async function tabLine(live: LiveSession): Promise<string> {
  const title = live.crashed ? '' : await withDeadline(live.page.title().catch(passedOverAs('')), 1000, () => '', { unref: true })
  const vp = live.page.viewport()
  const device = heldDevice(live.page)?.device
  const facts = [`page ${live.serial}`, vp === null && sessionAttached(live) ? '' : `viewport ${vp?.width}x${vp?.height}`, device ? `device ${device}` : '', live.persist ? 'persist' : 'idle lease', live.crashed ? 'crashed' : ''].filter(Boolean)
  return `${live.tab}: ${pageWhere(live)}${title ? ` — ${title}` : ''} (${facts.join('; ')})`
}

export async function statusReport(owner: OwnerKey, input: Input): Promise<string> {
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
  await refreshAttachedTabs(owner)
  const attached = attachedBrowser(owner)
  if (attached !== null) lines.push(`attached: ${attached.endpoint}${attached.product ? ` (${attached.product})` : ''} — the user's own browser; op:"close" detaches and leaves it open`)
  const tabs = browserTabs(owner)
  const live = attached === null && tabs.length === 1 && tabs[0]!.tab === MAIN_TAB ? tabs[0]! : null
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
  lines.push(attached === null ? APPROVAL_RULE_LINE : ATTACHED_RULE_LINE)
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

export function serializeAxTree(node: SerializedAXNode | null): string {
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

export function deepTextOf(root: Element): string {
  const own = (root as HTMLElement).innerText ?? ''
  const parts: string[] = []
  const seen = new Set<ShadowRoot>()
  const rendered = (node: Node, ownerEl: Element): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? '').trim() === '' || getComputedStyle(ownerEl).visibility !== 'visible') return false
      const range = document.createRange()
      range.selectNodeContents(node)
      return range.getClientRects().length > 0
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false
    const el = node as Element
    if (el.getClientRects().length > 0) return true
    return getComputedStyle(el).display === 'contents' && Array.from(el.childNodes).some(child => rendered(child, el))
  }
  const visitHost = (el: Element, scopeRange: Range): void => {
    const shadow = el.shadowRoot
    if (!(shadow instanceof ShadowRoot) || seen.has(shadow)) return
    const nodes = Array.from(shadow.childNodes).filter(n => n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE)
    if (nodes.length === 0 || nodes.some(n => scopeRange.isPointInRange(n, 0))) return
    seen.add(shadow)
    const text = nodes
      .map(n =>
        !rendered(n, el)
          ? ''
          : n.nodeType === Node.TEXT_NODE
            ? (n.textContent ?? '').trim()
            : ((n as HTMLElement).innerText ?? ''),
      )
      .filter(chunk => chunk.trim() !== '')
      .join('\n')
      .trim()
    const tag = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`
    if (text !== '') parts.push(`[shadow root of ${tag}]\n${text}`)
    walk(shadow)
  }
  const walk = (scope: Element | ShadowRoot): void => {
    const scopeRange = document.createRange()
    scopeRange.selectNodeContents(scope)
    if (scope instanceof Element) visitHost(scope, scopeRange)
    for (const el of Array.from(scope.querySelectorAll('*'))) visitHost(el, scopeRange)
  }
  walk(root)
  if (parts.length === 0) return own
  const head = own.trim()
  return head === '' ? parts.join('\n') : `${head}\n${parts.join('\n')}`
}

export function capExtract(header: string, body: string, offset = 0): string {
  const clean = body.trim()
  const start = Math.min(Math.max(Math.floor(offset), 0), clean.length)
  if (start === 0 && clean.length <= EXTRACT_CAP) return `${header} — ${clean.length} chars\n${clean}`
  const window = clean.slice(start, start + EXTRACT_CAP)
  const end = start + window.length
  return `${header} — chars ${start}-${end} of ${clean.length}${
    end < clean.length ? `, TRUNCATED to ${EXTRACT_CAP} (continue with offset: ${end}, or narrow with selector)` : ''
  }\n${window}`
}

export type LiveSession = NonNullable<ReturnType<typeof activeSession>>

export function targetSurface(s: LiveSession, frame: Input['frame']): Page | Frame {
  if (frame === undefined || frame === 0) return s.page
  const children = s.page.frames().filter(f => f.parentFrame() !== null)
  const matches = typeof frame === 'number' ? children.filter((_, i) => i + 1 === frame) : children.filter(f => f.url().includes(frame))
  if (matches.length !== 1) throw new Error(`frame ${JSON.stringify(frame)} matched ${matches.length} child frames; extract lists their indices and URLs`)
  return matches[0]!
}

async function surfaceOrigin(s: LiveSession, surface: Page | Frame): Promise<string> {
  if (surface === s.page) return originOf(surface.url())
  const realm = (surface as Frame & { isolatedRealm(): Pick<Frame, 'evaluate'> }).isolatedRealm()
  const origin = await realm.evaluate(() => window.origin)
  return origin === 'null' ? 'opaque:' : originOf(origin)
}

export async function targetOrigin(s: LiveSession, frame: Input['frame']): Promise<string> {
  return surfaceOrigin(s, targetSurface(s, frame))
}

type FramePoint = { x: number; y: number }

async function innerFrameAt(frame: Frame, point: FramePoint | null): Promise<{ frame: Frame; point: FramePoint | null } | null> {
  for (const child of frame.childFrames()) {
    const holder = await child.frameElement()
    if (holder === null) continue
    const inside = await holder.evaluate((el, at) => {
      if (at === null) {
        let active: Element | null = document.activeElement
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
        return active === el ? { x: 0, y: 0 } : null
      }
      let hit = document.elementFromPoint(at.x, at.y)
      while (hit?.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(at.x, at.y)
        if (!inner || inner === hit) break
        hit = inner
      }
      if (hit !== el) return null
      const box = el.getBoundingClientRect()
      return { x: at.x - box.x - el.clientLeft, y: at.y - box.y - el.clientTop }
    }, point)
    if (inside !== null) return { frame: child, point: point === null ? null : inside }
  }
  return null
}

async function landingOrigin(s: LiveSession, from: { frame: Frame; point: FramePoint | null }): Promise<string> {
  let landing = from
  for (;;) {
    const inner = await innerFrameAt(landing.frame, landing.point)
    if (inner === null) break
    landing = inner
  }
  return surfaceOrigin(s, landing.frame === s.page.mainFrame() ? s.page : landing.frame)
}

export async function heldFrameOrigin(s: LiveSession, holder: ElementHandle<Element>): Promise<string | null> {
  const held = await holder.contentFrame()
  if (held === null) return null
  return landingOrigin(s, { frame: held, point: await holder.evaluate(el => ({ x: el.clientWidth / 2, y: el.clientHeight / 2 })) })
}

export async function actOrigin(s: LiveSession, input: Input): Promise<string> {
  if (!sessionAttached(s)) return targetOrigin(s, input.frame)
  if (input.op === 'click' && input.selector) {
    const selector = input.selector
    const looked = (async () => {
      const holder = await targetSurface(s, input.frame).$(selector)
      return holder === null ? null : heldFrameOrigin(s, holder)
    })().catch(passedOverAs(null))
    return (await withDeadline(looked, 1000, () => null, { unref: true })) ?? targetOrigin(s, input.frame)
  }
  const pointed = input.op === 'click'
  if (input.frame !== undefined || !(pointed || input.op === 'press')) return targetOrigin(s, input.frame)
  return landingOrigin(s, { frame: s.page.mainFrame(), point: pointed ? { x: input.x ?? 0, y: input.y ?? 0 } : null })
}

export function sendOrigin(s: LiveSession): string {
  const here = originOf(s.page.url())
  return here.startsWith('http') || s.navFailure.last === null ? here : originOf(s.navFailure.last.url)
}

export function frameListing(owner: OwnerKey, s: LiveSession): string {
  const frames = s.page.frames().filter(f => f.parentFrame() !== null)
  const address = (url: string): string => (sessionAttached(s) && !originApproved(owner, originOf(url)) ? (url.split(/[?#]/)[0] ?? url) : url)
  return frames.length ? `\nFrames: ${frames.map((f, i) => `${i + 1} = ${address(f.url())}`).join('; ')}` : ''
}

export async function coveringLayerNote(s: LiveSession): Promise<string> {
  const layer = await withDeadline(
    s.page
      .evaluate(roots => {
        const above = (el: Element): Element | null => el.assignedSlot ?? el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null)
        const held = new Map<Element, { points: number; overPage: boolean }>()
        for (let i = 1; i <= 5; i++) {
          for (let j = 1; j <= 5; j++) {
            const stack = document.elementsFromPoint((innerWidth * i) / 6, (innerHeight * j) / 6)
            let root: Element | null = null
            for (let cur: Element | null = stack[0] ?? null; cur !== null && cur !== document.body && cur !== document.documentElement; cur = above(cur)) {
              if (getComputedStyle(cur).position === 'fixed' || cur.matches(roots)) root = cur
            }
            const over = root
            if (over === null) continue
            const seen = held.get(over) ?? { points: 0, overPage: false }
            held.set(over, { points: seen.points + 1, overPage: seen.overPage || stack.some(el => el !== document.body && el !== document.documentElement && !over.contains(el)) })
          }
        }
        const most = [...held].sort((a, b) => b[1].points - a[1].points)[0]
        if (most === undefined || most[1].points <= 12 || !most[1].overPage) return null
        const el = most[0]
        return { tag: el.tagName.toLowerCase(), id: el.id, cls: typeof el.className === 'string' ? el.className : '', words: ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 400) }
      }, LAYER_ROOT)
      .catch(passedOverAs(null)),
    MISS_LOOK_MS,
    () => null,
    { unref: true },
  )
  return layer === null ? '' : `\n  note: a layer covers most of the viewport: ${elementName(layer)}${layer.words === '' ? '' : ` ${JSON.stringify(pageWords(layer.words))}`}`
}

export function errorPageWords(s: LiveSession): string {
  const failed = s.navFailure.last
  return failed
    ? `the browser's own error page — ${failed.errorText} at ${failed.url}; the site did not load`
    : "the browser's own error page — the site did not load"
}

export function pageWhere(s: LiveSession): string {
  const url = s.page.url()
  return isBrowserErrorPage(url) ? `${url} (${errorPageWords(s)})` : url
}

export function failedNavigationWords(op: string, s: LiveSession, wanted: string): string {
  const failed = s.navFailure.last
  return `${op} failed: ${failed ? `${failed.errorText} at ${failed.url}` : `${wanted} did not load`} — the browser shows its own error page (${s.page.url()}), not the site; ${
    failed?.errorText === 'net::ERR_INVALID_AUTH_CREDENTIALS'
      ? 'the site asks for basic credentials (op:"viewport" with emulation.credentials sets them)'
      : 'the server is down or refusing connections'
  }`
}

export function viewportWords(s: LiveSession): string {
  const vp = s.page.viewport()
  if (vp === null && sessionAttached(s)) return 'viewport: the browser window\'s own size'
  return `viewport: ${vp?.width}x${vp?.height}${vp?.deviceScaleFactor ? ` @${vp.deviceScaleFactor}x` : ''}${vp?.isMobile ? ' mobile' : ''}${vp?.hasTouch ? ' touch' : ''}${vp?.isLandscape ? ' landscape' : ''}`
}

export function bytesWords(n: number): string {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export function bounded(ms: number): Promise<void> {
  return sleep(ms, undefined, { unref: true })
}
