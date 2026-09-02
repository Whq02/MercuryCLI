#!/usr/bin/env bun
// ============================================================================
//  scripts/repetition-guard/prove-stop-notice-persists.ts — a stopped turn
//  SAYS WHY in the transcript STORE, not just on the event stream.
//
//  The defect: the repetition breaker
//  ends the turn and yields its 'warning' notice — prove-hammer-breaker
//  pins that engine side sound — but the cockpit paints a daemon-hosted
//  session from the TRANSCRIPT FILE, and QueryEngine's system-message arm
//  pushed informational rows into the in-memory history only (never
//  recordTranscript), so the safety copy evaporated between the yield and
//  the store. render-hammer-breaker (the PTY prover on the built artifact)
//  was left honestly red on exactly this.
//
//  Pins:
//    N1  the hammer run ends `error_repetition_breaker` (rig sanity);
//    N2  the transcript FILE carries the warning notice row — type system,
//        subtype informational, level 'warning', the operator sentence;
//    N3  the loader round-trips it (loadFullLog returns the row — what the
//        connector deserializes and paints);
//    N4  no info-level chrome leaked into the store with it (warning/error
//        record; info stays in-memory — the SWIFT chrome law).
//
//  Run: ~/.bun/bin/bun run scripts/repetition-guard/prove-stop-notice-persists.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stop-notice-home-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'stop-notice-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'stop-notice-teams-'))
process.env.MERCURY_SCRIPTED_STREAM = 'hammer-breaker'
for (const k of ['MERCURY_SIMPLE', 'NODE_ENV', 'MERCURY_SKIP_PROMPT_HISTORY']) {
  delete process.env[k]
}

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { ask } = await import('../../src/QueryEngine.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { getAllBaseTools } = await import('../../src/tools.ts')
const { flushSessionStorage } = await import('../../src/utils/sessionStorage.ts')
const { loadFullLog } = await import('../../src/utils/sessionStorage/logs.ts')
const { getTranscriptPathForSession } = await import('../../src/utils/sessionStorage/paths.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — stop-notice prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

console.log('============================================================')
console.log(' the repetition stop notice reaches the transcript store')
console.log('============================================================')

let appState: Record<string, unknown> = {
  ...(getDefaultAppState() as unknown as Record<string, unknown>),
}
const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

const yields: Array<Record<string, unknown>> = []
const messages: never[] = []
let cache = createFileStateCacheWithSizeLimit(100)
for await (const message of ask({
  commands: [],
  prompt: 'please read that file',
  promptUuid: '99999999-8888-4777-8666-555555555555',
  cwd: process.cwd(),
  tools: getAllBaseTools() as never,
  verbose: false,
  mcpClients: [],
  canUseTool: allowAll as never,
  mutableMessages: messages,
  getReadFileCache: () => cache,
  setReadFileCache: next => {
    cache = next
  },
  getAppState: () => appState as never,
  setAppState: (f: (prev: never) => never): void => {
    appState = f(appState as never) as unknown as Record<string, unknown>
  },
  agents: [] as never,
} as never)) {
  yields.push(message as Record<string, unknown>)
}

const result = yields.find(m => m.type === 'result')
check(
  "N1 — the run ends 'error_repetition_breaker' (rig sanity)",
  result !== undefined && result.subtype === 'error_repetition_breaker',
  JSON.stringify(result?.subtype ?? 'no result frame'),
)

await flushSessionStorage()
const sessionId = getSessionId()
const log = (await loadFullLog({
  sessionId,
  messages: [],
  fullPath: getTranscriptPathForSession(sessionId),
} as never)) as unknown as {
  messages?: Array<Record<string, unknown>>
}
const rows = Array.isArray(log?.messages) ? log.messages : []
const systemRows = rows.filter(r => r.type === 'system' && r.subtype === 'informational')
const noticeRows = systemRows.filter(
  r => String(r.content ?? '').includes('Stopped this turn') && r.level === 'warning',
)
check(
  'N2 — the transcript store carries the warning notice row (the cockpit paints from THIS file)',
  noticeRows.length === 1,
  `found ${noticeRows.length} notice rows among ${rows.length} transcript rows`,
)
check(
  'N3 — the persisted row keeps the operator sentence whole',
  noticeRows.length === 1 && String(noticeRows[0]?.content ?? '').includes('Send a new prompt with a different approach'),
)
check(
  'N4 — no info-level chrome leaked into the store with it (warning/error persist; info stays in-memory)',
  systemRows.every(r => r.level === 'warning' || r.level === 'error'),
  JSON.stringify(systemRows.filter(r => r.level !== 'warning' && r.level !== 'error').map(r => r.content).slice(0, 3)),
)

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`STOP-NOTICE-PERSISTS: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`STOP-NOTICE-PERSISTS: all ${checks} checks passed`)
process.exit(0)
