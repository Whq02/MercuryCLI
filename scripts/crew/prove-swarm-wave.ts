import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootLead, closeWorld, LEAD_MODEL, makeWorld, toolResultOf } from './crew-world.ts'

const world = await makeWorld('swarm-wave', [
  { kind: 'tool_use', name: 'Crewmate', id: 'launch-alpha', input: { name: 'alpha', team: 'parser', description: 'Check parser fields', prompt: 'Post a parser question on the board, read the thread, then finish.', crewmate_type: 'mercury-crew', model: LEAD_MODEL, run_in_background: false } },
  { kind: 'tool_use', name: 'CrewBoard', id: 'alpha-post', input: { op: 'post', clientOpId: 'alpha-question', kind: 'ask', threadId: 'parser', taskId: 'parser', text: 'Which fields identify the resumed run?' } },
  { kind: 'tool_use', name: 'CrewBoard', id: 'alpha-read', input: { op: 'read', thread: 'parser' } },
  { kind: 'text', text: 'Alpha posted and read the parser thread.' },
  { kind: 'tool_use', name: 'Crewmate', id: 'launch-beta', input: { name: 'beta', team: 'transport', description: 'Check transport fields', prompt: 'Read the parser thread, post a transport question to it, then finish.', crewmate_type: 'mercury-crew', model: LEAD_MODEL, run_in_background: false } },
  { kind: 'tool_use', name: 'CrewBoard', id: 'beta-read', input: { op: 'read', thread: 'parser', since: 0 } },
  { kind: 'tool_use', name: 'CrewBoard', id: 'beta-post', input: { op: 'post', clientOpId: 'beta-question', kind: 'ask', threadId: 'parser', taskId: 'transport', text: 'Does the next packet preserve both fields?' } },
  { kind: 'text', text: 'Beta read and posted to the parser thread.' },
  { kind: 'tool_use', name: 'CrewBoard', id: 'lead-read', input: { op: 'read', thread: 'parser' } },
  { kind: 'text', text: 'The two-seat board wave is finished.' },
])
const settings = join(world.config, 'settings.json')
writeFileSync(settings, JSON.stringify({ ...(existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {}), swarm: { enabled: true } }))
const session = bootLead(world, ['--sovereign'], ['Crewmate', 'CrewBoard'])
try {
  session.submit('/swarm on')
  await session.waitFor('the board is on', () => session.stdout().includes('Swarm on for new crewmates') || session.stdout().toLowerCase().includes('unknown command'))
  assert(session.stdout().includes('Swarm on for new crewmates'), session.stdout())
  session.submit('Run the parser wave with alpha, then beta, and read their thread.')
  await session.waitFor('two actual crewmates finished the board wave', () => session.stdout().includes('The two-seat board wave is finished.'), 120000)
  assert.equal(await session.end(), 0, session.stderr())
  for (const id of ['alpha-post', 'alpha-read', 'beta-post', 'beta-read', 'lead-read']) {
    const result = toolResultOf(world, id)
    assert(result && !result.isError, `${id}: ${JSON.stringify(result)}\n${session.stdout().slice(-2500)}`)
  }
  const posted = (id: string) => {
    const text = toolResultOf(world, id)!.text
    const body = text.match(/\{"ok":true,"eventId":"[^"]+","seq":\d+,"replay":false(?:,"reach":\{[^}]*\})?(?:,"note":"[^"]*")?\}/)?.[0]
    assert(body, `${id}: ${text}`)
    return JSON.parse(body)
  }
  const alpha = posted('alpha-post')
  const beta = posted('beta-post')
  assert(alpha.seq < beta.seq)
  assert(toolResultOf(world, 'beta-read')!.text.includes(alpha.eventId))
  assert(toolResultOf(world, 'beta-read')!.text.includes('"team":"parser"'), 'launch team reaches the enrollment and another team can read it')
  const metadata: any[] = []
  function walk(dir: string): void { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.name.endsWith('.meta.json')) metadata.push(JSON.parse(readFileSync(path, 'utf8'))) } }
  walk(join(world.config, 'projects'))
  assert.equal(metadata.filter(row => row.swarm === true).length, 2)
  console.log('PASS built lead and two real crewmates post and read one ordered wave; both launch records keep the board road')
} finally {
  await session.terminate()
  await closeWorld(world)
}
