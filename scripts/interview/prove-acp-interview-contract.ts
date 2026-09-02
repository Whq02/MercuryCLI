#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-acp-interview-contract.ts — at the landed
//  projection: ACP/VS Code clients preserve interview MEANING and decision
//  identity. Scope per the ruling: contract tests over the
//  generic tool-call/permission projection (src/services/acp/acpServer.ts);
//  the extension-host GUI journey stays a follow-on.
//
//    §1  the ask wire carries the interview input VERBATIM — declared
//        question/decision/option ids, option text, trade-offs, previews,
//        multiSelect — and the toolCallId IS the tool_use id;
//    §2  the client's answer decides the ONE way: only an explicit allow
//        allows; deny, dismissal, and unknown outcomes all reject;
//    §3  the allow path echoes the input UNCHANGED and the channel fails
//        CLOSED (source-pinned at the one handler);
//    §4  the id-carrying input that crossed the wire still parses through
//        the REAL tool schema with identity intact — the round trip loses
//        no meaning.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const { permissionAskWire, permissionAllowedOf } = await import(
  '../../src/services/acp/acpServer.ts'
)
const { AskUserQuestionTool } = await import(
  '../../src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx'
)

const INTERVIEW_INPUT = {
  questions: [
    {
      id: 'iq_engine',
      decisionId: 'id_engine',
      question: 'Which storage engine should the cache use?',
      header: 'Cache',
      multiSelect: false,
      options: [
        { id: 'io_redis', label: 'Redis', description: 'Shared network cache.', preview: '### Redis\n\nshared' },
        { id: 'io_mem', label: 'In-memory', description: 'Process-local.' },
      ],
    },
  ],
  answers: {},
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — the ask wire carries the interview input verbatim')
{
  const wire = permissionAskWire(
    { toolUseId: 'toolu_abc', toolName: 'AskUserQuestion', input: INTERVIEW_INPUT },
    7,
    'acp-sess-1',
  )
  t.check('rawInput is the SAME object — nothing re-encodes meaning', wire.toolCall.rawInput === INTERVIEW_INPUT)
  t.check('the toolCallId IS the tool_use id', wire.toolCall.toolCallId === 'toolu_abc')
  t.check('an id-less ask still gets a stable call id', permissionAskWire({ toolName: 'AskUserQuestion', input: {} }, 7, 's').toolCall.toolCallId === 'ask-7')
  t.check('the title names the tool', wire.toolCall.title === 'AskUserQuestion')
  t.check(
    'exactly allow/deny with the documented kinds',
    wire.options.map(o => `${o.optionId}:${o.kind}`).join(',') === 'allow:allow_once,deny:reject_once',
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — the answer decides the ONE way')
{
  t.check('an explicit allow allows', permissionAllowedOf({ outcome: { outcome: 'selected', optionId: 'allow' } }))
  t.check('an explicit deny rejects', !permissionAllowedOf({ outcome: { outcome: 'selected', optionId: 'deny' } }))
  t.check('a dismissal rejects', !permissionAllowedOf({ outcome: { outcome: 'cancelled' } }))
  t.check('an unknown outcome rejects', !permissionAllowedOf({ outcome: { outcome: 'weird', optionId: 'allow' } }))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§3 — the handler echoes the input unchanged and fails closed')
{
  const src = readFileSync('src/services/acp/acpServer.ts', 'utf8')
  t.check(
    'the ONE handler routes through the contract seam',
    src.includes('permissionAskWire(ask, requestId, acpSessionId)') &&
      src.includes('const allowed = permissionAllowedOf(result)'),
  )
  t.check(
    'the allow echoes the input UNCHANGED',
    src.includes('child.answerPermission(requestId, allowed, { updatedInput: ask.input })'),
  )
  t.check(
    'a broken channel fails CLOSED',
    /catch \(e\) \{[^}]*answerPermission\(requestId, false/s.test(src),
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§4 — the round trip loses no meaning')
{
  const parsed = AskUserQuestionTool.inputSchema.safeParse(INTERVIEW_INPUT)
  t.check('the wire input parses through the REAL tool schema', parsed.success)
  if (parsed.success) {
    const q = (parsed.data.questions ?? [])[0] as Record<string, unknown>
    t.check('the question id survived', q.id === 'iq_engine')
    t.check('the decision id survived', q.decisionId === 'id_engine')
    const opts = q.options as { id?: string; preview?: string }[]
    t.check('the option ids survived', opts.map(o => o.id).join(',') === 'io_redis,io_mem')
    t.check('the preview text survived (readable trade-off for any client)', opts[0]?.preview?.includes('Redis') === true)
  }
}

t.finish('prove-acp-interview-contract')
