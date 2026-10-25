import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { mock } from 'bun:test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const scratch = mkdtempSync(join(tmpdir(), 'service-port-'))
const server = createServer(socket => socket.end())
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const calls: string[][] = []
const exec = await import('../../src/utils/execFileNoThrow.js')
const originalExec = exec.execFileNoThrowWithCwd
mock.module('../../src/utils/execFileNoThrow.js', () => ({
  ...exec,
  execFileNoThrowWithCwd: async (command: string, args: string[], options: any) => {
    if (command !== 'lsof') return originalExec(command, args, options)
    calls.push([command, ...args])
    return { code: 0, stderr: '', stdout: `p${process.pid}\ncfixture-node\nn127.0.0.1:${port}\n` }
  },
}))
const { startService, awaitOutput, waitForReady, stopService } = await import('../../src/services/projectServices/serviceManager.js')
try {
  const result = await startService({ sessionId: 'port-owner-proof', spec: {
    name: 'collision', command: process.execPath, args: ['-e', 'process.stderr.write("EADDRINUSE\\n"); process.exit(1)'], cwd: scratch,
    readiness: [{ kind: 'tcp', port }], readinessMode: 'all', restart: 'never', lifecycle: 'session',
  } })
  assert.ok('record' in result)
  await awaitOutput(scratch, 'collision', 0, 5000)
  const final = await waitForReady(scratch, 'collision', 5000)
  assert.equal(final.ready, false)
  assert.ok(final.statuses.some(status => status.detail.includes(`PID ${process.pid} (fixture-node)`) && !status.met), JSON.stringify(final.statuses))
  assert.ok(calls.some(args => args[0] === 'lsof' && args.includes(`-iTCP:${port}`) && args.includes('-sTCP:LISTEN')))
  console.log('service port holder: PASS')
} finally {
  await stopService(scratch, 'collision')
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(scratch, { recursive: true, force: true })
}
