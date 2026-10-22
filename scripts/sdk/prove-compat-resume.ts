import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, run, MercuryRefusal } from '../../sdk/src/index.ts'
import { compatRoadFixture, mercury, anthropicModel, pythonProof } from './compatRoadFixture.ts'

const guard = setTimeout(() => { console.error('FAIL compat resume timed out'); process.exit(1) }, 180_000)
const failures: string[] = []
async function check(name: string, work: () => Promise<void>) {
  try { await work(); console.log(`PASS ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error}`) }
}
const c = await compatRoadFixture(Array.from({ length: 30 }, () => ({ kind: 'text', text: 'ANTHROPIC-ANSWER', thinking: 'Anthropic fixture reasoning', model: anthropicModel })))
const options = { mercury, cwd: c.cwd, env: c.env }
try {
  for (const model of [anthropicModel, c.model]) await check(`cold and warm resume ${model}`, async () => {
    const saved = run({ ...options, model, prompt: 'remember the first turn', partial: true })
    assert.equal((await saved.outcome).status, 'completed')
    const sid = (await saved.session).session_id
    const before = c.requests.length
    const cold = run({ ...options, resume: sid, prompt: 'cold resume', partial: true })
    assert.equal((await cold.outcome).status, 'completed')
    assert.equal((await cold.session).model, model)
    if (model === c.model) {
      const replay = c.requests.slice(before).find(request => request.body.messages.some((message: any) => message.role === 'assistant'))
      assert(replay, 'resume sent the preceding assistant turn')
      assert(replay.body.messages.some((message: any) => message.role === 'assistant' && message.reasoning_content === 'reasoning-0'), 'compat resume kept reasoning_content')
    }
    const warm = await connect({ ...options, warm: true })
    try {
      await warm.claim({ session_id: sid, resume: true })
      assert.equal(warm.sessionId, sid)
      const outcome = await warm.prompt('warm resume')
      assert.equal(outcome.status, 'completed')
      assert.equal(outcome.answer, model === c.model ? 'LLMHOST-READY' : 'ANTHROPIC-ANSWER')
      assert(warm.rows.some(row => row.type === 'step' && row.model === model))
    } finally { await warm.close() }
  })
  await check('unavailable saved compat model refuses cold and warm resume without another provider', async () => {
    const saved = run({ ...options, model: c.model, prompt: 'save before the endpoint goes away' })
    await saved.outcome
    const sid = (await saved.session).session_id
    writeFileSync(join(c.home, 'settings.json'), JSON.stringify({ engine: c.settings.engine }))
    try {
      const before = [c.requests.length, c.api.messageRequests().length]
      const cold = run({ ...options, resume: sid, prompt: 'do not substitute' })
      await assert.rejects(cold.outcome, error => error instanceof MercuryRefusal && error.errorClass === 'load' && error.message.includes(c.model))
      const warm = await connect({ ...options, warm: true })
      try {
        await assert.rejects(warm.claim({ session_id: sid, resume: true }), MercuryRefusal)
        assert.equal(warm.sessionId, null)
      } finally { await warm.close() }
      assert.deepEqual([c.requests.length, c.api.messageRequests().length], before)
      const explicit = run({ ...options, resume: sid, model: anthropicModel, prompt: 'I choose the other provider' })
      assert.equal((await explicit.outcome).answer, 'ANTHROPIC-ANSWER')
    } finally { writeFileSync(join(c.home, 'settings.json'), JSON.stringify(c.settings)) }
  })
  await check('Python cold and warm resume preserve the model', () => pythonProof('python-compat-resume.py', c))
  assert(c.requests.every(request => request.fault === undefined))
} finally { await c.close(); clearTimeout(guard) }
assert.deepEqual(failures, [])
console.log('PASS headless and both SDK resume roads retain provider, replay and reasoning')
