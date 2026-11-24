import { type ToolEffectOutcome, type ToolUseContext, buildTool } from '../kit/tool.js'
import { modelReceivesImageBlocks } from '../../models/facts/capabilities.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import {
  BROWSER_CLOSE_BOUND_MS,
  BROWSER_PROTOCOL_TIMEOUT_MS,
  CONSOLE_RING_CAP,
  MAIN_TAB,
  NAVIGATION_CAP_MS,
  activeSession,
  beginBrowserActivity,
  bringTabToFront,
  browserSessionCap,
  pageKitOf,
  sessionAttached,
} from '../../integrations/browser/browserSession.js'
import { EMULATION_FIELD_WORDS } from '../../integrations/browser/browserEmulation.js'
import { ATTACH_OP } from '../../integrations/browser/browserWords.js'
import { scrubSecretFromText } from '../../integrations/browser/browserSecrets.js'
import { ownerFromToolUseContext } from '../../engine/run-owner/resolveOwner.js'
import { renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, userFacingName } from './rows.js'
import { readFileSync } from 'node:fs'
import type { OwnerKey } from '../../engine/run-owner/ownerKey.js'
import {
  ACT_OPS,
  ATTACHED_ASK_OPS,
  EXTRACT_CAP,
  FRONT_OPS,
  type Input,
  OPS,
  type Output,
  type SchemaType,
  TABLESS_OPS,
  TOUCH_OPS,
  browserToolEnabled,
  inputSchema,
} from './ops/schema.js'
import {
  BROWSER_GONE_ERROR,
  type OpLife,
  PAGE_CRASHED_ERROR,
  browserGoneMidOpWords,
  crashedWords,
  driverFailureWords,
  errorChainText,
  openOpLife,
} from './ops/failures.js'
import { type LiveSession, pageWhere } from './ops/page.js'
import { downloadAct, downloadSought, downloadVia, namedTransfers, transferWords } from './ops/downloads.js'
import { firstRequestWords, popupWords } from './ops/settle.js'
import { checkBrowserPermissions, sentByEmulation } from './ops/permissions.js'
import { validateBrowserInput } from './ops/validate.js'
import { runOp } from './ops/ops.js'
import { actOriginGate } from './ops/targets.js'
import { errorMessage } from '../../platform/errors/errors.js'
export { browserToolEnabled, EXTRACT_CAP, WAIT_CAP_MS, WAIT_DEFAULT_MS } from './ops/schema.js'
export type { Input, Output } from './ops/schema.js'
export { browserGoneMidOpWords, driverFailureWords, errorChainText, isDriverTimeout, openSchemeRefusal } from './ops/failures.js'
export { localClock } from './ops/page.js'
export { DOWNLOADS_NOT_FOLLOWED } from './ops/downloads.js'

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
    ATTACH_OP, 'remote debugging', 'running browser',
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
      'attach to a Chromium the user started with remote debugging on',
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
    return 'Drive a headless Chrome for Testing from the managed cache (or an operator-pinned browser; installed browsers are never launched) with full provenance: navigate, click, type, scroll, wait on events, extract text or the accessibility tree, read the console, screenshot; attach joins a Chromium the user started with remote debugging on'
  },
  wireDescription() {
    return 'Drive one isolated browser session per agent through the bundled driver. Returns page observations, action results and screenshots. Opening a new origin or first acting on a crossed-to origin asks; reads never ask. attach joins the user\'s own Chromium, where an origin\'s first read asks too. Grants belong to this agent and end with its session.'
  },
  async prompt() {
    const cap = browserSessionCap()
    return `## Operations
status reports browser resolution (operator pin, then managed Chrome-for-Testing), versions, session state and open tabs without launching. Installed browsers are not launched.
attach joins a Chromium the user started with remote debugging on (endpoint, loopback only) and lists its tabs as tab-1, tab-2 and so on; there open adds a tab, download with url or selector is refused, and close detaches: that browser and the user's tabs stay open, tabs opened here are closed.
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
    let imagePath = undefined as string | undefined
    let inlinePath = undefined as string | undefined
    let inlineMediaType = undefined as string | undefined
    let secretInPlay = null as { value: string; ref: string } | null
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
      const moved = sessionAtEntry !== null && !crashedAtEntry && ATTACHED_ASK_OPS.has(input.op) && sentByEmulation(input) === null && sessionAttached(sessionAtEntry) ? await actOriginGate(owner, sessionAtEntry, input) : null
      const answer = moved !== null ? { result: moved, outcome: 'failed' as const } : runOp({
        input,
        owner,
        tab,
        context,
        sessionAtEntry,
        crashedAtEntry,
        signalFor,
        acting,
        holdSecret: secret => {
          secretInPlay = secret
        },
        holdImage: path => {
          imagePath = path
        },
        holdInline: path => {
          inlinePath = path
        },
        holdInlineType: type => {
          inlineMediaType = type
        },
      })
      const done = answer instanceof Promise ? await answer : answer
      result = done.result
      outcome = done.outcome
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
      const path = output.inlinePath ?? output.imagePath
      try {
        const bytes = readFileSync(path)
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
      } catch (error) {
        return {
          tool_use_id: toolUseId,
          type: 'tool_result' as const,
          content: `${output.result}\n(image not inlined — could not read ${path} (${errorMessage(error)}))`,
        }
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
