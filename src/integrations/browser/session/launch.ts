import { startMetadataProxy } from '../metadataProxy.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Browser as DriverBrowser, Page } from 'puppeteer-core'
import { getMercuryHome } from '../../../platform/environment/envUtils.js'
import { errorMessage, getErrnoCode } from '../../../platform/errors/errors.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { subprocessEnv } from '../../../platform/processes/subprocessEnv.js'
import { parseOwnerKey, type OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { driverNodeGate, resolveBrowser, type BrowserResolution } from '../browserResolver.js'
import { MAIN_TAB, type Wiring, type Hold, type Session, type OwnerBrowserState, BROWSER_PROTOCOL_TIMEOUT_MS, EXITED, MOVE_FAILED, RESTARTED, type EnsureSessionRefusal, type EnsureBrowserSessionOptions, type PageIdentity, type PagePresented, type PageKit } from './shapes.js'
import { clearIdleLease, armIdleLease, type CloseOutcome, tempProfileDirOf, tempProfiles, closeChild, closePage, endHold, holdOf, type LaunchDriver, launchDriverForProof, ownerStates, installExitHook, browserSessionCap, liveBrowserSessionCensus, originOf, closeHoldNetwork, noteEnded, endDownloads, sweepDownloads, holdGone, reapDeadHolds, leaveHold } from './owners.js'
import { resolveHostLanguages, resolveNavigatorPlatform, resolveHostTimeZone, pageKits, prepareDocuments } from './stealth.js'
import { newWiring, listenProtocol, listenDownloads, targetIdOf, tabSession, listenPage, armAttachedPage } from './wiring.js'
import { watchFrames, watchBirths } from './births.js'
import { passedOver, passedOverAs } from '../../../platform/errors/passedOver.js'
import { posixFileModesApply } from '../../../platform/host-os/files.js'

export function browserProfileDirForOrigin(urlOrOrigin: string, owner?: OwnerKey): string | null {
  if (typeof urlOrOrigin !== 'string' || urlOrOrigin.trim() === '' || /[\s;"'\\]/.test(urlOrOrigin)) return null
  const origin = originOf(urlOrOrigin)
  if (!origin.startsWith('http://') && !origin.startsWith('https://')) return null
  let u: URL
  try {
    u = new URL(origin)
  } catch (error) {
    passedOver(error)
    return null
  }
  if (u.origin !== origin || !u.hostname || u.hostname.includes('..')) return null
  const scheme = u.protocol === 'https:' ? 'https' : 'http'
  const host = u.hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, '_').replace(/^\.+|\.+$/g, '')
  if (!host) return null
  const port = u.port ? `-${u.port}` : ''
  const slug = `${scheme}-${host}${port}`.slice(0, 100)
  const root = path.resolve(getMercuryHome(), 'browser-profiles')
  let candidate = path.resolve(root, slug)
  if (!candidate.startsWith(root + path.sep)) return null
  if (owner !== undefined) {
    const busy = ownerStates.owners().some(other => other !== owner && profileHeld(other, candidate))
    if (busy) {
      let lane = 'lane'
      try {
        lane = parseOwnerKey(owner).lane.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 32) || 'lane'
      } catch (error) { passedOver(error) }
      candidate = path.resolve(root, `${slug}--${lane}`)
      if (!candidate.startsWith(root + path.sep)) return null
    }
  }
  return candidate
}

function profileHeld(owner: OwnerKey, profileDir: string): boolean {
  return [...(ownerStates.peek(owner)?.holds ?? [])].some(hold => hold.browser.connected && hold.profileDir === profileDir)
}

async function armLate(page: Page, baseline: PagePresented, deny: boolean, births: boolean): Promise<PageKit> {
  const kit: PageKit = { cdp: null, identity: baseline.identity, languages: baseline.languages, timeZone: baseline.timeZone, presented: null, born: null, fetchHeld: false }
  const cdp = typeof page.createCDPSession === 'function' ? await page.createCDPSession().catch(passedOverAs(null)) : null
  kit.cdp = cdp
  await prepareDocuments(page, births ? cdp : null, baseline.languages)
  if (cdp !== null) {
    await cdp.send('Network.enable').catch(passedOverAs(undefined))
    if (deny) await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }).catch(passedOverAs(undefined))
    await cdp.send('Emulation.setAutomationOverride', { enabled: false }).catch(passedOverAs(undefined))
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: baseline.timeZone }).catch(passedOverAs(undefined))
    if (baseline.identity !== null) await cdp.send('Emulation.setUserAgentOverride', baseline.identity).catch(passedOverAs(undefined))
    if (births) await watchFrames(kit, cdp)
  }
  return kit
}

async function newHoldPage(hold: Hold): Promise<{ page: Page; wiring: Wiring }> {
  hold.creating++
  try {
    const page = await hold.browser.newPage()
    try {
      if (hold.attached !== null) {
        hold.attached.opened.add(page)
        const wiring = newWiring()
        await armAttachedPage(page, wiring, hold.baseline)
        return { page, wiring }
      }
      const id = targetIdOf(page)
      const born = id === null ? undefined : hold.births.get(id)
      if (born !== undefined && id !== null) {
        hold.births.delete(id)
        born.handover()
        pageKits.set(page, born.kit)
        return { page, wiring: born.wiring }
      }
      const wiring = newWiring()
      const kit = await armLate(page, hold.baseline, hold.downloads === null, hold.birthsAsked)
      if (kit.cdp !== null) {
        listenProtocol(wiring, kit.cdp)
        if (hold.downloads === null) listenDownloads(wiring, kit.cdp)
      }
      pageKits.set(page, kit)
      return { page, wiring }
    } catch (err) {
      await closePage(page)
      throw err
    }
  } finally {
    hold.creating--
  }
}

export async function ensureBrowserSession(
  owner: OwnerKey,
  opts: EnsureBrowserSessionOptions = {},
): Promise<Session | EnsureSessionRefusal> {
  const state = ownerStates.get(owner)
  const tab = opts.tab ?? MAIN_TAB
  const wantedOrigin = opts.origin && opts.origin.startsWith('http') ? originOf(opts.origin) : null
  for (;;) {
    const held = state.tabs.get(tab)
    if (held && held.browser.connected) {
      const stays = holdOf(held).attached !== null
      const sameHeadless = stays || opts.headless === undefined || held.headless === opts.headless
      const sameOrigin = stays || wantedOrigin === null || held.profileOrigin === wantedOrigin
      if (sameHeadless && sameOrigin) {
        armIdleLease(state)
        return held
      }
    }
    const inFlight = state.launchFlight
    if (inFlight === null) break
    if (inFlight.tab === tab) return awaitLaunch(inFlight.flight, opts.signal)
    await awaitLaunch(
      inFlight.flight.then(() => undefined, passedOverAs(undefined)),
      opts.signal,
    )
  }
  const flight = placeTab(owner, state, tab, opts)
  const entry = { tab, flight }
  state.launchFlight = entry
  const clear = (): void => {
    if (state.launchFlight === entry) state.launchFlight = null
  }
  void flight.then(clear, clear)
  return awaitLaunch(flight, opts.signal)
}

function awaitLaunch<T>(flight: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return flight
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    flight.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

export function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  const err = new Error('the launch wait was interrupted')
  err.name = 'AbortError'
  return err
}

function profileDirRefusal(dir: string, chmodFailure: unknown): string | null {
  const code = getErrnoCode(chmodFailure) ?? errorMessage(chmodFailure)
  let ownerUid: number
  try {
    ownerUid = fs.statSync(dir).uid
  } catch (statFailure) {
    logError(new Error(`the browser profile folder ${dir} could not be made private (chmod 0700: ${code}) and its owner could not be read (stat: ${getErrnoCode(statFailure) ?? errorMessage(statFailure)}), so the browser opens on it as before`))
    return null
  }
  if (typeof process.getuid === 'function' && ownerUid !== process.getuid()) {
    return `the browser profile folder ${dir} could not be made private to you (chmod 0700: ${code}) — nothing was opened; give the folder back to your user or remove it, then open again`
  }
  logError(new Error(`the browser profile folder ${dir} is yours but could not be made private (chmod 0700: ${code}): its filesystem takes no mode, so the browser opens on it as before`))
  return null
}

function readyProfileDir(owner: OwnerKey, profileDir: string, opts: EnsureBrowserSessionOptions): void {
  const profilesRoot = path.dirname(profileDir)
  fs.mkdirSync(profilesRoot, { recursive: true, mode: 0o700 })
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  if (posixFileModesApply()) {
    for (const dir of [profilesRoot, profileDir]) {
      try {
        fs.chmodSync(dir, 0o700)
      } catch (err) {
        const refusal = profileDirRefusal(dir, err)
        if (refusal !== null) throw new Error(refusal)
      }
    }
  }
  const heldElsewhere = ownerStates.owners().some(other => other !== owner && profileHeld(other, profileDir))
  if (!heldElsewhere) {
    for (const lockName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try {
        fs.rmSync(path.join(profileDir, lockName), { force: true })
      } catch (error) { passedOver(error) }
    }
    for (const earlier of ['Sessions', 'Sessions_Encrypted', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs', ...(opts.downloads === undefined ? [] : ['History', 'History-journal', 'History-wal', 'History-shm'])]) {
      try {
        fs.rmSync(path.join(profileDir, 'Default', earlier), { recursive: true, force: true })
      } catch (error) { passedOver(error) }
    }
  }
}

function launchArgsFor(proxy: Awaited<ReturnType<typeof startMetadataProxy>>, hostLang: ReturnType<typeof resolveHostLanguages>): { launchArgs: string[]; sandboxDowngraded: boolean } {
  const launchArgs = [
    `--proxy-server=http://127.0.0.1:${proxy.port}`,
    '--proxy-bypass-list=<-loopback>',
    '--disable-quic',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-component-update',
    '--disable-features=Translate',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,800',
    `--lang=${hostLang.primary}`,
  ]
  const sandboxDowngraded =
    process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0
  if (sandboxDowngraded) launchArgs.push('--no-sandbox')
  return { launchArgs, sandboxDowngraded }
}

function identityOf(resolution: BrowserResolution | null, versionStr: string, cleanUa: string, hostLang: ReturnType<typeof resolveHostLanguages>): PageIdentity {
  const fullVersion =
    resolution!.buildId ??
    (/(\d+\.\d+\.\d+\.\d+)/.exec(versionStr)?.[1] ??
      (/Chrome\/(\d+\.\d+\.\d+\.\d+)/.exec(cleanUa)?.[1] ?? '155.0.0.0'))
  const major = fullVersion.split('.')[0] || '155'
  const isMac = cleanUa.includes('Macintosh') || process.platform === 'darwin'
  const isWin = !isMac && (cleanUa.includes('Windows') || process.platform === 'win32')
  const navigatorPlatform = resolveNavigatorPlatform(cleanUa)
  const chPlatform = isMac ? 'macOS' : isWin ? 'Windows' : 'Linux'
  const chPlatformVersion = isMac
    ? (cleanUa.match(/Mac OS X ([0-9_]+)/)?.[1]?.replace(/_/g, '.') ?? '10.15.7')
    : isWin
      ? '10.0.0'
      : '6.5.0'
  const architecture = process.arch === 'arm64' ? 'arm' : 'x86'
  return {
    userAgent: cleanUa,
    acceptLanguage: hostLang.acceptLanguage,
    platform: navigatorPlatform,
    userAgentMetadata: {
      brands: [
        { brand: 'Not(A:Brand', version: '24' },
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
      ],
      fullVersionList: [
        { brand: 'Not(A:Brand', version: '24.0.0.0' },
        { brand: 'Chromium', version: fullVersion },
        { brand: 'Google Chrome', version: fullVersion },
      ],
      fullVersion,
      platform: chPlatform,
      platformVersion: chPlatformVersion,
      architecture,
      bitness: '64',
      model: '',
      mobile: false,
      wow64: false,
    },
  }
}

async function placeTab(
  owner: OwnerKey,
  state: OwnerBrowserState,
  tab: string,
  opts: EnsureBrowserSessionOptions = {},
): Promise<Session | EnsureSessionRefusal> {
  reapDeadHolds(state)
  const gate = driverNodeGate()
  if (!gate.ok) return { state: 'unavailable', note: gate.note }
  const profileOrigin = opts.origin && opts.origin.startsWith('http') ? originOf(opts.origin) : null
  const headless = opts.headless ?? true
  const home =
    [...state.holds].find(hold => hold.browser.connected && (hold.attached !== null || (hold.profileOrigin === profileOrigin && hold.headless === headless))) ?? null
  let resolution: BrowserResolution | null = null
  if (home === null) {
    const cap = browserSessionCap()
    const identity = parseOwnerKey(owner)
    const others = liveBrowserSessionCensus().filter(row => {
      if (row.owner === owner) return false
      const other = parseOwnerKey(row.owner)
      return other.workspace === identity.workspace && other.sessionId === identity.sessionId && other.lane !== 'main'
    })
    if (cap !== null && identity.lane !== 'main' && others.length >= cap) {
      const lanes = others.map(row => row.lane).join(', ')
      return {
        state: 'at-capacity',
        note: `${others.length} of ${cap} child browser sessions are live in this parent session (${lanes}); the lead has a separate slot. Close a finished session with op:"close", wait for its 5-minute idle lease to expire, or raise MERCURY_BROWSER_MAX_SESSIONS.`,
      }
    }
    const found = resolveBrowser()
    if (found.state === 'unavailable') {
      return { state: 'unavailable', note: `${found.note} — ${found.remedies.join('; ')}` }
    }
    resolution = found
  }
  const moving = state.tabs.get(tab) ?? null
  if (moving !== null) state.tabs.delete(tab)
  state.launching = true
  let unhanded: DriverBrowser | null = null
  let stray: Page | null = null
  let proxyClose: (() => void) | undefined
  let landed: Session | null = null
  try {
    if (moving !== null) await leaveHold(state, moving, true)
    let hold: Hold
    let page: Page
    let wiring: Wiring
    if (home !== null) {
      hold = home
      const made = await newHoldPage(hold)
      page = made.page
      wiring = made.wiring
      stray = page
    } else {
      const networkRefusal: Hold['networkRefusal'] = { count: 0, last: null }
      const relayFailures = new Map<string, { code: string; at: number }>()
      const relayFailureFor = (url: string): { code: string; at: number } | null => {
        let origin = ''
        try { origin = new URL(url).origin } catch (error) { passedOver(error); return null }
        const hit = relayFailures.get(url) ?? relayFailures.get(origin)
        if (hit === undefined || Date.now() - hit.at > 15_000) return null
        return hit
      }
      const launchArrivals: NonNullable<Hold['launchArrivals']> = { origins: new Set(), madeProfile: false }
      const proxy = await startMetadataProxy(
        reason => { networkRefusal.last = reason; networkRefusal.count++ },
        (target, code) => {
          relayFailures.set(target, { code, at: Date.now() })
          if (relayFailures.size > 32) relayFailures.delete(relayFailures.keys().next().value!)
        },
        origin => { launchArrivals.origins?.add(origin) },
      )
      proxyClose = proxy.close
      const launch: LaunchDriver =
        launchDriverForProof ?? (async options => (await import('puppeteer-core')).default.launch(options))
      const hostLang = resolveHostLanguages()
      const hostTimeZone = resolveHostTimeZone()
      const profileDir = profileOrigin ? browserProfileDirForOrigin(profileOrigin, owner) : null
      launchArrivals.madeProfile = profileDir === null || !fs.existsSync(profileDir)
      if (profileDir) {
        for (const other of [...state.holds]) {
          if (other.profileDir !== profileDir) continue
          const browser = other.browser
          holdGone(state, other, RESTARTED)
          await closeChild(browser)
        }
      }
      if (profileDir && launchDriverForProof === null) {
        readyProfileDir(owner, profileDir, opts)
      }
      const { launchArgs, sandboxDowngraded } = launchArgsFor(proxy, hostLang)
      const browser = await launch({
        executablePath: resolution!.executablePath,
        headless,
        protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
        env: subprocessEnv(),
        defaultViewport: { width: 1280, height: 800 },
        downloadBehavior: { policy: 'deny' },
        ignoreDefaultArgs: [
          '--enable-automation',
          '--disable-extensions',
          '--disable-default-apps',
          '--disable-component-extensions-with-background-pages',
        ],
        ...(profileDir ? { userDataDir: profileDir } : {}),
        args: launchArgs,
      })
      unhanded = browser
      const temp = tempProfileDirOf(browser)
      if (temp !== null) {
        tempProfiles.set(temp, browser)
        installExitHook()
      }
      const pages = await browser.pages()
      page = pages[0] ?? (await browser.newPage())
      const kit: PageKit = { cdp: null, identity: null, languages: hostLang.languages, timeZone: hostTimeZone, presented: null, born: null, fetchHeld: false }
      wiring = newWiring()
      const cdp =
        typeof page.createCDPSession === 'function' ? await page.createCDPSession().catch(passedOverAs(null)) : null
      kit.cdp = cdp
      await prepareDocuments(page, opts.births === true ? cdp : null, hostLang.languages)
      pageKits.set(page, kit)
      if (cdp !== null) {
        await cdp.send('Network.enable').catch(passedOverAs(undefined))
        listenProtocol(wiring, cdp)
        if (opts.downloads === undefined || opts.births !== true) await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }).catch(passedOverAs(undefined))
        await cdp.send('Emulation.setAutomationOverride', { enabled: false }).catch(passedOverAs(undefined))
        await cdp.send('Emulation.setTimezoneOverride', { timezoneId: hostTimeZone }).catch(passedOverAs(undefined))
        const rawUa = typeof browser.userAgent === 'function' ? await browser.userAgent().catch(passedOverAs('')) : ''
        const cleanUa = rawUa.replace(/HeadlessChrome\//g, 'Chrome/')
        if (cleanUa) {
          const versionStr = typeof browser.version === 'function' ? await browser.version().catch(passedOverAs('')) : ''
          kit.identity = identityOf(resolution, versionStr, cleanUa, hostLang)
          await cdp.send('Emulation.setUserAgentOverride', kit.identity).catch(passedOverAs(undefined))
        }
      }
      hold = {
        browser,
        attached: null,
        resolution: resolution!,
        sandboxDowngraded,
        profileOrigin,
        profileDir,
        headless,
        closeNetwork: proxy.close,
        networkRefusal,
        relayFailureFor,
        baseline: { identity: kit.identity, languages: hostLang.languages, timeZone: hostTimeZone, locale: null, headers: null, touch: false },
        tabs: new Set(),
        owned: new Map(),
        births: new Map(),
        died: new Map(),
        creating: 0,
        front: null,
        watch: null,
        birthsAsked: opts.births === true,
        downloads: null,
        arriving: new Map(),
        unwanted: new Set(),
        launchArrivals,
      }
    }
    const session = tabSession(state, hold, tab, page, wiring)
    listenPage(state, session, wiring)
    if (home === null) {
      if (typeof page.bringToFront === 'function') await page.bringToFront()
      if (opts.births === true) await watchBirths(state, hold, opts.downloads)
      const own = pageKits.get(page)?.cdp ?? null
      if (opts.births === true && own !== null) await watchFrames(pageKits.get(page)!, own)
      if (hold.downloads === null && own !== null) {
        if (opts.downloads !== undefined && opts.births === true) await own.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }).catch(passedOverAs(undefined))
        listenDownloads(wiring, own)
      }
    }
    if (state.disposed) {
      return {
        state: 'torn-down',
        note: 'the owner was torn down while its browser launch was in flight — the child was closed, nothing is open',
      }
    }
    state.goneAt = null
    if (home === null) {
      const browser = hold.browser
      browser.on('disconnected', () => holdGone(state, hold, EXITED))
      state.holds.add(hold)
    }
    hold.tabs.add(session)
    hold.front = session
    state.tabs.set(tab, session)
    state.ended.delete(tab)
    landed = session
    unhanded = null
    stray = null
  } finally {
    state.launching = false
    armIdleLease(state)
    if (unhanded !== null) await closeChild(unhanded)
    if (stray !== null) await closePage(stray)
    if (landed === null && moving !== null && state.tabs.size > 0) noteEnded(state, tab, MOVE_FAILED)
    if (state.tabs.size === 0) {
      state.approvedOrigins.clear()
      state.approvedSecretPairings.clear()
    }
    if (landed === null) proxyClose?.()
  }
  installExitHook()
  return landed
}

export async function closeBrowserSession(owner: OwnerKey): Promise<boolean> {
  const closed = await closeBrowserSessionDetailed(owner)
  return closed.outcome !== 'none'
}

export async function closeBrowserSessionDetailed(
  owner: OwnerKey,
  tab?: string,
): Promise<{ outcome: CloseOutcome | 'none'; closed: string[]; open: string[] }> {
  const state = ownerStates.peek(owner)
  if (!state) return { outcome: 'none', closed: [], open: [] }
  clearIdleLease(state)
  if (state.launchFlight !== null) await state.launchFlight.flight.catch(passedOverAs(undefined))
  if (tab === undefined) state.emulated.clear()
  else state.emulated.delete(tab)
  if (tab !== undefined && state.tabs.size > 0) {
    const session = state.tabs.get(tab)
    if (session === undefined || state.tabs.size > 1) {
      if (session !== undefined) {
        state.tabs.delete(tab)
        state.ended.delete(tab)
      }
      const outcome = session === undefined ? 'none' : await leaveHold(state, session)
      armIdleLease(state)
      return { outcome, closed: session === undefined ? [] : [tab], open: [...state.tabs.keys()] }
    }
  }
  if (state.tabs.size === 0) {
    if (state.goneAt === null) return { outcome: 'none', closed: [], open: [] }
    state.goneAt = null
    return { outcome: 'gone', closed: [], open: [] }
  }
  const closed = [...state.tabs.keys()]
  const holds = [...state.holds]
  for (const session of state.tabs.values()) session.left = true
  for (const hold of holds) {
    closeHoldNetwork(hold)
    endDownloads(state, hold)
  }
  const outcomes = await Promise.all(holds.map(hold => endHold(hold)))
  state.tabs.clear()
  state.holds.clear()
  await Promise.all(holds.map(hold => sweepDownloads(state, hold)))
  state.ended.clear()
  state.emulated.clear()
  state.popups = 0
  state.goneAt = null
  state.approvedOrigins.clear()
  state.approvedSecretPairings.clear()
  state.checkedActOrigin = null
  clearIdleLease(state)
  return { outcome: outcomes.includes('killed') ? 'killed' : outcomes.includes('unfinished') ? 'unfinished' : outcomes.includes('closed') ? 'closed' : outcomes.includes('detached') ? 'detached' : 'gone', closed, open: [] }
}
