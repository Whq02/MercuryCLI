import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runDoor, sceneRoot } from '../hooks/lib/runDoor.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const paths = sceneRoot('resume-other-folder-')
try {
  const seed = await runDoor(paths, { hooks: {}, turns: [{ kind: 'text', text: 'seeded' }] })
  assert.equal(seed.code, 0, seed.stderr)
  const id = String(seed.rows.find(row => row.type === 'session')?.session_id)
  const cwd = join(paths.root, 'sibling')
  mkdirSync(cwd)
  const other = await runDoor({ ...paths, cwd }, { hooks: {}, args: ['--resume', id], turns: [{ kind: 'text', text: 'not called' }] })
  assert.equal(other.code, 1)
  assert.equal(other.requests, 0)
  const text = JSON.stringify(other.rows)
  const refusal = other.rows.map(row => String((row.error as { message?: string } | undefined)?.message ?? '')).join('\n')
  assert.ok(refusal.includes(paths.cwd), text)
  assert.ok(refusal.includes('Resume it from that folder'), text)
  const missing = crypto.randomUUID()
  const absent = await runDoor({ ...paths, cwd }, { hooks: {}, args: ['--resume', missing], turns: [{ kind: 'text', text: 'not called' }] })
  assert.equal(absent.code, 1)
  assert.ok(JSON.stringify(absent.rows).includes(`No conversation found for session id ${missing}`))
  console.log('PASS a cross-folder resume names its folder; an absent id stays absent')
} finally {
  removeScratch(paths.root)
}
