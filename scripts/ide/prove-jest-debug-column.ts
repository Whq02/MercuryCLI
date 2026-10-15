#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const home = mkdtempSync(path.join(tmpdir(), 'jest-debug-column-'))
process.env.MERCURY_CONFIG_DIR = path.join(home, 'home')
process.env.MERCURY_BARE = '1'
const plans = await import('../../src/services/ide/testDebugPlans.ts')
const dap = await import('../../src/services/dap/dapClient.ts')
const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
const { ownerFromToolUseContext } = await import('../../src/services/run/resolveOwner.ts')
const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')
let failures = 0
function check(name: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`)
  if (!ok) failures++
}
const source = [
  '',
  'function add(a, b) { return a - b }',
  '',
  "describe('sum', () => {",
  "  it('adds two numbers', () => {",
  '    const result = add(2, 3)',
  '    expect(result).toBe(5)',
  '  })',
  "  it('adds two numbers suffix', () => { expect(1).toBe(1) })",
  '})', '',
].join('\n')
function project(label: string, modules?: string): string {
  const root = path.join(home, label)
  mkdirSync(root)
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, devDependencies: { jest: '*' }, jest: { testEnvironment: 'node' } }))
  writeFileSync(path.join(root, 'sum.test.js'), source)
  if (modules) symlinkSync(modules, path.join(root, 'node_modules'))
  else {
    mkdirSync(path.join(root, 'node_modules/jest/bin'), { recursive: true })
    mkdirSync(path.join(root, 'node_modules/.bin'))
    writeFileSync(path.join(root, 'node_modules/jest/package.json'), JSON.stringify({ name: 'jest', bin: 'bin/jest.js' }))
    for (const file of ['node_modules/jest/bin/jest.js', 'node_modules/.bin/jest']) {
      writeFileSync(path.join(root, file), '#!/usr/bin/env node\n')
      chmodSync(path.join(root, file), 0o755)
    }
  }
  return root
}
try {
  const root = project('plan')
  for (const [label, text] of [['original', source], ['long-name', source.replaceAll('result', 'calculatedResult')], ['multiline', source.replace('const result = add(2, 3)', 'const result =\n      add(2, 3)')]]) {
    writeFileSync(path.join(root, 'sum.test.js'), text!)
    const line = text!.split('\n').findIndex(l => l.includes('add(2, 3)')) + 1
    const column = text!.split('\n')[line - 1]!.indexOf('add(2, 3)') + 1
    const plan = plans.buildNodeRunnerDebugShim('jest', 'sum.test.js::sum adds two numbers', { from: root })
    const stop = 'state' in plan ? undefined : plan.stop as { line: number; column?: number } | null
    check(`${label}: breakpoint targets the initializer, not the declaration keyword`, stop?.line === line && stop?.column === column, stop)
  }
  const client = Object.create(dap.DapSession.prototype) as dap.DapSession
  client.breakpoints = new Map()
  const requests: Record<string, unknown>[] = []
  client.request = async (_command, args = {}) => { requests.push(args); return { breakpoints: [{ verified: true }] } }
  await client.setBreakpoints('sum.test.js', [{ line: 6, column: 20 } as dap.DapBreakpointSpec & { column: number }])
  await client.setBreakpoints('sum.test.js', [6])
  check('DAP forwards an explicit column without adding one to line-only breakpoints', JSON.stringify(requests.map(r => r.breakpoints)) === JSON.stringify([[{ line: 6, column: 20 }], [{ line: 6 }]]), requests)

  const modules = process.env.MERCURY_PROOF_RUNNER_MODULES
  const pkg = modules && path.join(modules, 'jest/package.json')
  const adapter = path.resolve(import.meta.dir, '../../dist/vendor/js-debug/src/dapDebugServer.js')
  const version = pkg && existsSync(pkg) ? JSON.parse(readFileSync(pkg, 'utf8')).version as string : ''
  if (!modules || !version.startsWith('30.')) {
    console.log(`SKIP — LOUD: Jest 30 is not installed in MERCURY_PROOF_RUNNER_MODULES (${version || 'absent'}); install it in a scratch project to run the Test-tool stop proof`)
  } else if (!existsSync(adapter)) {
    check('live Jest 30 requires the built js-debug adapter', false, adapter)
  } else {
    process.env.MERCURY_JS_DEBUG_DAP = adapter
    const live = project('live', modules)
    const ctx = { getAppState: () => ({}) } as never
    const owner = ownerFromToolUseContext(ctx)
    const call = (input: Record<string, unknown>) => runWithCwdOverride(live, () => TestTool.call(input as never, ctx)) as Promise<{ data: { outcome: string; result: string; record?: { counts: { failed: number; passed: number; skipped: number }; cases: Array<{ id: string; nameParts?: string[] }> } } }>
    const request = dap.DapSession.prototype.request
    const breakpointRequests: Array<{ session: string; breakpoints: unknown }> = []
    dap.DapSession.prototype.request = function(command, args, timeout) {
      if (command === 'setBreakpoints') breakpointRequests.push({ session: this.label, breakpoints: args?.breakpoints })
      return request.call(this, command, args, timeout)
    }
    try {
      const run = await call({ op: 'run', framework: 'jest' })
      check(`Jest ${version}: run selects one failure and one passing sibling`, run.data.record?.counts.failed === 1 && run.data.record.counts.passed === 1, run.data.record?.counts)
      check('report preserves the describe hierarchy used by the anchored matcher', run.data.record?.cases.some(c => c.id === 'sum adds two numbers' && JSON.stringify(c.nameParts) === JSON.stringify(['sum', 'adds two numbers'])) === true, run.data.record?.cases)
      const rerun = await call({ op: 'rerunFailed', framework: 'jest' })
      check('rerun selects only the failing test', rerun.data.record?.counts.failed === 1 && rerun.data.record.counts.passed === 0 && rerun.data.record.counts.skipped === 1, rerun.data.record?.counts)
      const out = await call({ op: 'debug', framework: 'jest', node: 'sum.test.js::sum adds two numbers' })
      check('Test debug reports a breakpoint stop under Jest 30', out.data.outcome === 'succeeded' && /reason breakpoint/.test(out.data.result), out.data.result)
      check('root and child sessions receive the same precise breakpoint', breakpointRequests.length >= 2 && breakpointRequests.every(r => JSON.stringify(r.breakpoints) === JSON.stringify([{ line: 6, column: 20 }])), breakpointRequests)
      const session = dap.getDapSession(owner, 'test')
      const stopped = session?.treeStopped()
      check('a stopped session is inspectable', !!stopped?.lastStopped, session?.output)
      if (session && stopped?.lastStopped) {
        const threadId = stopped.lastStopped.threadId ?? 1
        const stack = await stopped.request('stackTrace', { threadId, startFrame: 0, levels: 1 })
        const frame = (stack.stackFrames as Array<{ id: number; line: number; source?: { path?: string } }>)[0]
        check('the stop is inside the selected test on its initializer line', frame?.line === 6 && frame.source?.path === path.join(live, 'sum.test.js'), frame)
        const stamp = session.treeNewestStopStamp()
        await stopped.request('next', { threadId })
        const step = await session.waitForStopOutcome(10_000, undefined, stamp)
        check('stepping produces a new stop', step.state === 'stopped', step.state)
        if (step.state === 'stopped') {
          const after = await step.session.request('stackTrace', { threadId: step.info.threadId ?? threadId, startFrame: 0, levels: 1 })
          const next = (after.stackFrames as Array<{ id: number; line: number }>)[0]!
          check('one step reaches the assertion', next.line === 7, next)
          const scopes = await step.session.request('scopes', { frameId: next.id })
          const values: Array<{ name: string; value: string }> = []
          for (const scope of (scopes.scopes as Array<{ variablesReference: number }>).slice(0, 3)) {
            const vars = await step.session.request('variables', { variablesReference: scope.variablesReference })
            values.push(...vars.variables as Array<{ name: string; value: string }>)
          }
          check('locals contain the computed wrong value', values.find(v => v.name === 'result')?.value === '-1', values.find(v => v.name === 'result'))
        }
      }
    } finally {
      dap.DapSession.prototype.request = request
      await disposeOwner(owner)
      delete process.env.MERCURY_JS_DEBUG_DAP
    }
    check('disconnect leaves no debug sessions', dap._dapSessionCountForTesting() === 0, dap._dapSessionCountForTesting())
  }
} finally { rmSync(home, { recursive: true, force: true }) }
if (failures) process.exit(1)
console.log('prove-jest-debug-column: GREEN')
