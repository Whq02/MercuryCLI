import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { runDoor, say, savedHookRowsOf, sceneRoot } from './lib/runDoor.ts'

const cases = [
  { run: 'echo whyfail >&2; exit 1', code: 'hook_failed', words: 'whyfail', refused: false },
  { run: `echo '{invalid'`, code: 'hook_failed', words: 'JSON', refused: false },
  { run: say({ notice: 'read this first' }), code: 'hook_notice', words: 'read this first', refused: false },
  { run: 'echo cannot start >&2; exit 2', code: 'hook_blocked', words: 'cannot start', refused: true },
]
for (const test of cases) {
  const paths = sceneRoot('turn-start-notice-')
  try {
    const result = await runDoor(paths, { turns: [{ kind: 'text', text: 'done' }], hooks: { 'turn.start': [{ name: 'guard', run: test.run }] } })
    const notices = result.rows.filter(row => row.type === 'notice' && row.code === test.code)
    assert.equal(notices.length, 1, JSON.stringify(result.rows))
    assert.ok(String(notices[0]!.text).includes(test.words), JSON.stringify(notices))
    if (!test.refused) assert.ok(savedHookRowsOf(result.sessionRows).some(row => row.fields.event === 'turn.start'))
    assert.equal(result.code, test.refused ? 1 : 0)
    assert.equal(result.requests, test.refused ? 0 : 1)
    console.log(`PASS turn.start ${test.code}: ${test.words}`)
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
}
