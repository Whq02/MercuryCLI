import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootLead, closeWorld, DIST, makeWorld } from './crew-world.ts'

const bundle = readFileSync(DIST, 'utf8')
assert(!bundle.includes('CREATE TABLE IF NOT EXISTS deliveries'), 'the boot bundle must not contain the board store')
assert(!bundle.includes('A post holds at most 16 mentions'), 'the boot bundle must not contain the board implementation')
const modes = process.argv.includes('--cold-only') ? ['cold', 'setting'] as const : ['cold', 'setting', 'refused', 'on'] as const
for (const mode of modes) {
  const enabled = mode === 'setting' || mode === 'on'
  const world = await makeWorld(`swarm-${mode}`, mode === 'on' ? [
    { kind: 'tool_use', name: 'CrewBoard', input: { op: 'post', clientOpId: 'built-lead', kind: 'ask', text: 'Which lane has the parser?', taskId: 'parser' } },
    { kind: 'text', text: 'Board request finished.' },
  ] : [{ kind: 'text', text: 'Plain request finished.' }])
  const settings = join(world.config, 'settings.json')
  const prior = existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {}
  writeFileSync(settings, JSON.stringify({ ...prior, swarm: { enabled } }))
  const loads = join(world.dir, 'loads.txt')
  const hook = join(world.dir, 'loads.mjs')
  writeFileSync(hook, `import { registerHooks } from 'node:module'; import { appendFileSync } from 'node:fs'; registerHooks({ load(url, context, next) { if (url.includes('crew-board.mjs')) appendFileSync(${JSON.stringify(loads)}, url + '\\n'); return next(url, context); } });`)
  world.env.NODE_OPTIONS = `--import ${hook}`
  const session = bootLead(world, [], [mode === 'on' ? 'CrewBoard' : 'Read'])
  try {
    if (mode === 'refused' || mode === 'on') {
      session.submit('/swarm on')
      await session.waitFor('swarm command answered', () => session.stdout().includes(mode === 'on' ? 'Swarm on for new crewmates' : 'enable swarm.enabled'))
    }
    const beforeStatus = (session.stdout().match(/"type":"command_output"/g) ?? []).length
    session.submit('/swarm')
    await session.waitFor('headless swarm still answers its state', () => (session.stdout().match(/"type":"command_output"/g) ?? []).length > beforeStatus)
    assert(!session.stdout().includes('interactive in this form'), session.stdout())
    session.submit('Check the wave.')
    await session.waitFor('the built session answered', () => session.stdout().includes(mode === 'on' ? 'Board request finished.' : 'Plain request finished.'))
    assert.equal(await session.end(), 0, session.stderr())
    const loaded = existsSync(loads) ? readFileSync(loads, 'utf8') : ''
    assert.equal(loaded.includes('crew-board.mjs'), mode === 'on', `${mode}: ${loaded}`)
    if (mode === 'on') {
      const requests = world.fixture.messageRequests()
      assert(requests.some(r => r.raw.includes('built-lead')))
      assert(session.stdout().includes('eventId'), session.stdout().slice(-3000))
    } else assert(!world.fixture.messageRequests().some(r => r.raw.includes('CrewBoard reads and posts')))
    console.log(`PASS built session ${mode}: optional implementation ${mode === 'on' ? 'loaded after /swarm on' : 'never loaded'}`)
  } finally {
    await session.terminate()
    await closeWorld(world)
  }
}
console.log('Built board lazy-load checks passed')
