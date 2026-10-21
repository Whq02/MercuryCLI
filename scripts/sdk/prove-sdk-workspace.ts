import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as sdk from '../../sdk/src/index.ts'
const { connect } = sdk
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
  return { cwd, env, close: async () => { await api.close(); rmSync(home, { recursive: true, force: true }) } }
}
for (const language of ['ts', 'py']) {
  for (const scenario of ['capabilities', 'checkpoints', 'warm']) {
    if (selected && selected !== scenario) continue
    const c = await context(cwd => scenario === 'warm' ? [] : scenario === 'capabilities' ? [
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
        const child = spawn('python3', [join(root, 'scripts/sdk/python-workspace.py'), scenario, JSON.stringify(mercury), c.cwd], { env: { ...c.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(root, 'sdk-py/src') }, stdio: 'inherit' })
        assert.equal(await new Promise(r => child.once('close', r)), 0)
      } else if (scenario === 'capabilities') {
        let value = 'virtual original'; let reads = 0; let writes = 0
        const session = await connect({ mercury, cwd: c.cwd, env: c.env, onPermissionRequest: () => ({ outcome: 'allow' }), allowedTools: ['Read', 'Write'], onReadTextFile: () => { reads++; return { content: value } }, onWriteTextFile: params => { writes++; value = params.content } })
        try { assert.equal((await session.prompt('Read then write virtual.txt')).status, 'completed'); assert(reads > 0); assert.equal(writes, 1, JSON.stringify(session.rows.filter(row => row.type === 'tool_result'))); assert.equal(value, 'virtual changed') }
        finally { await session.close() }
      } else if (scenario === 'checkpoints') {
        const session = await connect({ mercury, cwd: c.cwd, env: c.env, onPermissionRequest: () => ({ outcome: 'allow' }), allowedTools: ['Read', 'Write'], checkpointFiles: true })
        try {
          const outcome = await session.prompt('Change saved.txt')
          assert.equal(outcome.status, 'completed'); assert.equal(readFileSync(join(c.cwd, 'saved.txt'), 'utf8'), 'changed\n')
          assert.equal(typeof session.lastPromptId, 'string')
          const facts = await session.facts(); assert.equal(facts.file_checkpoints?.capture, true); assert(facts.file_checkpoints?.restorable.includes(session.lastPromptId!))
          const args = { user_message_id: session.lastPromptId!, mode: 'both' as const }
          const dry = await session.rewind({ ...args, dry_run: true }); assert(dry.code?.files_changed.length); assert.equal(readFileSync(join(c.cwd, 'saved.txt'), 'utf8'), 'changed\n')
          const restored = await session.rewind(args); assert.equal(restored.outcome, 'applied'); assert.equal(readFileSync(join(c.cwd, 'saved.txt'), 'utf8'), 'original\n')
        } finally { await session.close() }
      } else {
        const session = await sdk.prewarm({ mercury, cwd: c.cwd, env: c.env })
        try { assert.equal(session.initialized.session_id, null); assert.equal((await session.claim({ session_id: '00000000-0000-4000-8000-000000000091' })).session_id, '00000000-0000-4000-8000-000000000091') }
        finally { await session.close() }
      }
      console.log(`PASS ${language} real runner ${scenario}`)
    } finally { await c.close() }
  }
}
clearTimeout(guard)
