;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'
import { isDeepStrictEqual } from 'node:util'

const t = checker()
const { permissionAskWire, permissionAllowedOf, permissionAnswerOf } = await import('../../src/services/acp/acpServer.ts')
const { questionFormOf } = await import('../../src/services/acp/questionForm.ts')
const { AskUserQuestionTool } = await import('../../src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx')

const input = {
  questions: [
    {
      id: 'iq_engine', decisionId: 'id_engine', question: 'Which storage engine should the cache use?', header: 'Cache', multiSelect: false,
      options: [
        { id: 'io_redis', label: 'Redis', description: 'Shared network cache.', preview: '### Redis\n\nshared' },
        { id: 'io_mem', label: 'In-memory', description: 'Process-local.' },
      ],
    },
  ],
  answers: {},
}
const ask = { kind: 'tool' as const, tool_use_id: 'toolu_abc', tool_name: 'AskUserQuestion', input }
const form = questionFormOf(ask, 'acp-sess-1')
t.check('a valid interview builds a form', form !== null)
if (!form) throw new Error('the interview form is absent')

t.section('the form preserves interview meaning and identity')
t.check('the form identifies its tool call and session', form.request.sessionId === 'acp-sess-1' && form.request.toolCallId === 'toolu_abc')
t.check('the form has a meaningful action title', form.request.message === "Answer Mercury's questions")
t.check('the complete question input crosses without rewriting', form.request._meta?.['mercury/input'] === input)
const schema = form.request.requestedSchema as { properties: Record<string, { type: string; oneOf?: Array<{ const: string; title: string; description: string }> }> }
t.check('stable question identity addresses the selection', schema.properties.iq_engine?.type === 'string')
t.check('stable option identity addresses Redis', schema.properties.iq_engine?.oneOf?.[0]?.const === 'io_redis')
t.check('option wording, trade-off and preview stay readable', schema.properties.iq_engine?.oneOf?.[0]?.title === 'Redis' && schema.properties.iq_engine.oneOf[0].description === 'Shared network cache.\n\n### Redis\n\nshared')

t.section('the answer edits only the answer fields and reaches the actual tool')
const decision = form.answer({ action: 'accept', content: { iq_engine: 'io_redis' } })
t.check('a complete selection allows the answered tool input', decision.outcome === 'allow' && decision.input !== undefined)
if (decision.outcome !== 'allow' || !decision.input) throw new Error('the selection did not produce answered input')
t.check('the question, decision and option identities survive', decision.input.questions === input.questions)
const parsed = AskUserQuestionTool.inputSchema.safeParse(decision.input)
t.check('the answered input parses through the tool schema', parsed.success)
if (!parsed.success) throw new Error('the tool refused the answered input')
const output = await AskUserQuestionTool.call(parsed.data as never, {} as never, {} as never, {} as never, {} as never)
t.check('the tool receives the selected label under the question identity', (output.data as { answers: Record<string, string> }).answers.iq_engine === 'Redis')
t.check('the tool receives the submitted outcome', (output.data as { outcome: { kind: string } }).outcome.kind === 'answers-submitted')
t.check('the selected preview reaches the tool', (output.data as { annotations: Record<string, { preview: string }> }).annotations.iq_engine?.preview === '### Redis\n\nshared')
t.check('unselected input remains unchanged', isDeepStrictEqual(input.answers, {}))

t.section('a form answer fails closed unless complete')
for (const answer of [null, {}, { action: 'decline' }, { action: 'cancel' }, { action: 'accept' }, { action: 'accept', content: {} }, { action: 'accept', content: { iq_engine: 'unknown' } }, { action: 'accept', content: { iq_engine: ['io_redis'] } }]) {
  t.check(`invalid or declined answer denies: ${JSON.stringify(answer)}`, form.answer(answer).outcome === 'deny')
}
const custom = form.answer({ action: 'accept', content: { iq_engine: 'other', iq_engine__other: 'Use the local database.' } })
t.check('the custom answer crosses verbatim', custom.outcome === 'allow' && (custom.input?.answers as Record<string, string>).iq_engine === 'Use the local database.')
t.check('a blank custom answer cannot complete the interview', form.answer({ action: 'accept', content: { iq_engine: 'other', iq_engine__other: ' ' } }).outcome === 'deny')
t.check('malformed question input has no form', questionFormOf({ ...ask, input: {} }, 's') === null)

t.section('ordinary permission decisions preserve their own contract')
const wire = permissionAskWire({ toolUseId: 'toolu_edit', toolName: 'Edit', input: { file_path: 'file.ts' }, title: 'Edit file.ts' }, 7, 's')
t.check('the permission title names the action', wire.toolCall.title === 'Edit file.ts')
t.check('the permission call identity is stable', wire.toolCall.toolCallId === 'toolu_edit')
t.check('an id-less permission has a stable fallback', permissionAskWire({ toolName: 'Read', input: {} }, 7, 's').toolCall.toolCallId === 'ask-7')
t.check('only explicit allow grants permission', permissionAllowedOf({ outcome: { outcome: 'selected', optionId: 'allow' } }))
for (const result of [{ outcome: { outcome: 'selected', optionId: 'deny' } }, { outcome: { outcome: 'cancelled' } }, { outcome: { outcome: 'unknown', optionId: 'allow' } }]) {
  t.check('dismissal and malformed choices deny', !permissionAllowedOf(result) && permissionAnswerOf(result, {}).outcome === 'deny')
}
t.check('ordinary allow carries no invented input', isDeepStrictEqual(permissionAnswerOf({ outcome: { outcome: 'selected', optionId: 'allow' } }, {}), { outcome: 'allow' }))
t.finish('prove-acp-interview-contract')
