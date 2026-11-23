#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const RELAY_FAIL_HINT = 'change publishSessionFacts or readSessionFacts in src/engine/connector/seatProjections.ts, preferSessionLimitWarning in src/models/roads/limitWarning.ts, or usage() in src/engine/connector/noSessionConnector.ts, whichever this check names'
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  const shown = ok ? '' : detail ? `${detail} | hint: ${RELAY_FAIL_HINT}` : RELAY_FAIL_HINT
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
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
for (const key of ['ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }


console.log('============================================================')
console.log(' limit-warning relay — the session answers its own line; the screen prefers it')
console.log('============================================================')

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()

const projections = await import('../../src/engine/connector/seatProjections.ts')
type Facts = import('../../src/engine/connector/seatProjections.ts').SessionFactsV1

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
    factsFor('relay-with', { ...ZERO_USAGE, limitWarning: { provider: 'anthropic', text: 'Anthropic: 91% of the Fable limit used' } }),
    daemonDir,
  )
  const withFact = await readBack('relay-with')
  check('a facts file published WITH the runner fact reads back', withFact !== null)
  check(
    '…carrying the fact verbatim on the usage readout',
    withFact?.usage.limitWarning?.provider === 'anthropic' && withFact?.usage.limitWarning?.text === 'Anthropic: 91% of the Fable limit used',
    JSON.stringify(withFact?.usage.limitWarning),
  )
  projections.publishSessionFacts(factsFor('relay-null', { ...ZERO_USAGE, limitWarning: null }), daemonDir)
  const nullFact = await readBack('relay-null')
  check("a runner that sees no warning answers null, and null survives the seam", nullFact !== null && nullFact.usage.limitWarning === null)
  projections.publishSessionFacts(factsFor('relay-older', { ...ZERO_USAGE }), daemonDir)
  const older = await readBack('relay-older')
  check("an older runner's answer (no field) reads back with the field ABSENT — never invented", older !== null && !('limitWarning' in older.usage))
}


section('§3 — the precedence law (pure, the owner’s)')
{
  const { preferSessionLimitWarning } = await import('../../src/models/roads/limitWarning.ts')
  const session = { provider: 'openai', text: 'OpenAI: 78% of weekly window used' }
  const local = { provider: 'anthropic', text: 'Anthropic: 91% of the Fable limit used' }
  check('a runner fact wins over the screen’s own derivation', preferSessionLimitWarning(session, local) === session)
  check('a runner that sees no warning (null) falls to the screen’s own', preferSessionLimitWarning(null, local) === local)
  check('an absent fact (older runner · no facts yet · the resting slot) falls to the screen’s own', preferSessionLimitWarning(undefined, local) === local)
  check('both silent ⇒ silent (never a fabricated line)', preferSessionLimitWarning(null, null) === null && preferSessionLimitWarning(undefined, null) === null)
}


section('§5 — the resting slot carries no fact')
{
  const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
  const resting = new NoSessionConnector()
  check('NoSessionConnector.usage() carries no limitWarning (absent, never null-as-silence)', !('limitWarning' in resting.usage()))
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
}
console.log(failures === 0 ? '\n✅ prove-limit-warning-relay — all checks pass' : '\n❌ prove-limit-warning-relay — check(s) failed')
process.exit(failures)
