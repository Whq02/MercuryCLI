#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handoffTurn } from '../lib/fixtureApi.ts'
import { dist, quote, runDoor, sceneRoot, type Row } from './lib/runDoor.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'hook-payload-facts-'))
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

let failures = 0
const check = (label: string, good: boolean, detail = ''): void => {
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
if (!existsSync(dist)) {
  console.log(`FAIL — ${dist} is missing; build first`)
  process.exit(1)
}

const C = await import('../../src/utils/hooks/contract.ts')
const { buildHookPayload } = await import('../../src/utils/hooks/fire.ts')

console.log('§1 the contract: tool.after carries the call wall time; every payload carries the crewmate identity fields')
{
  const base = { session_id: 's', transcript_path: '/t.jsonl', cwd: '/w', event: 'tool.after' }
  const fields = { tool: 'Read', input: {}, output: 'ok', call_id: 'c1', ok: true, cut: false }
  const schema = C.hookPayloadSchema('tool.after')
  check('a tool.after payload with wall_ms parses', schema.safeParse({ ...base, ...fields, wall_ms: 42 }).success)
  check('a tool.after payload without wall_ms is refused: the field is part of the moment', !schema.safeParse({ ...base, ...fields }).success)
  check('wall_ms is a whole number of milliseconds, never negative', !schema.safeParse({ ...base, ...fields, wall_ms: -1 }).success && !schema.safeParse({ ...base, ...fields, wall_ms: 1.5 }).success)
  const shape = C.hookEventTable['tool.after'].payload().shape
  check('the field is described for the schema readers', String((shape.wall_ms as { description?: string } | undefined)?.description).includes('wall time'))
  for (const event of C.HOOK_EVENTS) {
    const s = C.hookPayloadSchema(event).shape
    check(`${event}: crewmate_id and crewmate_type ride the base fields as optional`, 'crewmate_id' in s && 'crewmate_type' in s && 'session_id' in s)
  }
  const turnEnd = C.hookPayloadSchema('turn.end').shape
  check('turn.end keeps wall_ms, so one spelling names one fact on the table', 'wall_ms' in turnEnd)
}

console.log('§2 buildHookPayload: a crewmate moment names the crewmate; the lead moment carries the session id alone')
{
  const fields = { tool: 'Read', input: { file_path: '/w/a.txt' }, output: 'x', call_id: 'c1', ok: true, cut: false, wall_ms: 7 }
  const crewmate = buildHookPayload('tool.after', fields, { scope: { sessionId: 'sess-1', crewmateId: 'crew-9', cwd: '/w' }, crewmateType: 'reviewer' }) as Record<string, unknown>
  check('a crewmate scope lands as crewmate_id and crewmate_type beside session_id', crewmate.crewmate_id === 'crew-9' && crewmate.crewmate_type === 'reviewer' && crewmate.session_id === 'sess-1' && crewmate.wall_ms === 7, JSON.stringify(crewmate))
  const lead = buildHookPayload('tool.after', fields, { scope: { sessionId: 'sess-1', cwd: '/w' } }) as Record<string, unknown>
  check('the lead scope carries no crewmate fields: their absence is the lead', !('crewmate_id' in lead) && !('crewmate_type' in lead) && lead.session_id === 'sess-1', JSON.stringify(lead))
  check('both parse under the moment schema', C.hookPayloadSchema('tool.after').safeParse(crewmate).success && C.hookPayloadSchema('tool.after').safeParse(lead).success)
}

console.log('§3 the run door: a tool.after hook reads the wall time of the call it watched')
{
  const paths = sceneRoot('hook-payload-facts-')
  const target = join(paths.cwd, 'note.txt')
  writeFileSync(target, 'the note\n')
  const after = join(paths.root, 'after.json')
  const result = await runDoor(paths, {
    turns: [
      { kind: 'tool_use', name: 'Read', input: { file_path: target }, id: 'facts_1' },
      { kind: 'text', text: 'fixture answered' },
      handoffTurn(),
    ],
    hooks: { 'tool.after': [{ name: 'after', match: 'Read', run: `cat > ${quote(after)}` }] },
  })
  check('the run settles against the fixture', result.code === 0 && result.rows.some(row => row.type === 'outcome' && row.status === 'completed'), `code ${result.code} ${result.stderr.slice(0, 300)}`)
  const payload = existsSync(after) ? (JSON.parse(readFileSync(after, 'utf8')) as Row) : undefined
  check('the tool.after hook received its payload', payload?.event === 'tool.after' && payload.call_id === 'facts_1' && payload.tool === 'Read', JSON.stringify(payload))
  const wall = payload?.wall_ms
  check('the payload carries wall_ms as a whole number of milliseconds', typeof wall === 'number' && Number.isInteger(wall) && wall >= 0, JSON.stringify(payload))
  check('the wall time is within the run that produced it', typeof wall === 'number' && wall <= result.tookMs, `wall ${String(wall)} run ${result.tookMs}`)
  check('the captured payload parses under the published schema', payload !== undefined && C.hookPayloadSchema('tool.after').safeParse(payload).success, JSON.stringify(payload))
  check("the lead's call carries no crewmate fields and its session id", payload !== undefined && !('crewmate_id' in payload) && typeof payload.session_id === 'string', JSON.stringify(payload))
  rmSync(paths.root, { recursive: true, force: true })
}

rmSync(root, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\nprove-hook-payload-facts: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-hook-payload-facts: all green')
