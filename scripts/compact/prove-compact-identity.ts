#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of [
  'MERCURY_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_SCRIPTED_STREAM',
  'MERCURY_BARE',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_HOME',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_THINKING_BUDGET',
  'GOOGLE_API_KEY',
  'MERCURY_CONCOURSE_WORKER',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'compact-identity-'))

const FIXTURE_PORT = 0

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
}

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — compact identity prover exceeded 120s; the fold in call() of src/commands/compact/compact.ts did not return, or the fixture from scripts/lib/crossfamilyConcourseFixture.ts did not answer')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const fixture = await startCrossfamilyFixture({ port: FIXTURE_PORT })
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { call } = await import('../../src/commands/compact/compact.ts')
const { getSessionId } = await import('../../src/boot/process-state/processState.ts')
const { getTranscriptPath } = await import('../../src/sessions/transcripts/paths.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/platform/files/fileStateCache.ts')

function makeMessages(): unknown[] {
  const out: unknown[] = []
  for (let index = 0; index < 4; index++) {
    out.push(createUserMessage({ content: `identity ask ${index}` }))
    out.push({
      type: 'assistant',
      uuid: `00000000-0000-4000-a000-00000000id${String(10 + index).slice(-2)}`,
      requestId: `req_i${index}`,
      message: {
        id: `msg_i${index}`,
        type: 'message',
        role: 'assistant',
        model: 'fixture',
        content: [{ type: 'text', text: `identity answer ${index}. ${index === 0 ? 'The session keeps its identity. '.repeat(1_500) : ''}` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 12_000 + index, output_tokens: 40 },
      },
    })
  }
  return out
}

console.log('compact identity — the fold changes the context, never the session')

console.log('\nI1 the session id and the transcript file survive the fold byte-identically')
{
  const idBefore = getSessionId()
  const pathBefore = getTranscriptPath()
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = {
    toolPermissionContext,
    sessionHooks: new Map(),
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    effortValue: 'high',
    verbose: false,
    engineModel: 'claude-opus-4-8',
  }
  const readFileState = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)
  const context = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: makeMessages(),
    readFileState,
    options: {
      tools: [],
      mcpClients: [],
      commands: [],
      engineModel: 'claude-opus-4-8',
      maxThinkingTokens: 0,
      thinkingConfig: { type: 'disabled' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }
  const result = (await call('', context as never)) as { type?: string; compactionResult?: { summaryMessages?: Array<{ isCompactSummary?: boolean }> } }
  check('the fold landed', result.type === 'compact', String(result.type), 'call() in src/commands/compact/compact.ts must return type compact for this history; read its refusal and error branches')
  check('the session id is byte-identical across the fold', getSessionId() === idBefore, `${idBefore} → ${getSessionId()}`, 'the fold in src/commands/compact/compact.ts must not change the session id')
  check('the transcript path is byte-identical across the fold', getTranscriptPath() === pathBefore, `${pathBefore} → ${getTranscriptPath()}`, 'the fold in src/commands/compact/compact.ts must keep writing to the same transcript file')
  const summary = result.compactionResult?.summaryMessages?.[0]
  console.log('\nI4 the summary row keeps its own identity flag')
  check('the summary row stays flagged isCompactSummary', summary?.isCompactSummary === true, '', 'call() in src/commands/compact/compact.ts must return summaryMessages whose first row carries isCompactSummary')
}


console.log('\nI5 THE FOCUS LAW — /compact applies to the FOCUSED session (operator rider)')
{
  const { commandSeat } = await import('../../src/commands/catalogue/commands.ts')
  const compactCommand = (await import('../../src/commands/compact/index.ts')).default
  check('F1 /compact is a session-seat command (the one dispatch rule routes it to the focused chat)', commandSeat(compactCommand as never) === 'session', '', 'remove seat: screen, uiRouteAlias and userPrivate from the command in src/commands/compact/index.ts; commandSeat() in src/commands/catalogue/commands.ts makes those screen-seat')

}

await fixture.close()
clearTimeout(guard)

console.log(failures === 0 ? `\n ✅ COMPACT IDENTITY GREEN (${checks} checks)` : `\n ❌ ${failures} of ${checks} FAILED`)
process.exit(failures === 0 ? 0 : 1)
