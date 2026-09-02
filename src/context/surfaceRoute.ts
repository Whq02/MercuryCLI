
import { flagSpellings } from '../substrate/flagRegistry.js'
import { currentInputEventSeq, markInputConsumedThroughCurrentSeq } from '../ink/events/input-event.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { keyHintLabel } from '../components/mercury-ui/keyHintLabel.js'
import { concourseEnabled } from '../services/concourse/concourseEnabled.js'

export type SurfaceKind = 'repl' | 'boot-settings' | 'concourse' | 'session'

export type SurfaceTransitionVerb = 'PUSH' | 'RETURN' | 'HOME' | 'INIT'

export interface SurfaceTransitionRecord {
  readonly verb: SurfaceTransitionVerb
  readonly from: string
  readonly to: string
  readonly generation: number
  readonly commitSeq: number
}

export type SurfaceRoute =
  | { readonly kind: 'repl' }
  | { readonly kind: 'boot-settings' }
  | { readonly kind: 'concourse' }
  | { readonly kind: 'session'; readonly sessionId: string }

export const ROOT_REPL_ROUTE: SurfaceRoute = { kind: 'repl' }

export function surfaceRouteId(route: SurfaceRoute): string {
  return route.kind === 'session' ? `session:${route.sessionId}` : route.kind
}

export interface SurfaceReturnToken {
  readonly to: SurfaceRoute
  readonly nonce: number
}

export type SurfaceTransition =
  | { ok: true; token: SurfaceReturnToken }
  | { ok: false; code: 'surface-unregistered' | 'already-current' | 'invalid-target'; reason: string }


export interface RouteSurfaceEntry {
  render: (route: SurfaceRoute) => import('react').ReactNode
  frame?: 'inherit'
}

const registry = new Map<SurfaceKind, RouteSurfaceEntry>()

export function registerRouteSurface(kind: Exclude<SurfaceKind, 'repl'>, entry: RouteSurfaceEntry): () => void {
  registry.set(kind, entry)
  bump()
  return () => {
    if (registry.get(kind) === entry) {
      registry.delete(kind)
      bump()
    }
  }
}

export function routeSurfaceRegistered(kind: SurfaceKind): boolean {
  return kind === 'repl' ? true : registry.has(kind)
}

export function getRouteSurface(kind: SurfaceKind): RouteSurfaceEntry | undefined {
  return kind === 'repl' ? undefined : registry.get(kind)
}


let current: SurfaceRoute = ROOT_REPL_ROUTE
let returnStack: SurfaceReturnToken[] = []
let nextNonce = 1
let version = 0
let generation = 0
let lastTransition: SurfaceTransitionRecord = {
  verb: 'INIT',
  from: 'repl',
  to: 'repl',
  generation: 0,
  commitSeq: 0,
}
const listeners = new Set<() => void>()

function commitTransition(verb: SurfaceTransitionVerb, from: SurfaceRoute, to: SurfaceRoute): void {
  generation += 1
  lastTransition = {
    verb,
    from: surfaceRouteId(from),
    to: surfaceRouteId(to),
    generation,
    commitSeq: currentInputEventSeq(),
  }
  markInputConsumedThroughCurrentSeq()
}

export function surfaceGeneration(): number {
  return generation
}

export function lastSurfaceTransition(): SurfaceTransitionRecord {
  return lastTransition
}

export function isPriorGenerationInput(eventSeq: number): boolean {
  return eventSeq <= lastTransition.commitSeq
}

export function consumeEntryDecisionInput(): void {
  markInputConsumedThroughCurrentSeq()
}

function bump(): void {
  version += 1
  for (const cb of listeners) {
    try {
      cb()
    } catch {
    }
  }
}

export function subscribeSurfaceRoute(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function surfaceRouteVersion(): number {
  return version
}

export function currentSurfaceRoute(): SurfaceRoute {
  return current
}

function enter(target: SurfaceRoute): SurfaceTransition {
  if (surfaceRouteId(target) === surfaceRouteId(current)) {
    return { ok: false, code: 'already-current', reason: `already on ${surfaceRouteId(current)}` }
  }
  if (!routeSurfaceRegistered(target.kind)) {
    return {
      ok: false,
      code: 'surface-unregistered',
      reason: `the ${target.kind} surface is not registered in this build — the route exists as a typed target only`,
    }
  }
  const token: SurfaceReturnToken = { to: current, nonce: nextNonce++ }
  returnStack.push(token)
  const from = current
  current = target
  commitTransition('PUSH', from, target)
  bump()
  return { ok: true, token }
}

export function enterBootSettings(): SurfaceTransition {
  return enter({ kind: 'boot-settings' })
}

export function enterConcourse(): SurfaceTransition {
  return enter({ kind: 'concourse' })
}

export function enterSessionRepl(sessionId: string): SurfaceTransition {
  if (sessionId.length === 0) {
    return { ok: false, code: 'invalid-target', reason: 'a session route needs a session id' }
  }
  return enter({ kind: 'session', sessionId })
}

export function returnToConcourse(): SurfaceTransition {
  return enter({ kind: 'concourse' })
}


export type ChatEntry = { ok: true } | { ok: false; code: 'no-chat'; reason: string }

export function enterRootRepl(): ChatEntry {
  if (!chatPresent()) {
    return { ok: false, code: 'no-chat', reason: NO_CHAT_HINT }
  }
  if (current.kind !== 'repl' || returnStack.length > 0) {
    const from = current
    current = ROOT_REPL_ROUTE
    returnStack = []
    commitTransition('HOME', from, ROOT_REPL_ROUTE)
    bump()
  }
  return { ok: true }
}

export function returnFromSurface(token: SurfaceReturnToken): { ok: boolean } {
  const top = returnStack[returnStack.length - 1]
  if (!top || top.nonce !== token.nonce) return { ok: false }
  if (top.to.kind === 'repl' && !chatPresent()) return { ok: false }
  returnStack.pop()
  const from = current
  current = top.to
  commitTransition('RETURN', from, top.to)
  bump()
  return { ok: true }
}

export function settleAbsentChat(): { ok: boolean } {
  if (current.kind !== 'repl' || chatPresent() || !routeSurfaceRegistered('boot-settings')) return { ok: false }
  const from = current
  current = { kind: 'boot-settings' }
  returnStack = []
  commitTransition('PUSH', from, current)
  bump()
  return { ok: true }
}

export function activeReturnToken(): SurfaceReturnToken | null {
  return returnStack[returnStack.length - 1] ?? null
}

export function leaveCurrentSurface(): { ok: boolean } {
  const top = activeReturnToken()
  return top ? returnFromSurface(top) : { ok: false }
}


export type StripStop = 'boot-settings' | 'concourse' | 'repl'
export const STRIP_ORDER: readonly StripStop[] = ['boot-settings', 'concourse', 'repl']

export interface StripFacts {
  readonly concourseEnabled: boolean
  readonly chatBoot: boolean
  readonly chatPresent: boolean
}

export function chatOnlyBootOf(facts: Pick<StripFacts, 'concourseEnabled' | 'chatBoot'>): boolean {
  return facts.chatBoot || !facts.concourseEnabled
}

export function stripStops(facts: StripFacts): StripStop[] {
  const stops: StripStop[] = ['boot-settings']
  if (facts.concourseEnabled && !facts.chatBoot) stops.push('concourse')
  if (facts.chatPresent) stops.push('repl')
  return stops
}

export type StripDirection = 'left' | 'right'
export type StripMove = { readonly to: StripStop } | { readonly to: null; readonly hint: string | null }

export const NO_CHAT_HINT = 'no chat open'

export function stripMove(at: SurfaceKind, dir: StripDirection, present: readonly StripStop[]): StripMove {
  const from = STRIP_ORDER.indexOf(at === 'session' ? 'concourse' : at)
  const step = dir === 'right' ? 1 : -1
  for (let i = from + step; i >= 0 && i < STRIP_ORDER.length; i += step) {
    const stop = STRIP_ORDER[i]!
    if (present.includes(stop)) return { to: stop }
  }
  const chatMissingAhead = dir === 'right' && at !== 'repl' && !present.includes('repl')
  return { to: null, hint: chatMissingAhead ? NO_CHAT_HINT : null }
}

const STOP_NAMES: Readonly<Record<StripStop, string>> = { 'boot-settings': 'boot face', concourse: 'concourse', repl: 'chat' }

export function stripKeyMapHintOf(at: SurfaceKind, present: readonly StripStop[]): string {
  const parts: string[] = []
  const left = stripMove(at, 'left', present)
  if (left.to !== null) parts.push(`${keyHintLabel('⇧←')} ${STOP_NAMES[left.to]}`)
  const right = stripMove(at, 'right', present)
  if (right.to !== null) parts.push(`${keyHintLabel('⇧→')} ${STOP_NAMES[right.to]}`)
  else if (right.hint !== null) parts.push(`${keyHintLabel('⇧→')} ${right.hint}`)
  return parts.join(' · ')
}

export interface ChatPresenceSeam {
  present: () => boolean
  subscribe: (listener: () => void) => () => void
}
let chatPresence: ChatPresenceSeam | null = null
let unsubscribeChatPresence: (() => void) | null = null
export function registerChatPresence(seam: ChatPresenceSeam): () => void {
  unsubscribeChatPresence?.()
  chatPresence = seam
  unsubscribeChatPresence = seam.subscribe(bump)
  bump()
  return () => {
    if (chatPresence !== seam) return
    unsubscribeChatPresence?.()
    unsubscribeChatPresence = null
    chatPresence = null
    bump()
  }
}

export function chatPresent(): boolean {
  return chatPresence?.present() ?? false
}

let chatBoot = false
export function markChatBoot(): void {
  chatBoot = true
  bump()
}

export function chatOnlyBoot(): boolean {
  return chatOnlyBootOf({ concourseEnabled: concourseEnabled(), chatBoot })
}

export type PlainWorldWhy = '--chat' | 'concourse off' | '--chat · concourse off'
export function plainWorldWhyOf(facts: Pick<StripFacts, 'concourseEnabled' | 'chatBoot'>): PlainWorldWhy | null {
  if (facts.chatBoot && !facts.concourseEnabled) return '--chat · concourse off'
  if (facts.chatBoot) return '--chat'
  if (!facts.concourseEnabled) return 'concourse off'
  return null
}
export function plainWorldWhy(): PlainWorldWhy | null {
  return plainWorldWhyOf({ concourseEnabled: concourseEnabled(), chatBoot })
}

export function concourseOffSentenceOf(facts: Pick<StripFacts, 'concourseEnabled' | 'chatBoot'>): string | null {
  const why = plainWorldWhyOf(facts)
  if (why === null) return null
  return `the Session Concourse is off in this boot (${why}) — ${concourseWayBackOf(facts)}`
}
export function concourseOffSentence(): string | null {
  return concourseOffSentenceOf({ concourseEnabled: concourseEnabled(), chatBoot })
}

export function concourseWayBackOf(facts: Pick<StripFacts, 'concourseEnabled'>): string {
  return facts.concourseEnabled ? 'a plain `mercury` boot has it' : '`mercury --concourse-on` or /config turns it back'
}
export function concourseWayBack(): string {
  return concourseWayBackOf({ concourseEnabled: concourseEnabled() })
}

export function stripFacts(): StripFacts {
  return { concourseEnabled: concourseEnabled(), chatBoot, chatPresent: chatPresent() }
}

export function presentStripStops(): StripStop[] {
  return stripStops(stripFacts()).filter(stop => routeSurfaceRegistered(stop))
}

export function stripKeyMapHint(): string {
  return stripKeyMapHintOf(current.kind, presentStripStops())
}

export type StripOutcome = { ok: true; moved: boolean; hint: string | null } | { ok: false; reason: string }

export function cycleSurface(dir: 1 | -1): StripOutcome {
  if (!isFullscreenEnvEnabled()) {
    return {
      ok: false,
      reason:
        'the surface strip needs the fullscreen surface (MERCURY_FULLSCREEN=0 boots have no frame to claim) — the standalone Boot Menu on the next launch carries the same rows',
    }
  }
  const move = stripMove(current.kind, dir === 1 ? 'left' : 'right', presentStripStops())
  if (move.to === null) return { ok: true, moved: false, hint: move.hint }
  const from = current
  current = move.to === 'repl' ? ROOT_REPL_ROUTE : ({ kind: move.to } as SurfaceRoute)
  returnStack = []
  commitTransition(move.to === 'repl' ? 'HOME' : 'PUSH', from, current)
  bump()
  return { ok: true, moved: true, hint: null }
}


export type ConcoursePolicy = 'off' | 'auto' | 'always'

export function resolveConcoursePolicy(env: NodeJS.ProcessEnv = process.env): ConcoursePolicy {
  let raw: string | undefined
  for (const spelling of flagSpellings('MERCURY_CONCOURSE')) {
    raw = env[spelling]
    if (raw !== undefined) break
  }
  return raw === 'auto' || raw === 'always' ? raw : 'off'
}

export interface InitialSurfaceResolution {
  requested: SurfaceRoute
  effective: SurfaceRoute
  policy: ConcoursePolicy
  reason:
    | 'concourse-off'
    | 'always'
    | 'auto-live-sessions'
    | 'auto-needs-you'
    | 'auto-idle'
    | 'splash-intent'
    | 'face-door-intent'
    | 'boot-menu-landing'
    | 'concourse-surface-unregistered'
  liveWorkers?: number
}

export async function resolveInitialSurface(
  opts: { env?: NodeJS.ProcessEnv; recordsDir?: string } = {},
): Promise<InitialSurfaceResolution> {
  const policy = stripStops(stripFacts()).includes('concourse') ? resolveConcoursePolicy(opts.env) : 'off'
  let bootMenuArmed = false
  try {
    const handover = await import('../substrate/splashHandover.js')
    const { isFullscreenEnvEnabled } = await import('../utils/fullscreen.js')
    const intent = handover.consumeBootSurfaceIntent()
    if (intent === 'repl') {
      void import('../substrate/launchMilestones.js')
        .then(m => m.recordLaunchMilestone('route-ready'))
        .catch(() => {})
      return { requested: ROOT_REPL_ROUTE, effective: ROOT_REPL_ROUTE, policy, reason: 'splash-intent' }
    }
    if (intent === 'concourse' && isFullscreenEnvEnabled()) {
      const requested: SurfaceRoute = { kind: 'concourse' }
      void import('../substrate/launchMilestones.js')
        .then(m => m.recordLaunchMilestone('route-ready'))
        .catch(() => {})
      if (!routeSurfaceRegistered('concourse')) {
        return { requested, effective: ROOT_REPL_ROUTE, policy, reason: 'concourse-surface-unregistered' }
      }
      return { requested, effective: requested, policy, reason: 'splash-intent' }
    }
    if (handover.peekFaceDoorDeepLink() !== null && isFullscreenEnvEnabled() && routeSurfaceRegistered('boot-settings')) {
      const requested: SurfaceRoute = { kind: 'boot-settings' }
      void import('../substrate/launchMilestones.js')
        .then(m => m.recordLaunchMilestone('route-ready'))
        .catch(() => {})
      return { requested, effective: requested, policy, reason: 'face-door-intent' }
    }
    bootMenuArmed = !handover.bootJourneyIsExplicit() && isFullscreenEnvEnabled() && routeSurfaceRegistered('boot-settings')
  } catch {
  }
  const bootMenuLanding = (): InitialSurfaceResolution => {
    const requested: SurfaceRoute = { kind: 'boot-settings' }
    void import('../substrate/launchMilestones.js')
      .then(m => m.recordLaunchMilestone('route-ready'))
      .catch(() => {})
    return { requested, effective: requested, policy, reason: 'boot-menu-landing' }
  }
  if (policy === 'off') {
    if (bootMenuArmed) return bootMenuLanding()
    return { requested: ROOT_REPL_ROUTE, effective: ROOT_REPL_ROUTE, policy, reason: 'concourse-off' }
  }
  const concourse: SurfaceRoute = { kind: 'concourse' }
  const settle = (requested: SurfaceRoute, reason: InitialSurfaceResolution['reason'], liveWorkers?: number): InitialSurfaceResolution => {
    void import('../substrate/launchMilestones.js')
      .then(m => m.recordLaunchMilestone('route-ready'))
      .catch(() => {})
    if (requested.kind !== 'repl' && !routeSurfaceRegistered(requested.kind)) {
      return {
        requested,
        effective: ROOT_REPL_ROUTE,
        policy,
        reason: 'concourse-surface-unregistered',
        ...(liveWorkers !== undefined ? { liveWorkers } : {}),
      }
    }
    return { requested, effective: requested, policy, reason, ...(liveWorkers !== undefined ? { liveWorkers } : {}) }
  }
  if (policy === 'always') return settle(concourse, 'always')
  let live = 0
  try {
    const supervisor = await import('../daemon/concourseSupervisor.js')
    live = supervisor.countLiveConcourseWorkers(opts.recordsDir)
  } catch {
    live = 0
  }
  if (live > 1) return settle(concourse, 'auto-live-sessions', live)
  try {
    const obligations = await import('../services/crew/obligations.js')
    const open = await obligations.openObligations({ scope: 'switchboard' })
    if (open.length > 0) return settle(concourse, 'auto-needs-you', live)
  } catch {
  }
  if (bootMenuArmed) return bootMenuLanding()
  return settle(ROOT_REPL_ROUTE, 'auto-idle', live)
}

export function initializeSurfaceRoute(initial: SurfaceRoute): void {
  const from = current
  current = routeSurfaceRegistered(initial.kind) ? initial : ROOT_REPL_ROUTE
  returnStack = []
  commitTransition('INIT', from, current)
  bump()
}

export function _resetSurfaceRouteForTesting(): void {
  current = ROOT_REPL_ROUTE
  returnStack = []
  registry.clear()
  generation = 0
  lastTransition = { verb: 'INIT', from: 'repl', to: 'repl', generation: 0, commitSeq: 0 }
  unsubscribeChatPresence?.()
  unsubscribeChatPresence = null
  chatPresence = null
  chatBoot = false
  bump()
}
