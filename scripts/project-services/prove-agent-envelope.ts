#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vanguard-envelope-'))
delete process.env.MERCURY_CHANGE_RECEIPTS

const { buildCrewmateResultEnvelope, formatEnvelopeBlock, parseDeclaration } = await import(
  '../../src/crew/agent-results/normalize.ts'
)
const { ENVELOPE_DOCTRINE } = await import('../../src/crew/agent-results/contracts.ts')
const { attachCrewmateEnvelope, envelopeFor } = await import(
  '../../src/crew/agent-results/ingest.ts'
)
const { observeToolTerminal } = await import('../../src/engine/run-owner/effectObserver.ts')
const { processOwnerForLane } = await import('../../src/engine/run-owner/resolveOwner.ts')
const { recordEvidence, verificationSummary, _resetVerificationStateForTesting } = await import(
  '../../src/platform/verification/verificationState.ts'
)
const { _resetChangeReceiptsForTesting } = await import(
  '../../src/tools/engines/change-transaction/receipts.ts'
)
const { getMercuryHome } = await import('../../src/platform/environment/envUtils.ts')
const { sanitizePath } = await import('../../src/sessions/transcripts/sessionStoragePortable.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — agent envelope proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const AGENT_ID = 'agent-envelope-fixture'
const owner = processOwnerForLane(AGENT_ID)

function seedReceipt(outcome: 'succeeded' | 'failed', path: string): void {
  observeToolTerminal({
    owner,
    toolName: 'Edit',
    toolUseId: 'toolu_env',
    input: { file_path: path },
    ok: outcome === 'succeeded',
    durationMs: 1,
    cwd: '/tmp',
    effect: {
      outcome,
      operation: 'file.edit',
      changedPaths: outcome === 'succeeded' ? [path] : [],
      evidence: 'seeded',
      startedAt: 1,
      completedAt: 2,
    },
  } as never)
}

section('N. normalizer laws')
{
  _resetChangeReceiptsForTesting()

  const legacy = await buildCrewmateResultEnvelope({
    agentId: AGENT_ID,
    status: 'completed',
    finalText: 'I did some work.\n'.repeat(100),
  })
  check('N1 legacy prose: clipped summary, no invented findings/checks',
    legacy.summary.length <= 501 &&
    legacy.findings.length === 0 &&
    legacy.checks.length === 0 &&
    legacy.changedPaths.length === 0 &&
    legacy.fullOutputRef === `mercury://agent/${AGENT_ID}`,
    `summary ${legacy.summary.length} chars, findings ${legacy.findings.length}, checks ${legacy.checks.length}, changedPaths ${legacy.changedPaths.length}, ref ${legacy.fullOutputRef} · fix the prose-only path of buildAgentResultEnvelope in src/crew/agent-results/normalize.ts`)

  const declaredText =
    'Long prose here.\n<mercury-envelope>{"summary":"declared summary","findings":["f1"],"unresolved":["u1"],"recommendedNextAction":"merge it"}</mercury-envelope>'
  const parsed = parseDeclaration(declaredText)
  check('N2a parseDeclaration strips the block from prose',
    parsed.declared?.summary === 'declared summary' && parsed.prose === 'Long prose here.',
    `declared summary ${parsed.declared?.summary} · prose ${JSON.stringify(parsed.prose)} · fix parseDeclaration in src/crew/agent-results/normalize.ts`)
  const declared = await buildCrewmateResultEnvelope({
    agentId: AGENT_ID,
    status: 'completed',
    finalText: declaredText,
  })
  check('N2b declared fields ride the envelope',
    declared.summary === 'declared summary' &&
    declared.findings[0] === 'f1' &&
    declared.unresolved[0] === 'u1' &&
    declared.recommendedNextAction === 'merge it',
    `${JSON.stringify(declared)} · fix how buildAgentResultEnvelope in src/crew/agent-results/normalize.ts carries the declared fields`)

  const malformed = await buildCrewmateResultEnvelope({
    agentId: AGENT_ID,
    status: 'completed',
    finalText: 'Prose stands.\n<mercury-envelope>{not json at all</mercury-envelope>',
  })
  check('N3 malformed declaration: artifact ref preserved + prose fallback',
    malformed.malformedDeclarationRef?.startsWith('mercury://artifact/agent-results/') === true &&
    malformed.summary === 'Prose stands.' &&
    malformed.artifacts.length === 1,
    `ref ${malformed.malformedDeclarationRef} · summary ${JSON.stringify(malformed.summary)} · artifacts ${malformed.artifacts.length} · fix the malformed-declaration branch of buildAgentResultEnvelope in src/crew/agent-results/normalize.ts`)

  const extraKeys = await buildCrewmateResultEnvelope({
    agentId: AGENT_ID,
    status: 'completed',
    finalText: 'P.\n<mercury-envelope>{"summary":"s","invented_field":true}</mercury-envelope>',
  })
  check('N4 unknown declaration keys refuse (strict) and preserve the raw',
    extraKeys.malformedDeclarationRef !== undefined && extraKeys.summary === 'P.',
    `ref ${extraKeys.malformedDeclarationRef} · summary ${JSON.stringify(extraKeys.summary)} · parseDeclaration in src/crew/agent-results/normalize.ts must refuse unknown keys`)
}

section('O. observed truth — the observer, never prose')
{
  _resetChangeReceiptsForTesting()
  seedReceipt('succeeded', '/tmp/real-a.ts')
  seedReceipt('succeeded', '/tmp/real-b.ts')
  seedReceipt('failed', '/tmp/failed-attempt.ts')
  recordEvidence('/tmp', { command: 'bash scripts/lsp/run-all.sh', ok: true, scope: 'suite', coverage: 'scripts/lsp suite' }, owner)
  recordEvidence('/tmp', { command: 'bun run typecheck', ok: false, scope: 'typecheck', coverage: 'strict typecheck floor' }, owner)

  const env = await buildCrewmateResultEnvelope({
    agentId: AGENT_ID,
    status: 'completed',
    finalText:
      'I changed /tmp/prose-claim.ts and ran everything green.\n<mercury-envelope>{"summary":"work done","checks":["scripts/lsp","scripts/never-ran"]}</mercury-envelope>',
  })
  check('O1 changedPaths are the observed receipts only (prose claims mint nothing)',
    env.changedPaths.length === 2 &&
    env.changedPaths.includes('/tmp/real-a.ts') &&
    env.changedPaths.includes('/tmp/real-b.ts') &&
    !env.changedPaths.includes('/tmp/prose-claim.ts'),
    `changedPaths ${JSON.stringify(env.changedPaths)} · changedPaths must come only from the observed change receipts in buildAgentResultEnvelope (src/crew/agent-results/normalize.ts)`)
  check('O2 failed attempts counted from observed effects', env.failedAttempts === 1, `failedAttempts ${env.failedAttempts} · buildAgentResultEnvelope in src/crew/agent-results/normalize.ts must count failed receipts`)
  const byName = Object.fromEntries(env.checks.map(c => [c.name, c.state]))
  check('O3 declared check matching evidence reads observed',
    byName['scripts/lsp'] === 'observed',
    `checks ${JSON.stringify(byName)} · a declared check must match recorded evidence in buildAgentResultEnvelope (src/crew/agent-results/normalize.ts)`)
  check('O4 declared-but-never-ran check reads unknown',
    byName['scripts/never-ran'] === 'unknown',
    `checks ${JSON.stringify(byName)} · a declared check with no evidence must read unknown in buildAgentResultEnvelope (src/crew/agent-results/normalize.ts)`)
  check('O5 observed-but-undeclared evidence joins with its REAL outcome (failed typecheck)',
    env.checks.some(c => c.state === 'failed' && c.name.includes('typecheck')),
    `checks ${JSON.stringify(env.checks)} · undeclared evidence must join with its real outcome in buildAgentResultEnvelope (src/crew/agent-results/normalize.ts)`)

  const block = formatEnvelopeBlock(env)
  check('O6 the wire block carries observed truth + the ref',
    block.includes('changed (observed): /tmp/real-a.ts') &&
    block.includes('failed/indeterminate attempts (observed): 1') &&
    block.includes(`full output: mercury://agent/${AGENT_ID}`),
    `${block} · fix formatEnvelopeBlock in src/crew/agent-results/normalize.ts`)
}

section('P. a second seat in the same project reports only the checks its own run performed')
{
  const FRESH_ID = 'agent-envelope-fresh-seat'
  const fresh = processOwnerForLane(FRESH_ID)
  const inherited = verificationSummary('/tmp', { skipDigest: true, owner: fresh })
  check('P1 the project history still reaches the fresh seat as tree state (the last persisted check was the failed typecheck)',
    inherited.state === 'failed' && inherited.lastEvidence?.command === 'bun run typecheck', `${inherited.state} · ${inherited.lastEvidence?.command ?? 'no evidence'} · verificationSummary in src/platform/verification/verificationState.ts must still report the persisted project history`)
  const idle = await buildCrewmateResultEnvelope({
    agentId: FRESH_ID,
    status: 'completed',
    finalText: 'Read the brief; ran nothing.\n<mercury-envelope>{"summary":"read only"}</mercury-envelope>',
  })
  check('P2 a seat that ran no check reports no check — the persisted project history is not its observed checks',
    idle.checks.length === 0, idle.checks.map(c => `${c.name}:${c.state}`).join(' · ') + ' · buildAgentResultEnvelope in src/crew/agent-results/normalize.ts must list only checks the seat itself ran')
  recordEvidence('/tmp', { command: 'bun run scripts/eval/prove-output-bounds.ts', ok: true, scope: 'proof', coverage: 'prove-output-bounds.ts' }, fresh)
  const own = await buildCrewmateResultEnvelope({
    agentId: FRESH_ID,
    status: 'completed',
    finalText: 'Ran one proof.\n<mercury-envelope>{"summary":"one proof","checks":["prove-output-bounds"]}</mercury-envelope>',
  })
  check('P3 after its own check the envelope carries exactly that one, observed',
    own.checks.length === 1 && own.checks[0]?.name === 'prove-output-bounds' && own.checks[0]?.state === 'observed', own.checks.map(c => `${c.name}:${c.state}`).join(' · ') + ' · buildAgentResultEnvelope in src/crew/agent-results/normalize.ts must carry the seat own evidence')
  check('P4 the seat that performed the checks still reports them',
    (await buildCrewmateResultEnvelope({ agentId: AGENT_ID, status: 'completed', finalText: 'done' })).checks.length === 2,
    'the seat that ran the checks must still report both · buildAgentResultEnvelope in src/crew/agent-results/normalize.ts')

  _resetVerificationStateForTesting()
  const RESUMED_ID = 'agent-envelope-resumed-seat'
  const resumed = processOwnerForLane(RESUMED_ID)
  const afterRestart = verificationSummary('/tmp', { skipDigest: true, owner: resumed })
  const store = readFileSync(join(getMercuryHome(), 'verify', sanitizePath('/tmp'), 'evidence.json'), 'utf8')
  check('P5 after a restart the store still answers tree state, and the store carries no in-memory marker',
    afterRestart.lastEvidence?.command === 'bun run scripts/eval/prove-output-bounds.ts' && !store.includes('inherited'),
    `${afterRestart.lastEvidence?.command ?? 'no evidence'} · marker in store: ${store.includes('inherited')} · the inherited marker must stay in memory only, see the persist and load code in src/platform/verification/verificationState.ts`)
  const resumedEnvelope = await buildCrewmateResultEnvelope({
    agentId: RESUMED_ID,
    status: 'completed',
    finalText: 'Resumed; ran nothing this time.\n<mercury-envelope>{"summary":"resumed"}</mercury-envelope>',
  })
  check('P6 a resumed seat with zero tool uses reports zero checks', resumedEnvelope.checks.length === 0, resumedEnvelope.checks.map(c => `${c.name}:${c.state}`).join(' · ') + ' · inherited records must not count as the seat own checks in src/platform/verification/verificationState.ts and src/crew/agent-results/normalize.ts')
}

section('B. the AgentTool parent boundary')
{
  const { CrewmateTool } = await import('../../src/tools/crewmate/CrewmateTool.tsx')
  const map = (CrewmateTool as { mapToolResultToToolResultBlockParam: Function })
    .mapToolResultToToolResultBlockParam
  const data = {
    status: 'completed',
    agentId: AGENT_ID,
    agentType: 'custom-role',
    content: [{ type: 'text', text: 'final prose' }],
    totalTokens: 10,
    totalToolUseCount: 2,
    totalDurationMs: 30,
  }
  const envelope = await buildCrewmateResultEnvelope({
    agentId: AGENT_ID,
    status: 'completed',
    finalText: 'final prose',
  })
  attachCrewmateEnvelope(data, envelope)
  check('B0 the ingest side-channel round-trips', envelopeFor(data) === envelope, 'attachAgentEnvelope and envelopeFor in src/crew/agent-results/ingest.ts must return the same envelope object')
  const block = map(data, 'toolu_b')
  const trailer = (block.content as { text: string }[])[1]?.text ?? ''
  check('B1 the completed trailer carries the envelope block',
    trailer.includes('<envelope v="1" status="completed">') &&
    trailer.includes('full output: mercury://agent/'),
    `trailer ${JSON.stringify(trailer)} · mapToolResultToToolResultBlockParam in src/tools/crewmate/CrewmateTool.tsx must append the envelope block`)
  const oneShot = map({ ...data, agentType: 'mercury-scout' }, 'toolu_b2')
  check('B2 one-shot builtins still drop the whole trailer (envelope included)',
    (oneShot.content as unknown[]).length === 1,
    `content blocks ${(oneShot.content as unknown[]).length} · mapToolResultToToolResultBlockParam in src/tools/crewmate/CrewmateTool.tsx must drop the trailer for one-shot builtin agents`)
  const noEnvelope = map({ ...data, agentId: 'other-agent' }, 'toolu_b3')
  const plainTrailer = (noEnvelope.content as { text: string }[])[1]?.text ?? ''
  check('B3 a data object without an attached envelope keeps the pre-slice trailer',
    plainTrailer.includes('<usage>') && !plainTrailer.includes('<envelope'),
    `trailer ${JSON.stringify(plainTrailer)} · mapToolResultToToolResultBlockParam in src/tools/crewmate/CrewmateTool.tsx must keep the usage trailer when no envelope is attached`)
}

section('A. the async completion notification')
{
  const { enqueueCrewmateNotification } = await import(
    '../../src/engine/tasks/local-agent/crewmateTask.tsx'
  )
  const { dequeueAll } = await import('../../src/daemon/runner/messageQueueManager.ts')
  dequeueAll()

  let state: {
    tasks: Record<string, Record<string, unknown>>
    speculation: { status: string }
  } = {
    tasks: {
      [AGENT_ID]: {
        id: AGENT_ID,
        type: 'local_agent',
        status: 'completed',
        description: 'fixture agent',
        notified: false,
        startTime: Date.now(),
        outputFile: '/tmp/out',
        outputOffset: 0,
      },
    },
    speculation: { status: 'idle' },
  }
  const setAppState = (fn: (prev: typeof state) => typeof state): void => {
    state = fn(state)
  }

  enqueueCrewmateNotification({
    taskId: AGENT_ID,
    description: 'fixture agent',
    status: 'completed',
    setAppState: setAppState as never,
    finalMessage: 'done',
    envelopeBlock: formatEnvelopeBlock(
      await buildCrewmateResultEnvelope({
        agentId: AGENT_ID,
        status: 'completed',
        finalText: 'done',
      }),
    ),
  })
  const queued = dequeueAll()
  check('A1 the notification carries the envelope block',
    queued.length === 1 &&
    String((queued[0] as { value?: string }).value).includes('<envelope v="1"'),
    `queued ${queued.length} · enqueueAgentNotification in src/engine/tasks/local-agent/crewmateTask.tsx must include envelopeBlock in the notification`)

  enqueueCrewmateNotification({
    taskId: AGENT_ID,
    description: 'fixture agent',
    status: 'completed',
    setAppState: setAppState as never,
    finalMessage: 'done again',
  })
  check('A2 duplicate delivery is latched (exactly-once)', dequeueAll().length === 0, 'enqueueAgentNotification in src/engine/tasks/local-agent/crewmateTask.tsx must skip a task already marked notified')
}

section('D. doctrine splice')
{
  const { buildCrewmateMercurySections } = await import(
    '../../src/tools/crewmate/subagentDoctrine.ts'
  )
  const sections = buildCrewmateMercurySections({
    agentDefinition: { agentType: 'mercury-crew' } as never,
  })
  check('D1 the envelope doctrine reaches spawned agents',
    sections.some(s => s.includes('mercury-envelope')),
    'buildSubagentMercurySections in src/tools/crewmate/subagentDoctrine.ts must add ENVELOPE_DOCTRINE while change receipts are on')
  check('D2 the doctrine text is the contracts export, and it ends on the fields (the cross-check claim rides the seat contract, not the envelope)', ENVELOPE_DOCTRINE.endsWith('(names of verification commands you actually ran).') && !ENVELOPE_DOCTRINE.includes('cross-checked') && sections.some(s => s === ENVELOPE_DOCTRINE),
    'ENVELOPE_DOCTRINE in src/crew/agent-results/contracts.ts must end on the fields and buildSubagentMercurySections must splice it unchanged')

  process.env.MERCURY_CHANGE_RECEIPTS = '0'
  const off = buildCrewmateMercurySections({
    agentDefinition: { agentType: 'mercury-crew' } as never,
  })
  check('D3 gate OFF drops the doctrine (byte-identical prompts)',
    !off.some(s => s.includes('mercury-envelope')),
    'buildSubagentMercurySections in src/tools/crewmate/subagentDoctrine.ts must drop the doctrine when MERCURY_CHANGE_RECEIPTS is 0')
  delete process.env.MERCURY_CHANGE_RECEIPTS
}

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ agent envelope: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ agent envelope: every law holds')
