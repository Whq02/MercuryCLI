import assert from 'node:assert/strict'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorld, bootLead, toolResultOf, userTextsOf } from './crew-world.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const childPrompt = 'stopped-child-wire-fixture'
const model = 'claude-opus-5-5'
const readInput = { file_path: '' }
const stopInput = { task_id: '' }
const world = await makeWorld('taskstop-resume-wire', [
  { kind: 'tool_use', name: 'Read', id: 'child-read', input: readInput, thinking: 'Read the file before editing.', whenSaid: childPrompt, model },
  { kind: 'hang', deltas: [], whenSaid: childPrompt },
  { kind: 'hang', deltas: [], whenSaid: childPrompt },
  { kind: 'text', text: 'CHILD-RESUMED', whenSaid: childPrompt, model },
  { kind: 'tool_use', name: 'Crewmate', id: 'launch-stopped-child', input: { name: 'stopped-child', description: 'stopped child fixture', prompt: childPrompt, run_in_background: true, model, effort: 'max' }, whenSaid: 'parent-launch' },
  { kind: 'text', text: 'PARENT-LAUNCHED', whenSaid: 'parent-launch' },
  { kind: 'tool_use', name: 'TaskStop', id: 'stop-one', input: stopInput, whenSaid: 'parent-stop-one' },
  { kind: 'text', text: 'PARENT-STOPPED-ONE', whenSaid: 'parent-stop-one' },
  { kind: 'tool_use', name: 'ResumeCrewmate', id: 'resume-one', input: { to: 'stopped-child', message: 'resume the stopped edit' }, whenSaid: 'parent-resume-one' },
  { kind: 'text', text: 'PARENT-RESUMED-ONE', whenSaid: 'parent-resume-one' },
  { kind: 'tool_use', name: 'TaskStop', id: 'stop-two', input: stopInput, whenSaid: 'parent-stop-two' },
  { kind: 'text', text: 'PARENT-STOPPED-TWO', whenSaid: 'parent-stop-two' },
  { kind: 'tool_use', name: 'ResumeCrewmate', id: 'resume-two', input: { to: 'stopped-child', message: 'do as the lead said' }, whenSaid: 'parent-resume-two' },
  { kind: 'text', text: 'PARENT-RESUMED-TWO', whenSaid: 'parent-resume-two' },
  ...Array.from({ length: 12 }, () => ({ kind: 'text' as const, text: 'PARENT-NOTED' })),
])
readInput.file_path = join(world.project, 'README.md')
const lead = bootLead(world, ['--sovereign'], ['Crewmate', 'TaskStop', 'ResumeCrewmate'])
const childRequests = (): any[] => world.fixture.messageRequests().filter(request => (request.body as any).model === model).map(request => request.body)
const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)])
try {
  lead.submit('parent-launch')
  await lead.waitFor('child has read and entered its empty stream', () => childRequests().length === 2 && toolResultOf(world, 'launch-stopped-child') !== null)
  const receipt = toolResultOf(world, 'launch-stopped-child')!
  stopInput.task_id = /agentId: (a[0-9a-z]+)/.exec(receipt.text)?.[1] ?? ''
  assert.notEqual(stopInput.task_id, '', receipt.text)
  const second = childRequests()[1]
  assert.ok(JSON.stringify(second.messages).includes('signature'))
  for (const [round, expected] of [['one', 3], ['two', 4]] as const) {
    lead.submit(`parent-stop-${round}`)
    await lead.waitFor(`TaskStop ${round} settles`, () => toolResultOf(world, `stop-${round}`) !== null)
    assert.equal(toolResultOf(world, `stop-${round}`)?.isError, false)
    lead.submit(`parent-resume-${round}`)
    await lead.waitFor(`ResumeCrewmate ${round} sends its request`, () => childRequests().length === expected && toolResultOf(world, `resume-${round}`) !== null)
    assert.equal(toolResultOf(world, `resume-${round}`)?.isError, false)
    const request = childRequests().at(-1)
    assert.equal(request.output_config?.effort, 'max')
    assert.deepEqual(request.thinking, second.thinking)
    assert.equal(request.max_tokens, second.max_tokens)
    assert.ok(JSON.stringify(request.messages).includes('[Request interrupted by user]'))
    assert.ok(JSON.stringify(request.messages).includes(round === 'one' ? 'resume the stopped edit' : 'do as the lead said'))
    assert.deepEqual(request.messages.filter((row: any) => row.role === 'assistant'), second.messages.filter((row: any) => row.role === 'assistant'))
    assert.ok(request.messages.every((row: any, index: number) => index === 0 || row.role !== request.messages[index - 1].role), 'Anthropic request roles alternate')
    console.log(`PASS TaskStop then ResumeCrewmate ${round}: alternating wire roles, signed reasoning, max effort and output ceiling preserved`)
  }
  await lead.waitFor('the resumed child completes', () => userTextsOf(world).some(text => text.includes('<result>CHILD-RESUMED</result>')))
  const path = files(world.config).find(path => path.endsWith(`/agent-${stopInput.task_id}.jsonl`))
  assert.ok(path)
  const records = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const inputs = records.filter(record => record.payload?.kind === 'input')
  assert.ok(inputs.some(record => JSON.stringify(record.payload).includes('resume the stopped edit')))
  assert.ok(inputs.some(record => JSON.stringify(record.payload).includes('do as the lead said')))
  assert.equal(childRequests().length, 4)
  assert.equal(await lead.end(), 0)
  console.log('PASS the transcript keeps the stop and resume records separately; no synthetic assistant stop was invented')
} finally {
  await lead.terminate()
  await world.fixture.close()
  rmSync(world.dir, { recursive: true, force: true })
}
