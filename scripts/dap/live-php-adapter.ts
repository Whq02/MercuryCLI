import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('Set MERCURY_CONFIG_DIR to a scratch home before this live drive')
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { optionalAdapterPlan, installOptionalAdapter, installedOptionalAdapter } = await import('../../src/services/dap/optionalAdapters.js')
const { installPermission } = await import('../../src/extensions/installConsent.js')
const plan = optionalAdapterPlan('php')!
if (process.argv.includes('--install')) {
  const permission = installPermission(plan)
  console.log('message' in permission ? permission.message : '')
  await installOptionalAdapter(plan, { authorize: async () => true })
}
assert.ok(installedOptionalAdapter('php'), 'run once with --install to fetch the pinned adapter into the scratch home')
const { DapSession, createDapSession, removeDapSession, resolveAdapter } = await import('../../src/services/dap/dapClient.js')
const spec = resolveAdapter('php')!
const scratch = mkdtempSync(join(tmpdir(), 'live-php-adapter-'))
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
const owner = makeOwnerKey({ workspace: scratch, sessionId: 'live-php', lane: 'main' })
try {
  const adapter = new DapSession('php', spec, '', scratch)
  try {
    const capabilities = await adapter.request('initialize', { adapterID: 'php', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' })
    assert.equal(capabilities.supportsConfigurationDoneRequest, true)
    console.log('PASS real PHP Debug adapter answered initialize over stdio')
  } finally {
    await adapter.dispose()
  }
  if (spec.preflightError) {
    console.log(`NOT RUN PHP breakpoint drive: ${spec.preflightError}`)
  } else {
    const source = join(scratch, 'main.php')
    writeFileSync(source, '<?php\n$a = 4;\n$b = 2;\necho $a * 10 + $b;\n')
    const session = await createDapSession({ owner, id: 'php', adapterKey: 'php', program: source, cwd: scratch, breakpoints: new Map([[source, [4]]]) })
    const stop = await session.waitForStopOutcome(30_000)
    assert.equal(stop.state, 'stopped', session.output.join('\n'))
    if (stop.state !== 'stopped') throw new Error(session.output.join('\n'))
    assert.equal(stop.info.reason, 'breakpoint')
    const stack = await stop.session.request('stackTrace', { threadId: stop.info.threadId })
    const frames = stack.stackFrames as Array<{ id: number; line: number }>
    assert.equal(frames[0]?.line, 4)
    const value = await stop.session.request('evaluate', { expression: '$a * 10 + $b', frameId: frames[0]!.id, context: 'watch' })
    assert.match(String(value.result), /\b42\b/)
    console.log('PASS real PHP breakpoint at main.php:4; evaluate $a * 10 + $b = 42')
  }
} finally {
  await removeDapSession(owner, 'php')
  rmSync(scratch, { recursive: true, force: true })
}
