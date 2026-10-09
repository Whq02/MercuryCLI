
import { errorMessage } from '../errors.js'
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


const ENTRIES_MAX = 24


let entries: ConsoleEntry[] = []
let entrySeq = 0
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


export function getConsolePending(): { question: string; startedAt: number } | null {
  return pendingPublic
}

export function getConsoleEntries(): readonly ConsoleEntry[] {
  return entries
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

export function consoleAsk(question: string, run: ConsoleRunner): boolean {
  return startAsk(question, run)
}

export function consoleClear(): boolean {
  const had = entries.length > 0 || pendingAsk !== null
  if (pendingAsk) {
    pendingAsk.controller.abort()
    recordAskOutcome(pendingAsk.id, { kind: 'dismissed' })
    pendingAsk = null
    pendingPublic = null
  }
  entries = []
  if (had) notify()
  return had
}


export function resetConsoleForTest(): void {
  entries = []
  entrySeq = 0
  pendingAsk?.controller.abort()
  pendingAsk = null
  pendingPublic = null
  conversationMints.clear()
  version = 0
}
