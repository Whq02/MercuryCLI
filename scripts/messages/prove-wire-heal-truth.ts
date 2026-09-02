#!/usr/bin/env bun
import {
  createAssistantMessage,
  createUserMessage,
  healWalkableForWire,
  orderToolResultsByUse,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
} from '../../src/utils/messages.ts'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../src/types/message.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

function asst(id: string, blocks: unknown[]): AssistantMessage {
  const m = createAssistantMessage({ content: blocks as never })
  return { ...m, message: { ...m.message, id } }
}
const use = (id: string) => ({
  type: 'tool_use',
  id,
  name: 'Read',
  input: { file_path: '/tmp/' + id },
})
const tr = (id: string) => ({
  type: 'tool_result',
  tool_use_id: id,
  content: [{ type: 'text', text: 'RESULT-' + id }],
})
const userTr = (...ids: string[]): UserMessage =>
  createUserMessage({ content: ids.map(tr) as never })
const userText = (text: string): UserMessage => createUserMessage({ content: text })

type Row = UserMessage | AssistantMessage
const heal = (msgs: Message[]): Row[] => healWalkableForWire(msgs as never)
const json = (rows: unknown): string => JSON.stringify(rows)

function roundsPaired(rows: Row[]): boolean {
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i]!
    if (m.type !== 'assistant') continue
    const uses = m.message.content
      .filter(b => b.type === 'tool_use')
      .map(b => (b as { id: string }).id)
    if (uses.length === 0) continue
    const next = rows[i + 1]
    if (next?.type !== 'user' || !Array.isArray(next.message.content)) {
      return false
    }
    const results = new Set(
      (next.message.content as { type: string; tool_use_id?: string }[])
        .filter(b => b.type === 'tool_result')
        .map(b => b.tool_use_id),
    )
    if (!uses.every(id => results.has(id))) return false
  }
  return true
}

{
  const att = {
    attachment: { type: 'plan_mode_exit', planExists: false, planFilePath: '' },
    type: 'attachment',
    uuid: 'iv-att-1',
    timestamp: new Date().toISOString(),
  } as unknown as Message
  const sys = {
    type: 'system',
    subtype: 'local_command',
    content: 'LOCAL-CMD-OUTPUT-MARKER',
    uuid: 'iv-sys-1',
    timestamp: new Date().toISOString(),
  } as unknown as Message
  const healed = json(heal([userText('hello'), att, sys]))
  t('A1 plan_mode_exit attachment projects onto the family wire', healed.includes('Exited Strategy Mode'))
  t('A2 local_command system row projects onto the family wire', healed.includes('LOCAL-CMD-OUTPUT-MARKER'))
  t('A3 projected rows are user rows (walkable)', heal([userText('x'), att]).every(r => r.type === 'user' || r.type === 'assistant'))
}

{
  const rows = heal([
    userText('go'),
    asst('mX', [use('A')]),
    asst('mY', [use('C')]),
    userTr('A'),
    userTr('C'),
  ])
  const s = json(rows)
  t('B1 no synthetic for interleaved rounds', !s.includes(SYNTHETIC_TOOL_RESULT_PLACEHOLDER))
  t('B2 real RESULT-A survives', s.includes('RESULT-A'))
  t('B3 real RESULT-C survives', s.includes('RESULT-C'))
  t('B4 every round pairs adjacent', roundsPaired(rows))
}

{
  const rows = heal([
    userText('go'),
    asst('mX', [use('A')]),
    userText('[Request interrupted by user]'),
    userTr('A'),
  ])
  const s = json(rows)
  t('C1 real RESULT-A survives interrupt-between', s.includes('RESULT-A'))
  t('C2 no synthetic injected', !s.includes(SYNTHETIC_TOOL_RESULT_PLACEHOLDER))
  t('C3 interrupt text is preserved', s.includes('[Request interrupted by user]'))
  t('C4 pairing adjacent', roundsPaired(rows))
}

{
  const rows = heal([
    userText('go'),
    asst('mX', [use('A')]),
    asst('mX', [use('B')]),
    userTr('A'),
    userTr('B'),
  ])
  const s = json(rows)
  t('D1 grouped: no synthetic', !s.includes(SYNTHETIC_TOOL_RESULT_PLACEHOLDER))
  t('D2 grouped: both results survive', s.includes('RESULT-A') && s.includes('RESULT-B'))
  t('D3 grouped: pairs adjacent', roundsPaired(rows))
}

{
  const rows = heal([
    userText('go'),
    asst('mX', [use('A'), use('B')]),
    userTr('A'),
    userText('steer note'),
    userTr('B'),
  ])
  const s = json(rows)
  t('E1 both results survive the mid-round steer', s.includes('RESULT-A') && s.includes('RESULT-B'))
  t('E2 no synthetic', !s.includes(SYNTHETIC_TOOL_RESULT_PLACEHOLDER))
  t('E3 steer text preserved', s.includes('steer note'))
  t('E4 pairs adjacent', roundsPaired(rows))
}

{
  const att = {
    attachment: { type: 'plan_mode_exit', planExists: false, planFilePath: '' },
    type: 'attachment',
    uuid: 'iv-att-2',
    timestamp: new Date().toISOString(),
  } as unknown as Message
  const rows = heal([
    userText('go'),
    asst('mX', [use('A')]),
    att,
    userTr('A'),
  ])
  const s = json(rows)
  t('F1 result survives a projected attachment between', s.includes('RESULT-A'))
  t('F2 no synthetic', !s.includes(SYNTHETIC_TOOL_RESULT_PLACEHOLDER))
  t('F3 attachment text still delivered', s.includes('Exited Strategy Mode'))
  t('F4 pairs adjacent', roundsPaired(rows))
}

{
  const steer = {
    attachment: {
      type: 'queued_command',
      prompt: 'STEER-MARKER: refocus on the failing suite first',
      commandMode: 'prompt',
    },
    type: 'attachment',
    uuid: 'iv-steer-1',
    timestamp: new Date().toISOString(),
  } as unknown as Message
  const rows = heal([
    userText('go'),
    asst('mX', [use('A')]),
    userTr('A'),
    steer,
  ])
  const s = json(rows)
  t('Q1 the drained steer text reaches the wire', s.includes('STEER-MARKER'))
  t('Q2 pairing stays adjacent around the steer', roundsPaired(rows))
  t('Q3 no synthetic', !s.includes(SYNTHETIC_TOOL_RESULT_PLACEHOLDER))
}

{
  const rows = heal([
    userText('go'),
    asst('mX', [use('A')]),
    userTr('B'),
    asst('mY', [use('B')]),
    userTr('A'),
  ])
  const s = json(rows)
  t('G1 repairable half delivers (RESULT-A)', s.includes('RESULT-A'))
  t('G2 unrepairable use gets the honest synthetic', s.includes(SYNTHETIC_TOOL_RESULT_PLACEHOLDER))
}

{
  const rows = heal([userText('go'), asst('mX', [use('A')]), userText('next')])
  const s = json(rows)
  t('H1 missing result → synthetic injected', s.includes(SYNTHETIC_TOOL_RESULT_PLACEHOLDER))
}

{
  const rows = heal([
    userText('go'),
    asst('mX', [use('A')]),
    userTr('A'),
    userTr('A'),
  ])
  const count = (json(rows).match(/RESULT-A/g) ?? []).length
  t('I1 duplicate tool_result deduped to one', count === 1, `count=${count}`)
}

{
  const trBlock = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: `RESULT-${id}` })
  const idsOf = (rows: Message[]): string[] => {
    const answer = rows.find(r => r.type === 'user' && Array.isArray((r as UserMessage).message.content) && ((r as UserMessage).message.content as Array<{ type: string }>).some(b => b.type === 'tool_result')) as UserMessage | undefined
    return ((answer?.message.content ?? []) as Array<{ type: string; tool_use_id?: string }>).map(b => (b.type === 'tool_result' ? String(b.tool_use_id) : b.type))
  }
  const arrival = heal([
    userText('go'),
    asst('mO', [use('A'), use('B'), use('C')]),
    createUserMessage({ content: [trBlock('C')] as never }),
    createUserMessage({ content: [trBlock('A')] as never }),
    createUserMessage({ content: [trBlock('B')] as never }),
  ])
  t('O1 results that arrived C·A·B replay as A·B·C', idsOf(arrival).join(',') === 'A,B,C', idsOf(arrival).join(','))
  const feedback = heal([
    userText('go'),
    asst('mO2', [use('A'), use('B'), use('C')]),
    createUserMessage({ content: [trBlock('A'), { type: 'text', text: 'feedback beside A' }] as never }),
    createUserMessage({ content: [trBlock('B')] as never }),
    createUserMessage({ content: [trBlock('C')] as never }),
  ])
  t('O2 a sibling feedback block: results first in the assistant\'s order, the feedback after', idsOf(feedback).join(',') === 'A,B,C,text', idsOf(feedback).join(','))
  t('O2 the feedback text survives the reorder', json(feedback).includes('feedback beside A'))
  const direct = orderToolResultsByUse([
    asst('mO3', [use('X'), use('Y')]),
    createUserMessage({ content: [trBlock('Y'), { type: 'text', text: 'tail' }, trBlock('X')] as never }),
  ] as never)
  t('O3 orderToolResultsByUse: Y·text·X → X·Y·text', idsOf(direct as never).join(',') === 'X,Y,text', idsOf(direct as never).join(','))
  const untouched = [asst('mO4', [use('X')]), createUserMessage({ content: [trBlock('X')] as never })]
  t('O4 an already-ordered row is returned as the same array (no churn)', orderToolResultsByUse(untouched as never) === untouched)
}

{
  const input: Message[] = [
    userText('go'),
    asst('mX', [use('A')]),
    userText('between'),
    userTr('A'),
  ]
  const before = json(input)
  heal(input)
  t('P1 input rows unmutated', json(input) === before)
}

console.log(failures === 0 ? '✅ wire-heal truth: ALL GREEN' : '❌ wire-heal truth: FAILURES')
process.exit(failures)
