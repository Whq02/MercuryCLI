#!/usr/bin/env bun
// ============================================================================
//  scripts/compact/prove-compact-identity.ts — compact preserves session
//  identity (compact-frontier part 6): the fold changes what the CONTEXT
//  holds, never WHICH SESSION this is — same session id, same transcript
//  file, same board row.
//
//    I1  behavioral, over the REAL /compact command: the session id and the
//        transcript path answer byte-identically before and after the fold;
//    I2  structural: the compact estate never touches the id mint or the
//        session-file rotation — no setSessionId, no session re-mint, and
//        the one transcript write it performs is reAppendSessionMetadata
//        (an append to the SAME file, never a rotation);
//    I3  structural: the fold never reaches the board row's title door —
//        the compact estate imports neither the naming module nor the
//        set-title verb, and the title derivation's own signature
//        (deriveSessionTitle over the RECORD alone) is fold-invariant by
//        construction: no transcript rides its inputs;
//    I4  the summary row cannot masquerade as operator words downstream:
//        it stays flagged isCompactSummary (the operator-turn predicates
//        exclude it — the row-shuffle belt for every preview that derives
//        from operator turns).
//
//  Run:  ~/.bun/bin/bun run scripts/compact/prove-compact-identity.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_SCRIPTED_STREAM',
  'MERCURY_SIMPLE',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_HOME',
  'MERCURY_EFFORT_LEVEL',
  'MAX_THINKING_TOKENS',
  'GOOGLE_API_KEY',
  'MERCURY_CONCOURSE_WORKER',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'compact-identity-'))

const FIXTURE_PORT = 34125

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — compact identity prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { startCrossfamilyFixture } = await import('../lib/crossfamilyConcourseFixture.ts')
const fixture = await startCrossfamilyFixture({ port: FIXTURE_PORT })
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { call } = await import('../../src/commands/compact/compact.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
const { getTranscriptPath } = await import('../../src/utils/sessionStorage/paths.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')

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
        content: [{ type: 'text', text: `identity answer ${index}.` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 400 + index, output_tokens: 40 },
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
    denialTracking: undefined,
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    effortValue: 'high',
    verbose: false,
    mainLoopModel: 'claude-opus-4-8',
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
      mainLoopModel: 'claude-opus-4-8',
      maxThinkingTokens: 0,
      thinkingConfig: { type: 'disabled' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }
  const result = (await call('', context as never)) as { type?: string; compactionResult?: { summaryMessages?: Array<{ isCompactSummary?: boolean }> } }
  check('the fold landed', result.type === 'compact')
  check('the session id is byte-identical across the fold', getSessionId() === idBefore, `${idBefore} → ${getSessionId()}`)
  check('the transcript path is byte-identical across the fold', getTranscriptPath() === pathBefore, `${pathBefore} → ${getTranscriptPath()}`)
  const summary = result.compactionResult?.summaryMessages?.[0]
  console.log('\nI4 the summary row keeps its own identity flag')
  check('the summary row stays flagged isCompactSummary', summary?.isCompactSummary === true)
}

console.log('\nI2 the compact estate never touches the id mint or the file rotation (structural)')
{
  const root = join(import.meta.dir, '..', '..')
  const estate = [
    'src/services/compact/compact.ts',
    'src/services/compact/autoCompact.ts',
    'src/commands/compact/compact.ts',
  ].map(rel => readFileSync(join(root, rel), 'utf8')).join('\n')
  check('no setSessionId in the compact estate', !estate.includes('setSessionId'))
  check('no session re-mint in the compact estate', !/mintSessionId|newSessionId|rotateSession/.test(estate))
  check('the one transcript write is the metadata re-append (same file)', estate.includes('reAppendSessionMetadata'))
}

console.log('\nI3 the board row title door is out of the fold’s reach (structural)')
{
  const root = join(import.meta.dir, '..', '..')
  const estate = [
    'src/services/compact/compact.ts',
    'src/services/compact/autoCompact.ts',
    'src/commands/compact/compact.ts',
  ].map(rel => readFileSync(join(root, rel), 'utf8')).join('\n')
  check('the compact estate never imports the naming module', !estate.includes('sessionNaming'))
  check('the compact estate never speaks the set-title verb', !estate.includes('set-title') && !estate.includes('setTitle'))
  const naming = readFileSync(join(root, 'src/services/concourse/sessionNaming.ts'), 'utf8')
  check(
    'the title door reads the record plus the brief callback — no transcript input of its own',
    naming.includes('sessionTitleOf(') && naming.includes('rec: { title?: string; workspaceId: string }'),
  )
  console.log('  [NOTE] the operator drill: watch a board row across a /compact — same row, same title, no shuffle (the receipt names it).')
}

console.log('\nI4b the operator-turn predicates exclude the summary row (the preview belt)')
{
  const root = join(import.meta.dir, '..', '..')
  const operatorTurns = readFileSync(join(root, 'src/utils/messages/operatorTurns.ts'), 'utf8')
  check(
    'isCompactSummary rows are excluded from operator turns',
    /isCompactSummary === true[\s\S]{0,80}return false/.test(operatorTurns),
  )
}

console.log('\nI5 THE FOCUS LAW — /compact applies to the FOCUSED session (operator rider)')
{
  // F1 the command table's own fact: /compact is a SESSION-seat command — the
  // composer hands it to the focused chat's runner, never a screen body.
  const { commandSeat } = await import('../../src/commands.ts')
  const compactCommand = (await import('../../src/commands/compact/index.ts')).default
  check('F1 /compact is a session-seat command (the one dispatch rule routes it to the focused chat)', commandSeat(compactCommand as never) === 'session')

  const root = join(import.meta.dir, '..', '..')
  const repl = readFileSync(join(root, 'src/screens/REPL.tsx'), 'utf8')
  // F2 the composer road: the submit captures the FOCUSED connector and the
  // session branch delivers through it — the same focus law the usage panel
  // follows (prove-usage-follows-focus).
  check(
    'F2 the submit captures the focused connector and delivers through it',
    repl.includes('const focusedNow = getFocusedSessionConnector()') && repl.includes('focusedNow\n        .sendWords(text'),
  )
  // F3 the connector's delivery names its OWN record as the target — a
  // /compact in a world with focused session X folds X, never a global
  // default or another session.
  const connector = readFileSync(join(root, 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
  check(
    "F3 the connector targets its own record's session (targetSessionId: this.record.sessionId)",
    connector.includes('targetSessionId: this.record.sessionId'),
  )
  // F4 the state word and the receipt paint on X: the seat publishes the
  // tail under the SEAT'S OWN session id, the connector reads its own
  // record's tail, and the REPL paints the FOCUSED live view.
  const seat = readFileSync(join(root, 'src/daemon/sessionSeat.ts'), 'utf8')
  check("F4 the seat publishes the tail under the seat's own session id", seat.includes('sessionId: seat.sessionId'))
  check("F4 the connector reads its own record's tail", connector.includes('readSessionTail(this.record.sessionId)'))
  check('F4 the REPL paints the FOCUSED live view', repl.includes('subscribeFocusedSeatLive'))
  // F5 the blank world: no focused session ⇒ the send REFUSES with the
  // no-chat sentence — never a global fold.
  const blank = readFileSync(join(root, 'src/services/engine-connector/noSessionConnector.ts'), 'utf8')
  check('F5 the blank chat refuses the send (REFUSED_NO_CHAT) — no global fold exists', /sendWords\(\): Promise<SendReceiptV1> \{\s*\n\s*return REFUSED_NO_CHAT/.test(blank))
  // F6 the other typing surfaces keep their landed local truths (the
  // chat-relief ground — verify, never refix): the console and Minerva
  // /compact answers are production-consumed constants, and the coordinator
  // pane's fold is its own store's (its provers run beside this suite).
  const helmConsole = readFileSync(join(root, 'src/utils/cockpit/helmConsole.ts'), 'utf8')
  const minerva = readFileSync(join(root, 'src/utils/cockpit/minervaRepl.ts'), 'utf8')
  check('F6 the console /compact truth is production-consumed', helmConsole.includes('CONSOLE_COMPACT_TRUTH') && helmConsole.includes('answer: CONSOLE_COMPACT_TRUTH'))
  check('F6 the Minerva /compact truth is production-consumed', minerva.includes('MINERVA_COMPACT_TRUTH') && minerva.includes('reply: MINERVA_COMPACT_TRUTH'))
  console.log('  [NOTE] the concourse SessionMirror strip carries no composer road in this tree — the one typing road into a session is the focused chat composer (F2); the coordinator pane folds its OWN store (prove-coordinator-compact-clear / prove-coordinator-auto-compact are the landed ground).')
}

await fixture.close()
clearTimeout(guard)

console.log(failures === 0 ? `\n ✅ COMPACT IDENTITY GREEN (${checks} checks)` : `\n ❌ ${failures} of ${checks} FAILED`)
process.exit(failures === 0 ? 0 : 1)
