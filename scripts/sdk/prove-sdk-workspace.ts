import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PYTHON } from './runtime.ts'
import * as sdk from '../../sdk/src/index.ts'
const { connect, structuredSchema, MercurySchemaError } = sdk
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const root = resolve(import.meta.dir, '../..')
const mercury = ['node', join(root, 'dist/mercury.mjs')]
const selected = process.env.SDK_BUILDER_CASE
const guard = setTimeout(() => { console.error('FAIL SDK workspace timed out'); process.exit(1) }, 180000)
async function context(turns: (cwd: string) => ScriptedTurn[]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-workspace-')))
  const cwd = join(home, 'project'); mkdirSync(cwd); seedFirstRun(home, [cwd])
  const api = await startFixtureApi(turns(cwd))
  const env = { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url }
  return { cwd, env, api, close: async () => { await api.close(); rmSync(home, { recursive: true, force: true }) } }
}
const offeredTools = (api: { requests: { raw: string; body: unknown }[] }, said: string): string[] => {
  const request = api.requests.find(r => r.raw.includes(said))
  assert(request, `no model request carried ${JSON.stringify(said)}`)
  return ((request.body as { tools?: { name: string }[] }).tools ?? []).map(tool => tool.name)
}
for (const language of ['ts', 'py']) {
  if (process.env.SDK_BUILDER_LANGUAGE && process.env.SDK_BUILDER_LANGUAGE !== language) continue
  for (const scenario of ['capabilities', 'checkpoints', 'warm', 'roster', 'schema', 'midturn']) {
    if (selected && selected !== scenario) continue
    const c = await context(cwd => scenario === 'warm' ? [] : scenario === 'roster' ? [
      { kind: 'text', text: 'Default roster seen.', whenBody: 'roster of a default session' },
      { kind: 'text', text: 'Opted-out roster seen.', whenBody: 'roster of a session without checkpoints' },
    ] : scenario === 'midturn' ? [
      { kind: 'tool_use', name: 'Sleep', input: { seconds: 2 }, whenBody: 'the folded first prompt' }, { kind: 'text', text: 'Folded reply.', whenBody: 'the folded second prompt' },
      { kind: 'paced', deltas: ['one ', 'two ', 'three.'], gapMs: 700, whenBody: 'the queued first prompt' }, { kind: 'text', text: 'Queued reply.', whenBody: 'the queued second prompt' },
      { kind: 'tool_use', name: 'Sleep', input: { seconds: 2 }, whenBody: 'the swallowed first prompt' }, { kind: 'paced', deltas: ['held back'], gapMs: 100, startDelayMs: 30000, whenBody: 'the swallowed second prompt' },
    ] : scenario === 'schema' ? [
      { kind: 'tool_use', name: 'StructuredOutput', input: { count: 3 }, whenBody: 'the count turn' }, { kind: 'text', text: 'Three.', whenBody: 'the count turn' },
      { kind: 'tool_use', name: 'StructuredOutput', input: { name: 'pelican' }, whenBody: 'the name turn' }, { kind: 'text', text: 'Pelican.', whenBody: 'the name turn' },
      { kind: 'text', text: 'Plain.', whenBody: 'the plain turn' },
      { kind: 'tool_use', name: 'StructuredOutput', input: { count: 9 }, whenBody: 'the boot schema turn' }, { kind: 'text', text: 'Nine.', whenBody: 'the boot schema turn' },
    ] : scenario === 'capabilities' ? [
      { kind: 'tool_use', name: 'Read', input: { file_path: join(cwd, 'virtual.txt') } },
      { kind: 'tool_use', name: 'Write', input: { file_path: join(cwd, 'virtual.txt'), content: 'virtual changed' } },
      { kind: 'text', text: 'Virtual workspace finished.' },
    ] : [
      { kind: 'tool_use', name: 'Read', input: { file_path: join(cwd, 'saved.txt') } },
      { kind: 'tool_use', name: 'Write', input: { file_path: join(cwd, 'saved.txt'), content: 'changed\n' } },
      { kind: 'text', text: 'Checkpoint finished.' },
    ])
    writeFileSync(join(c.cwd, 'saved.txt'), 'original\n')
    try {
      if (language === 'py') {
        const child = spawn(PYTHON, [join(root, 'scripts/sdk/python-workspace.py'), scenario, JSON.stringify(mercury), c.cwd], { env: { ...c.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(root, 'sdk-py/src') }, stdio: 'inherit' })
        assert.equal(await new Promise(r => child.once('close', r)), 0)
      } else if (scenario === 'capabilities') {
        let value = 'virtual original'; let reads = 0; let writes = 0
        const session = await connect({ mercury, cwd: c.cwd, env: c.env, onPermissionRequest: () => ({ outcome: 'allow' }), allowedTools: ['Read', 'Write'], onReadTextFile: () => { reads++; return { content: value } }, onWriteTextFile: params => { writes++; value = params.content } })
        try { assert.equal((await session.prompt('Read then write virtual.txt')).status, 'completed'); assert(reads > 0); assert.equal(writes, 1, JSON.stringify(session.rows.filter(row => row.type === 'tool_result'))); assert.equal(value, 'virtual changed') }
        finally { await session.close() }
      } else if (scenario === 'checkpoints') {
        const session = await connect({ mercury, cwd: c.cwd, env: c.env, onPermissionRequest: () => ({ outcome: 'allow' }), allowedTools: ['Read', 'Write'] })
        try {
          assert.deepEqual(session.fileCheckpoints, { capture: true, source: 'initialize' }, 'a default connect asks for file checkpoints on initialize and the CLI says it captures them')
          const outcome = await session.prompt('Change saved.txt')
          assert.equal(outcome.status, 'completed'); assert.equal(readFileSync(join(c.cwd, 'saved.txt'), 'utf8'), 'changed\n')
          assert.equal(typeof session.lastPromptId, 'string')
          const facts = await session.facts(); assert.equal(facts.file_checkpoints?.capture, true); assert.equal(facts.file_checkpoints?.source, 'initialize'); assert(facts.file_checkpoints?.restorable.includes(session.lastPromptId!))
          const args = { user_message_id: session.lastPromptId!, mode: 'both' as const }
          const dry = await session.rewind({ ...args, dry_run: true }); assert(dry.code?.files_changed.length); assert.equal(readFileSync(join(c.cwd, 'saved.txt'), 'utf8'), 'changed\n')
          const restored = await session.rewind(args); assert.equal(restored.outcome, 'applied'); assert.equal(readFileSync(join(c.cwd, 'saved.txt'), 'utf8'), 'original\n')
        } finally { await session.close() }
      } else if (scenario === 'roster') {
        for (const [said, options, expected] of [['roster of a default session', {}, { capture: true, source: 'initialize' }], ['roster of a session without checkpoints', { checkpoints: false }, { capture: false, source: 'headless' }]] as const) {
          const session = await connect({ mercury, cwd: c.cwd, env: c.env, ...options })
          try { assert.deepEqual(session.fileCheckpoints, expected, said); assert.equal((await session.prompt(`Describe the ${said}`)).status, 'completed') } finally { await session.close() }
        }
      } else if (scenario === 'schema') {
        const count = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } as const
        const name = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } as const
        const malformed = { type: 'nonsense-type', properties: 5 } as unknown as sdk.JsonSchema
        const session = await connect({ mercury, cwd: c.cwd, env: c.env })
        try {
          assert.deepEqual((await session.prompt('the count turn', { schema: count })).structured, { count: 3 })
          assert.deepEqual((await session.prompt('the name turn', { schema: structuredSchema(name, value => ({ who: (value as { name: string }).name.toUpperCase() })) })).structured, { who: 'PELICAN' })
          const plain = await session.prompt('the plain turn'); assert.equal(plain.status, 'completed'); assert(!('structured' in plain), 'a turn without a schema carries no structured output')
          await assert.rejects(session.prompt('the refused turn', { schema: malformed }), (e: unknown) => e instanceof MercurySchemaError && e.code === -32602 && e.outcome === null && e.issues[0]?.path === 'schema' && /not a JSON schema/.test(e.issues[0].message) && e.message === e.issues[0].message)
          assert.equal(typeof session.lastPromptId, 'string')
          const shapes = c.api.requests.map(r => JSON.stringify(((r.body as { tools?: { name: string; input_schema?: unknown }[] }).tools ?? []).find(t => t.name === 'StructuredOutput')?.input_schema ?? null))
          assert(shapes.includes(JSON.stringify(count)) && shapes.includes(JSON.stringify(name)) && shapes.includes('null'), `each turn's schema reaches the model as that turn's StructuredOutput tool, and the plain turn has none: ${shapes.join(' | ')}`)
        } finally { await session.close() }
        const boot = await connect({ mercury, cwd: c.cwd, env: c.env, schema: structuredSchema(count, value => (value as { count: number }).count * 2) })
        try { assert(boot.child.spawnargs.includes('--schema'), 'the boot schema travels on initialize and as --schema, the road every Mercury version honours'); assert.equal((await boot.prompt('the boot schema turn')).structured, 18) } finally { await boot.close() }
        await assert.rejects(connect({ mercury, cwd: c.cwd, env: c.env, schema: malformed }), (e: unknown) => e instanceof MercurySchemaError && e.code === -32602 && e.issues[0]?.path === 'schema')
      } else if (scenario === 'midturn') {
        for (const shape of ['folded', 'queued', 'swallowed'] as const) {
          const session = await connect({ mercury, cwd: c.cwd, env: c.env, onPermissionRequest: () => ({ outcome: 'allow' }), allowedTools: ['Sleep'] })
          try {
            await assert.rejects(session.prompt(`the ${shape} first prompt`, { timeoutMs: 500 }), /prompt: no answer within 500 ms/)
            const started = performance.now()
            const second = session.prompt(`the ${shape} second prompt`, { timeoutMs: 25000 })
            if (shape === 'swallowed') {
              setTimeout(() => void session.interrupt().catch(() => undefined), 3500)
              await assert.rejects(second, (e: unknown) => e instanceof sdk.MercuryError && /^prompt: turn 1 ended interrupted and the runner holds this prompt neither queued nor in a turn/.test(e.message))
              assert(performance.now() - started < 12000, 'the swallowed prompt is rejected within the grace after the interrupted outcome')
            } else {
              const row = await second
              assert.equal(row.status, 'completed', shape)
              assert.equal(row.answer, shape === 'folded' ? 'Folded reply.' : 'Queued reply.', `${shape}: the prompt resolves with the turn that answered it`)
              assert.equal(row.turn, shape === 'folded' ? 1 : 2, shape)
              if (shape === 'folded') assert(session.rows.some(r => r.type === 'text' && r.in_reply_to?.some(mark => mark.id === session.lastPromptId)), 'the fold is marked in_reply_to the second prompt')
            }
          } finally { await session.close() }
        }
      } else {
        const session = await sdk.prewarm({ mercury, cwd: c.cwd, env: c.env })
        try { assert.equal(session.initialized.session_id, null); assert.equal((await session.claim({ session_id: '00000000-0000-4000-8000-000000000091' })).session_id, '00000000-0000-4000-8000-000000000091') }
        finally { await session.close() }
      }
      if (scenario === 'roster') {
        for (const said of ['roster of a default session', 'roster of a session without checkpoints']) {
          const offered = offeredTools(c.api, said)
          for (const tool of ['Crewmate', 'Workflow']) assert(offered.includes(tool), `a connect session must offer ${tool} (${said}); offered: ${offered.join(',')}`)
          assert(!offered.includes('Contract'), `a connect session must not carry the session-runner Contract tool (${said})`)
        }
      }
      console.log(`PASS ${language} real runner ${scenario}`)
    } finally { await c.close() }
  }
}
clearTimeout(guard)
