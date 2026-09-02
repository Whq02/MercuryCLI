
import { errorMessage } from '../errors.js'
import { getHelmFocus, subscribeHelmFocus } from './helmFocus.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function consoleEnabled(): boolean {
  return flagEnv('MERCURY_HELM_CONSOLE') !== '0'
}


export type ConsoleUsage = {
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
}

export type ConsoleEntry = {
  id: number
  question: string
  askedAt: number
  durationMs?: number
  answer?: string
  error?: string
  usage?: ConsoleUsage
  originRef?: string
  conversationId?: string
}

export type ConsoleRunnerResult = {
  response: string | null
  originRef?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

export type ConsoleRunner = (
  question: string,
  abortController: AbortController,
) => Promise<ConsoleRunnerResult>


const BUFFER_MAX = 2000
const ENTRIES_MAX = 24
const HISTORY_MAX = 50


let composing = false
let buffer: string[] = []
let cursor = 0
let draft: string[] = []
let histIdx: number | null = null
let history: string[] = []
let entries: ConsoleEntry[] = []
let entrySeq = 0
let askCount = 0
let pendingAsk: {
  id: number
  question: string
  startedAt: number
  controller: AbortController
} | null = null
let pendingPublic: { question: string; startedAt: number } | null = null

let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version++
  for (const l of listeners) l()
}

const conversationMints = new Map<number, Promise<string | null>>()

function mintAskConversation(id: number, question: string): void {
  const mint = (async (): Promise<string | null> => {
    const { crewDirectoryEnabled } = await import('../../services/crew/identity.js')
    if (!crewDirectoryEnabled()) return null
    const [{ openSideConversation }, { operatorPrincipal }] = await Promise.all([
      import('../../services/crew/consoleHandoff.js'),
      import('../../substrate/identity/identity.js'),
    ])
    const conversation = await openSideConversation({
      question,
      askedBy: { kind: 'operator', principalId: operatorPrincipal().id },
    })
    const e = entries.find(x => x.id === id)
    if (e) {
      e.conversationId = conversation.conversationId
      notify()
    }
    return conversation.conversationId
  })().catch(() => null)
  conversationMints.set(id, mint)
}

function recordAskOutcome(
  id: number,
  outcome:
    | { kind: 'answered'; response: string; ref?: string }
    | { kind: 'failed'; reason: string }
    | { kind: 'dismissed' },
): void {
  const mint = conversationMints.get(id)
  conversationMints.delete(id)
  if (!mint) return
  void mint
    .then(async conversationId => {
      if (!conversationId) return
      const { recordSideOutcome } = await import('../../services/crew/consoleHandoff.js')
      await recordSideOutcome(conversationId as never, outcome)
    })
    .catch(() => {
    })
}

export function subscribeConsole(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getConsoleVersion(): number {
  return version
}


let unsubFocus: (() => void) | null = null

function armFocusWatch(): void {
  if (unsubFocus) return
  unsubFocus = subscribeHelmFocus(() => {
    if (composing && getHelmFocus() !== 'telemetry') exitConsoleCompose()
  })
}

function disarmFocusWatch(): void {
  if (!unsubFocus) return
  unsubFocus()
  unsubFocus = null
}


export function isConsoleComposing(): boolean {
  return composing
}

export function getConsoleBuffer(): string {
  return buffer.join('')
}

export function getConsoleCursor(): number {
  return cursor
}

export function isConsoleRecalling(): boolean {
  return histIdx !== null
}

export function getConsolePending(): { question: string; startedAt: number } | null {
  return pendingPublic
}

export function getConsoleEntries(): readonly ConsoleEntry[] {
  return entries
}

export function getConsoleAskCount(): number {
  return askCount
}


export function beginConsoleCompose(seed?: string): void {
  if (composing && seed === undefined) return
  composing = true
  if (seed !== undefined) {
    insertRaw(seed)
  }
  armFocusWatch()
  notify()
}

export function exitConsoleCompose(): void {
  if (!composing) return
  composing = false
  histIdx = null
  disarmFocusWatch()
  notify()
}


function insertRaw(s: string): void {
  const clean = Array.from(
    s.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ''),
  )
  const room = BUFFER_MAX - buffer.length
  if (room <= 0) return
  const ins = clean.slice(0, room)
  buffer.splice(cursor, 0, ...ins)
  cursor += ins.length
  histIdx = null
}

export function consoleInsert(s: string): void {
  if (!composing || !s) return
  insertRaw(s)
  notify()
}

export function consoleBackspace(): void {
  if (!composing || cursor === 0) return
  buffer.splice(cursor - 1, 1)
  cursor--
  histIdx = null
  notify()
}

export function consoleDeleteForward(): void {
  if (!composing || cursor >= buffer.length) return
  buffer.splice(cursor, 1)
  histIdx = null
  notify()
}

export function consoleMoveCursor(delta: number): void {
  if (!composing) return
  const next = Math.max(0, Math.min(buffer.length, cursor + delta))
  if (next === cursor) return
  cursor = next
  notify()
}

export function consoleCursorHome(): void {
  if (!composing || cursor === 0) return
  cursor = 0
  notify()
}

export function consoleCursorEnd(): void {
  if (!composing || cursor === buffer.length) return
  cursor = buffer.length
  notify()
}

export function consoleKillLine(): void {
  if (!composing || buffer.length === 0) return
  buffer = []
  cursor = 0
  histIdx = null
  notify()
}

export function consoleKillWord(): void {
  if (!composing || cursor === 0) return
  let i = cursor
  while (i > 0 && buffer[i - 1] === ' ') i--
  while (i > 0 && buffer[i - 1] !== ' ') i--
  buffer.splice(i, cursor - i)
  cursor = i
  histIdx = null
  notify()
}


function pushHistory(q: string): void {
  if (history[history.length - 1] === q) return
  history.push(q)
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX)
}

export function consoleHistoryMove(dir: -1 | 1): void {
  if (!composing || history.length === 0) return
  if (dir === -1) {
    if (histIdx === null) {
      draft = buffer
      histIdx = history.length - 1
    } else if (histIdx > 0) {
      histIdx--
    } else {
      return
    }
    buffer = Array.from(history[histIdx] ?? '')
    cursor = buffer.length
    notify()
    return
  }
  if (histIdx === null) return
  if (histIdx < history.length - 1) {
    histIdx++
    buffer = Array.from(history[histIdx] ?? '')
  } else {
    histIdx = null
    buffer = draft
    draft = []
  }
  cursor = buffer.length
  notify()
}


function normalizeUsage(u: ConsoleRunnerResult['usage']): ConsoleUsage | undefined {
  if (!u) return undefined
  return {
    in: u.input_tokens ?? 0,
    out: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  }
}

function settle(id: number, res: ConsoleRunnerResult | undefined, err: unknown): void {
  if (pendingAsk?.id !== id) return
  const startedAt = pendingAsk.startedAt
  pendingAsk = null
  pendingPublic = null
  const e = entries.find(x => x.id === id)
  if (!e) {
    notify()
    return
  }
  e.durationMs = Date.now() - startedAt
  if (err !== undefined) {
    e.error = errorMessage(err) || 'Failed to get response'
    recordAskOutcome(id, { kind: 'failed', reason: e.error })
  } else if (res?.response) {
    e.answer = res.response
    e.usage = normalizeUsage(res.usage)
    if (res.originRef !== undefined) e.originRef = res.originRef
    recordAskOutcome(id, {
      kind: 'answered',
      response: res.response,
      ...(res.originRef !== undefined ? { ref: res.originRef } : {}),
    })
  } else {
    e.error = 'No response received'
    recordAskOutcome(id, { kind: 'failed', reason: e.error })
  }
  notify()
}

export const CONSOLE_COMPACT_TRUTH =
  `the console shares the main chat's context — /compact there relieves both; ` +
  `this shelf keeps the last ${ENTRIES_MAX} asks, and /clear empties it`

function reliefVerb(q: string): boolean {
  if (q !== '/clear' && q !== '/compact') return false
  if (q === '/clear') {
    consoleClear()
    return true
  }
  const id = ++entrySeq
  entries.push({ id, question: q, askedAt: Date.now(), durationMs: 0, answer: CONSOLE_COMPACT_TRUTH })
  if (entries.length > ENTRIES_MAX) entries = entries.slice(-ENTRIES_MAX)
  pushHistory(q)
  buffer = []
  cursor = 0
  draft = []
  histIdx = null
  notify()
  return true
}

function startAsk(question: string, run: ConsoleRunner): boolean {
  if (!consoleEnabled()) return false
  const q = question.trim()
  if (!q) return false
  if (reliefVerb(q)) return true
  if (pendingAsk) return false
  const id = ++entrySeq
  entries.push({ id, question: q, askedAt: Date.now() })
  if (entries.length > ENTRIES_MAX) entries = entries.slice(-ENTRIES_MAX)
  mintAskConversation(id, q)
  pushHistory(q)
  askCount++
  buffer = []
  cursor = 0
  draft = []
  histIdx = null
  const controller = new AbortController()
  const startedAt = Date.now()
  pendingAsk = { id, question: q, startedAt, controller }
  pendingPublic = { question: q, startedAt }
  notify()
  run(q, controller).then(
    res => settle(id, res, undefined),
    err => settle(id, undefined, err),
  )
  return true
}

export function consoleSubmitBuffer(run: ConsoleRunner): boolean {
  if (!composing) return false
  return startAsk(buffer.join(''), run)
}

export function consoleAsk(question: string, run: ConsoleRunner): boolean {
  return startAsk(question, run)
}

export function consoleAbortAsk(): boolean {
  if (!pendingAsk) return false
  const { id, controller, question } = pendingAsk
  pendingAsk = null
  pendingPublic = null
  controller.abort()
  recordAskOutcome(id, { kind: 'dismissed' })
  const idx = entries.findIndex(e => e.id === id)
  if (idx >= 0) entries.splice(idx, 1)
  buffer = Array.from(question)
  cursor = buffer.length
  histIdx = null
  composing = true
  armFocusWatch()
  notify()
  return true
}

export function consoleClear(): boolean {
  const had =
    entries.length > 0 ||
    history.length > 0 ||
    buffer.length > 0 ||
    pendingAsk !== null
  if (pendingAsk) {
    pendingAsk.controller.abort()
    recordAskOutcome(pendingAsk.id, { kind: 'dismissed' })
    pendingAsk = null
    pendingPublic = null
  }
  entries = []
  history = []
  buffer = []
  cursor = 0
  draft = []
  histIdx = null
  askCount = 0
  if (had) notify()
  return had
}


export function resetConsoleForTest(): void {
  composing = false
  buffer = []
  cursor = 0
  draft = []
  histIdx = null
  history = []
  entries = []
  entrySeq = 0
  askCount = 0
  pendingAsk?.controller.abort()
  pendingAsk = null
  pendingPublic = null
  conversationMints.clear()
  disarmFocusWatch()
  version = 0
}
