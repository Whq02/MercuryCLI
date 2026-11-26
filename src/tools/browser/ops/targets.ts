import type { ElementHandle, Frame, Page } from 'puppeteer-core'
import { type CheckedTarget, approveWebOrigin, consumeCheckedActOrigin, originApproved, sessionAttached } from '../../../integrations/browser/browserSession.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { type Input, WAIT_CAP_MS, WAIT_DEFAULT_MS } from './schema.js'
import { isDriverTimeout } from './failures.js'
import { type LiveSession, actOrigin, heldFrameOrigin, targetSurface } from './page.js'
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
    if ((await s.page.$(selector)) !== null) return null
    const held = await Promise.all(children.map(frame => withDeadline(frame.$(selector).catch(passedOverAs(null)), 1000, () => null, { unref: true })))
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

export async function selectorMissWords(
  s: LiveSession,
  selector: string,
  deadline: number,
  frame: Input['frame'],
  watched: 'visible' | 'attached',
  absentNote = '',
): Promise<string> {
  const attached = watched === 'visible' ? await targetSurface(s, frame).$(selector).catch(passedOverAs(null)) : null
  if (attached) return `${selector} is present but never became visible within the ${deadline}ms deadline (hidden or zero-sized — acts need a visible target; waitFor state:"attached" can read its arrival)`
  const framed = frame === undefined ? await framedOnly(s, selector) : null
  return framed !== null ? framedTargetWords(selector, framed) : `no element for selector ${selector} within the ${deadline}ms deadline${absentNote}${framesDiagnosis(s)}`
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
    if (isDriverTimeout(err)) {
      throw new Error(`no element for selector ${selector} within the ${deadline}ms deadline${framesDiagnosis(s)}`)
    }
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

export async function clickGate(handle: ElementHandle<Element>): Promise<string | null> {
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
        const id = hit.id ? `#${hit.id}` : ''
        const cls = typeof hit.className === 'string' && hit.className.trim() !== '' ? `.${hit.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')}` : ''
        return `${hit.tagName.toLowerCase()}${id}${cls}`
      },
      x,
      y,
      current === handle,
      ENCLOSING_CONTROL,
    )
    if (occluder) return `the click point (${Math.round(point.x)}, ${Math.round(point.y)}) is covered by ${occluder}; click the covering element to dismiss it, or scroll the target into view; after reading the overlay, force: true dispatches a DOM click to the target`
    current = container
  }
  return null
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
