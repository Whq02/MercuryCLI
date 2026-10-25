import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { makeWorld, bootLead, LEAD_MODEL, toolResultOf, userTextsOf } from './crew-world.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ResumeAgentTool } = await import('../../src/tools/ResumeAgentTool/ResumeAgentTool.ts')
const childPrompt = 'interrupt-child-only'
const resumePrompt = 'resume-the-cut-turn-now'
const world = await makeWorld('resume-interrupt', [
  { kind: 'hang', deltas: ['CHILD-PARTIAL'], whenSaid: childPrompt },
  { kind: 'text', text: 'CHILD-RESUMED', whenSaid: childPrompt },
  { kind: 'tool_use', name: 'Crewmate', id: 'launch-child', input: { name: 'interrupt-child', description: 'interrupt child', prompt: childPrompt, run_in_background: true, effort: 'high' }, whenSaid: 'parent-launch' },
  { kind: 'text', text: 'PARENT-LAUNCHED', whenSaid: 'parent-launch' },
  { kind: 'tool_use', name: 'ResumeCrewmate', id: 'interrupt-child', input: { to: 'interrupt-child', message: resumePrompt, interrupt: true }, whenSaid: 'parent-interrupt' },
  { kind: 'text', text: 'PARENT-INTERRUPTED', whenSaid: 'parent-interrupt' },
  ...Array.from({ length: 8 }, () => ({ kind: 'text' as const, text: 'PARENT-NOTED' })),
])
const lead = bootLead(world, ['--sovereign'], ['Crewmate', 'ResumeCrewmate'])
const childRequests = (): any[] => world.fixture.messageRequests().filter(request => {
  const text = JSON.stringify((request.body as { messages?: unknown[] }).messages)
  return text.includes(childPrompt) && !text.includes('parent-launch')
}).map(request => request.body)
try {
  const input = ResumeAgentTool.inputSchema.parse({ to: 'interrupt-child', message: resumePrompt, interrupt: true })
  assert.equal((input as Record<string, unknown>).interrupt, true, 'interrupt survives tool validation')
  lead.submit('parent-launch')
  await lead.waitFor('child is streaming', () => childRequests().length === 1)
  lead.submit('parent-interrupt')
  await lead.waitFor('interrupt tool settles', () => toolResultOf(world, 'interrupt-child') !== null)
  await lead.waitFor('new turn begins without waiting for the old response', () => childRequests().length >= 2, 15_000)
  const [first, second] = childRequests()
  assert.equal(second.model, LEAD_MODEL)
  assert.equal(second.output_config?.effort, first.output_config?.effort)
  assert.ok(JSON.stringify(second.messages).includes('CHILD-PARTIAL'))
  assert.ok(JSON.stringify(second.messages).includes('[Request interrupted by user]'))
  assert.ok(JSON.stringify(second.messages).includes(resumePrompt))
  await lead.waitFor('resumed child completes', () => userTextsOf(world).some(text => text.includes('<result>CHILD-RESUMED</result>')))
  assert.ok(userTextsOf(world).some(text => text.includes('<status>interrupted</status>')))
  assert.equal(childRequests().length, 2, 'exactly one replacement turn')
  assert.equal(await lead.end(), 0)
  console.log('PASS delta pin 11: typed interrupt, partial replay, same model and effort, one immediate replacement turn')
} finally {
  await lead.terminate()
  await world.fixture.close()
  rmSync(world.dir, { recursive: true, force: true })
}
