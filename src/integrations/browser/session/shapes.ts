import type { Browser as DriverBrowser, CDPSession, Frame, Page, Protocol } from 'puppeteer-core'
import type { BrowserResolution } from '../browserResolver.js'
import type { Transfer, TransferBook } from '../browserTransfers.js'

export interface ConsoleEntry {
  at: number
  kind: string
  text: string
}

export const CONSOLE_RING_CAP = 250
export const CONSOLE_ENTRY_CAP = 300
export const MAIN_TAB = 'main'
export const ENDED_TABS_KEPT = 64
export const POPUP_NOTES_KEPT = 32
export const POPUP_SETTLE_MS = 3_000
export const FIRST_NAVIGATION_SILENCE_MS = 5_000
export const FIRST_NAVIGATION_STARTS = 4

interface NavFailure {
  url: string
  errorText: string
  at: number
}

export interface DownloadNotice {
  guid: string
  url: string
  filename: string
  bytes: number | null
  type: string | null
  at: number
  done: Promise<void>
  transfer: Transfer | null
}

export interface DownloadHome {
  home: string
  staging?: string
  claim: () => void
}

interface PopupNote {
  url: string
  tab: string | null
}

export function isBrowserErrorPage(url: string): boolean {
  return url.startsWith('chrome-error://')
}

export interface Wiring {
  consoleRing: ConsoleEntry[]
  nav: { seq: number; seen: number; web: number }
  popups: { count: number; last: string; log: PopupNote[]; waiters: Array<() => void> }
  navFailure: { last: NavFailure | null }
  policyBlocks: Map<string, { reason: string; at: number }>
  downloads: { count: number; last: DownloadNotice | null; waiters: Array<() => void>; late: Array<Transfer | string> }
  navWatch: { pendingUrl: string | null; frames: number; abortedAt: number; waiters: Array<() => void> }
  docResponses: Map<string, string | null>
  capture: (kind: string, text: string) => void
}

export interface Hold {
  browser: DriverBrowser
  resolution: BrowserResolution
  sandboxDowngraded: boolean
  profileOrigin: string | null
  profileDir: string | null
  headless: boolean
  closeNetwork: () => void
  networkRefusal: { count: number; last: string | null }
  relayFailureFor: (url: string) => { code: string; at: number } | null
  baseline: PagePresented
  tabs: Set<Session>
  owned: Map<string, Session>
  births: Map<string, Birth>
  died: Map<string, Birth>
  creating: number
  front: Session | null
  watch: CDPSession | null
  birthsAsked: boolean
  downloads: DownloadHome | null
  arriving: Map<string, { notice: DownloadNotice & { finish: () => void }; wiring: Wiring }>
  unwanted: Set<string>
  launchArrivals: { origins: Set<string> | null; madeProfile: boolean } | null
}

export interface Birth {
  cdp: CDPSession
  kit: PageKit
  wiring: Wiring
  opener: Session | null
  keep: boolean
  posted: boolean
  handover: () => void
  settled: Promise<void>
  settle: () => void
}

export interface Session {
  tab: string
  serial: number
  persist: boolean
  openedBy: { tab: string; op: string; posted: boolean } | null
  crashed: boolean
  acting: number
  actOp: string
  touched: boolean
  left: boolean
  opening: string | null
  browser: DriverBrowser
  page: Page
  resolution: BrowserResolution
  driverVersion: string
  consoleRing: ConsoleEntry[]
  nav: { seq: number; seen: number; web: number }
  sandboxDowngraded: boolean
  popups: { count: number; last: string; log: PopupNote[]; waiters: Array<() => void> }
  navFailure: { last: NavFailure | null }
  networkRefusal: { count: number; last: string | null }
  policyBlocks: Map<string, { reason: string; at: number }>
  closeNetwork: () => void
  downloads: { count: number; last: DownloadNotice | null; waiters: Array<() => void>; late: Array<Transfer | string> }
  navWatch: { pendingUrl: string | null; frames: number; abortedAt: number; waiters: Array<() => void> }
  profileOrigin: string | null
  profileDir: string | null
  headless: boolean
  cursor: { x: number; y: number }
}

export interface CheckedTarget {
  tab: string
  page: Page
  frame: Frame | null
}

export interface CheckedAct {
  op: string
  origin: string
  bound: CheckedTarget | null
}

export interface OwnerBrowserState {
  tabs: Map<string, Session>
  holds: Set<Hold>
  ended: Map<string, string>
  emulated: Map<string, Page>
  pages: number
  popups: number
  transfers: TransferBook
  launching: boolean
  launchFlight: { tab: string; flight: Promise<Session | EnsureSessionRefusal> } | null
  disposed: boolean
  approvedOrigins: Set<string>
  approvedSecretPairings: Set<string>
  checkedActOrigin: CheckedAct | null
  goneAt: number | null
  activeCalls: number
  idleTimer: ReturnType<typeof setTimeout> | null
}

export const BROWSER_CLOSE_BOUND_MS = 3_000
export const BROWSER_FINISH_BOUND_MS = 10_000
export const BROWSER_PROTOCOL_TIMEOUT_MS = 90_000
export const NAVIGATION_CAP_MS = BROWSER_PROTOCOL_TIMEOUT_MS
export const BROWSER_IDLE_MS = 300_000
export const EXITED = 'is gone (its browser process exited)'
export const IDLE_ENDED = 'was closed after 5 minutes idle'
export const SELF_CLOSED = 'closed itself (window.close)'
export const MOVE_FAILED = 'was closed for its move to another browser, which then failed'
export const RESTARTED = 'was closed when its browser restarted in another window mode'

export type EnsureSessionRefusal = { state: 'unavailable' | 'at-capacity' | 'torn-down'; note: string }

export interface EnsureBrowserSessionOptions {
  signal?: AbortSignal | undefined
  origin?: string | undefined
  headless?: boolean | undefined
  tab?: string | undefined
  births?: boolean | undefined
  downloads?: DownloadHome | undefined
}

export type PageIdentity = Protocol.Emulation.SetUserAgentOverrideRequest

export interface PagePresented {
  identity: PageIdentity | null
  languages: string[]
  timeZone: string
  locale: string | null
  headers: Record<string, string> | null
  touch: boolean
}

export interface PageKit {
  cdp: CDPSession | null
  identity: PageIdentity | null
  languages: string[]
  timeZone: string
  presented: PagePresented | null
  born: PagePresented | null
  fetchHeld: boolean
  firstRequestUnarmed?: boolean
  late?: CDPSession | null
  frames?: Map<string, { session: CDPSession; parent: string; target: string }>
}
