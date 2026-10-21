import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connect, run, defineAgent, defineTool, serveTools, MercuryRefusal } from '../../sdk/src/index.ts'
import { startFixtureServer } from '../../sdk/src/testing.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const root = resolve(import.meta.dir, '../..')
const mercury = ['node', join(root, 'dist/mercury.mjs')]
const guard = setTimeout(() => { console.error('FAIL SDK live doors timed out'); process.exit(1) }, 240000)
async function context(turns: (cwd: string) => ScriptedTurn[]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-live-')))
  const cwd = join(home, 'project'); mkdirSync(cwd)
  seedFirstRun(home, [cwd])
  const api = await startFixtureApi(turns(cwd))
  const env = { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), BROWSER: '/usr/bin/true', MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url }
  return { home, cwd, api, env, close: async () => { await api.close(); rmSync(home, { recursive: true, force: true }) } }
}
try {
  const c = await context(cwd => [
    { kind: 'tool_use', name: 'Write', input: { file_path: join(cwd, 'denied.txt'), content: 'never' } },
    { kind: 'text', text: 'Denied as requested.' },
    { kind: 'hang', deltas: ['turn open'] },
  ])
  try {
    let asks = 0
    const session = await connect({ mercury, cwd: c.cwd, env: c.env, mode: 'default', ephemeral: true, partial: true, onPermissionRequest: async ask => {
      assert.equal(ask.tool_name, 'Write'); asks++; return { outcome: 'deny', message: 'SDK host refused this write' }
    } })
    try {
      assert.equal(session.initialized.protocol, 1)
      const first = await session.prompt('Write the file')
      assert.equal(first.status, 'completed'); assert.equal(asks, 1); assert.equal(existsSync(join(c.cwd, 'denied.txt')), false)
      assert.equal(first.denials.length, 1)
      await assert.rejects(session.setMode('not-a-mode'), e => e instanceof MercuryRefusal && e.code === -32010 && (e.data as any).kind === 'mode')
      const second = session.prompt('hold the turn open')
      await c.api.messageRequestStarted(3)
      const id = '11111111-1111-4111-8111-111111111111'
      assert.equal((await session.sendPrompt('a prompt mid-turn', { id, priority: 'next' })).accepted, true)
      assert.equal((await session.withdraw(id)).withdrawn, true)
      const facts = await session.facts(); assert('usage' in facts && 'queue' in facts)
      assert.equal((await session.interrupt()).interrupted, true)
      assert.equal((await second).status, 'interrupted')
      assert(session.rows.some(r => r.type === 'tool_result' && r.output.includes('SDK host refused')))
    } finally { await session.close() }
    console.log('PASS TypeScript live runner initialize, permission, mid-turn prompt, withdrawal, interrupt, facts, typed refusal')
  } finally { await c.close() }

  const identity = await context(() => [{ kind: 'text', text: 'Saved identity.' }])
  try {
    const saved = run({ mercury, cwd: identity.cwd, env: identity.env, prompt: 'save a session' })
    await saved.outcome
    const id = (await saved.session).session_id
    for (const options of [{ resume: id }, { continue: true }]) {
      const session = await connect({ mercury, cwd: identity.cwd, env: identity.env, ...options })
      try { assert.equal(session.initialized.session_id, id) } finally { await session.close() }
    }
    const warm = await connect({ mercury, cwd: identity.cwd, env: identity.env, warm: true })
    try {
      assert.equal(warm.initialized.session_id, null)
      await warm.claim({ session_id: '00000000-0000-4000-8000-000000000099' })
    } finally { await warm.close() }
    console.log('PASS TypeScript real runner partial, resume, continue and warm claim')
  } finally { await identity.close() }

  const streaming = await context(() => [{ kind: 'text', text: 'Streaming input arrived.' }])
  try {
    const task = run({ mercury, cwd: streaming.cwd, env: streaming.env, input: 'rows', ephemeral: true })
    await task.sendPrompt('hello from rows'); task.closeInput()
    assert.equal((await task.outcome).answer, 'Streaming input arrived.')
    assert.equal((await task.exit).code, 0)
    const replay = await startFixtureServer({ rows: task.rows as unknown as Record<string, unknown>[] })
    try { assert.deepEqual(await run({ mercury: replay.mercury, prompt: 'replay' }).outcome, await task.outcome) } finally { await replay.close() }
    console.log('PASS TypeScript live streaming input')
  } finally { await streaming.close() }

  const inline = await context(() => [{ kind: 'tool_use', name: 'mcp__sdk-tools__echo', input: { text: 'inline result' } }, { kind: 'text', text: 'Inline finished.' }])
  const echo = defineTool({ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, execute: (p: { text: string }, context) => { assert(context.signal instanceof AbortSignal); return p.text } })
  try {
    const task = run({ mercury, cwd: inline.cwd, env: inline.env, prompt: 'Use echo', mode: 'default', ephemeral: true, tools: [echo], agent: 'sdk-reader', agentDefs: { 'sdk-reader': defineAgent({ description: 'SDK reader', prompt: 'Use the echo tool.' }) } })
    assert.equal((await task.outcome).status, 'completed')
    assert(task.rows.some(r => r.type === 'tool_result' && r.output.includes('inline result')))
    assert((await task.session).agents.includes('sdk-reader'))
    console.log('PASS live inline MCP tool and inline agent definition')
  } finally { await inline.close() }

  const cancelled = await context(() => [{ kind: 'hang', deltas: ['open'] }])
  try {
    const task = run({ mercury, cwd: cancelled.cwd, env: cancelled.env, prompt: 'cancel', signal: AbortSignal.abort(), ephemeral: true })
    assert.equal((await task.outcome).status, 'interrupted')
    console.log('PASS real run handles pre-aborted AbortSignal after boot')
    const script = `import asyncio,json,sys\nfrom mercury_cli_sdk import run\nasync def main():\n event=asyncio.Event();event.set()\n task=await run('cancel',mercury=json.loads(sys.argv[1]),cwd=sys.argv[2],cancel=event,ephemeral=True)\n assert (await task.outcome)['status']=='interrupted'\n print('PASS Python real run pre-set cancellation event',flush=True)\nasyncio.run(main())`
    const child = spawn('python3', ['-c', script, JSON.stringify(mercury), cancelled.cwd], { env: { ...cancelled.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(root, 'sdk-py/src') }, stdio: 'inherit' })
    assert.equal(await new Promise(r => child.once('close', r)), 0)
  } finally { await cancelled.close() }

  const py = await context(cwd => [
    { kind: 'text', text: 'Python run works.' },
    { kind: 'tool_use', name: 'Write', input: { file_path: join(cwd, 'denied-python.txt'), content: 'never' } },
    { kind: 'text', text: 'Python host answered.' },
    { kind: 'hang', deltas: ['python open'] },
    { kind: 'tool_use', name: 'mcp__sdk-tools__echo', input: { text: 'Python inline result' } },
    { kind: 'text', text: 'Python inline finished.' },
    { kind: 'text', text: 'Saved Python identity.' },
  ])
  try {
    const child = spawn('python3', [join(root, 'scripts/sdk/python-live.py'), JSON.stringify(mercury), py.cwd], { env: { ...py.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(root, 'sdk-py/src') }, stdio: 'inherit' })
    assert.equal(await new Promise(r => child.once('close', r)), 0)
  } finally { await py.close() }
} finally { clearTimeout(guard) }
console.log('PASS both SDKs drive the real frozen CLI over loopback fixtures')
