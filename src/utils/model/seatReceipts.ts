import { daemonRosterSnapshot } from '../cockpit/daemonRosterSnapshot.js'
import { resolveOpenaiAccount } from '../../services/providers/openai/openaiAccounts.js'
import { providerFamilyOfSetting } from './modelTransition.js'
import type { SlotRole } from './seatSlotStore.js'

export type SeatReceipt = {
  text: string
  level: 'info' | 'warning'
}

export type ReslotExpectation = {
  role: SlotRole
  model?: string
  effort?: string
  registeredAt: number
}

export const RESLOT_RECEIPT_DEADLINE_MS = 10 * 60_000

const RECEIPT_QUEUE_CAP = 20
const OBSERVER_TICK_MS = 5_000

export function expectationSatisfied(
  exp: Pick<ReslotExpectation, 'model' | 'effort'>,
  truth: { model?: string; effort?: string },
): boolean {
  const mOk = exp.model === undefined || truth.model === exp.model
  const eOk = exp.effort === undefined || truth.effort === exp.effort
  return mOk && eOk
}

export function seatBackendNote(model: string | undefined): string {
  if (!model) return ''
  const family = providerFamilyOfSetting(model)
  if (family === 'openai') {
    let source: string | undefined
    try {
      source = resolveOpenaiAccount()?.label
    } catch {
      source = undefined
    }
    return ` · backend: native OpenAI Responses · ${source ?? 'NO OpenAI account connected — /logins before this seat can serve'}`
  }
  if (family === 'zai') return ' · backend: native Z.AI'
  return ''
}

export function composeAppliedReceipt(exp: Pick<ReslotExpectation, 'role' | 'model' | 'effort'>): string {
  const parts = [exp.model, exp.effort ? `@${exp.effort}` : undefined].filter(Boolean).join(' ')
  return `⇄ reslot applied — ${exp.role} → ${parts || 'spec'}${seatBackendNote(exp.model)}`
}

export function composeTimeoutReceipt(exp: Pick<ReslotExpectation, 'role' | 'model' | 'effort'>): string {
  const parts = [exp.model, exp.effort ? `@${exp.effort}` : undefined].filter(Boolean).join(' ')
  return `▲ reslot pending — ${exp.role} → ${parts || 'spec'} not observed applied after 10m (seat busy or daemon down — check /daemon)`
}


const expectations: ReslotExpectation[] = []
const queue: SeatReceipt[] = []
const listeners = new Set<(r: SeatReceipt) => void>()

function emit(r: SeatReceipt): void {
  if (listeners.size === 0) {
    queue.push(r)
    if (queue.length > RECEIPT_QUEUE_CAP) queue.shift()
    return
  }
  for (const l of listeners) l(r)
}

export function subscribeSeatReceipts(cb: (r: SeatReceipt) => void): () => void {
  listeners.add(cb)
  while (queue.length > 0) {
    const r = queue.shift()!
    for (const l of listeners) l(r)
  }
  return () => {
    listeners.delete(cb)
  }
}

export function mintImmediateReceipt(text: string, level: SeatReceipt['level'] = 'info'): void {
  emit({ text, level })
}


let implementerTimer: ReturnType<typeof setInterval> | null = null
let deadlineTimer: ReturnType<typeof setInterval> | null = null

function settle(exp: ReslotExpectation, receipt: SeatReceipt): void {
  const i = expectations.indexOf(exp)
  if (i < 0) return
  expectations.splice(i, 1)
  emit(receipt)
  rearmObservers()
}

async function pollImplementer(): Promise<void> {
  if (!expectations.some(e => e.role === 'implementer')) return
  const snap = await daemonRosterSnapshot('implementer').catch(() => null)
  if (!snap?.ok || !snap.entry) return
  const truth = { model: snap.entry.model, effort: snap.entry.effort }
  for (const exp of [...expectations]) {
    if (exp.role !== 'implementer') continue
    if (expectationSatisfied(exp, truth)) {
      settle(exp, { text: composeAppliedReceipt(exp), level: 'info' })
    }
  }
}

function sweepDeadlines(): void {
  const now = Date.now()
  for (const exp of [...expectations]) {
    if (now - exp.registeredAt >= RESLOT_RECEIPT_DEADLINE_MS) {
      settle(exp, { text: composeTimeoutReceipt(exp), level: 'warning' })
    }
  }
}

function rearmObservers(): void {
  const wantImplementer = expectations.some(e => e.role === 'implementer')
  const wantDeadline = expectations.length > 0
  if (wantImplementer && implementerTimer === null) {
    void pollImplementer()
    implementerTimer = setInterval(() => void pollImplementer(), OBSERVER_TICK_MS)
    implementerTimer.unref?.()
  } else if (!wantImplementer && implementerTimer !== null) {
    clearInterval(implementerTimer)
    implementerTimer = null
  }
  if (wantDeadline && deadlineTimer === null) {
    deadlineTimer = setInterval(sweepDeadlines, OBSERVER_TICK_MS)
    deadlineTimer.unref?.()
  } else if (!wantDeadline && deadlineTimer !== null) {
    clearInterval(deadlineTimer)
    deadlineTimer = null
  }
}

export function registerReslotExpectation(exp: Omit<ReslotExpectation, 'registeredAt'>): void {
  for (let i = expectations.length - 1; i >= 0; i--) {
    if (expectations[i]!.role === exp.role) expectations.splice(i, 1)
  }
  expectations.push({ ...exp, registeredAt: Date.now() })
  rearmObservers()
}

export function __sweepDeadlinesForTests(): void {
  sweepDeadlines()
}

export function __resetSeatReceiptsForTests(): void {
  expectations.length = 0
  queue.length = 0
  listeners.clear()
  rearmObservers()
}

export function __pendingExpectationsForTests(): readonly ReslotExpectation[] {
  return [...expectations]
}
