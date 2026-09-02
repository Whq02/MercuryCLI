#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { deserializeLiveMessages } = await import('../../src/utils/conversationRecovery.js')
const { normalizeMessages } = await import('../../src/utils/messages/normalize.js')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.js')
type Msg = ReturnType<typeof createUserMessage>

section('A. deserializeLiveMessages is 1:1 and index-aligned (the merge rests on it)')
{
  const rows = [
    createUserMessage({ content: 'first words' }),
    createAssistantMessage({ content: [{ type: 'text', text: 'a reply', citations: [] }] }),
    createUserMessage({ content: 'second words' }),
  ] as unknown as Msg[]
  const out = deserializeLiveMessages(rows as never)
  check('N in ⇒ N out', out.length === rows.length, `${rows.length} → ${out.length}`)
  check(
    'order held (uuid per index)',
    out.every((m, i) => (m as { uuid?: string }).uuid === (rows[i] as { uuid?: string }).uuid),
  )
}

section('B. normalize identity — unchanged parent ⇒ the SAME row objects')
{
  const user = createUserMessage({ content: 'hello there' }) as unknown as Msg
  const assistant = createAssistantMessage({
    content: [{ type: 'text', text: 'reply prose', citations: [] }],
  }) as unknown as Msg
  const list = [user, assistant] as never[]
  const first = normalizeMessages(list)
  const second = normalizeMessages(list)
  check('two walks over the same parents return the same row COUNT', first.length === second.length)
  check(
    'every row keeps its OBJECT identity across walks (the row memo bails)',
    first.every((r, i) => r === second[i]),
  )
  const userTwin = createUserMessage({ content: 'hello there' }) as unknown as Msg
  const third = normalizeMessages([userTwin] as never)
  check('a fresh parent object mints fresh rows (no value-keyed staleness)', third[0] !== first[0])
}

section('C. normalize identity — the chain-state variant never replays wrong uuids')
{
  const single = createAssistantMessage({
    content: [{ type: 'text', text: 'one block', citations: [] }],
  }) as unknown as Msg
  const multi = createAssistantMessage({
    content: [
      { type: 'text', text: 'block a', citations: [] },
      { type: 'text', text: 'block b', citations: [] },
    ],
  }) as unknown as Msg
  const unchained = normalizeMessages([single] as never)
  const chainedWalk = normalizeMessages([multi, single] as never)
  const chained = chainedWalk.slice(-1)
  check(
    'unchained walk keeps the parent uuid',
    (unchained[0] as { uuid?: string }).uuid === (single as { uuid?: string }).uuid,
  )
  check(
    'chained walk derives a different uuid for the SAME parent object',
    (chained[0] as { uuid?: string }).uuid !== (single as { uuid?: string }).uuid,
  )
  const unchainedAgain = normalizeMessages([single] as never)
  const chainedAgain = normalizeMessages([multi, single] as never).slice(-1)
  check('the unchained variant replays ITS rows by identity', unchainedAgain[0] === unchained[0])
  check('the chained variant replays ITS rows by identity', chainedAgain[0] === chained[0])
  check('the two variants stay distinct objects', unchained[0] !== chained[0])
}

section('D. the connector merge, DRIVEN in BOTH directions (the lead\'s pin law)')
{
  const { mergeRecordsContentKeyed } = await import('../../src/services/engine-connector/recordIdentity.js')
  const rawOf = (texts: string[]): unknown[] => texts.map((t, i) => ({ type: 'user', uuid: `u${i}-${t}`, message: { role: 'user', content: t } }))
  const freshOf = (raw: unknown[]): Msg[] => raw.map(r => ({ ...(r as object) })) as Msg[]

  const raw1 = rawOf(['alpha', 'beta'])
  const t1 = mergeRecordsContentKeyed([], [], raw1, freshOf(raw1) as never)
  check('cold start: nothing reused', t1.reusedAll === false && t1.records.length === 2)

  const raw2 = rawOf(['alpha', 'beta'])
  const t2 = mergeRecordsContentKeyed(t1.records, t1.sigs, raw2, freshOf(raw2) as never)
  check('byte-identical read: every object is the SAME object', t2.records[0] === t1.records[0] && t2.records[1] === t1.records[1])
  check('byte-identical read: reusedAll (the array keeps its identity upstream)', t2.reusedAll === true)

  const raw3 = rawOf(['alpha', 'beta', 'gamma'])
  const t3 = mergeRecordsContentKeyed(t2.records, t2.sigs, raw3, freshOf(raw3) as never)
  check('append: priors keep their objects, the newcomer is fresh', t3.records[0] === t1.records[0] && t3.records[1] === t1.records[1] && t3.records[2] !== undefined && t3.reusedAll === false)

  const raw4 = rawOf(['alpha', 'beta CHANGED', 'gamma'])
  const t4 = mergeRecordsContentKeyed(t3.records, t3.sigs, raw4, freshOf(raw4) as never)
  check('changed bytes: the changed index is a NEW object', t4.records[1] !== t3.records[1])
  check(
    'changed bytes: the new object carries the NEW content',
    (t4.records[1] as unknown as { message: { content: string } }).message.content === 'beta CHANGED',
  )
  check('changed bytes: the untouched neighbours still reuse', t4.records[0] === t1.records[0] && t4.records[2] === t3.records[2])

  const raw5 = rawOf(['beta CHANGED', 'gamma']).map((r, i) => ({ ...(r as object), uuid: `u${i + 1}` }))
  const t5 = mergeRecordsContentKeyed(t4.records, t4.sigs, raw5, freshOf(raw5) as never)
  check('a shifted file reuses nothing (conservative fresh identities)', t5.records[0] !== t4.records[1] && t5.records[1] !== t4.records[2] && t5.reusedAll === false)
}

section('E. the coordinator pane merge, DRIVEN in BOTH directions')
{
  const { mergeCoordinatorEntries } = await import('../../src/components/concourse/CoordinatorPane.js')
  const entry = (id: string, text: string) => ({ id, role: 'coordinator' as const, text, ts: 1000 })
  const a = [entry('e1', 'first'), entry('e2', 'second')]
  const first = mergeCoordinatorEntries(null, a)
  check('a cold read takes the rows as-is', first === a)
  const again = mergeCoordinatorEntries(first, [entry('e1', 'first'), entry('e2', 'second')])
  check('byte-identical read returns prev ITSELF (nothing repaints)', again === first)
  const appended = mergeCoordinatorEntries(first, [entry('e1', 'first'), entry('e2', 'second'), entry('e3', 'third')])
  check('append: prior entries keep their objects', appended[0] === first[0] && appended[1] === first[1] && appended.length === 3)
  const changed = mergeCoordinatorEntries(appended, [entry('e1', 'first'), entry('e2', 'second EDITED'), entry('e3', 'third')])
  check('changed bytes: a NEW object carrying the NEW text', changed[1] !== appended[1] && changed[1]!.text === 'second EDITED')
  check('changed bytes: neighbours still reuse', changed[0] === first[0] && changed[2] === appended[2])
  const shifted = mergeCoordinatorEntries(changed, [entry('co:compact:x', 'conversation compacted — 1 earlier turn folded away'), entry('e1', 'first'), entry('e2', 'second EDITED')])
  check('a misaligned shift reuses nothing (conservative fresh identities)', shifted[0] !== changed[0] && shifted[1] !== changed[1] && shifted[2] !== changed[2])
  const realCompact = mergeCoordinatorEntries(changed, [entry('co:compact:y', 'conversation compacted — 1 earlier turn folded away'), entry('e2', 'second EDITED'), entry('e3', 'third')])
  check('a real compaction keeps the objects whose index and bytes held', realCompact[0] !== changed[0] && realCompact[1] === changed[1] && realCompact[2] === changed[2])
}

section('F. the seams hold their shape (source locks)')
{
  const root = join(import.meta.dir, '../../src')
  const connector = readFileSync(join(root, 'services/engine-connector/daemonConnector.ts'), 'utf8')
  check('the connector ticks through the pure merge seam', connector.includes('mergeRecordsContentKeyed('))
  check(
    'a byte-identical re-read wakes no listener (array identity kept)',
    /if \(merge\.reusedAll\) return/.test(connector),
  )
  const rowMemo = readFileSync(join(root, 'components/MessageRow.tsx'), 'utf8')
  check(
    'the row memo keys on message IDENTITY (what makes the chain sufficient)',
    rowMemo.includes('if (prev.message !== next.message) return false'),
  )
  const normalize = readFileSync(join(root, 'utils/messages/normalize.ts'), 'utf8')
  check('the normalize cache is weakly keyed by the parent object', normalize.includes('new WeakMap'))
  const pane = readFileSync(join(root, 'components/concourse/CoordinatorPane.tsx'), 'utf8')
  check('the pane merges through the exported pure seam', pane.includes('mergeCoordinatorEntries(prev, rows)'))
  check('the coordinator entry row is memoized', /const CoordinatorEntryBlock = React\.memo\(/.test(pane))
}

if (failures > 0) {
  console.error(`\n❌ ${failures} TRANSCRIPT-CALM-IDENTITY PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL TRANSCRIPT-CALM-IDENTITY PROOFS PASS')
