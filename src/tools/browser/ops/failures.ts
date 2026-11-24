import { BROWSER_PROTOCOL_TIMEOUT_MS, MAIN_TAB, browserTabs, endedTab, sessionGoneAt } from '../../../integrations/browser/browserSession.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import type { LiveSession } from './page.js'
import { ATTACH_OP } from '../../../integrations/browser/browserWords.js'

export function openSchemeRefusal(url: string | undefined): string {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url ?? '')?.[1]?.toLowerCase()
  if (scheme === undefined) return `open requires an http(s) url — "${url ?? ''}" has no scheme`
  if (scheme === 'file') return 'open requires an http(s) url — serve the folder first (the Service tool or a loopback server); file:// is not supported'
  return `open requires an http(s) url — ${scheme}: is not a web scheme this tool opens (${scheme}:// is not supported; the browser's own pages and non-web protocols stay closed)`
}

const NO_SESSION = 'no open session — use op:"open" first'
const BROWSER_GONE = 'the browser is gone (its process exited) — op:"open" starts a new one'

export function noSessionWords(owner: OwnerKey, tab: string = MAIN_TAB): string {
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

export function relayNamedFailure(s: LiveSession, url: string, err: unknown): unknown {
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

export const BROWSER_GONE_ERROR = 'BrowserGoneError'
export const PAGE_CRASHED_ERROR = 'PageCrashedError'
export const CRASH_OPEN_OPS: ReadonlySet<string> = new Set(['status', 'devices', 'provision', 'open', ATTACH_OP, 'reload', 'close', 'console'])

function pageCrashedError(): Error {
  const err = new Error('the page crashed (its process exited mid-op)')
  err.name = PAGE_CRASHED_ERROR
  return err
}

export function crashedWords(s: LiveSession, named: boolean, op?: string): string {
  return `${op === undefined ? '' : `${op}: `}${named ? `tab ${s.tab}` : 'the page'} crashed (its process exited${op === undefined ? '' : ' mid-op'}) — op:"reload" loads it again with its form values and script state gone; op:"close"${named ? ` with tab:"${s.tab}" drops it` : ' ends the session'}`
}

export const RECOVERED_NOTE = '\n  note: the page had crashed and this is a fresh load: form values and script state are gone; history, cookies and stored data stay'

function browserGoneError(): Error {
  const err = new Error('the browser is gone (its process exited mid-op)')
  err.name = BROWSER_GONE_ERROR
  return err
}

export interface OpLife {
  signal: AbortSignal
  browser: LiveSession['browser']
  release: () => void
}

export function openOpLife(s: LiveSession, outer: AbortSignal | undefined): OpLife {
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
