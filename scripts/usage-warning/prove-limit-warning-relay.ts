#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const scratch = mkdtempSync(join(tmpdir(), 'limit-warning-relay-'))
const home = join(scratch, 'home')
const daemonDir = join(scratch, 'daemon')
mkdirSync(home, { recursive: true })
mkdirSync(daemonDir, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
process.env.MERCURY_DAEMON_DIR = daemonDir
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_MODEL', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const REPO = join(import.meta.dir, '..', '..')

console.log('============================================================')
console.log(' limit-warning relay — the session answers its own line; the screen prefers it')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const projections = await import('../../src/services/engine-connector/seatProjections.ts')
type Facts = import('../../src/services/engine-connector/seatProjections.ts').SessionFactsV1

const ZERO_USAGE = {
  totalCostUSD: 0,
  totalAPIDurationMs: 0,
  totalDurationMs: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadInputTokens: 0,
  totalCacheCreationInputTokens: 0,
  hasUnknownModelCost: false,
}
const factsFor = (sessionId: string, usage: Facts['usage']): Facts => ({
  schema: 1,
  sessionId,
  atMs: Date.now(),
  model: { effective: 'claude-fable-5', setting: null },
  usage,
  identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: true, accountEmail: null },
  skills: [],
  mcp: [],
  permissionMode: 'flow',
  workspace: { cwd: scratch, originalCwd: scratch, projectRoot: scratch, instructionRoots: [] },
  queue: [],
  pendingModel: null,
  busy: false,
})
async function readBack(sessionId: string): Promise<Facts | null> {
  for (let i = 0; i < 40; i++) {
    const facts = projections.readSessionFacts(sessionId, daemonDir)
    if (facts !== null) return facts
    await sleep(50)
  }
  return null
}

section('§1 — additive on the payload: with the field, without the field')
{
  projections.publishSessionFacts(
    factsFor('relay-with', { ...ZERO_USAGE, limitWarning: { provider: 'anthropic', text: 'Anthropic: 91% of Fable limit used' } }),
    daemonDir,
  )
  const withFact = await readBack('relay-with')
  check('a facts file published WITH the runner fact reads back', withFact !== null)
  check(
    '…carrying the fact verbatim on the usage readout',
    withFact?.usage.limitWarning?.provider === 'anthropic' && withFact?.usage.limitWarning?.text === 'Anthropic: 91% of Fable limit used',
    JSON.stringify(withFact?.usage.limitWarning),
  )
  projections.publishSessionFacts(factsFor('relay-null', { ...ZERO_USAGE, limitWarning: null }), daemonDir)
  const nullFact = await readBack('relay-null')
  check("a runner that sees no warning answers null, and null survives the seam", nullFact !== null && nullFact.usage.limitWarning === null)
  projections.publishSessionFacts(factsFor('relay-older', { ...ZERO_USAGE }), daemonDir)
  const older = await readBack('relay-older')
  check("an older runner's answer (no field) reads back with the field ABSENT — never invented", older !== null && !('limitWarning' in older.usage))
  const typesSrc = readFileSync(join(REPO, 'src/services/engine-connector/types.ts'), 'utf8')
  check('the field is declared OPTIONAL on UsageFactsV1 (the additive law in the type)', /limitWarning\?: LimitWarningFactV1 \| null/.test(typesSrc))
}

section("§2 — not a verb: the wire's two hashed blocks did not move")
{
  const src = readFileSync(join(REPO, 'src/daemon/protocol.ts'), 'utf8')
  const opsStart = src.indexOf('export type DaemonOp =')
  const opsEnd = src.indexOf('\n\n', opsStart)
  const ops = Array.from(src.slice(opsStart, opsEnd).matchAll(/'([A-Za-z-]+)'/g), m => m[1]!)
  const reqStart = src.indexOf('export type DaemonRequest =')
  const ctlStart = src.indexOf("op: 'sessionControl'", reqStart)
  const actStart = src.indexOf('action:', ctlStart)
  const actEnd = src.indexOf('sessionId: string', actStart)
  const controlActions = Array.from(src.slice(actStart, actEnd).matchAll(/'([A-Za-z-]+)'/g), m => m[1]!)
  const hash = 'sha256:' + createHash('sha256').update(JSON.stringify({ ops, controlActions })).digest('hex')
  const registered = /export const DAEMON_PROTO_SHAPE = '([^']+)'/.exec(src)?.[1] ?? ''
  check('both hashed blocks were found', ops.length >= 20 && controlActions.length >= 15, `${ops.length} ops · ${controlActions.length} actions`)
  check('no verb in either block names a limit or a warning', ![...ops, ...controlActions].some(v => /limit|warning/i.test(v)))
  check('the registered DAEMON_PROTO_SHAPE still equals the hash of the two blocks (nothing moved on the wire)', registered === hash, `${registered} vs ${hash}`)
  check('protocol.ts spells no limitWarning at all', !src.includes('limitWarning'))
}

section('§3 — the precedence law (pure, the owner’s)')
{
  const { preferSessionLimitWarning } = await import('../../src/services/providers/limitWarning.ts')
  const session = { provider: 'openai', text: 'OpenAI: 78% of weekly window used' }
  const local = { provider: 'anthropic', text: 'Anthropic: 91% of Fable limit used' }
  check('a runner fact wins over the screen’s own derivation', preferSessionLimitWarning(session, local) === session)
  check('a runner that sees no warning (null) falls to the screen’s own', preferSessionLimitWarning(null, local) === local)
  check('an absent fact (older runner · no facts yet · the resting slot) falls to the screen’s own', preferSessionLimitWarning(undefined, local) === local)
  check('both silent ⇒ silent (never a fabricated line)', preferSessionLimitWarning(null, null) === null && preferSessionLimitWarning(undefined, null) === null)
}

section('§4 — the two seams: the child answers from the one owner; the hook reads the session first')
{
  const printSrc = readFileSync(join(REPO, 'src/cli/print.ts'), 'utf8')
  const caseStart = printSrc.indexOf("case 'session_facts':")
  const caseEnd = printSrc.indexOf("case '", caseStart + 1)
  const answerer = printSrc.slice(caseStart, caseEnd)
  check('the session_facts answerer was found', caseStart !== -1 && caseEnd > caseStart)
  check('the child answers limitWarning from the ONE owner (providerLimitWarning) on its own model', /limitWarning: providerLimitWarning\(\{ model: activeModel \?\? getMainLoopModel\(\) \}\)/.test(answerer))
  check('the child imports the owner, never a second grammar', printSrc.includes("import { providerLimitWarning } from '../services/providers/limitWarning.js'"))
  const hookSrc = readFileSync(join(REPO, 'src/hooks/notifs/useRateLimitWarningNotification.tsx'), 'utf8')
  check('the hook reads the FOCUSED connector', hookSrc.includes('useSessionConnector()'))
  check('…and prefers its usage readout’s fact through the owner’s law', /preferSessionLimitWarning\(\s*connector\.usage\(\)\.limitWarning,/.test(hookSrc))
  check("…re-reading on the connector change, the engine tick and the usage records' own signals", /\[limits, model, tick, connector, addNotification, usageRecordVersion, openaiObservedVersion\]/.test(hookSrc))
}

section('§5 — the resting slot carries no fact')
{
  const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
  const resting = new NoSessionConnector()
  check('NoSessionConnector.usage() carries no limitWarning (absent, never null-as-silence)', !('limitWarning' in resting.usage()))
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
}
console.log(failures === 0 ? '\n✅ prove-limit-warning-relay — all checks pass' : '\n❌ prove-limit-warning-relay — check(s) failed')
process.exit(failures)
