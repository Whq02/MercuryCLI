#!/usr/bin/env bun
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dist, payloadKindsOf, quote, runDoor, savedHookRowsOf, say, sceneRoot, type Row } from './lib/runDoor.ts'

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

{
  const paths = sceneRoot('hook-tool-road-block-')
  const target = join(paths.cwd, 'secret.md')
  writeFileSync(target, 'the secret\n')
  const decided = join(paths.root, 'decided.json')
  const before = join(paths.root, 'before.json')
  const after = join(paths.root, 'after.json')
  const result = await runDoor(paths, {
    turns: [
      { kind: 'tool_use', name: 'Read', input: { file_path: target }, id: 'road_block_1' },
      { kind: 'text', text: 'fixture answered' },
    ],
    hooks: {
      'tool.before': [{ name: 'no secrets', match: 'Read', run: `tee ${quote(before)} > /dev/null; echo "no reads of secrets here" >&2; exit 2` }],
      'permission.decided': [{ name: 'decided', run: `cat > ${quote(decided)}` }],
      'tool.after': [{ name: 'after', run: `cat > ${quote(after)}` }],
    },
  })
  const rows = result.rows
  const call = rows.find(row => row.type === 'tool_call')
  const toolResult = rows.find(row => row.type === 'tool_result')
  check('the run settles against the fixture with the turn completed', result.code === 0 && rows.some(row => row.type === 'outcome' && row.status === 'completed'), `code ${result.code} ${result.stderr.slice(0, 300)}`)
  check('a tool.before block denies the call: the result is an error carrying the hook\'s words, and the file was never read', call !== undefined && toolResult !== undefined && toolResult.status === 'error' && String(toolResult.output).includes('no reads of secrets here') && !String(toolResult.output).includes('the secret'), JSON.stringify(toolResult))
  const beforePayload = existsSync(before) ? (JSON.parse(readFileSync(before, 'utf8')) as Row) : undefined
  check('the tool.before payload names the call: call_id, tool, input, with the base fields', beforePayload?.event === 'tool.before' && beforePayload.tool === 'Read' && beforePayload.call_id === 'road_block_1' && (beforePayload.input as Row)?.file_path === target && typeof beforePayload.session_id === 'string' && typeof beforePayload.cwd === 'string' && typeof beforePayload.transcript_path === 'string' && beforePayload.permission_mode !== undefined, JSON.stringify(beforePayload))
  const decidedPayload = existsSync(decided) ? (JSON.parse(readFileSync(decided, 'utf8')) as Row) : undefined
  check('permission.decided fires for the refused call with decision denied, by hook', decidedPayload?.event === 'permission.decided' && decidedPayload.decision === 'denied' && decidedPayload.by === 'hook' && decidedPayload.call_id === 'road_block_1' && decidedPayload.tool === 'Read', JSON.stringify(decidedPayload))
  check('tool.after does not fire for a call that never ran', !existsSync(after))
  const block = rows.find(row => row.type === 'notice' && String(row.text).includes('no reads of secrets here'))
  check('the block reaches the rows stream as a notice row between the call and its result', block !== undefined && rows.indexOf(block) > rows.indexOf(call!) && rows.indexOf(block) < rows.indexOf(toolResult!), rows.map(row => row.type).join(' '))
  const saved = savedHookRowsOf(result.sessionRows)
  const savedBlock = saved.find(row => row.fields.outcome === 'block' && row.fields.event === 'tool.before')
  check('the session file keeps the block as a hook row with its call id', savedBlock !== undefined && savedBlock.fields.name === 'no secrets' && savedBlock.fields.callId === 'road_block_1' && String(savedBlock.fields.words).includes('no reads of secrets here'), JSON.stringify(saved.map(row => row.fields)))
  check('the model was asked twice: the refusal went back as the tool result', result.requests === 2, `${result.requests} requests`)
  check('every row on the stream is valid JSON', rows.every(row => !('bad' in row)))
  if (failures) console.log(JSON.stringify({ rows, stderr: result.stderr.slice(0, 600) }))
  rmSync(paths.root, { recursive: true, force: true })
}

{
  const paths = sceneRoot('hook-tool-road-shape-')
  const target = join(paths.cwd, 'README.md')
  const other = join(paths.cwd, 'OTHER.md')
  writeFileSync(target, 'readme words\n')
  writeFileSync(other, 'other words\n')
  const decided = join(paths.root, 'decided.json')
  const after = join(paths.root, 'after.json')
  const result = await runDoor(paths, {
    turns: [
      { kind: 'tool_use', name: 'Read', input: { file_path: target }, id: 'road_shape_1' },
      { kind: 'text', text: 'fixture answered' },
    ],
    hooks: {
      'tool.before': [
        { name: 'redirect', match: 'Read', run: say({ input: { file_path: other }, context: 'the read was redirected' }) },
        { name: 'broken before', match: 'Read', run: 'echo the before hook broke >&2; exit 1' },
      ],
      'permission.decided': [{ name: 'decided', run: `cat > ${quote(decided)}` }],
      'tool.after': [{ name: 'rewrite output', match: 'Read', run: `tee ${quote(after)} > /dev/null; ${say({ output: 'THE REWRITTEN OUTPUT' })}` }],
    },
  })
  const rows = result.rows
  const call = rows.find(row => row.type === 'tool_call')
  const toolResult = rows.find(row => row.type === 'tool_result')
  check('the run settles with the turn completed', result.code === 0 && rows.some(row => row.type === 'outcome' && row.status === 'completed'), `code ${result.code} ${result.stderr.slice(0, 300)}`)
  check('a tool.before `input` answer rewrites the call: the tool ran on the other file', toolResult !== undefined && toolResult.status === 'ok' && (call?.input as Row)?.file_path === target, JSON.stringify({ call, toolResult }))
  const afterPayload = existsSync(after) ? (JSON.parse(readFileSync(after, 'utf8')) as Row) : undefined
  check('the tool.after payload carries the input the tool really ran with, ok true, the output and cut false', afterPayload?.event === 'tool.after' && (afterPayload.input as Row)?.file_path === other && afterPayload.ok === true && JSON.stringify(afterPayload.output).includes('other words') && afterPayload.cut === false, JSON.stringify(afterPayload))
  check('a tool.after `output` answer replaces what the model reads', toolResult !== undefined && String(toolResult.output).includes('THE REWRITTEN OUTPUT'), JSON.stringify(toolResult))
  const decidedPayload = existsSync(decided) ? (JSON.parse(readFileSync(decided, 'utf8')) as Row) : undefined
  check('permission.decided fires for the allowed call with decision allowed and a decider word', decidedPayload?.decision === 'allowed' && ['rule', 'mode', 'hook', 'operator', 'safety', 'other'].includes(String(decidedPayload.by)) && (decidedPayload.input as Row)?.file_path === other, JSON.stringify(decidedPayload))
  const failedNotice = rows.find(row => row.type === 'notice' && String(row.text).includes('broken before') && String(row.text).includes('the before hook broke'))
  check('a failed tool.before hook is a warning notice row between the call and its result, in the one sentence of the row vocabulary', failedNotice !== undefined && failedNotice.level === 'warning' && failedNotice.code === 'hook_failed' && rows.indexOf(failedNotice) > rows.indexOf(call!) && rows.indexOf(failedNotice) < rows.indexOf(toolResult!), JSON.stringify(rows.filter(row => row.type === 'notice')))
  check('the failed hook never stops the call: the tool ran', toolResult?.status === 'ok')
  const saved = savedHookRowsOf(result.sessionRows)
  const kinds = payloadKindsOf(result.sessionRows)
  const savedFailed = saved.find(row => row.fields.outcome === 'failed')
  const savedContext = saved.find(row => row.fields.outcome === 'context' && row.fields.event === 'tool.before')
  check('the session file keeps the context row and the failed row with the call id, after the call and before the result', savedFailed !== undefined && savedContext !== undefined && savedFailed.fields.callId === 'road_shape_1' && savedContext.fields.callId === 'road_shape_1' && kinds.indexOf('output') < result.sessionRows.findIndex(row => (row.payload as Row)?.kind === 'attachment' && ((row.payload as Row).fields as Row)?.outcome === 'failed'), JSON.stringify(saved.map(row => row.fields)))
  const secondRequest = result.requests
  check('the model was asked twice, the second time with the rewritten output as the tool result', secondRequest === 2, `${secondRequest} requests`)
  check('every row on the stream is valid JSON', rows.every(row => !('bad' in row)))
  if (failures) console.log(JSON.stringify({ rows, stderr: result.stderr.slice(0, 600) }))
  rmSync(paths.root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'HOOK TOOL ROAD GREEN' : `${failures} HOOK TOOL ROAD FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
