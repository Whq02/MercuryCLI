import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinSourceRef } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const root = mkdtempSync(join(tmpdir(), 'resume-admission-'))
process.env.TMPDIR = root
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.env.MERCURY_DAEMON_DIR = join(root, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
const oldCwd = process.cwd()
process.chdir(root)
const { makeConcourseAdmitHandler } = await import('../../src/daemon/concourseWorkers.js')
const { startControlServer } = await import('../../src/daemon/controlServer.js')
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.js')
const { controlSockPath } = await import('../../src/daemon/controlSocket.js')
const socketPath = process.platform === 'win32' ? controlSockPath() : 'fixture.sock'
const uuid = '12345678-1234-4234-8234-123456789abc'
const refusal = 'no live session record owns this id'
const invalid = [`${uuid}.receipts`, '', `${uuid}.jsonl`, '../elsewhere', '..\\elsewhere', null, 123, {}]
let forwarded = 0
const server = await startControlServer({
  controlKey: 'fixture-auth', isReady: () => true,
  concourseAdmit: async () => { forwarded++; return { ok: true, runnerId: 'fixture', sessionId: uuid } },
} as never, { socketPath })
async function request(fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath)
    let output = ''
    sock.setTimeout(2000, () => sock.destroy(new Error('admission fixture timed out')))
    sock.on('error', reject)
    sock.on('connect', () => sock.write(JSON.stringify({ op: 'sessionAdmit', proto: MERCURY_DAEMON_PROTO, auth: 'fixture-auth', workspaceDir: root, ...fields }) + '\n'))
    sock.on('data', bytes => { output += bytes.toString() })
    sock.on('end', () => { try { resolve(JSON.parse(output)) } catch (error) { reject(error) } })
  })
}
try {
  for (const resumeSessionId of invalid) {
    const reply = await request({ resumeSessionId })
    assert.equal(reply.ok, false, JSON.stringify(resumeSessionId))
    assert.equal(reply.error, refusal)
  }
  assert.equal(forwarded, 0)
  for (const resumeSessionId of [uuid, uuid.toUpperCase()]) assert.equal((await request({ resumeSessionId })).ok, true)
  assert.equal((await request({})).ok, true)
  assert.equal(forwarded, 3)
  console.log('PASS raw admission rejects invalid ids before forwarding; UUIDs and new-session requests remain admitted')
  const admit = makeConcourseAdmitHandler({} as never)
  for (const resumeSessionId of invalid) {
    const reply = await admit({ workspaceDir: root, resumeSessionId, effort: 'fixture-invalid-effort' } as never)
    assert.equal(reply.ok, false)
    if (!reply.ok) { assert.equal(reply.code, 'invalid-request'); assert.equal(reply.error, refusal) }
  }
  for (const resumeSessionId of [uuid, undefined]) {
    const reply = await admit({ workspaceDir: root, resumeSessionId, effort: 'fixture-invalid-effort' })
    assert.equal(reply.ok, false)
    if (!reply.ok) assert.match(reply.error, /^effort refused/)
  }
  console.log('PASS direct admission validates before model lookup, transcript reads, worktree creation or worker spawn')
} finally {
  await server.close()
  process.chdir(oldCwd)
  rmSync(root, { recursive: true, force: true })
}
