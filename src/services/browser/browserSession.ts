// ============================================================================
//  services/browser/browserSession — the driver-session owner, keyed PER
//  OWNER (the canonical OwnerKey: main lane and each agent lane its own):
//  every in-process agent drives its OWN puppeteer-core session against the
//  resolver's executable (pin > installed > managed cache), with its OWN
//  origin grants — an approval granted to one owner never authorizes
//  another, and one owner's navigation can never move another's page.
//  Children are bounded (browserSessionCap), reaped per owner (an owner's
//  teardown kills ITS child) and swept at process exit. No second process
//  owner — every browser child is owned HERE, exclusively.
// ============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Browser as DriverBrowser, LaunchOptions, Page } from 'puppeteer-core'
import puppeteerPkg from 'puppeteer-core/package.json' with { type: 'json' }
import { getMercuryHome } from '../../utils/envUtils.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { parseOwnerKey, type OwnerKey } from '../run/ownerKey.js'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import {
  driverNodeGate,
  resolveBrowser,
  type BrowserResolution,
} from './browserResolver.js'

/** One captured console/page-error line — bounded at capture time. */
export interface ConsoleEntry {
  at: number
  kind: string
  text: string
}

/** The console ring keeps the LAST this-many entries (older lines drop). */
export const CONSOLE_RING_CAP = 250
/** Each captured line is bounded to this many chars at capture time. */
export const CONSOLE_ENTRY_CAP = 300

interface Session {
  browser: DriverBrowser
  page: Page
  resolution: BrowserResolution
  driverVersion: string
  /** The page's console + page-error ring (bounded; see CONSOLE_RING_CAP). */
  consoleRing: ConsoleEntry[]
  /** Main-frame navigation ledger: seq counts every committed navigation;
   *  seen is stamped by each ACT op at its start, so "did a navigation land
   *  since the last act?" is one comparison — the lost-navigation race
   *  (waiter armed after the event) dies here. */
  nav: { seq: number; seen: number }
  /** true when the launch appended --no-sandbox (uid 0 on linux) — status
   *  names the downgrade so it is never silent. */
  sandboxDowngraded: boolean
  /** New-tab ledger: a popup is NAMED (ring + here) and closed unadopted —
   *  the one-owned-page law keeps, the silence dies. */
  popups: { count: number; last: string }
}

/** One owner's whole browser estate: the session, the origin grants the
 *  operator approved FOR THIS OWNER, and the one-shot judged-origin carry.
 *  `launching` reserves the concurrency slot SYNCHRONOUSLY (before the
 *  launch's first await), so two owners racing ensure() cannot both pass
 *  the cap census and overshoot it. */
interface OwnerBrowserState {
  session: Session | null
  launching: boolean
  /** The owner's ONE in-flight launch: a parallel ensure() joins it instead
   *  of racing a second child. The cap census excludes the caller's own rows
   *  (a relaunch must not self-block), so it cannot police a same-owner race
   *  — without this, the loser's child was overwritten OUT of the store:
   *  invisible to the census, unkillable by the exit sweep, a leaked Chrome. */
  launchFlight: Promise<Session | EnsureSessionRefusal> | null
  /** Set by the disposer, for the rest of this state's life: the owner is
   *  torn down. The store forgets the state the moment dispose is called, so
   *  a launch still in the air is the LAST thing that can reach it — a child
   *  written into a forgotten state is invisible to the census and the exit
   *  sweep and no repeat dispose can find it, a stranded Chrome. A launch
   *  landing on a disposed state closes the child it spawned instead. */
  disposed: boolean
  approvedOrigins: Set<string>
  /** Approved secret-fill pairings, keyed "<ref>@<origin>" — the pairing
   *  consent class: an origin grant never covers a secret fill, and a
   *  pairing dies with the child exactly like an origin grant. */
  approvedSecretPairings: Set<string>
  checkedActOrigin: { op: string; origin: string } | null
}

function killChild(browser: DriverBrowser): void {
  try {
    browser.process()?.kill()
  } catch {
    /* already gone */
  }
}

/** Close a child politely; a close that throws (protocol down, child already
 *  gone) falls back to the kill. The ONE road every child leaves by. */
async function closeChild(browser: DriverBrowser): Promise<void> {
  try {
    await browser.close()
  } catch {
    killChild(browser)
  }
}

/** The driver launch call. Proofs stand a fixture driver in for puppeteer-core
 *  here, so the launch lifecycle (a teardown mid-launch, a setup failure after
 *  the spawn, a relaunch behind a teardown) is provable with no real Chrome;
 *  everything around the call — the gate, the cap census, the slot reserve,
 *  the handoff — stays the real code. */
type LaunchDriver = (options: LaunchOptions) => Promise<DriverBrowser>
let launchDriverForProof: LaunchDriver | null = null
export function setBrowserLaunchDriverForProof(driver: LaunchDriver | null): void {
  launchDriverForProof = driver
}

// ── the per-owner store ─────────────────────────────────────────────────────
// Registered with ownerLifecycle, so disposeOwner(owner) and the process-
// shutdown sweep reap an owner's child with the rest of its owner state.
// A live child is RETAINED (never LRU-evicted — eviction would kill a
// browser mid-act wearing a cache policy's clothes); session-less states
// hold nothing (grants die with the child) and evict freely.
const ownerStates = new OwnerScopedStore<OwnerBrowserState>({
  name: 'browser-sessions',
  create: () => ({
    session: null,
    launching: false,
    launchFlight: null,
    disposed: false,
    approvedOrigins: new Set(),
    approvedSecretPairings: new Set(),
    checkedActOrigin: null,
  }),
  dispose: async state => {
    state.disposed = true
    state.approvedOrigins.clear()
    state.approvedSecretPairings.clear()
    state.checkedActOrigin = null
    // A launch in the air: wait for it to land. The launch body reads
    // `disposed` at its handoff and closes its own child before its flight
    // settles, so this await returns only once no child of this owner's
    // exists — the awaiting callers (the agent teardown, the shutdown sweep's
    // drain) get "the child is gone", never "the child will be gone".
    if (state.launchFlight !== null) await state.launchFlight.catch(() => undefined)
    const session = state.session
    state.session = null
    if (!session) return
    await closeChild(session.browser)
  },
  retain: state => state.session !== null || state.launching,
})
registerOwnerScopedStore(ownerStates)

let exitHookInstalled = false

/** Reap ONE owner's browser estate: close (or kill) its child, wipe its
 *  grants, drop its state. The agent-teardown seam (runAgent's leak repair)
 *  and the proofs call this; disposeOwner(owner) reaches the same disposer
 *  through the ownerLifecycle registry. Idempotent. */
export async function disposeBrowserOwner(owner: OwnerKey): Promise<void> {
  await ownerStates.disposeAsync(owner)
}

/** Concurrent-children cap (live + launching, process-wide). The default is
 *  deliberately small — every session is a whole Chrome child; the operator
 *  widens or narrows with MERCURY_BROWSER_MAX_SESSIONS (floor 1). */
export const BROWSER_SESSION_CAP_DEFAULT = 3
export function browserSessionCap(): number {
  const raw = flagEnv('MERCURY_BROWSER_MAX_SESSIONS')
  if (raw === undefined || raw.trim() === '') return BROWSER_SESSION_CAP_DEFAULT
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : BROWSER_SESSION_CAP_DEFAULT
}

/** The live-children census (connected or mid-launch), for the cap refusal
 *  and the status surface. Lane names come from the owner key — honest
 *  attribution, never a guess. */
export function liveBrowserSessionCensus(): Array<{ owner: OwnerKey; lane: string; url: string | null }> {
  const rows: Array<{ owner: OwnerKey; lane: string; url: string | null }> = []
  for (const owner of ownerStates.owners()) {
    const state = ownerStates.peek(owner)
    if (!state) continue
    const live = state.session !== null && state.session.browser.connected
    if (!live && !state.launching) continue
    let lane = 'unknown'
    try {
      lane = parseOwnerKey(owner).lane
    } catch {
      /* census only — a bad key still counts toward the cap */
    }
    rows.push({ owner, lane, url: live ? state.session!.page.url() : null })
  }
  return rows
}

// ── origin identity ─────────────────────────────────────────────────────────
/** Web origin of a URL (scheme+host+port); non-web schemes (about:blank,
 *  chrome-error://…) reduce to their scheme marker. A MALFORMED url gets its
 *  own marker — it must never inherit about:blank's ask-free standing. */
export function originOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : u.protocol
  } catch {
    return 'unparseable:'
  }
}

// ── the judged-origin carry (check → act), per owner ────────────────────────
// checkPermissions judges an origin and the operator answers for THAT
// origin; the page can navigate while the consent card is open. The judged
// origin travels here (one-shot, keyed by op, ON THE OWNER'S OWN STATE) and
// the act refuses on a mismatch — an approval for origin A can never grant
// origin B, and one owner's judged origin can never answer another owner's
// act.
export function noteCheckedActOrigin(owner: OwnerKey, op: string, origin: string): void {
  ownerStates.get(owner).checkedActOrigin = { op, origin }
}

export function consumeCheckedActOrigin(owner: OwnerKey, op: string): string | null {
  const state = ownerStates.peek(owner)
  if (!state) return null
  const held = state.checkedActOrigin
  state.checkedActOrigin = null
  return held !== null && held.op === op ? held.origin : null
}

// ── owner-scoped origin grants ──────────────────────────────────────────────
// The permission grammar's memory: an origin the operator approved (or an
// act ran on) rides for the rest of the OWNER'S session; any transition
// through "no live browser child" wipes the owner's set — a grant lives
// exactly as long as the child that received it, and never crosses owners.
export function originApproved(owner: OwnerKey, origin: string): boolean {
  return ownerStates.peek(owner)?.approvedOrigins.has(origin) ?? false
}

/** Record a grant for the URL's web origin (non-web schemes are not stored). */
export function approveWebOrigin(owner: OwnerKey, url: string): void {
  const origin = originOf(url)
  if (origin.startsWith('http')) ownerStates.get(owner).approvedOrigins.add(origin)
}

export function approvedOriginList(owner: OwnerKey): string[] {
  return [...(ownerStates.peek(owner)?.approvedOrigins ?? [])]
}

/** A dead child must not lend its grants: any read of an owner's session
 *  first drops a disconnected browser and wipes that owner's origin grants
 *  — "grants die with the child" holds on the crash path, not just close. */
function reapDeadSession(state: OwnerBrowserState): void {
  if (state.session && !state.session.browser.connected) {
    state.session = null
    state.approvedOrigins.clear()
    state.approvedSecretPairings.clear()
  }
}

export function activeSession(owner: OwnerKey): Session | null {
  const state = ownerStates.peek(owner)
  if (!state) return null
  reapDeadSession(state)
  return state.session
}

/** Driver version for STATUS surfaces (no session needed). */
export function driverVersion(): string {
  return (puppeteerPkg as { version?: string }).version ?? 'bundled'
}

/** Why no session came back: no drivable engine ('unavailable'), the cap
 *  ('at-capacity'), or the owner torn down while its launch was in the air
 *  ('torn-down' — the child that landed was closed, nothing is open). */
export type EnsureSessionRefusal = { state: 'unavailable' | 'at-capacity' | 'torn-down'; note: string }

export async function ensureBrowserSession(owner: OwnerKey): Promise<Session | EnsureSessionRefusal> {
  const state = ownerStates.get(owner)
  if (state.session && state.session.browser.connected) return state.session
  // Single-flight per owner: a call landing while this owner's launch is in
  // flight AWAITS that launch (success and refusal alike — a parallel caller
  // today would meet the same synchronous refusal state). Only the minter
  // clears the slot, and only ITS OWN flight — a joiner's late finally must
  // never wipe a newer flight back open (that crack re-arms the race).
  if (state.launchFlight !== null) return state.launchFlight
  const flight = launchOwnerSession(owner, state)
  state.launchFlight = flight
  try {
    return await flight
  } finally {
    if (state.launchFlight === flight) state.launchFlight = null
  }
}

/** The launch body. The synchronous head (gate, cap census, resolution, the
 *  `launching` slot reserve) runs in the CALLER's frame — an async function
 *  executes synchronously to its first await — so the cap's no-overshoot
 *  guarantee is exactly the pre-flight one. */
async function launchOwnerSession(owner: OwnerKey, state: OwnerBrowserState): Promise<Session | EnsureSessionRefusal> {
  if (state.session) {
    // the granted-to child died — grants and pairings die with it
    state.approvedOrigins.clear()
    state.approvedSecretPairings.clear()
  }
  state.session = null
  const gate = driverNodeGate()
  if (!gate.ok) return { state: 'unavailable', note: gate.note }
  // The cap census counts live AND launching children; the slot reserves
  // synchronously below (before any await), so racing owners cannot both
  // pass this line and overshoot the cap.
  const cap = browserSessionCap()
  const others = liveBrowserSessionCensus().filter(row => row.owner !== owner)
  if (others.length >= cap) {
    const lanes = others.map(row => row.lane).join(', ')
    return {
      state: 'at-capacity',
      note: `${others.length} of ${cap} concurrent browser sessions are live (${lanes}) — wait for one to finish, close one from its own lane (op:"close"), or raise MERCURY_BROWSER_MAX_SESSIONS`,
    }
  }
  const resolution = resolveBrowser()
  if (resolution.state === 'unavailable') {
    return { state: 'unavailable', note: `${resolution.note} — ${resolution.remedies.join('; ')}` }
  }
  state.launching = true
  /** The child this body spawned and has not yet handed to the state. Closed
   *  on EVERY exit before the handoff — a setup throw after the spawn, an
   *  owner torn down while the launch was in the air — because the body owns
   *  what it spawned until the state does. */
  let unhanded: DriverBrowser | null = null
  try {
    const launch: LaunchDriver =
      launchDriverForProof ?? (async options => (await import('puppeteer-core')).default.launch(options))
    const launchArgs = [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      // Chrome crashes on a small /dev/shm (every devcontainer); harmless
      // elsewhere — shared memory falls back to /tmp.
      '--disable-dev-shm-usage',
    ]
    // Chrome refuses to start as uid 0 without --no-sandbox, and a container
    // running as root is the most common agent host. The downgrade is
    // CONDITIONAL (never on a normal developer box) and recorded on the
    // session so status names it — an honest downgrade, not a silent one.
    const sandboxDowngraded =
      process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0
    if (sandboxDowngraded) launchArgs.push('--no-sandbox')
    const browser = await launch({
      executablePath: resolution.executablePath,
      headless: true,
      // The child inherits the SCRUBBED environment (the driver's default is
      // the raw process env): session tokens and the browser secret family
      // must never reach the Chrome child.
      env: subprocessEnv(),
      // 1280x800: desktop-first, above the common lg (1024px) breakpoint — an
      // explicit decision, replacing the driver's 800x600 tablet accident that
      // made every screenshot and layout judgement a mobile render.
      defaultViewport: { width: 1280, height: 800 },
      // The header law made TRUE BY CONSTRUCTION: with no policy set, Chrome's
      // own default governs and a Content-Disposition:attachment navigation
      // can write unconsented bytes to disk. Deny at the protocol level —
      // /browser provisioning stays the ONE consented download road.
      downloadBehavior: { policy: 'deny' },
      args: launchArgs,
    })
    unhanded = browser
    const pages = await browser.pages()
    const page = pages[0] ?? (await browser.newPage())
    const consoleRing: ConsoleEntry[] = []
    const nav = { seq: 0, seen: 0 }
    const popups = { count: 0, last: '' }
    const capture = (kind: string, text: string): void => {
      // Oversize truncates LOUDLY (the extract law): a React stack cut
      // mid-word with no marker reads as the whole message.
      const bounded =
        text.length > CONSOLE_ENTRY_CAP
          ? `${text.slice(0, CONSOLE_ENTRY_CAP)}… [+${text.length - CONSOLE_ENTRY_CAP} chars]`
          : text
      consoleRing.push({ at: Date.now(), kind, text: bounded })
      if (consoleRing.length > CONSOLE_RING_CAP) consoleRing.shift()
    }
    /** Query strings never enter the ring — they carry tokens. */
    const redactUrl = (url: string): string => {
      const q = url.indexOf('?')
      return q === -1 ? url : `${url.slice(0, q)}?…`
    }
    page.on('framenavigated', frame => {
      if (frame.parentFrame() === null) {
        nav.seq++
        capture('nav', `navigated to ${redactUrl(frame.url())}`)
      }
    })
    page.on('console', message => {
      const loc = message.location()
      const where = loc.url ? ` @ ${redactUrl(loc.url)}:${loc.lineNumber ?? 0}` : ''
      const args = message.args()
      if (args.length === 0) {
        capture(message.type(), `${message.text()}${where}`)
        return
      }
      // Structured logging is the norm — resolve args best-effort so
      // console.log('state', {user}) lands as JSON, not JSHandle@object.
      // (puppeteer does not dispose console handles while a listener is
      // attached, so jsonValue here is safe.)
      void Promise.all(args.map(a => a.jsonValue().catch(() => undefined)))
        .then(vals => {
          const rendered = vals
            .map(v => (v === undefined ? '<unserializable>' : typeof v === 'string' ? v : JSON.stringify(v)))
            .join(' ')
          capture(message.type(), `${rendered.trim() !== '' ? rendered : message.text()}${where}`)
        })
        .catch(() => capture(message.type(), `${message.text()}${where}`))
    })
    page.on('pageerror', err => {
      const e = err as Error | undefined
      const stack = (e?.stack ?? '')
        .split('\n')
        .slice(1, 4)
        .map(l => l.trim())
        .filter(Boolean)
      capture('pageerror', `${String(e?.message ?? err)}${stack.length > 0 ? ` | ${stack.join(' | ')}` : ''}`)
    })
    // A target=_blank / window.open click really opens a tab (popup blocking
    // is off in headless) — unowned it was a black hole: the click reported
    // success at an unchanged URL and the tab lived until exit. NAME it in the
    // ring, count it for the acting op, close it unadopted (adoption is a
    // named deferral; op:"open" follows the URL under the origin grammar).
    page.on('popup', popup => {
      if (!popup) return
      void (async () => {
        let url = popup.url()
        if (!url || url === 'about:blank') {
          await new Promise(r => setTimeout(r, 300))
          url = popup.url()
        }
        popups.count++
        popups.last = redactUrl(url || '(unknown)')
        capture('popup', `the page opened a new tab: ${popups.last} — closed unadopted (one owned page; op:"open" follows it)`)
        await popup.close().catch(() => {})
      })()
    })
    // The network truth an agent opens a browser for: failed requests and
    // error responses join the SAME bounded ring as kind "net" — method, path
    // (query redacted), status/failure, resource type. Never headers, never
    // bodies.
    page.on('requestfailed', request => {
      capture(
        'net',
        `${request.method()} ${redactUrl(request.url())} FAILED ${request.failure()?.errorText ?? ''} (${request.resourceType()})`,
      )
    })
    page.on('response', response => {
      const status = response.status()
      if (status < 400) return
      const req = response.request()
      capture('net', `${req.method()} ${redactUrl(response.url())} ${status} (${req.resourceType()})`)
    })
    // JS dialogs: puppeteer never auto-answers, and an open dialog BLOCKS the
    // renderer — every later evaluate/waitForSelector/goto would hang to the
    // protocol timeout. The session owns the answer: dismiss (the
    // no-consequence choice) for alert/confirm/prompt, accept for beforeunload
    // so navigation completes; every dialog lands in the ring BY TEXT so a
    // silently-cancelled confirm is visible provenance, never a mystery.
    page.on('dialog', dialog => {
      const kind = dialog.type()
      const verb = kind === 'beforeunload' ? 'accepted' : 'dismissed'
      capture('dialog', `${kind}("${dialog.message()}") auto-${verb} — the page was blocked on it`)
      void (kind === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(() => {
        /* already handled or target gone */
      })
    })
    // The owner was torn down while this launch was in the air: the state is
    // already out of the store, so a session written into it would be a
    // stranded child. The finally closes what was spawned; the joined callers
    // get the refusal.
    if (state.disposed) {
      return {
        state: 'torn-down',
        note: 'the owner was torn down while its browser launch was in flight — the child was closed, nothing is open',
      }
    }
    state.session = {
      browser,
      page,
      resolution,
      // The version probe (browserVersionOf — a blocking child spawn, worst
      // case its whole 5 s timeout on win32) stays OFF the launch path: only
      // the status surfaces ask for it, and they call the resolver directly.
      driverVersion: (puppeteerPkg as { version?: string }).version ?? 'bundled',
      consoleRing,
      nav,
      sandboxDowngraded,
      popups,
    }
    unhanded = null
  } finally {
    state.launching = false
    // Every exit before the handoff closes the child — a disposer awaiting
    // this flight then finds no session, and the census never counted a
    // child that nothing could reach.
    if (unhanded !== null) await closeChild(unhanded)
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true
    // The last-resort sweep: kill EVERY owner's child on process exit. The
    // graceful road (ownerLifecycle's shutdown sweep) closes politely; this
    // one holds on the raw-exit cliff the §14 drill drives.
    process.on('exit', () => {
      for (const key of ownerStates.owners()) {
        const st = ownerStates.peek(key)
        if (st?.session) killChild(st.session.browser)
      }
    })
  }
  return state.session
}

export async function closeBrowserSession(owner: OwnerKey): Promise<boolean> {
  const state = ownerStates.peek(owner)
  if (!state) return false
  // "closed" means no child of this owner's when this returns: a launch in
  // the air lands into this very state, so wait for it and close what landed.
  if (state.launchFlight !== null) await state.launchFlight.catch(() => undefined)
  if (!state.session) return false
  const session = state.session
  await closeChild(session.browser)
  state.session = null
  state.approvedOrigins.clear() // origin grants are session-scoped — close wipes them
  state.approvedSecretPairings.clear()
  return true
}

// ── secret-fill pairings (the credential road's consent class) ──────────────
// "fill secret <ref> into <origin>" is its OWN consent — an origin grant
// never covers it, and it rides for the rest of the owner's session once
// the operator says yes (a localSettings pairing rule persists across
// sessions). Keys never carry values.
export function secretPairingKey(ref: string, origin: string): string {
  return `${ref}@${origin}`
}

export function secretPairingApproved(owner: OwnerKey, ref: string, origin: string): boolean {
  return ownerStates.peek(owner)?.approvedSecretPairings.has(secretPairingKey(ref, origin)) ?? false
}

export function approveSecretPairing(owner: OwnerKey, ref: string, origin: string): void {
  if (origin.startsWith('http')) ownerStates.get(owner).approvedSecretPairings.add(secretPairingKey(ref, origin))
}

/** Session screenshot dir (beside the existing image-cache convention). */
export function screenshotPath(label: string): string {
  const dir = path.join(getMercuryHome(), 'browser-shots')
  fs.mkdirSync(dir, { recursive: true })
  const safe = label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'shot'
  return path.join(dir, `${Date.now()}-${safe}.png`)
}
