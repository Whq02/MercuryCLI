import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootLead, closeWorld, makeWorld, record, toolResultOf } from './crew-world.ts'

const text = 'A'.repeat(3000)
const world = await makeWorld('swarm-controls', [
  { kind: 'tool_use', name: 'CrewBoard', id: 'long-post', input: { op: 'post', clientOpId: 'long-post', kind: 'result', text } },
  { kind: 'tool_use', name: 'CrewBoard', id: 'first-read', input: { op: 'read' } },
  { kind: 'tool_use', name: 'CrewBoard', id: 'second-read', input: { op: 'read' } },
  { kind: 'text', text: 'Uncapped reads finished.' },
  { kind: 'tool_use', name: 'CrewBoard', id: 'capped-read', input: { op: 'read', since: 0 } },
  { kind: 'text', text: 'Capped read finished.' },
])
const settings = join(world.config, 'settings.json')
writeFileSync(settings, JSON.stringify({ ...(existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {}), swarm: { enabled: true, seatAllowance: 1000, waveAllowance: 1000, postChars: 400 } }))
const session = bootLead(world, [], ['CrewBoard'])
const command = async (op: string, words: string) => {
  const before = session.stdout().length
  session.submit(`/swarm ${op}`)
  await session.waitFor(`swarm ${op} answered`, () => session.stdout().slice(before).includes(words))
}
try {
  await command('on', 'Swarm on for new crewmates')
  await command('uncap', '/swarm uncap is on')
  await command('status', 'no limit per agent, no limit per wave')
  session.submit('Post the finding and read the board twice.')
  await session.waitFor('the uncapped tool calls finished', () => session.stdout().includes('Uncapped reads finished.'))
  assert(toolResultOf(world, 'long-post')?.text.includes('"ok":true'))
  assert(toolResultOf(world, 'first-read')?.text.includes(text))
  assert(toolResultOf(world, 'second-read')?.text.includes('"events":[]'))
  assert(toolResultOf(world, 'second-read')?.text.includes('"tokens":0'))
  assert(toolResultOf(world, 'second-read')?.text.includes('"skippedSeen":1'))
  await command('cap', '1,000 per agent, 1,000 per wave')
  await command('status', '400 characters per post')
  session.submit('Re-read the board after restoring its caps.')
  await session.waitFor('the capped read finished', () => session.stdout().includes('Capped read finished.'))
  assert(toolResultOf(world, 'capped-read')?.text.includes('swarm.seatAllowance'))
  assert(toolResultOf(world, 'capped-read')?.text.includes('/swarm uncap'))
  assert.equal(await session.end(), 0, session.stderr())
  console.log('PASS built /swarm uncap/status/cap: long post and first read arrive whole; second read skips seen without charge; restoring the cap names the spent seat allowance')
} finally {
  record('swarm-controls-requests.json', JSON.stringify(world.fixture.messageRequests().map(request => request.body)))
  record('swarm-controls-out.txt', session.stdout())
  await session.terminate()
  await closeWorld(world)
}
