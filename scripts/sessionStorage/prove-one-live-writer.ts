import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { dist, runDoor, sceneRoot } from '../hooks/lib/runDoor.ts'
import { connect } from '../../sdk/src/index.ts'

const paths = sceneRoot('one-session-writer-')
try {
  const first = await runDoor(paths, { hooks: {}, prompt: 'seed prompt', turns: [{ kind: 'text', text: 'SEED ANSWER' }] })
  assert.equal(first.code, 0, first.stderr)
  const id = String(first.rows.find(row => row.type === 'session')?.session_id)
  const competitors = await Promise.all(['A', 'B'].map(name => runDoor(paths, {
    hooks: {}, args: ['--resume', id], prompt: `prompt from ${name}`,
    turns: [{ kind: 'paced', deltas: [`ANSWER-${name} one `, `ANSWER-${name} two `, `ANSWER-${name} three`], gapMs: 800 }],
  })))
  assert.deepEqual(competitors.map(result => result.code).sort(), [0, 1], 'only one live writer may resume')
  const winner = competitors[0]!.code === 0 ? 'A' : 'B'
  const loser = competitors[winner === 'A' ? 1 : 0]!
  assert.equal(loser.requests, 0)
  assert.ok(JSON.stringify(loser.rows).includes('already open'), JSON.stringify(loser.rows))
  const after = await runDoor(paths, { hooks: {}, args: ['--resume', id], prompt: 'next prompt', turns: [{ kind: 'text', text: 'next answer' }] })
  assert.equal(after.code, 0, after.stderr)
  const wire = JSON.stringify(after.wire[0]!.body)
  assert.ok(wire.includes(`prompt from ${winner}`) && wire.includes(`ANSWER-${winner}`))
  assert.ok(!wire.includes(`prompt from ${winner === 'A' ? 'B' : 'A'}`))
  const continued = await runDoor(paths, { hooks: {}, args: ['--continue'], prompt: 'continue prompt', turns: [{ kind: 'text', text: 'continued' }] })
  assert.equal(continued.code, 0, continued.stderr)
  assert.ok(JSON.stringify(continued.wire[0]!.body).includes('next prompt'))
  const warm = await connect({ mercury: ['node', dist], cwd: paths.cwd, env: { ...process.env, MERCURY_CONFIG_DIR: paths.home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_TRUST_DIALOG_ACCEPTED: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none' }, warm: true })
  try {
    await warm.claim({ session_id: id, resume: true })
    const refused = await runDoor(paths, { hooks: {}, args: ['--resume', id], turns: [{ kind: 'text', text: 'not called' }] })
    assert.equal(refused.code, 1)
    assert.equal(refused.requests, 0)
    const forked = await runDoor(paths, { hooks: {}, args: ['--resume', id, '--fork'], turns: [{ kind: 'text', text: 'forked' }] })
    assert.equal(forked.code, 0, forked.stderr)
    assert.notEqual(forked.rows.find(row => row.type === 'session')?.session_id, id)
  } finally {
    await warm.close()
  }
  const killed = await runDoor(paths, { hooks: {}, args: ['--resume', id], signalAfterMs: { ms: 1800, signal: 'SIGKILL' }, turns: [{ kind: 'paced', deltas: ['partial ', 'later'], gapMs: 3000 }] })
  assert.equal(killed.code, null)
  assert.equal(killed.requests, 1)
  const recovered = await runDoor(paths, { hooks: {}, args: ['--resume', id], turns: [{ kind: 'text', text: 'recovered' }] })
  assert.equal(recovered.code, 0, recovered.stderr)
  console.log('PASS one live writer across run and warm claim, fork remains independent, dead writer reclaimed')
} finally {
  rmSync(paths.root, { recursive: true, force: true })
}
