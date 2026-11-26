import { metadataSafeAddresses } from '../../web-fetch/privateHost.js'
import { join } from 'node:path'
import type { ToolEffectOutcome } from '../../kit/tool.js'
import {
  NAVIGATION_CAP_MS,
  approveWebOrigin,
  bringTabToFront,
  browserTabs,
  emulatedPageOf,
  ensureBrowserSession,
  firstNavigation,
  isBrowserErrorPage,
  noteEmulatedPage,
  originApproved,
  originOf,
  sessionAttached,
} from '../../../integrations/browser/browserSession.js'
import { carryEmulation, emulationActive, emulationSummary } from '../../../integrations/browser/browserEmulation.js'
import { ensureScratchpadDir } from '../../../platform/files/scratchpad.js'
import { getScratchpadDir } from '../../../permissions/rules/filesystem.js'
import { RECOVERED_NOTE, isDriverTimeout, relayNamedFailure } from './failures.js'
import { type LiveSession, MISS_LOOK_MS, coveringLayerNote, deepTextOf, failedNavigationWords, pageWhere, preview, targetSurface } from './page.js'
import { downloadWords } from './downloads.js'
import { errorPageSettled, markAct, settleAfterAct } from './settle.js'
import { actOriginGate, selectorMissWords } from './targets.js'
import type { OpDone, OpRun } from './ops.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import type { Input } from './schema.js'
import { withDeadline } from '../../../platform/async/deadline.js'
import { passedOver, passedOverAs } from '../../../platform/errors/passedOver.js'
import { sleep } from '../../../platform/async/sleep.js'

export async function openOp({ input, owner, tab, context, sessionAtEntry, crashedAtEntry, signalFor, acting }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
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
    return { result, outcome }
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
    return { result, outcome }
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
      return { result, outcome }
    }
    approveWebOrigin(owner, input.url!)
    result = `open: ${input.url} is ${downloadWords(s.downloads.last)}\n  note: the tab stays at ${pageWhere(s)}`
    outcome = 'succeeded'
    return { result, outcome }
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
    .catch(passedOverAs(null))
  const errs = s.consoleRing.slice(ringMark).filter(e => e.kind === 'pageerror').length
  const census =
    textLen === null
      ? ''
      : `\n  page: ${textLen} chars of body text${errs > 0 ? `, ${errs} page error(s) — op:"console" reads them` : ''}${
          textLen === 0 ? ' (the app may still be rendering — waitFor a selector or text)' : ''
        }`
  result = `open: ${s.page.url()}${statusBit} — ${await s.page.title()} (${s.resolution.source}: ${s.resolution.label})${environment}${
    landed !== target && landed.startsWith('http')
      ? `\n  note: landed on ${landed} (a redirect crossed origins${originApproved(owner, landed) ? '' : ' — acts there will ask'})`
      : ''
  }${census}${await coveringLayerNote(s)}${lease}${crashedAtEntry && s === sessionAtEntry ? RECOVERED_NOTE : ''}`
  if (s === sessionAtEntry) s.crashed = false
  outcome = 'succeeded'
  return { result, outcome }
}

const TEXT_STEP_MS = 100

function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function rendersText(surface: ReturnType<typeof targetSurface>, needle: string): Promise<boolean> {
  return surface.$eval('body', deepTextOf).then(text => flat(text).includes(flat(needle)), passedOverAs(false))
}

async function textArrives(surface: ReturnType<typeof targetSurface>, needle: string, deadline: number, signal: AbortSignal): Promise<boolean> {
  const until = Date.now() + deadline
  for (;;) {
    signal.throwIfAborted()
    const asked = Date.now()
    if (await withDeadline(rendersText(surface, needle), Math.max(0, until - asked), () => false, { unref: true })) return true
    const now = Date.now()
    if (now >= until) return false
    await sleep(Math.min(until - now, Math.max(TEXT_STEP_MS, 4 * (now - asked))), signal, { unref: true })
  }
}

function pageKeepsText(needle: string): boolean {
  const norm = (x: string): string => x.replace(/\s+/g, ' ').trim().toLowerCase()
  return norm(document.body?.textContent ?? '').includes(norm(needle))
}

async function textElsewhere(owner: OwnerKey, s: LiveSession, needle: string, frame: Input['frame']): Promise<string> {
  const children = frame === undefined ? s.page.frames().filter(f => f.parentFrame() !== null) : []
  const [held, unrendered] = await Promise.all([
    Promise.all(
      children.map(child =>
        sessionAttached(s) && !originApproved(owner, originOf(child.url()))
          ? false
          : withDeadline(rendersText(child, needle), MISS_LOOK_MS, () => false, { unref: true }),
      ),
    ),
    withDeadline(targetSurface(s, frame).evaluate(pageKeepsText, needle).catch(passedOverAs(false)), MISS_LOOK_MS, () => false, { unref: true }),
  ])
  const at = held.indexOf(true)
  if (at !== -1) return `; child frame ${at + 1} (${children[at]!.url().split('?')[0]}) holds it (set frame to wait there)`
  return unrendered ? '; the page holds it in content that is not rendered (extract with a selector reads hidden content)' : ''
}

async function waitMissWords(owner: OwnerKey, s: LiveSession, input: Input, deadline: number): Promise<string> {
  const where = pageWhere(s)
  if (input.selector) {
    const state = input.state ?? 'visible'
    const stood =
      state === 'hidden'
        ? `${input.selector} is still present and visible after the ${deadline}ms deadline`
        : await selectorMissWords(s, input.selector, deadline, input.frame, state)
    return ` (${state}) failed at ${where}: ${stood}`
  }
  if (input.text !== undefined) return ` failed at ${where}: not in the page's rendered text within the ${deadline}ms deadline${await textElsewhere(owner, s, input.text, input.frame)}`
  return ` failed: no navigation within the ${deadline}ms deadline; the tab stayed at ${where}`
}

export async function waitForOp(s: LiveSession, { input, owner, signalFor }: OpRun, deadline: number, t0: number, waited: string): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
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
      if (!(await textArrives(targetSurface(s, input.frame), input.text, deadline, signalFor(s)))) {
        result = `waitFor ${waited}${await waitMissWords(owner, s, input, deadline)}`
        outcome = 'failed'
        return { result, outcome }
      }
      result = `waitFor text "${preview(input.text)}": present after ${Date.now() - t0}ms at ${pageWhere(s)}`
    } else if (s.nav.seq > s.nav.seen) {
      await s.page
        .waitForFunction(() => document.readyState !== 'loading', {
          timeout: deadline,
          polling: 'raf',
          signal: signalFor(s),
        })
        .catch(passedOver)
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
      result = `waitFor ${waited}${await waitMissWords(owner, s, input, deadline)}`
      outcome = 'failed'
      return { result, outcome }
    }
    throw err
  }
  outcome = 'succeeded'
  return { result, outcome }
}

export async function backOp(s: LiveSession, { input, owner, signalFor }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const originGate = await actOriginGate(owner, s, input)
  if (originGate !== null) {
    result = originGate
    outcome = 'failed'
    return { result, outcome }
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
    return { result, outcome }
  }
  if (isBrowserErrorPage(after)) {
    result = failedNavigationWords('back', s, 'the earlier page')
    outcome = 'failed'
    return { result, outcome }
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
  return { result, outcome }
}

export async function reloadOp(s: LiveSession, { input, owner, crashedAtEntry, signalFor }: OpRun): Promise<OpDone> {
  let result: string
  let outcome: ToolEffectOutcome = 'no-change'
  const originGate = await actOriginGate(owner, s, input)
  if (originGate !== null) {
    result = originGate
    outcome = 'failed'
    return { result, outcome }
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
    return { result, outcome }
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
  return { result, outcome }
}
