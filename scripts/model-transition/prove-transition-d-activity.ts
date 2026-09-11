#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeOnlyText } from '../lib/codeText.ts'

const HOME = mkdtempSync(join(tmpdir(), 'ctm-d-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'

const act = await import('../../src/services/crew/activity.js')
const dispatch = await import('../../src/services/crew/dispatch.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '../..')

function seatInput(kind: string, payload: Record<string, unknown>, sourceEventId = `e-${Math.abs(JSON.stringify(payload).length)}-${kind}`): Parameters<typeof act.classifyActivity>[0] {
  return {
    event: { kind, payload, sourceEventId, atMs: 1754000000000 } as never,
    agentId: 'crew:test-agent' as never,
    sessionId: 'sess-1',
    adapterKind: 'claude-code',
    conversationId: 'conv-1',
  }
}

section('§A D01 — the four continuity classifiers through the declared extension point')
{
  const order = act.activityClassifierOrder()
  for (const name of ['model-transition', 'branch-boundary', 'context-plan', 'session-connect']) {
    check(`classifier registered: ${name}`, order.some(c => c.name === name))
  }
  const transition = act.classifyActivity(
    seatInput('system.model_transition', {
      type: 'system',
      subtype: 'model_transition',
      transition: { previous: 'claude-opus-5', requested: 'gpt-5.6-sol', applied: 'gpt-5.6-sol', resolution: 'applied', boundary: 'idle', cross_provider: true, cache_disposition: 'reset' },
    }),
  )
  check('a transition frame lifts class handoff / switched model', transition.class === 'handoff' && transition.verb === 'switched model')
  check('…with the route in the label', transition.objectLabel.includes('claude-opus-5 → gpt-5.6-sol') && transition.objectLabel.includes('cross-provider'))
  check('…and the resolution as outcome', transition.outcomeLabel === 'applied' && transition.phase === 'succeeded')

  const branch = act.classifyActivity(
    seatInput('system.fork_boundary', { type: 'system', subtype: 'fork_boundary', parentSessionId: 'aaaabbbb-1111-2222-3333-444455556666', forkOrdinal: 12, branchSessionId: 'x' }),
  )
  check('a fork boundary lifts verb branched with lineage', branch.class === 'session-lifecycle' && branch.verb === 'branched' && branch.objectLabel.includes('aaaabbbb') && branch.objectLabel.includes('12'))
  const rewind = act.classifyActivity(
    seatInput('system.rewind_boundary', { type: 'system', subtype: 'rewind_boundary', parentSessionId: 'aaaabbbb-1111-2222-3333-444455556666', forkOrdinal: 5 }),
  )
  check('a rewind boundary lifts verb rewound', rewind.verb === 'rewound')

  const compact = act.classifyActivity(
    seatInput('system.compact_boundary', { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } }),
  )
  check('a compact boundary lifts the context-plan row', compact.class === 'plan' && compact.verb === 'compacted' && compact.outcomeLabel === 'auto')

  const connect = act.classifyActivity(
    seatInput('system.init', { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5' }),
  )
  check('an init frame lifts the (re)connect row', connect.class === 'session-lifecycle' && connect.verb === 'connected')
  check('…not the generic lifecycle fallback (precedence outranks)', connect.objectLabel === 'the session')
}

section('§B intake C — model identity lifted once, surfaced at the WORK rows')
{
  const assistant = act.classifyActivity(
    seatInput('assistant', {
      type: 'assistant',
      message: { id: 'msg_1', model: 'claude-fable-5', content: [{ type: 'text', text: 'hello there' }] },
    }),
  )
  check('an assistant frame carries its model onto the row', assistant.model === 'claude-fable-5')
  const init = act.classifyActivity(
    seatInput('system.init', { type: 'system', subtype: 'init', model: 'gpt-5.6-sol' }),
  )
  check('an init frame carries payload.model onto the row', init.model === 'gpt-5.6-sol')
  const toolFrame = act.classifyActivity(
    seatInput('assistant', {
      type: 'assistant',
      message: { id: 'msg_2', model: 'glm-5', content: [{ type: 'tool_use', id: 'tu_9', name: 'Bash', input: { command: 'ls' } }] },
    }),
  )
  check('EVERY classifier inherits the lift (tool row carries model too)', toolFrame.model === 'glm-5')
  const modelless = act.classifyActivity(
    seatInput('system.compact_boundary', { type: 'system', subtype: 'compact_boundary' }),
  )
  check('a frame without model identity stays honest (absent, never guessed)', modelless.model === undefined)
  const crewCmd = readFileSync(join(ROOT, 'src/commands/crew/index.ts'), 'utf8')
  check('the surviving activity consumer (/crew) reads the one owner', /activityRows|cachedActivityFeed/.test(crewCmd))
}

section('§C D05 — activity rows settle in place')
{
  act._resetActivityFeedForTesting()
  act.ingestActivity(
    seatInput('assistant', {
      type: 'assistant',
      message: { id: 'msg_3', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'tu_settle', name: 'Bash', input: { command: 'bun test' } }] },
    }),
  )
  const afterStart = act.cachedActivityFeed()
  const started = afterStart.order.length
  act.ingestActivity(
    seatInput('user', {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_settle', content: 'ok' }] },
    }),
  )
  const afterSettle = act.cachedActivityFeed()
  check('the result folds into the SAME row (no duplicate)', afterSettle.order.length === started, `rows=${afterSettle.order.length}`)
  const row = afterSettle.rows.get(afterSettle.order.find(id => id.includes('tu_settle'))!)
  check('the row settled in place (phase left running)', row !== undefined && row.phase !== 'running', row?.phase)
  check('the activityId stayed the owner id (stable key)', row !== undefined && row.activityId.includes('tool:tu_settle'))
  act._resetActivityFeedForTesting()
}

section('§D D02 — identical identities across shared views')
{
  const a = act.classifyActivity(seatInput('assistant', { type: 'assistant', message: { id: 'm', model: 'x', content: [{ type: 'text', text: 'hi' }] } }))
  check('agent/session/conversation ids pass through verbatim', String(a.agentId) === 'crew:test-agent' && a.sessionId === 'sess-1' && a.conversationId === 'conv-1')
  const i1 = seatInput('assistant', { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'x' }] } }, 'stable-ev')
  const id1 = act.activityIdOf(i1)
  const id2 = act.activityIdOf(i1)
  check('activityId is deterministic (same input ⇒ same id)', id1 === id2)
  check('…and session-scoped (two seats never fold each other)', id1.startsWith('claude-code:sess-1:'))
}

section('§E D07 — one vocabulary, versioned projections, no parallel truth')
{
  const { execSync } = await import('node:child_process')
  const defs = execSync("grep -rl 'ACTIVITY_CLASSES = \\[' src --include='*.ts' --include='*.tsx'", { encoding: 'utf8' }).trim().split('\n')
  check('exactly ONE ACTIVITY_CLASSES definition tree-wide', defs.length === 1 && defs[0] === 'src/services/crew/activity.ts', defs.join(','))
  const acp = readFileSync(join(ROOT, 'src/services/acp/acpServer.ts'), 'utf8')
  check('the ACP crew surface consumes THE crew owners (same ids, same folds)', acp.includes("'_mercury/crew'") && acp.includes('resolveCrewSnapshot') && acp.includes('deriveInbox'))
  const model = 'model?: string'
  const activitySrc = readFileSync(join(ROOT, 'src/services/crew/activity.ts'), 'utf8')
  check('the model field is ADDITIVE (versioned forward — optional)', activitySrc.includes(model))
}

section('§G D03/D04 — role/handoff/delivery truth where it ships')
{
  check('tri-state delivery is the exported vocabulary', JSON.stringify(dispatch.DELIVERY_STATES) === JSON.stringify(['delivered', 'not-delivered', 'delivery-unknown']))
  const dispatchCode = codeOnlyText('dispatch.ts', readFileSync(join(ROOT, 'src/services/crew/dispatch.ts'), 'utf8'))
  check(
    'delivery-unknown receipts are NEVER evicted by resolved churn (the ring partitions them and bounds them apart)',
    dispatchCode.includes("const unknown = file.receipts.filter(r => r.state === 'delivery-unknown')") &&
      dispatchCode.includes('const keptUnknown = new Set(unknown.slice(-MAX_RECEIPTS))') &&
      dispatchCode.includes('receipts: file.receipts.filter(r => keptResolved.has(r) || keptUnknown.has(r))'),
  )
  check(
    '…and carry the no-auto-retry prohibition (a same-id retry of an unresolved outcome returns the recorded receipt unless the adapter declared idempotency)',
    /if \(retryingUnknown && !seat\.declaresIdempotentDelivery\) \{\s*return retryingUnknown\s*\}/.test(dispatchCode) &&
      /if \(retryingUnknown\) \{\s*return retryingUnknown\s*\}/.test(dispatchCode),
  )
  const handoffSrc = readFileSync(join(ROOT, 'src/services/crew/consoleHandoff.ts'), 'utf8')
  check('handoff links BOTH lineages with no id change', handoffSrc.includes("linkConversation(sideConversationId, targetConversationId, 'handoff'"))
  check('a conversation cannot hand off to itself (typed refusal)', handoffSrc.includes('cannot hand off to itself'))
  for (const suite of ['scripts/helm-console/run-all.sh', 'scripts/crew/run-all.sh']) {
    const { existsSync } = await import('node:fs')
    check(`standing journey suite present: ${suite}`, existsSync(join(ROOT, suite)))
  }
}

console.log(
  failures === 0
    ? '\n ✅ ACTIVITY — one vocabulary, settled rows, ratified cursor, shipped role truth'
    : `\n ❌ ACTIVITY — ${failures} failure(s)`,
)
process.exit(failures === 0 ? 0 : 1)
