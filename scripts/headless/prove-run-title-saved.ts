import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dist, runDoor, sceneRoot } from '../hooks/lib/runDoor.ts'

const paths = sceneRoot('run-title-')
try {
  const run = (args: string[]) => runDoor(paths, { args, hooks: {}, prompt: 'first prompt words', turns: [{ kind: 'text', text: 'done' }] })
  const first = await run(['--title', 'Named session'])
  assert.equal(first.code, 0, first.stderr)
  assert.ok(JSON.stringify(first.sessionRows).includes('Named session'), 'title missing from transcript')
  const id = String(first.rows.find(row => row.type === 'session')?.session_id)
  const resumed = await run(['--resume', id, '--title', 'Renamed session'])
  assert.equal(resumed.code, 0, resumed.stderr)
  const listed = spawnSync('node', [dist, 'sessions', 'list'], { cwd: paths.cwd, env: { ...process.env, MERCURY_CONFIG_DIR: paths.home }, encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  assert.ok(listed.stdout.includes('Renamed session'), listed.stdout)
  const ephemeral = await run(['--ephemeral', '--title', 'Do not save me'])
  assert.equal(ephemeral.code, 0, ephemeral.stderr)
  assert.ok(!JSON.stringify(ephemeral.sessionRows).includes('Do not save me'))
  console.log('PASS run titles saved, resumed title replaced, ephemeral title not saved')
} finally {
  rmSync(paths.root, { recursive: true, force: true })
}
