;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Message } from '../../src/types/message.ts'

const home = mkdtempSync(join(tmpdir(), 'fold-breaker-answers-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY ??= 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
delete process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const auto = await import('../../src/services/compact/autoCompact.ts') as Record<string, unknown>
const { autoCompactIfNeeded, rapidRefillCount, AUTOCOMPACT_THRASH_MESSAGE, getAutoCompactThreshold } = auto as {
  autoCompactIfNeeded: (...args: unknown[]) => Promise<Record<string, unknown>>
  rapidRefillCount: (tracking?: Record<string, unknown>) => number
  AUTOCOMPACT_THRASH_MESSAGE: string
  getAutoCompactThreshold: (model: string) => number
}
const rapidRefillPauseText = (auto.rapidRefillPauseText as ((opts: { nonInteractive: boolean }) => string) | undefined) ?? (() => '')
const { foldAvailability, overflowRefusalText } = await import('../../src/services/compact/overflowRecovery.ts')
const { estimateOverflowSignal } = await import('../../src/services/api/overflowSignal.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { createContentReplacementState } = await import('../../src/utils/toolResultStorage.ts')
const { setAskChannel, getAskChannel } = await import('../../src/bootstrap/state.ts')

let checks = 0
let failures = 0
const check = (label: string, condition: boolean, detail = ''): void => {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${condition || !detail ? '' : `: ${detail}`}`)
}

const MODEL = 'claude-opus-4-8'
let clock = Date.UTC(2026, 9, 17)
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { role: 'user', content } }) as Message
const assistant = (content: unknown): Message => ({ type: 'assistant', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { id: randomUUID(), role: 'assistant', model: MODEL, stop_reason: 'tool_use', content } }) as Message
function stretch(rounds: number, resultChars: number, label: string): Message[] {
  const rows: Message[] = []
  for (let index = 0; index < rounds; index++) {
    rows.push(user(`${label} ask ${index}: read the next notes file`))
    const id = randomUUID()
    rows.push(assistant([{ type: 'tool_use', id, name: 'Read', input: { file_path: `/notes/${label}-${index}.txt` } }]))
    rows.push({ ...user([{ type: 'tool_result', tool_use_id: id, content: `${label} notes ${index} line `.repeat(Math.ceil(resultChars / 20)) }]), toolUseResult: { code: 0 } } as Message)
  }
  return rows
}
const api = await startFixtureApi(Array.from({ length: 6 }, () => ({ kind: 'text' as const, text: 'The notes files were read one by one; the operator asks ride whole beside this summary.' })))
process.env.ANTHROPIC_BASE_URL = api.url
const owner = makeOwnerKey({ workspace: process.cwd(), sessionId: 'fold-breaker-answers-proof', lane: 'main' })
const context = (nonInteractive = false) => ({
  owner,
  abortController: new AbortController(),
  readFileState: createFileStateCacheWithSizeLimit(20),
  contentReplacementState: createContentReplacementState(),
  loadedNestedMemoryPaths: new Set<string>(),
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, mcp: { tools: [], clients: [], commands: [], resources: {} } }),
  options: { tools: [], mcpClients: [], commands: [], agentDefinitions: { activeAgents: [] }, engineModel: MODEL, thinkingConfig: { type: 'disabled' }, isNonInteractiveSession: nonInteractive },
}) as never
const cacheSafe = (ctx: unknown) => ({ systemPrompt: ['fixture'], userContext: {}, systemContext: {}, toolUseContext: ctx, forkContextMessages: [] }) as never

try {
  process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = '60000'
  const threshold = getAutoCompactThreshold(MODEL)
  const history = stretch(12, 20_000, 'tidy')
  console.log(`B1 the breaker's window counts a refill within ONE round of the fold (threshold ${threshold})`)
  {
    check('a fold followed by one round that refills counts as a rapid refill', rapidRefillCount({ compacted: true, turnCounter: 1, turnId: 't', consecutiveRapidRefills: 0 }) === 1)
    check('a refill after two rounds is the healthy cadence of a small window, not a rapid refill (red on the base: it counted)', rapidRefillCount({ compacted: true, turnCounter: 2, turnId: 't', consecutiveRapidRefills: 2 }) === 0)
    check('the thrash words say so: within 1 turn of each fold, 3 times in a row', AUTOCOMPACT_THRASH_MESSAGE.startsWith('Auto-compaction is looping: the context refilled within 1 turn of each fold 3 times in a row'), AUTOCOMPACT_THRASH_MESSAGE)
  }

  console.log('B2 the trip: the fold that trips the breaker still lands, and the result says the breaker tripped')
  {
    const paid = api.messageRequests().length
    const tripped = await autoCompactIfNeeded(history, context(), cacheSafe(context()), 'sdk', { compacted: true, turnCounter: 1, turnId: 't3', consecutiveRapidRefills: 2 }, 0, undefined)
    check('the fold landed (one summary request) and carries the trip (red on the base: no fold, the trip alone)', tripped.wasCompacted === true && tripped.rapidRefillBreakerTripped === true && api.messageRequests().length === paid + 1, JSON.stringify({ wasCompacted: tripped.wasCompacted, tripped: tripped.rapidRefillBreakerTripped, requests: api.messageRequests().length - paid, refusal: tripped.refusal }))
    check('the post-fold estimate sits under the threshold: the answer can be made on it', typeof (tripped.compactionResult as { truePostCompactTokenCount?: number } | undefined)?.truePostCompactTokenCount === 'number' && ((tripped.compactionResult as { truePostCompactTokenCount: number }).truePostCompactTokenCount < threshold), String((tripped.compactionResult as { truePostCompactTokenCount?: number } | undefined)?.truePostCompactTokenCount))
  }

  console.log('B3 the pause: once paused, no further automatic fold for the run; a forced fold names the pause in its refusal')
  {
    const paid = api.messageRequests().length
    const paused = { compacted: true, turnCounter: 1, turnId: 't4', consecutiveRapidRefills: 3, rapidRefillPaused: true as const }
    const quiet = await autoCompactIfNeeded(history, context(), cacheSafe(context()), 'sdk', paused, 0, undefined)
    check('the threshold road makes no summary request while paused', quiet.wasCompacted === false && quiet.rapidRefillBreakerTripped === undefined && api.messageRequests().length === paid, JSON.stringify(quiet))
    const signal = estimateOverflowSignal({ family: 'anthropic', actualTokens: 70_000, limitTokens: 60_000 })
    const forced = await autoCompactIfNeeded(history, context(), cacheSafe(context()), 'sdk', paused, 0, signal)
    check('the overflow road refuses with the pause named, in the interactive spelling', forced.wasCompacted === false && forced.refusal === rapidRefillPauseText({ nonInteractive: false }) && String(forced.refusal).includes('/compact folds the conversation by hand') && String(forced.refusal).includes('the next message makes a fresh automatic attempt'), String(forced.refusal))
    const channel = getAskChannel()
    setAskChannel('none')
    const headless = await autoCompactIfNeeded(history, context(true), cacheSafe(context(true)), 'sdk', paused, 0, signal)
    setAskChannel(channel)
    check('…and the headless spelling names a fresh run, never a slash command', headless.refusal === rapidRefillPauseText({ nonInteractive: true }) && !String(headless.refusal).includes('/compact') && String(headless.refusal).includes('start a fresh run'), String(headless.refusal))
    const availability = foldAvailability({ tracking: paused, hasHistory: true })
    check('the recovery ladder reads the pause as the breaker with the rapid-refill detail', availability.available === false && availability.why === 'breaker' && availability.detail === 'rapid-refill', JSON.stringify(availability))
    const words = overflowRefusalText(signal, 'breaker', { nonInteractive: false, detail: 'rapid-refill' })
    check("the ladder's exhaustion sentence carries the pause words, not the three-failures words", words.includes('Automatic compaction is paused for the rest of this run') && !words.includes('failed 3 times'), words)
  }
} finally {
  delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} fold breaker answers (${checks} checks, ${failures} failures)`)
process.exit(failures ? 1 : 0)
