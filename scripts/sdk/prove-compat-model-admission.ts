import assert from 'node:assert/strict'
import { connect, run, MercuryRefusal } from '../../sdk/src/index.ts'
import { compatRoadFixture, mercury, anthropicModel, pythonProof } from './compatRoadFixture.ts'

const guard = setTimeout(() => { console.error('FAIL compat model admission timed out'); process.exit(1) }, 180_000)
const failures: string[] = []
async function check(name: string, work: () => Promise<void>) {
  try { await work(); console.log(`PASS ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error}`) }
}
const c = await compatRoadFixture(Array.from({ length: 12 }, () => ({ kind: 'text', text: 'ANTHROPIC-ANSWER', model: anthropicModel })))
const options = { mercury, cwd: c.cwd, env: c.env, ephemeral: true }
try {
  for (const model of [anthropicModel, c.model, 'compat']) await check(`TS run ${model}`, async () => {
    const task = run({ ...options, model, prompt: 'hello model', partial: true })
    const result = await task.outcome
    assert.equal(result.status, 'completed'); assert.equal((await task.exit).code, 0)
    assert.equal((await task.session).model, model === 'compat' ? c.model : model)
    assert.equal(result.answer, model === anthropicModel ? 'ANTHROPIC-ANSWER' : 'LLMHOST-READY')
    if (model !== anthropicModel) assert(Object.keys(result.models).includes(c.model))
  })
  await check('compat-only credentials need no Anthropic sign-in', async () => {
    const env = { ...c.env }
    delete env.ANTHROPIC_API_KEY
    for (const model of [c.model, 'compat']) {
      const task = run({ ...options, env, model, prompt: 'compat without a subscription' })
      assert.equal((await task.outcome).answer, 'LLMHOST-READY')
      assert.equal((await task.exit).code, 0)
    }
  })
  for (const model of ['local', 'huggingface', 'compat/fixture/not-listed', 'compat/absent/Reasoner']) await check(`TS run refuses ${model} without fallback`, async () => {
    const before = [c.requests.length, c.api.messageRequests().length]
    const task = run({ ...options, model, prompt: 'must not reach another provider' })
    await assert.rejects(task.outcome, error => error instanceof MercuryRefusal && error.errorClass === 'option')
    assert.notEqual((await task.exit).code, 0)
    assert.deepEqual([c.requests.length, c.api.messageRequests().length], before)
  })
  await check('TS runner switches compat and Anthropic, refuses unknown without changing its model', async () => {
    const session = await connect({ ...options, model: anthropicModel })
    try {
      assert.equal((await session.prompt('Anthropic before switching')).answer, 'ANTHROPIC-ANSWER')
      assert.equal((await session.setModel(c.model)).model, c.model)
      assert.equal((await session.prompt('explicit compat switch')).answer, 'LLMHOST-READY')
      assert.equal((await session.setModel('compat')).model, c.model)
      assert.equal((await session.prompt('compat turn')).answer, 'LLMHOST-READY')
      await assert.rejects(session.setModel('compat/fixture/not-listed'), error => error instanceof MercuryRefusal && error.code === -32010)
      assert.equal((await session.prompt('still compat')).answer, 'LLMHOST-READY')
      assert.equal((await session.setModel(anthropicModel)).model, anthropicModel)
      assert.equal((await session.prompt('back to Anthropic')).answer, 'ANTHROPIC-ANSWER')
    } finally { await session.close() }
  })
  await check('TS warm claim resolves the compat class and refuses an unknown endpoint atomically', async () => {
    const session = await connect({ ...options, warm: true })
    try {
      await assert.rejects(session.claim({ session_id: '00000000-0000-4000-8000-000000000123', model: 'compat/absent/Reasoner' }), MercuryRefusal)
      assert.equal(session.sessionId, null)
      await session.claim({ session_id: '00000000-0000-4000-8000-000000000124', model: 'compat' })
      assert.equal((await session.prompt('claimed compat')).answer, 'LLMHOST-READY')
    } finally { await session.close() }
  })
  await check('local and huggingface class words resolve on their configured loopback engines', async () => {
    for (const [model, env] of [
      ['local', { ...c.env, MERCURY_LOCAL_PROBE_TARGETS: `llamacpp=${c.baseUrl.replace(/\/v1$/, '')}`, MERCURY_LOCAL_API_KEY: c.key }],
      ['huggingface', { ...c.env, HF_TOKEN: c.key, MERCURY_HUGGINGFACE_API_BASE: c.baseUrl, MERCURY_HUGGINGFACE_HUB_BASE: c.baseUrl }],
    ] as const) {
      const before = c.api.messageRequests().length
      const task = run({ ...options, env, model, prompt: 'selected class engine' })
      assert.equal((await task.outcome).answer, 'LLMHOST-READY')
      assert.equal((await task.session).model, `${model}/${c.state.modelIds[0]}`)
      assert.equal(c.api.messageRequests().length, before)
    }
  })
  await check('disabled class words use the Crewmate refusal rather than a resolver exception', async () => {
    for (const model of ['compat', 'local', 'huggingface']) {
      const before = [c.requests.length, c.api.messageRequests().length]
      const task = run({ ...options, model, config: { engine: { disabledProviders: [model] } }, prompt: 'disabled class must refuse' })
      await assert.rejects(task.outcome, error => error instanceof MercuryRefusal && error.message.includes(`model '${model}' names no model`))
      assert.deepEqual([c.requests.length, c.api.messageRequests().length], before)
    }
  })
  await check('Python model admission parity', () => pythonProof('python-compat-models.py', c))
  assert(c.requests.length > 0 && c.requests.every(request => request.fault === undefined && request.auth === `Bearer ${c.key}`))
} finally { await c.close(); clearTimeout(guard) }
assert.deepEqual(failures, [])
console.log('PASS compat and Anthropic model admission through both real SDKs')
