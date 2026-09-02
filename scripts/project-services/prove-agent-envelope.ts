#!/usr/bin/env bun
// ============================================================================
//  scripts/project-services/prove-agent-envelope.ts — the
//  AgentResultEnvelope, proved against the PRODUCTION normalizer, the real
//  effect-observer feed, the AgentTool parent boundary, and the async
//  completion notification (exactly-once latch included).
//
//  Laws:
//    N. normalizer — legacy prose ⇒ honest minimal envelope; a declared
//       <mercury-envelope> tail ⇒ declared fields; a MALFORMED tail ⇒ raw
//       preserved as an artifact + legacy fallback (never silently dropped)
//    O. observed truth — changedPaths/failedAttempts come from the agent
//       lane's receipts; prose claims mint nothing; declared checks resolve
//       observed/failed/unknown against real evidence records
//    B. the AgentTool boundary — the completed trailer carries the envelope
//       block; one-shot builtins keep dropping the whole trailer
//    A. the async notification — the envelope block rides the task
//       notification; the notified latch stays exactly-once
//
//  Run:  ~/.bun/bin/bun run scripts/project-services/prove-agent-envelope.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vanguard-envelope-'))
delete process.env.MERCURY_CHANGE_RECEIPTS

const { buildAgentResultEnvelope, formatEnvelopeBlock, parseDeclaration } = await import(
  '../../src/services/agentResults/normalize.ts'
)
const { ENVELOPE_DOCTRINE } = await import('../../src/services/agentResults/contracts.ts')
const { attachAgentEnvelope, envelopeFor } = await import(
  '../../src/services/agentResults/ingest.ts'
)
const { observeToolTerminal } = await import('../../src/services/run/effectObserver.ts')
const { processOwnerForLane } = await import('../../src/services/run/resolveOwner.ts')
const { recordEvidence, _resetForTesting } = await import(
  '../../src/utils/verification/verificationState.ts'
).then(m => ({
  recordEvidence: (m as Record<string, unknown>).recordEvidence as Function,
  _resetForTesting: null,
}))
const { _resetChangeReceiptsForTesting } = await import(
  '../../src/services/changeTransaction/receipts.ts'
)

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

// ── N. normalizer ───────────────────────────────────────────────────────────
section('N. normalizer laws')
{
  _resetChangeReceiptsForTesting()

  // N1: legacy prose — honest minimal envelope.
  const legacy = await buildAgentResultEnvelope({
    agentId: AGENT_ID,
    status: 'completed',
    finalText: 'I did some work.\n'.repeat(100),
  })
  check('N1 legacy prose: clipped summary, no invented findings/checks',
    legacy.summary.length <= 501 &&
    legacy.findings.length === 0 &&
    legacy.checks.length === 0 &&
    legacy.changedPaths.length === 0 &&
    legacy.fullOutputRef === `mercury://agent/${AGENT_ID}`)

  // N2: declared tail — declared fields win, prose stripped from summary.
  const declaredText =
    'Long prose here.\n<mercury-envelope>{"summary":"declared summary","findings":["f1"],"unresolved":["u1"],"recommendedNextAction":"merge it"}</mercury-envelope>'
  const parsed = parseDeclaration(declaredText)
  check('N2a parseDeclaration strips the block from prose',
    parsed.declared?.summary === 'declared summary' && parsed.prose === 'Long prose here.')
  const declared = await buildAgentResultEnvelope({
    agentId: AGENT_ID,
    status: 'completed',
    finalText: declaredText,
  })
  check('N2b declared fields ride the envelope',
    declared.summary === 'declared summary' &&
    declared.findings[0] === 'f1' &&
    declared.unresolved[0] === 'u1' &&
    declared.recommendedNextAction === 'merge it')

  // N3: malformed tail — raw preserved as artifact, legacy fallback.
  const malformed = await buildAgentResultEnvelope({
    agentId: AGENT_ID,
    status: 'completed',
    finalText: 'Prose stands.\n<mercury-envelope>{not json at all</mercury-envelope>',
  })
  check('N3 malformed declaration: artifact ref preserved + prose fallback',
    malformed.malformedDeclarationRef?.startsWith('mercury://artifact/agent-results/') === true &&
    malformed.summary === 'Prose stands.' &&
    malformed.artifacts.length === 1)

  // N4: unknown extra keys are malformed (strict schema), not silently eaten.
  const extraKeys = await buildAgentResultEnvelope({
    agentId: AGENT_ID,
    status: 'completed',
    finalText: 'P.\n<mercury-envelope>{"summary":"s","invented_field":true}</mercury-envelope>',
  })
  check('N4 unknown declaration keys refuse (strict) and preserve the raw',
    extraKeys.malformedDeclarationRef !== undefined && extraKeys.summary === 'P.')
}

// ── O. observed truth ───────────────────────────────────────────────────────
section('O. observed truth — the observer, never prose')
{
  _resetChangeReceiptsForTesting()
  seedReceipt('succeeded', '/tmp/real-a.ts')
  seedReceipt('succeeded', '/tmp/real-b.ts')
  seedReceipt('failed', '/tmp/failed-attempt.ts')
  recordEvidence('/tmp', { command: 'bash scripts/lsp/run-all.sh', ok: true, scope: 'suite', coverage: 'scripts/lsp suite' }, owner)
  recordEvidence('/tmp', { command: 'bun run typecheck', ok: false, scope: 'typecheck', coverage: 'strict typecheck floor' }, owner)

  const env = await buildAgentResultEnvelope({
    agentId: AGENT_ID,
    status: 'completed',
    finalText:
      'I changed /tmp/prose-claim.ts and ran everything green.\n<mercury-envelope>{"summary":"work done","checks":["scripts/lsp","scripts/never-ran"]}</mercury-envelope>',
  })
  check('O1 changedPaths are the observed receipts only (prose claims mint nothing)',
    env.changedPaths.length === 2 &&
    env.changedPaths.includes('/tmp/real-a.ts') &&
    env.changedPaths.includes('/tmp/real-b.ts') &&
    !env.changedPaths.includes('/tmp/prose-claim.ts'))
  check('O2 failed attempts counted from observed effects', env.failedAttempts === 1)
  const byName = Object.fromEntries(env.checks.map(c => [c.name, c.state]))
  check('O3 declared check matching evidence reads observed',
    byName['scripts/lsp'] === 'observed')
  check('O4 declared-but-never-ran check reads unknown',
    byName['scripts/never-ran'] === 'unknown')
  check('O5 observed-but-undeclared evidence joins with its REAL outcome (failed typecheck)',
    env.checks.some(c => c.state === 'failed' && c.name.includes('typecheck')))

  const block = formatEnvelopeBlock(env)
  check('O6 the wire block carries observed truth + the ref',
    block.includes('changed (observed): /tmp/real-a.ts') &&
    block.includes('failed/indeterminate attempts (observed): 1') &&
    block.includes(`full output: mercury://agent/${AGENT_ID}`))
}

// ── B. the AgentTool boundary ───────────────────────────────────────────────
section('B. the AgentTool parent boundary')
{
  const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
  const map = (AgentTool as { mapToolResultToToolResultBlockParam: Function })
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
  const envelope = await buildAgentResultEnvelope({
    agentId: AGENT_ID,
    status: 'completed',
    finalText: 'final prose',
  })
  attachAgentEnvelope(data, envelope)
  check('B0 the ingest side-channel round-trips', envelopeFor(data) === envelope)
  const block = map(data, 'toolu_b')
  const trailer = (block.content as { text: string }[])[1]?.text ?? ''
  check('B1 the completed trailer carries the envelope block',
    trailer.includes('<envelope v="1" status="completed">') &&
    trailer.includes('full output: mercury://agent/'))
  const oneShot = map({ ...data, agentType: 'Explore' }, 'toolu_b2')
  check('B2 one-shot builtins still drop the whole trailer (envelope included)',
    (oneShot.content as unknown[]).length === 1)
  const noEnvelope = map({ ...data, agentId: 'other-agent' }, 'toolu_b3')
  const plainTrailer = (noEnvelope.content as { text: string }[])[1]?.text ?? ''
  check('B3 a data object without an attached envelope keeps the pre-slice trailer',
    plainTrailer.includes('<usage>') && !plainTrailer.includes('<envelope'))
}

// ── A. the async notification ───────────────────────────────────────────────
section('A. the async completion notification')
{
  const { enqueueAgentNotification } = await import(
    '../../src/tasks/LocalAgentTask/LocalAgentTask.tsx'
  )
  const { dequeueAll } = await import('../../src/utils/messageQueueManager.ts')
  dequeueAll()

  // Minimal AppState holder with one live agent task (+ the speculation
  // field abortSpeculation reads on the notification path).
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

  enqueueAgentNotification({
    taskId: AGENT_ID,
    description: 'fixture agent',
    status: 'completed',
    setAppState: setAppState as never,
    finalMessage: 'done',
    envelopeBlock: formatEnvelopeBlock(
      await buildAgentResultEnvelope({
        agentId: AGENT_ID,
        status: 'completed',
        finalText: 'done',
      }),
    ),
  })
  const queued = dequeueAll()
  check('A1 the notification carries the envelope block',
    queued.length === 1 &&
    String((queued[0] as { value?: string }).value).includes('<envelope v="1"'))

  // Exactly-once: the notified latch swallows a duplicate delivery.
  enqueueAgentNotification({
    taskId: AGENT_ID,
    description: 'fixture agent',
    status: 'completed',
    setAppState: setAppState as never,
    finalMessage: 'done again',
  })
  check('A2 duplicate delivery is latched (exactly-once)', dequeueAll().length === 0)
}

// ── D. doctrine presence ────────────────────────────────────────────────────
section('D. doctrine splice')
{
  const { buildSubagentMercurySections } = await import(
    '../../src/constants/subagentDoctrine.ts'
  )
  const sections = buildSubagentMercurySections({
    agentDefinition: { agentType: 'general-purpose' } as never,
  })
  check('D1 the envelope doctrine reaches spawned agents',
    sections.some(s => s.includes('mercury-envelope')))
  check('D2 the doctrine text is the contracts export', ENVELOPE_DOCTRINE.includes('never claim work'))

  process.env.MERCURY_CHANGE_RECEIPTS = '0'
  const off = buildSubagentMercurySections({
    agentDefinition: { agentType: 'general-purpose' } as never,
  })
  check('D3 gate OFF drops the doctrine (byte-identical prompts)',
    !off.some(s => s.includes('mercury-envelope')))
  delete process.env.MERCURY_CHANGE_RECEIPTS
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ agent envelope: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ agent envelope: every law holds')
