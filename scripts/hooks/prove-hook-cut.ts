#!/usr/bin/env bun
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { dist, quote, runDoor, sceneRoot, type Row } from './lib/runDoor.ts'

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
const readLines = (path: string): Row[] => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Row) : [])

const paths = sceneRoot('hook-cut-')
const ends = join(paths.root, 'turn-ends.jsonl')
const afters = join(paths.root, 'tool-afters.jsonl')
const endMark = join(paths.root, 'slow-end-mark')
const sleeperPid = join(paths.root, 'sleeper.pid')
const result = await runDoor(paths, {
  args: ['--sovereign'],
  turns: [
    { kind: 'tool_use', name: 'Bash', input: { command: `echo $$ > ${quote(sleeperPid)}; sleep 40` }, id: 'cut_call_1' },
    { kind: 'text', text: 'never reached' },
  ],
  hooks: {
    'turn.end': [
      { name: 'end facts', run: `cat >> ${quote(ends)}` },
      { name: 'slow end', match: 'interrupted', run: `echo started > ${quote(endMark)}; sleep 20; echo finished > ${quote(endMark)}` },
    ],
    'tool.after': [{ name: 'after facts', match: 'Bash', run: `cat >> ${quote(afters)}` }],
  },
  signalAfterMs: { ms: 4_000, signal: 'SIGINT' },
  timeoutMs: 60_000,
})
if (existsSync(sleeperPid)) {
  const pid = Number(readFileSync(sleeperPid, 'utf8').trim())
  if (Number.isFinite(pid) && pid > 1) try { process.kill(pid, 'SIGKILL') } catch {}
}
const rows = result.rows
const call = rows.find(row => row.type === 'tool_call')
const outcome = rows.find(row => row.type === 'outcome')
check('the cut turn ends interrupted on the rows stream, and the door leaves with the signal\'s code', outcome?.status === 'interrupted' && result.code === 130, JSON.stringify({ outcome, code: result.code, stderr: result.stderr.slice(0, 300) }))
check('the tool call the cut ended is on the stream', call?.call_id === 'cut_call_1', JSON.stringify(call))
const ended = readLines(ends)
const end = ended[0]
check('turn.end fires once for the cut turn with status interrupted', ended.length === 1 && end?.status === 'interrupted', JSON.stringify(ended))
check('…carrying the cut: reason operator, no detail, tools naming the call the cut ended', end !== undefined && typeof end.cut === 'object' && (end.cut as Row).reason === 'operator' && (end.cut as Row).detail === undefined && JSON.stringify((end.cut as Row).tools) === JSON.stringify(['Bash']), JSON.stringify(end?.cut))
check('…and the turn facts: steps, wall_ms, usage, with no answer', end !== undefined && typeof end.steps === 'number' && typeof end.wall_ms === 'number' && typeof end.usage === 'object' && end.answer === undefined, JSON.stringify(end))
const afterRows = readLines(afters)
const after = afterRows[0]
check('tool.after fires once for the call the cut ended, with ok false and cut true', afterRows.length === 1 && after?.ok === false && after.cut === true && after.call_id === 'cut_call_1' && typeof after.error === 'string', JSON.stringify(afterRows))
const mark = existsSync(endMark) ? readFileSync(endMark, 'utf8').trim() : 'never ran'
check('a cut turn.end runs under the 1.5 s budget: the slow hook was started and killed, and the door left within seconds', mark === 'started' && result.tookMs < 4_000 + 15_000, `${mark} after ${result.tookMs}ms`)
check('no model call followed the cut', result.requests === 1, `${result.requests} requests`)
if (failures) console.log(JSON.stringify({ rows, stderr: result.stderr.slice(0, 800) }))
rmSync(paths.root, { recursive: true, force: true })
console.log(failures === 0 ? 'HOOK CUT GREEN' : `${failures} HOOK CUT FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
