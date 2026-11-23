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
const { makeConcourseAdmitHandler } = await import('../../src/daemon/concourse-workers/concourseWorkers.js')
const { startControlServer } = await import('../../src/daemon/control/controlServer.js')
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/control/protocol.js')
const { controlSockPath } = await import('../../src/daemon/control/controlSocket.js')
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
    assert.equal(reply.ok, false, `${JSON.stringify(resumeSessionId)} must be refused before forwarding; fix readSessionAdmit in src/daemon/control/controlServer.ts (the validateUuid check on resumeSessionId)`)
    assert.equal(reply.error, refusal, `the refusal text for ${JSON.stringify(resumeSessionId)} changed; readSessionAdmit in src/daemon/control/controlServer.ts must answer '${refusal}'`)
  }
  assert.equal(forwarded, 0, 'an invalid resumeSessionId reached concourseAdmit; readSessionAdmit in src/daemon/control/controlServer.ts must refuse it before forwarding')
  for (const resumeSessionId of [uuid, uuid.toUpperCase()]) assert.equal((await request({ resumeSessionId })).ok, true, `a valid UUID ${resumeSessionId} was refused; readSessionAdmit in src/daemon/control/controlServer.ts must admit it`)
  assert.equal((await request({})).ok, true, 'a sessionAdmit request with no resumeSessionId was refused; readSessionAdmit in src/daemon/control/controlServer.ts must admit a new session')
  assert.equal(forwarded, 3, 'the valid and new-session requests must each reach concourseAdmit once; check readSessionAdmit in src/daemon/control/controlServer.ts')
  console.log('PASS raw admission rejects invalid ids before forwarding; UUIDs and new-session requests remain admitted')
  const admit = makeConcourseAdmitHandler({} as never)
  for (const resumeSessionId of invalid) {
    const reply = await admit({ workspaceDir: root, resumeSessionId, effort: 'fixture-invalid-effort' } as never)
    assert.equal(reply.ok, false, `direct admission accepted ${JSON.stringify(resumeSessionId)}; validate resumeSessionId first in makeConcourseAdmitHandler (src/daemon/concourse-workers/admit.ts)`)
    if (!reply.ok) { assert.equal(reply.code, 'invalid-request', 'the refusal code must be invalid-request; see makeConcourseAdmitHandler in src/daemon/concourse-workers/admit.ts'); assert.equal(reply.error, refusal, `the refusal text must be '${refusal}'; see makeConcourseAdmitHandler in src/daemon/concourse-workers/admit.ts`) }
  }
  for (const resumeSessionId of [uuid, undefined]) {
    const reply = await admit({ workspaceDir: root, resumeSessionId, effort: 'fixture-invalid-effort' })
    assert.equal(reply.ok, false, 'an invalid effort was admitted for a valid or absent resumeSessionId; makeConcourseAdmitHandler (src/daemon/concourse-workers/admit.ts) must refuse it')
    if (!reply.ok) assert.match(reply.error, /^effort refused/, 'the refusal must begin with "effort refused"; see the effort check in makeConcourseAdmitHandler (src/daemon/concourse-workers/admit.ts)')
  }
  console.log('PASS direct admission validates before model lookup, transcript reads, worktree creation or worker spawn')
} finally {
  await server.close()
  process.chdir(oldCwd)
  rmSync(root, { recursive: true, force: true })
}
