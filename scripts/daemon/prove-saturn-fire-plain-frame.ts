#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'saturn-fire-home-'))
const DAEMON_DIR = mkdtempSync(join(tmpdir(), 'saturn-fire-daemon-'))
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
mkdirSync(DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_WAKE_REASON
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const saturn = await import('../../src/daemon/saturn.ts')
const ticker = await import('../../src/daemon/saturnTicker.ts')
const supervisor = await import('../../src/daemon/concourseSupervisor.ts')
const bridge = await import('../../src/services/saturn/sessionScheduleBridge.ts')
const ledger = await import('../../src/services/providers/anthropic/prefixLedger.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const SESSION_LIVE = 'sess-fire-live'
const SESSION_PARKED = 'sess-fire-parked'
const LIVE_MODEL = 'claude-fable-5-1'
const OTHER_MODEL = 'claude-opus-4-8'
const ACCOUNT = {
  family: 'anthropic',
  source: 'oauth' as const,
  scopeDir: join(DAEMON_DIR, 'scope'),
  identity: 'operator@example.com',
  knownExpiresAt: Date.now() + 86_400_000,
  refreshable: true,
}
const addDerivations: string[] = []
const addDeps = {
  deriveAccount: (modelKey: string) => {
    addDerivations.push(modelKey)
    return { ok: true as const, account: { ...ACCOUNT } }
  },
}
const workerRecord = (runnerId: string, sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1,
  runnerId,
  sessionId,
  workspaceId: '/scratch/repo',
  isolation: 'shared',
  modelKey: LIVE_MODEL,
  effort: 'high',
  spawnedAt: Date.now(),
  lastLiveAt: Date.now(),
  ...extra,
})
const readWorkers = (): Record<string, Record<string, unknown>> =>
  (JSON.parse(readFileSync(supervisor.concourseWorkersPath(DAEMON_DIR), 'utf8')) as { workers: Record<string, Record<string, unknown>> }).workers

section('§1 a fire into a live session is a plain user frame — no model, no prefix, the session\'s own model derives the account')
supervisor.updateConcourseWorkers(workers => {
  for (const key of Object.keys(workers)) delete workers[key]
  workers['concourse-live'] = workerRecord('concourse-live', SESSION_LIVE) as never
  workers['concourse-parked'] = workerRecord('concourse-parked', SESSION_PARKED, { parkedAt: Date.now() - 60_000 }) as never
}, DAEMON_DIR)
const sameModel = saturn.applyConcourseScheduleOp(
  SESSION_LIVE,
  { op: 'add', schedule: { when: { kind: 'every', cron: '* * * * *' }, action: { kind: 'fire', prompt: 'same-model beat' } } },
  'operator:test',
  addDeps as never,
  DAEMON_DIR,
)
const otherModel = saturn.applyConcourseScheduleOp(
  SESSION_LIVE,
  { op: 'add', schedule: { when: { kind: 'every', cron: '* * * * *' }, action: { kind: 'fire', prompt: 'other-model beat' }, modelKey: OTHER_MODEL } },
  'operator:test',
  addDeps as never,
  DAEMON_DIR,
)
const parkedFire = saturn.applyConcourseScheduleOp(
  SESSION_PARKED,
  { op: 'add', schedule: { when: { kind: 'every', cron: '* * * * *' }, action: { kind: 'fire', prompt: 'parked beat' } } },
  'operator:test',
  addDeps as never,
  DAEMON_DIR,
)
check('three fire schedules land: same model, a captured other model, and one on a parked session', sameModel.outcome === 'applied' && otherModel.outcome === 'applied' && parkedFire.outcome === 'applied', `${sameModel.outcome} ${otherModel.outcome} ${parkedFire.outcome}`)
check("the add-time derivation reads the session's model for a plain fire and the captured key for the other", j(addDerivations) === j([LIVE_MODEL, OTHER_MODEL, LIVE_MODEL]), j(addDerivations))
const T0 = Date.now()
supervisor.updateConcourseWorkers(workers => {
  for (const rec of Object.values(workers)) {
    for (const row of ((rec as { schedules?: Array<Record<string, unknown>> }).schedules ?? [])) row.createdAt = T0 - 120_000
  }
}, DAEMON_DIR)
const capturedKeys = Object.values(readWorkers()).flatMap(rec => ((rec.schedules ?? []) as Array<{ modelKey?: string }>).map(s => s.modelKey))
check('the captured keys stand on the record as provenance', capturedKeys.filter(k => k === OTHER_MODEL).length === 1 && capturedKeys.filter(k => k === LIVE_MODEL).length === 2, j(capturedKeys))

const fireDerivations: string[] = []
const delivered: Array<Record<string, unknown>> = []
const ports = {
  now: () => T0,
  records: () => Object.values(readWorkers()).filter(r => r.endedAt === undefined),
  liveFacts: () => ({ credentialed: true, stranded: false, expiresAt: null, refreshable: false }),
  deriveAccount: (modelKey: string) => {
    fireDerivations.push(modelKey)
    return { ok: true, account: { ...ACCOUNT } }
  },
  deliver: async (d: Record<string, unknown>) => {
    delivered.push({ ...d })
    return { ok: true }
  },
  birth: async () => ({ ok: true, sessionId: 'born-x' }),
  screenOpen: () => true,
  dir: DAEMON_DIR,
}
const report = await ticker.tickSaturnOnce(ports as never)
check('the tick fires all three', report.fired === 3 && report.held === 0 && delivered.length === 3, j(report))
const FRAME_KEYS = 'by,clientMessageId,parked,prompt,sessionId,workspaceId'
for (const d of delivered) {
  const keys = Object.keys(d).sort().join(',')
  check(`the delivery for '${String(d.prompt)}' is a plain frame: ${FRAME_KEYS} — no model, no system, no tools, no messages`, keys === FRAME_KEYS, keys)
}
const byPrompt = (prompt: string): Record<string, unknown> | undefined => delivered.find(d => d.prompt === prompt)
check('the same-model fire delivers into the live session, not parked', byPrompt('same-model beat')?.sessionId === SESSION_LIVE && byPrompt('same-model beat')?.parked === false)
check('the captured-other-model fire delivers into the same live session, the same plain frame, not parked', byPrompt('other-model beat')?.sessionId === SESSION_LIVE && byPrompt('other-model beat')?.parked === false)
check("the parked session's fire rides the same door with parked true (the revive road), still without a model", byPrompt('parked beat')?.sessionId === SESSION_PARKED && byPrompt('parked beat')?.parked === true)
check("the fire-time derivation reads the SESSION's live model for every fire — the captured other key is never consulted", fireDerivations.length === 3 && fireDerivations.every(k => k === LIVE_MODEL), j(fireDerivations))
const afterKeys = Object.values(readWorkers()).flatMap(rec => ((rec.schedules ?? []) as Array<{ modelKey?: string }>).map(s => s.modelKey))
check('the captured key is untouched by the fire (provenance only; the family did not move)', j(afterKeys.sort()) === j(capturedKeys.slice().sort()), j(afterKeys))
check('each delivery names its fire once: saturn-<session>-<schedule>-<dueAt>', delivered.every(d => String(d.clientMessageId).startsWith(`saturn-${String(d.sessionId)}-`)), j(delivered.map(d => d.clientMessageId)))

section('§2 the fired words are an appended user row — the wake reason rides inside it, nothing sent before it moves')
check('with no reason the fired prompt is byte-identical', bridge.applyWakeReason('same-model beat', undefined) === 'same-model beat' && bridge.applyWakeReason('same-model beat', ' \r\n ') === 'same-model beat')
check('a reason is one bracketed line ahead of the prompt inside the new row', bridge.applyWakeReason('same-model beat', 'the loop\r\nwoke') === '[self-paced wake — why you woke: the loop woke]\n\nsame-model beat')
type Block = Record<string, unknown>
const THINK = (text: string): Block => ({ type: 'thinking', thinking: text, signature: `sig-${text}` })
const TEXT = (text: string): Block => ({ type: 'text', text })
const SYSTEM = [{ type: 'text', text: 'You are Mercury.\n\n# Environment\n - Platform: darwin' }]
const TOOLS = [{ name: 'Read', description: 'reads', input_schema: { type: 'object' } }]
const history = [
  { role: 'user', content: [TEXT('start the loop')] },
  { role: 'assistant', content: [THINK('plan'), TEXT('looping')] },
  { role: 'user', content: [TEXT('carry on')] },
  { role: 'assistant', content: [THINK('again'), TEXT('done for now')] },
]
ledger.resetPrefixLedger()
const key = 'owner|first|claude-fable-5-1'
ledger.judgeAndRecordPrefix('fire-owner', key, { system: SYSTEM, tools: TOOLS, messages: history }, [null, 'msg_1', null, 'msg_2'])
const fired = [...history, { role: 'user', content: [TEXT(bridge.applyWakeReason('same-model beat', 'the loop woke'))] }]
const verdict = ledger.judgeAndRecordPrefix('fire-owner', key, { system: SYSTEM, tools: TOOLS, messages: fired }, [null, 'msg_1', null, 'msg_2', null])
check("the request the fire's turn sends compares against the session's own record and moves nothing ahead of the preserved thinking", verdict.compared && verdict.mismatch === null && verdict.lastThinkingIndex === 3, verdict.mismatch ? ledger.describePrefixMismatch(verdict.mismatch) : `compared=${verdict.compared}`)

console.log(`\n${failures === 0 ? '✅' : '❌'} saturn fire plain frame: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
