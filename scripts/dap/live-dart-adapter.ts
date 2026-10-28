import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'live-dart-adapter-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { createDapSession, removeDapSession, resolveAdapter } = await import('../../src/services/dap/dapClient.js')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
const owner = makeOwnerKey({ workspace: scratch, sessionId: 'live-dart', lane: 'main' })
try {
  assert.ok(resolveAdapter('dart'), 'put the Dart SDK on PATH for this live drive')
  const source = join(scratch, 'main.dart')
  mkdirSync(join(scratch, 'home'))
  writeFileSync(source, 'void main() {\n  var a = 4;\n  var b = 2;\n  print(a * 10 + b);\n}\n')
  const session = await createDapSession({ owner, id: 'dart', adapterKey: 'dart', program: source, cwd: scratch, stopOnEntry: false, breakpoints: new Map([[source, [4]]]) })
  let stop = await session.waitForStopOutcome(30_000)
  if (stop.state === 'stopped' && stop.info.reason === 'entry') {
    stop = await session.waitForStopOutcome(30_000, undefined, stop.session.lastStoppedAt)
  }
  assert.equal(stop.state, 'stopped', JSON.stringify(stop))
  if (stop.state !== 'stopped') throw new Error(session.output.join('\n'))
  assert.equal(stop.info.reason, 'breakpoint')
  const stack = await stop.session.request('stackTrace', { threadId: stop.info.threadId })
  const frames = stack.stackFrames as Array<{ id: number; line: number; name: string }>
  assert.equal(frames[0]?.line, 4)
  const value = await stop.session.request('evaluate', { expression: 'a * 10 + b', frameId: frames[0]!.id, context: 'watch' })
  assert.equal(value.result, '42')
  console.log('PASS real Dart breakpoint at main.dart:4; evaluate a * 10 + b = 42')
} finally {
  await removeDapSession(owner, 'dart')
  rmSync(scratch, { recursive: true, force: true })
}
