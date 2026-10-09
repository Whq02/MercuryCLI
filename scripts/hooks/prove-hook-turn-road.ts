#!/usr/bin/env bun
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { dist, quote, runDoor, savedHookRowsOf, say, sceneRoot, type Row } from './lib/runDoor.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let failures = 0
const check = (label: string, good: boolean, detail = ''): void => {
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
if (!existsSync(dist)) {
  console.log(`FAIL — ${dist} is missing; build first`)
  process.exit(1)
}
const readJson = (path: string): Row | undefined => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Row) : undefined)
const readLines = (path: string): Row[] => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Row) : [])

{
  const paths = sceneRoot('hook-turn-road-')
  const startPayload = join(paths.root, 'session-start.json')
  const turnStart = join(paths.root, 'turn-start.json')
  const answers = join(paths.root, 'turn-answers.jsonl')
  const ends = join(paths.root, 'turn-ends.jsonl')
  const endPayload = join(paths.root, 'session-end.json')
  const marks = join(paths.root, 'marks.txt')
  const result = await runDoor(paths, {
    prompt: 'count the beans',
    turns: [
      { kind: 'text', text: 'first answer' },
      { kind: 'text', text: 'second answer' },
    ],
    hooks: {
      'session.start': [{ name: 'hello', match: 'new', run: `tee ${quote(startPayload)} > /dev/null; echo session >> ${quote(marks)}; echo the project is a bean counter` }],
      'turn.start': [{ name: 'prompt note', run: `cat > ${quote(turnStart)}; echo turn >> ${quote(marks)}; ${say({ context: 'beans are counted in dozens' })}` }],
      'turn.answer': [{ name: 'answer gate', run: `tee -a ${quote(answers)} > /dev/null; echo answer >> ${quote(marks)}; if grep -q '"again":false' ${quote(answers)} && [ "$(wc -l < ${quote(answers)})" -eq 1 ]; then echo "say it again, with feeling" >&2; exit 2; fi; exit 0` }],
      'turn.end': [{ name: 'end facts', run: `tee -a ${quote(ends)} > /dev/null; echo end >> ${quote(marks)}` }],
      'session.end': [{ name: 'bye', run: `cat > ${quote(endPayload)}; echo bye >> ${quote(marks)}` }],
    },
  })
  const rows = result.rows
  check('the run settles with the turn completed', result.code === 0 && rows.some(row => row.type === 'outcome' && row.status === 'completed'), `code ${result.code} ${result.stderr.slice(0, 300)}`)
  const order = existsSync(marks) ? readFileSync(marks, 'utf8').trim().split('\n') : []
  check('the events fire in their order: session.start, turn.start, turn.answer (twice: the block sent the model back), turn.end, session.end', order.join(' ') === 'session turn answer answer end bye', order.join(' '))
  const start = readJson(startPayload)
  check('session.start carries reason new and the model, and matches on the reason', start?.event === 'session.start' && start.reason === 'new' && typeof start.model === 'string' && (start.model as string).length > 0, JSON.stringify(start))
  const turn = readJson(turnStart)
  check('turn.start carries the prompt and the turn id', turn?.event === 'turn.start' && turn.prompt === 'count the beans' && typeof turn.turn_id === 'string' && (turn.turn_id as string).length > 0, JSON.stringify(turn))
  const answered = readLines(answers)
  check('turn.answer carries the answer text; the first fire has again false, the fire after the block has again true', answered.length === 2 && answered[0]!.answer === 'first answer' && answered[0]!.again === false && answered[1]!.answer === 'second answer' && answered[1]!.again === true, JSON.stringify(answered))
  check('the block sent the model back: the fixture served two turns', result.requests === 2, `${result.requests} requests`)
  const ended = readLines(ends)
  const turnRow = rows.find(row => row.type === 'turn')
  const outcome = rows.find(row => row.type === 'outcome')
  check('turn.end carries the facts of the outcome row under the same turn id: status, steps, wall_ms, usage, the answer', ended.length === 1 && ended[0]!.turn_id === turn?.turn_id && ended[0]!.status === 'completed' && typeof ended[0]!.steps === 'number' && typeof ended[0]!.wall_ms === 'number' && typeof ended[0]!.usage === 'object' && ended[0]!.answer === 'second answer' && ended[0]!.cut === undefined, JSON.stringify({ end: ended[0], turnRow, outcome }))
  check('the turn id the hooks saw is the turn row\'s id', turnRow !== undefined && turn?.turn_id === turnRow.turn_id, JSON.stringify({ turnRow, turnId: turn?.turn_id }))
  const end = readJson(endPayload)
  check('session.end carries the reason the run door leaves with', end?.event === 'session.end' && end.reason === 'closed', JSON.stringify(end))
  const taskRows = rows.filter(row => row.type === 'task' && row.task_type === 'hook')
  check('hooks outside a turn (session.start) are task rows named for the hook; hooks inside a turn are not', taskRows.some(row => row.description === 'hello') && !taskRows.some(row => ['prompt note', 'answer gate', 'end facts'].includes(String(row.description))), JSON.stringify(taskRows.map(row => [row.description, row.state])))
  const saved = savedHookRowsOf(result.sessionRows)
  const savedStart = saved.find(row => row.fields.event === 'session.start')
  const savedTurnStart = saved.find(row => row.fields.event === 'turn.start')
  const savedBlock = saved.find(row => row.fields.event === 'turn.answer' && row.fields.outcome === 'block')
  check('the session file keeps the session.start words as a context row (plain stdout is context there)', savedStart !== undefined && savedStart.fields.outcome === 'context' && savedStart.fields.words === 'the project is a bean counter', JSON.stringify(savedStart))
  check('…the turn.start context row and the turn.answer block row', savedTurnStart?.fields.outcome === 'context' && savedTurnStart.fields.words === 'beans are counted in dozens' && savedBlock !== undefined && savedBlock.fields.words === 'say it again, with feeling', JSON.stringify(saved.map(row => row.fields)))
  const blockNotice = rows.find(row => row.type === 'notice' && String(row.text).includes('say it again, with feeling'))
  check('the turn.answer block reaches the rows stream as a notice naming the hook and the event', blockNotice !== undefined && String(blockNotice.text).includes('answer gate') && blockNotice.code === 'hook_blocked', JSON.stringify(rows.filter(row => row.type === 'notice')))
  const secondRequestBody = JSON.stringify(result.rows)
  void secondRequestBody
  check('every row on the stream is valid JSON', rows.every(row => !('bad' in row)))
  if (failures) console.log(JSON.stringify({ rows, stderr: result.stderr.slice(0, 600) }))
  rmSync(paths.root, { recursive: true, force: true })
}

{
  const paths = sceneRoot('hook-turn-road-refused-')
  const ends = join(paths.root, 'turn-ends.jsonl')
  const result = await runDoor(paths, {
    prompt: 'do the forbidden thing',
    turns: [{ kind: 'text', text: 'never asked' }],
    hooks: {
      'turn.start': [{ name: 'prompt gate', run: 'echo "not that, not now" >&2; exit 2' }],
      'turn.end': [{ name: 'end facts', run: `cat >> ${quote(ends)}` }],
    },
  })
  const rows = result.rows
  const outcome = rows.find(row => row.type === 'outcome')
  check('a turn.start block refuses the turn: the outcome is refused with the hook\'s words and the model is never asked', outcome !== undefined && outcome.status === 'refused' && JSON.stringify(outcome).includes('not that, not now') && result.requests === 0, JSON.stringify({ outcome, requests: result.requests }))
  const ended = readLines(ends)
  check('turn.end still fires for the refused turn with status refused and the error class hook', ended.length === 1 && ended[0]!.status === 'refused' && (ended[0]!.error as Row)?.class === 'hook' && String((ended[0]!.error as Row)?.message).includes('not that, not now'), JSON.stringify(ended))
  check('the run exits non-zero for a refused turn', result.code !== 0, `code ${result.code}`)
  if (failures) console.log(JSON.stringify({ rows, stderr: result.stderr.slice(0, 600) }))
  rmSync(paths.root, { recursive: true, force: true })
}

{
  const paths = sceneRoot('hook-turn-road-stop-')
  const result = await runDoor(paths, {
    turns: [{ kind: 'text', text: 'first answer' }, { kind: 'text', text: 'never served' }],
    hooks: {
      'turn.answer': [{ name: 'enough', run: say({ stop: 'that is enough for tonight' }) }],
    },
  })
  const rows = result.rows
  const outcome = rows.find(row => row.type === 'outcome')
  check('a turn.answer stop ends the turn without a send-back: one model call, the turn completed', outcome?.status === 'completed' && result.requests === 1, JSON.stringify({ outcome, requests: result.requests }))
  const stopNotice = rows.find(row => row.type === 'notice' && String(row.text).includes('that is enough for tonight'))
  check('the stop reaches the rows stream as a notice naming the hook', stopNotice !== undefined && String(stopNotice.text).includes('enough') && stopNotice.code === 'hook_stopped', JSON.stringify(rows.filter(row => row.type === 'notice')))
  if (failures) console.log(JSON.stringify({ rows, stderr: result.stderr.slice(0, 600) }))
  rmSync(paths.root, { recursive: true, force: true })
}

{
  const paths = sceneRoot('hook-turn-road-end-budget-')
  const endMark = join(paths.root, 'end-mark')
  const result = await runDoor(paths, {
    turns: [{ kind: 'text', text: 'the answer' }],
    hooks: {
      'session.end': [{ name: 'slow goodbye', run: `echo started > ${quote(endMark)}; sleep 20; echo finished > ${quote(endMark)}` }],
    },
  })
  check('the run settles', result.code === 0, `code ${result.code}`)
  const mark = existsSync(endMark) ? readFileSync(endMark, 'utf8').trim() : 'never ran'
  check('session.end runs under the 1.5 s budget: the slow hook was started and killed, the door left within seconds', mark === 'started' && result.tookMs < 30_000, `${mark} after ${result.tookMs}ms`)
  rmSync(paths.root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'HOOK TURN ROAD GREEN' : `${failures} HOOK TURN ROAD FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
