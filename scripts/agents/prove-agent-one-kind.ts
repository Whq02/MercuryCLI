#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const ROOT = join(import.meta.dir, '../..')

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passed++
  else failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { inputSchema, AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const { getPrompt } = await import('../../src/tools/AgentTool/prompt.ts')

console.log('── §1 the schema: crew_name is an unknown key like any other ──')
const schema = inputSchema()
check('no crew_name key in the launch schema', !('crew_name' in schema.shape), Object.keys(schema.shape).join(','))
const base = { description: 'probe', prompt: 'say pong', name: 'pong' }
const withCrew = schema.safeParse({ ...base, crew_name: 'k3' })
const withNonsense = schema.safeParse({ ...base, banana: 'k3' })
check('a launch carrying crew_name parses', withCrew.success)
check('a launch carrying a nonsense key parses', withNonsense.success)
check(
  'the two parse to the same launch — the crew name is dropped like the nonsense key',
  withCrew.success && withNonsense.success && JSON.stringify(withCrew.data) === JSON.stringify(withNonsense.data),
)
check('the parsed launch carries no crew_name', withCrew.success && !('crew_name' in withCrew.data))

console.log('── §2 the words a model reads ──')
const descriptions = Object.values(schema.shape)
  .map(field => (field as { description?: string }).description ?? '')
  .join('\n')
check('no parameter description names crew_name or a crew to join', !/crew_name|crew a named|joins/.test(descriptions))
const prompt = await getPrompt([], false)
check('the tool prompt never spells crew_name', !prompt.includes('crew_name'))
check('the tool prompt has no in-process-crewmate or crewmates-cannot-spawn note', !/in-process crewmate session|cannot spawn crewmates/.test(prompt))
const receiptOf = (status: string): string => {
  try {
    return JSON.stringify(AgentTool.mapToolResultToToolResultBlockParam({ status, agentId: 'x', agentName: 'pong', crewName: 'k3' } as never, 'tool-1'))
  } catch (error) {
    return `threw: ${(error as Error).message}`
  }
}
const spawned = receiptOf('crewmate_spawned')
const nonsense = receiptOf('banana_spawned')
check('a crewmate_spawned status is as unknown as a nonsense status', spawned.replace('crewmate_spawned', '?') === nonsense.replace('banana_spawned', '?'), spawned)
check('no spawned-crewmate receipt line exists', !/Crewmate spawned|mailbox/.test(spawned))

console.log('── §3 the source: one spawn road ──')
const source = readFileSync(join(ROOT, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
for (const word of ['crew_name', 'isCrewmateSpawn', 'spawnCrewmate', 'crewmate_spawned', 'spawnMultiAgent']) {
  check(`AgentTool.tsx does not spell ${word}`, !source.includes(word))
}
const promptSource = readFileSync(join(ROOT, 'src/tools/AgentTool/prompt.ts'), 'utf8')
check('prompt.ts reads no crewmate identity', !/isInProcessCrewmate|isCrewmate\(/.test(promptSource))

console.log(`agent-one-kind: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
