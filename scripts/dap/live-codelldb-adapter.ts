import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('Set MERCURY_CONFIG_DIR to a scratch home before this live drive')
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { optionalAdapterPlan, installOptionalAdapter, installedOptionalAdapter } = await import('../../src/services/dap/optionalAdapters.js')
const { installPermission } = await import('../../src/extensions/installConsent.js')
const plan = optionalAdapterPlan('codelldb')
assert.ok(plan)
if (process.argv.includes('--install')) {
  const permission = installPermission(plan)
  console.log('message' in permission ? permission.message : '')
  await installOptionalAdapter(plan, { authorize: async () => true })
}
assert.ok(installedOptionalAdapter('codelldb'), 'run once with --install to fetch the pinned adapter into the scratch home')
const scratch = mkdtempSync(join(tmpdir(), 'live-codelldb-'))
const { createDapSession, removeDapSession } = await import('../../src/services/dap/dapClient.js')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
const owner = makeOwnerKey({ workspace: scratch, sessionId: 'live-codelldb', lane: 'main' })
try {
  const source = join(scratch, 'main.rs')
  const program = join(scratch, process.platform === 'win32' ? 'fixture.exe' : 'fixture')
  writeFileSync(source, 'fn main() {\n    let a: i32 = 4;\n    let b: i32 = 2;\n    println!("{}", a * 10 + b);\n}\n')
  execFileSync(process.argv.find(arg => arg.endsWith('/rustc')) ?? 'rustc', ['-g', '-C', 'opt-level=0', source, '-o', program], { windowsHide: true, cwd: scratch })
  const session = await createDapSession({ owner, id: 'codelldb', adapterKey: 'codelldb', program, cwd: scratch, breakpoints: new Map([[source, [4]]]) })
  const stop = await session.waitForStopOutcome(30_000)
  assert.equal(stop.state, 'stopped', session.output.join('\n'))
  if (stop.state !== 'stopped') throw new Error(session.output.join('\n'))
  assert.equal(stop.info.reason, 'breakpoint')
  const stack = await stop.session.request('stackTrace', { threadId: stop.info.threadId })
  const frames = stack.stackFrames as Array<{ id: number; line: number }>
  assert.equal(frames[0]?.line, 4)
  const value = await stop.session.request('evaluate', { expression: 'a * 10 + b', frameId: frames[0]!.id, context: 'watch' })
  assert.match(String(value.result), /\b42\b/)
  console.log('PASS real CodeLLDB breakpoint at main.rs:4; evaluate a * 10 + b = 42')
} finally {
  await removeDapSession(owner, 'codelldb')
  rmSync(scratch, { recursive: true, force: true })
}
