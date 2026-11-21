import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runDoor, sceneRoot } from '../hooks/lib/runDoor.ts'
import { removeScratch } from '../lib/removeScratch.ts'

function findTranscript(dir: string, id: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = findTranscript(full, id)
      if (hit !== null) return hit
    } else if (entry.name === `${id}.jsonl`) {
      return full
    }
  }
  return null
}

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
  assert.ok(JSON.stringify(absent.rows).includes(`No conversation found for session id ${missing}`), `headless --resume for absent id ${missing} must report "No conversation found for session id" (got ${JSON.stringify(absent.rows).slice(0, 240)})`)

  const posixModes = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
  if (posixModes) {
    const { spawnSync } = await import('node:child_process')
    const dist = join(import.meta.dir, '../../dist/mercury.mjs')
    const transcript = findTranscript(join(paths.home, 'projects'), id)
    assert.ok(transcript !== null, `expected seeded transcript for ${id}`)
    chmodSync(transcript, 0o000)
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_CONFIG_DIR: paths.home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_API_KEY: 'proof-key' }
      delete env.MERCURY_HOME
      delete env.NODE_ENV
      const unread = spawnSync(process.env.MERCURY_NODE ?? 'node', [dist, 'run', '--resume', id, 'not called'], {
        cwd: paths.cwd,
        env,
        encoding: 'utf8',
        timeout: 30_000,
      })
      const unreadOut = `${unread.stdout ?? ''}\n${unread.stderr ?? ''}`
      assert.equal(unread.status, 1, unreadOut)
      assert.ok(
        unreadOut.includes('transcript could not be read') && unreadOut.includes('EACCES') && !unreadOut.includes('No conversation found for session id'),
        `expected unreadable-transcript refusal, got: ${JSON.stringify(unreadOut.slice(0, 600))}`,
      )
    } finally {
      chmodSync(transcript, 0o644)
    }
  }
  console.log('PASS a cross-folder resume names its folder; an unreadable transcript says it could not be read; an absent id stays absent')
} finally {
  removeScratch(paths.root)
}
