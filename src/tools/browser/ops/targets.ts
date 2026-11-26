import type { ElementHandle, Frame, Page } from 'puppeteer-core'
import { type CheckedTarget, approveWebOrigin, consumeCheckedActOrigin, forgetClicked, originApproved, sessionAttached } from '../../../integrations/browser/browserSession.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { type Input, WAIT_CAP_MS, WAIT_DEFAULT_MS } from './schema.js'
import { isDriverTimeout } from './failures.js'
import { LAYER_ROOT, type LiveSession, MISS_LOOK_MS, actOrigin, bounded, coveringLayerNote, elementName, heldFrameOrigin, targetSurface } from './page.js'
import { passedOver, passedOverAs } from '../../../platform/errors/passedOver.js'
import { withDeadline } from '../../../platform/async/deadline.js'

function framesDiagnosis(s: LiveSession): string {
  try {
    const children = s.page.frames().filter(f => f.parentFrame() !== null)
    if (children.length === 0) return ''
    const urls = children
      .slice(0, 3)
      .map(f => f.url().split('?')[0])
      .join(', ')
    return `; ${children.length} child frame(s) present (${urls}); set frame to an index from extract or a unique URL substring`
  } catch (error) {
    passedOver(error)
    return ''
  }
}

export function checkedTarget(s: LiveSession, surface: Page | Frame): CheckedTarget {
  return { tab: s.tab, page: s.page, frame: surface === s.page ? null : (surface as Frame) }
}

function otherPageWords(op: string, s: LiveSession): string {
  return `${op} refused: tab ${s.tab} holds another page than the one the permission check saw — nothing done; re-issue to act on the page that is there now`
}

function otherFrameWords(op: string): string {
  return `${op} refused: the frame is another one than the permission check saw — nothing done; re-issue to act on the frame that is there now`
}

export function replacedSinceCheck(op: string, s: LiveSession, bound: CheckedTarget | null, surface: Page | Frame): string | null {
  if (bound === null || bound.tab !== s.tab) return null
  if (bound.page !== s.page) return otherPageWords(op, s)
  if (bound.frame !== (surface === s.page ? null : surface)) return otherFrameWords(op)
  return null
}

export async function actOriginGate(owner: OwnerKey, s: LiveSession, input: Input): Promise<string | null> {
  const op = input.op
  const checked = consumeCheckedActOrigin(owner, op)
  const live = await actOrigin(s, input)
  const bound = checked?.bound ?? null
  const replaced = replacedSinceCheck(op, s, bound, targetSurface(s, input.frame))
  if (replaced !== null) return replaced
  const judged = checked !== null && (bound === null || bound.tab === s.tab) ? checked.origin : null
  if (judged !== null && judged !== live) {
    return `${op} refused: the page moved from ${judged} to ${live} between the permission check and the act — nothing done; re-issue to ask for the new origin`
  }
  if (judged === null && sessionAttached(s) && live.startsWith('http') && !originApproved(owner, live)) {
    return input.frame === undefined ? otherPageWords(op, s) : otherFrameWords(op)
  }
  approveWebOrigin(owner, judged ?? live)
  return null
}

export async function heldFrameRefusal(owner: OwnerKey, s: LiveSession, op: string, holder: ElementHandle<Element>): Promise<string | null> {
  if (!sessionAttached(s)) return null
  const origin = await heldFrameOrigin(s, holder)
  return origin === null || !origin.startsWith('http') || originApproved(owner, origin) ? null : otherFrameWords(op)
}

export function actDeadline(input: Input): number {
  return Math.min(Math.max(input.timeoutMs ?? WAIT_DEFAULT_MS, 250), WAIT_CAP_MS)
}

async function framedOnly(s: LiveSession, selector: string): Promise<string | null> {
  try {
    const children = s.page.frames().filter(f => f.parentFrame() !== null)
    if (children.length === 0) return null
    if (await withDeadline(s.page.$(selector).then(found => found !== null), MISS_LOOK_MS, () => true, { unref: true })) return null
    const held = await Promise.all(children.map(frame => withDeadline(frame.$(selector).catch(passedOverAs(null)), MISS_LOOK_MS, () => null, { unref: true })))
    const holder = children[held.findIndex(handle => handle !== null)]
    return holder === undefined ? null : (holder.url().split('?')[0] ?? holder.url())
  } catch (error) {
    passedOver(error)
    return null
  }
}

function framedTargetWords(selector: string, frameUrl: string): string {
  return `${selector} lives inside a child frame (${frameUrl}); set frame to its index from extract or a unique URL substring`
}

function hiddenWords(found: ElementHandle<Element>): Promise<string> {
  return found
    .evaluate(el => {
      const above = (node: Element): Element | null => node.assignedSlot ?? node.parentElement ?? (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null)
      const part = (node: Element): { tag: string; id: string; cls: string } => ({ tag: node.tagName.toLowerCase(), id: node.id, cls: typeof node.className === 'string' ? node.className : '' })
      let hider: Element | null = null
      let how = ''
      for (let cur: Element | null = el; cur !== null && hider === null; cur = above(cur)) {
        if (getComputedStyle(cur).display !== 'none') continue
        hider = cur
        how = cur.hasAttribute('hidden') ? 'the hidden attribute' : 'display:none'
      }
      if (hider === null && getComputedStyle(el).visibility !== 'visible') {
        hider = el
        how = `visibility:${getComputedStyle(el).visibility}`
        for (let cur = above(el); cur !== null && getComputedStyle(cur).visibility !== 'visible'; cur = above(cur)) hider = cur
      }
      if (hider === null) {
        const box = el.getBoundingClientRect()
        if (box.width > 0 && box.height > 0) return null
        hider = el
        how = 'zero-sized'
      }
      let control: Element | null = null
      for (let cur: Element | null = el; cur !== null && control === null; cur = cur === hider ? null : above(cur)) {
        if (cur.id !== '') control = document.querySelector(`[aria-controls~="${CSS.escape(cur.id)}"]`)
      }
      return { hider: part(hider), how, control: control === null ? null : { ...part(control), expanded: control.getAttribute('aria-expanded') } }
    })
    .then(read => {
      if (read === null) return ''
      const opens = read.control === null ? '' : `; ${elementName(read.control)}${read.control.expanded === 'true' || read.control.expanded === 'false' ? ` [aria-expanded="${read.control.expanded}"]` : ''} controls it`
      return `; hidden by ${elementName(read.hider)} (${read.how})${opens}`
    }, passedOverAs(''))
}

export async function selectorMissWords(
  s: LiveSession,
  selector: string,
  deadline: number,
  frame: Input['frame'],
  watched: 'visible' | 'attached',
  absentNote = '',
): Promise<string> {
  const [attached, framed, layer] = await Promise.all([
    watched === 'visible' ? withDeadline(targetSurface(s, frame).$(selector).then<string | false>(found => (found === null ? false : hiddenWords(found))).catch(passedOverAs(false)), MISS_LOOK_MS, () => null, { unref: true }) : false,
    frame === undefined ? framedOnly(s, selector) : null,
    coveringLayerNote(s),
  ])
  if (typeof attached === 'string') return `${selector} is present but never became visible within the ${deadline}ms deadline (hidden or zero-sized — acts need a visible target; waitFor state:"attached" can read its arrival)${attached}${layer}`
  if (framed !== null) return framedTargetWords(selector, framed)
  if (attached === null) return `${selector} did not become visible within the ${deadline}ms deadline, and the page did not answer within ${MISS_LOOK_MS}ms when asked whether it is there (its script may be busy)`
  return `no element for selector ${selector} within the ${deadline}ms deadline${absentNote}${framesDiagnosis(s)}${layer}`
}

export async function resolveActTarget(
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
    if (isDriverTimeout(err)) throw new Error(await selectorMissWords(s, selector, deadline, frame, 'visible', ' (the act auto-waits; the element never appeared)'))
    throw err
  }
}

export async function resolveReadTarget(
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
    if (isDriverTimeout(err)) throw new Error(await selectorMissWords(s, selector, deadline, frame, 'attached'))
    throw err
  }
}

export async function settleBoundingBox(handle: ElementHandle<Element>, deadline: number): Promise<void> {
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

const ENCLOSING_CONTROL =
  'button, a, label, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"]'

export async function isDisabledTarget(handle: ElementHandle<Element>): Promise<boolean> {
  return handle.evaluate(
    el => (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true' || el.closest('fieldset:disabled') !== null,
  )
}

interface Cover {
  hop: ElementHandle<Element>
  x: number
  y: number
  point: { x: number; y: number }
  occluder: string
}

async function coverOf(handle: ElementHandle<Element>): Promise<Cover | null> {
  const point = await handle.clickablePoint()
  let current: ElementHandle<Element> | null = handle
  while (current !== null) {
    const frame: Frame = current.frame
    const container: ElementHandle<HTMLIFrameElement> | null = await frame.frameElement()
    const box = container ? await container.boundingBox() : null
    const border = container ? await container.evaluate(el => ({ x: el.clientLeft, y: el.clientTop })) : { x: 0, y: 0 }
    const x = point.x - (box?.x ?? 0) - border.x
    const y = point.y - (box?.y ?? 0) - border.y
    const occluder = await current.evaluate(
      (el, px, py, allowEnclosing, control) => {
        let hit = document.elementFromPoint(px, py)
        while (hit?.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(px, py)
          if (!inner || inner === hit) break
          hit = inner
        }
        if (hit && (hit === el || el.contains(hit))) return null
        if (hit && allowEnclosing && !el.matches(`${control}, input, select, textarea`) && hit.matches(control) && !hit.matches(':disabled, [aria-disabled="true"]')) {
          let cur: Element | null = el.assignedSlot ?? el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null)
          while (cur !== null) {
            if (cur === hit) return null
            if (cur.matches(`${control}, input, select, textarea`)) break
            cur = cur.assignedSlot ?? cur.parentElement ?? (cur.getRootNode() instanceof ShadowRoot ? (cur.getRootNode() as ShadowRoot).host : null)
          }
        }
        if (!hit) return 'the viewport edge'
        return { tag: hit.tagName.toLowerCase(), id: hit.id, cls: typeof hit.className === 'string' ? hit.className : '' }
      },
      x,
      y,
      current === handle,
      ENCLOSING_CONTROL,
    )
    if (occluder) return { hop: current, x, y, point, occluder: typeof occluder === 'string' ? occluder : elementName(occluder) }
    current = container
  }
  return null
}

function coveredWords(cover: Cover): string {
  return `the click point (${Math.round(cover.point.x)}, ${Math.round(cover.point.y)}) is covered by ${cover.occluder}; click the covering element to dismiss it, or scroll the target into view; after reading the overlay, force: true dispatches a DOM click to the target`
}

export async function clickGate(handle: ElementHandle<Element>): Promise<string | null> {
  if (await isDisabledTarget(handle)) return 'the target is disabled'
  const cover = await coverOf(handle)
  return cover === null ? null : coveredWords(cover)
}

const COVER_CLICKED_MS = 5000
const COVER_SETTLE_MS = 2000
const COVER_DRIFT_MS = 1000
const COVER_STEP_MS = 50

async function coverMotion(cover: Cover): Promise<{ settlesIn: number | null; drifts: boolean }> {
  return cover.hop.evaluate(
    async (_el, px, py, soon) => {
      const above = (el: Element): Element | null => el.assignedSlot ?? el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null)
      const at = (): Element | null => {
        let hit = document.elementFromPoint(px, py)
        while (hit?.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(px, py)
          if (!inner || inner === hit) break
          hit = inner
        }
        return hit
      }
      const reading = (el: Element): string => {
        const box = el.getBoundingClientRect()
        let opacity = 1
        for (let cur: Element | null = el; cur !== null; cur = above(cur)) opacity *= Number(getComputedStyle(cur).opacity)
        return [box.x, box.y, box.width, box.height, opacity].join(' ')
      }
      const first = at()
      if (first === null) return { settlesIn: null, drifts: false }
      let settlesIn: number | null = null
      let steady = false
      for (let cur: Element | null = first; cur !== null; cur = above(cur)) {
        for (const run of cur.getAnimations()) {
          if (run.playState !== 'running') continue
          const played = Number(run.currentTime ?? 0)
          const left = run.playbackRate > 0 ? (Number(run.effect?.getComputedTiming().endTime ?? 0) - played) / run.playbackRate : run.playbackRate < 0 ? played / -run.playbackRate : Infinity
          if (left > soon) steady = true
          else settlesIn = Math.max(settlesIn ?? 0, left)
        }
      }
      const before = reading(first)
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
      return { settlesIn, drifts: at() !== first || (!steady && settlesIn === null && reading(first) !== before) }
    },
    cover.x,
    cover.y,
    COVER_SETTLE_MS,
  )
}

async function coverHoldsClick(s: LiveSession, cover: Cover): Promise<boolean> {
  const clicked = s.clicked
  if (clicked === null || clicked.target.frame !== cover.hop.frame || Date.now() >= clicked.at + COVER_CLICKED_MS) return false
  return clicked.target
    .evaluate(
      (last, target, px, py, roots) => {
        const above = (el: Element): Element | null => el.assignedSlot ?? el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null)
        const line = (el: Element): Element[] => {
          const up: Element[] = []
          for (let cur: Element | null = el; cur !== null; cur = above(cur)) up.push(cur)
          return up
        }
        const layer = (up: Element[]): Element | undefined =>
          up.findLast(el => el !== document.body && el !== document.documentElement && (getComputedStyle(el).position === 'fixed' || el.matches(roots)))
        let hit = document.elementFromPoint(px, py)
        while (hit?.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(px, py)
          if (!inner || inner === hit) break
          hit = inner
        }
        if (hit === null) return false
        const mine = line(last)
        const its = line(hit)
        const shared = layer(mine)
        const tie = mine.includes(hit) ? hit : its.includes(last) ? last : shared !== undefined && shared === layer(its) ? shared : null
        return tie !== null && !line(target).includes(tie)
      },
      cover.hop,
      cover.x,
      cover.y,
      LAYER_ROOT,
    )
    .catch(passedOverAs(false))
}

export function rememberClick(s: LiveSession, target: ElementHandle<Element>): void {
  forgetClicked(s)
  const mine = { target, at: Date.now() }
  s.clicked = mine
  void bounded(COVER_CLICKED_MS).then(() => {
    if (s.clicked === mine) forgetClicked(s)
  })
}

type ClickGate = { clear: true; waited: string } | { clear: false; refusal: string; stood: string }

export async function clickGateWhenClear(s: LiveSession, handle: ElementHandle<Element>, until: number): Promise<ClickGate> {
  const began = Date.now()
  const page = s.nav.seq
  let first: string | null = null
  let watchBy = 0
  let because: string | null = null
  for (;;) {
    try {
      if (await isDisabledTarget(handle)) return { clear: false, refusal: 'the target is disabled', stood: '' }
      const cover = await coverOf(handle)
      if (cover === null) return { clear: true, waited: first === null ? '' : `\n  note: the click waited ${Date.now() - began}ms for ${first}, which covered the target, to leave` }
      if (first === null) {
        first = cover.occluder
        const motion = await coverMotion(cover)
        if (motion.settlesIn !== null) {
          watchBy = Date.now() + motion.settlesIn + 2 * COVER_STEP_MS
          because = 'the cover was animating'
        } else if (motion.drifts) {
          watchBy = Date.now() + COVER_DRIFT_MS
          because = 'the cover was changing'
        }
      }
      const held = await coverHoldsClick(s, cover)
      if (held) because = 'the last click landed in the cover'
      const now = Date.now()
      if (now >= until || !(held || now < watchBy)) {
        return { clear: false, refusal: coveredWords(cover), stood: because === null ? ` (watched ${now - began}ms: the cover did not move)` : ` (watched ${now - began}ms because ${because}: the target stayed covered)` }
      }
      await bounded(COVER_STEP_MS)
    } catch (err) {
      if (first !== null && (s.nav.seq !== page || s.navWatch.pendingUrl !== null)) return { clear: false, refusal: `the page navigated away while the click waited for ${first} to leave`, stood: '' }
      throw err
    }
  }
}

export async function probeEditableTarget(s: LiveSession, requested: ElementHandle<Element> | null, frame?: Input['frame']) {
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
