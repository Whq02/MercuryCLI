
import { readFileSync, writeFileSync } from 'node:fs'
import { metadataSafeAddresses } from '../WebFetchTool/privateHost.js'
import { join } from 'node:path'
import type { ElementHandle, Frame, Page } from 'puppeteer-core'
import { type ToolEffectOutcome, type ToolUseContext, buildTool } from '../../Tool.js'
import { readImageWithTokenBudget } from '../FileReadTool/FileReadTool.js'
import { imageDimensionsOfBase64 } from '../../utils/imageResizer.js'
import { modelReceivesImageBlocks } from '../../utils/model/capabilities.js'
import { getEngineModel } from '../../utils/model/model.js'
import {
  BROWSER_CLOSE_BOUND_MS,
  BROWSER_FINISH_BOUND_MS,
  BROWSER_PROTOCOL_TIMEOUT_MS,
  CONSOLE_RING_CAP,
  MAIN_TAB,
  NAVIGATION_CAP_MS,
  activeSession,
  approveSecretPairing,
  approveWebOrigin,
  beginBrowserActivity,
  bringTabToFront,
  browserSessionCap,
  browserTabs,
  browserTransfers,
  closeBrowserSessionDetailed,
  consumeCheckedActOrigin,
  driverVersion,
  emulatedPageOf,
  ensureBrowserSession,
  firstNavigation,
  isBrowserErrorPage,
  noteEmulatedPage,
  originApproved,
  originOf,
  pageKitOf,
  screenshotPath,
} from '../../services/browser/browserSession.js'
import {
  EMULATION_FIELD_WORDS,
  type EmulationOutcome,
  applyEmulation,
  carryEmulation,
  deviceNames,
  emulationActive,
  emulationLines,
  emulationSummary,
  heldDevice,
  notePlainSize,
  parseEmulation,
} from '../../services/browser/browserEmulation.js'
import { resolveBrowserSecret, scrubSecretFromText } from '../../services/browser/browserSecrets.js'
import type { Transfer } from '../../services/browser/browserTransfers.js'
import { ensureScratchpadDir } from '../../utils/scratchpad.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { getScratchpadDir } from '../../utils/permissions/filesystem.js'
import type { ToolPermissionContext } from '../../types/permissions.js'
import { renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, userFacingName } from './UI.js'
import {
  ACT_OPS,
  EXTRACT_CAP,
  FRONT_OPS,
  type Input,
  OPS,
  type Output,
  PRESS_KEYS,
  type SchemaType,
  TABLESS_OPS,
  TEXT_INPUT_TYPES,
  TOUCH_OPS,
  WAIT_CAP_MS,
  WAIT_DEFAULT_MS,
  browserToolEnabled,
  inputSchema,
} from './browser/schema.js'
import {
  BROWSER_GONE_ERROR,
  CRASH_OPEN_OPS,
  type OpLife,
  PAGE_CRASHED_ERROR,
  RECOVERED_NOTE,
  browserGoneMidOpWords,
  crashedWords,
  driverFailureWords,
  errorChainText,
  isDriverTimeout,
  noSessionWords,
  openOpLife,
  relayNamedFailure,
} from './browser/failures.js'
import {
  type LiveSession,
  capExtract,
  deepTextOf,
  errorPageWords,
  failedNavigationWords,
  frameListing,
  localClock,
  pageWhere,
  preview,
  sendOrigin,
  serializeAxTree,
  statusReport,
  targetOrigin,
  targetSurface,
  viewportWords,
} from './browser/page.js'
import { downloadAct, downloadSought, downloadVia, downloadWords, namedTransfers, transferWords } from './browser/downloads.js'
import { actConsequences, errorPageSettled, firstRequestWords, markAct, popupWords, settleAfterAct } from './browser/settle.js'
import {
  actDeadline,
  actOriginGate,
  clickGate,
  isDisabledTarget,
  probeEditableTarget,
  replacedSinceCheck,
  resolveActTarget,
  resolveReadTarget,
  settleBoundingBox,
} from './browser/targets.js'
import { humanClickPoint, humanMoveTo, humanTypeText, pickTargetPoint } from './browser/human.js'
import { sendUpload, takeCheckedUpload } from './browser/upload.js'
import { checkBrowserPermissions, sentByEmulation } from './browser/permissions.js'
import { validateBrowserInput } from './browser/validate.js'
export { browserToolEnabled, EXTRACT_CAP, WAIT_CAP_MS, WAIT_DEFAULT_MS } from './browser/schema.js'
export type { Input, Output } from './browser/schema.js'
export { browserGoneMidOpWords, driverFailureWords, errorChainText, isDriverTimeout, openSchemeRefusal } from './browser/failures.js'
export { localClock } from './browser/page.js'
export { DOWNLOADS_NOT_FOLLOWED } from './browser/downloads.js'

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
  checkPermissions(asked: Input, context: ToolUseContext) {
    return checkBrowserPermissions(asked, context)
  },
  validateInput(asked: Input) {
    return validateBrowserInput(asked)
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
