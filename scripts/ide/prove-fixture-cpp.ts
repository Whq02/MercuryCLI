#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — fixture exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

console.log('============================================================')
console.log(' C/C++ closed-loop fixture — diagnose→edit→build→debug→prove')
console.log('============================================================')

const { probeBuiltinClangd } = await import('../../src/integrations/lsp/clangdLane.js')
const clangd = probeBuiltinClangd()
const clang = spawnSync('clang', ['--version'], { encoding: 'utf8', env: { ...process.env } })
const lldbDap = spawnSync('xcrun', ['-f', 'lldb-dap'], { encoding: 'utf8', env: { ...process.env } })
const lldbPath = lldbDap.status === 0 ? lldbDap.stdout.trim() : null
const devMode =
  process.platform === 'darwin'
    ? spawnSync('DevToolsSecurity', ['-status'], { encoding: 'utf8', env: { ...process.env } })
    : null
const debugAuthorized = devMode === null || /enabled/i.test(devMode.stdout ?? '')
if (!clangd.available || clang.status !== 0 || !lldbPath || !debugAuthorized) {
  console.log('\n  [SKIP — LOUD] this machine lacks the native trio:')
  console.log(`    clangd: ${clangd.available ? 'ok' : (clangd.reason ?? 'absent')}`)
  console.log(`    clang:  ${clang.status === 0 ? 'ok' : 'absent (xcode-select --install)'}`)
  console.log(`    lldb-dap: ${lldbPath ?? 'absent (Xcode 16+/CommandLineTools; older toolchains name it lldb-vscode)'}`)
  console.log(
    `    debugger authorization: ${debugAuthorized ? 'ok' : 'DEVELOPER MODE DISABLED — native attach would hang in task_for_pid. Fix: sudo DevToolsSecurity -enable'}`,
  )
  process.exit(0)
}

const proj = mkdtempSync(path.join(tmpdir(), 'fixture-cpp-'))
const srcC = path.join(proj, 'tally.c')
writeFileSync(
  srcC,
  '#include <stdio.h>\n' +
    'int accumulate(int base, int step, int times);\n' +
    'int accumulate(int base, int step) { // DEFECT: arity mismatch with the declaration\n' +
    '  return base + step;\n' +
    '}\n' +
    'int main(void) {\n' +
    '  int total = accumulate(10, 5);\n' +
    '  printf("total: %d\\n", total);\n' +
    '  return 0;\n' +
    '}\n',
)

process.chdir(proj)
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { createLSPServerManager } = await import('../../src/integrations/lsp/LSPServerManager.js')
const { registerLSPNotificationHandlers } = await import('../../src/integrations/lsp/publishedDiagnostics.js')
const { subscribeLSPDiagnosticPublish } = await import('../../src/integrations/lsp/LSPDiagnosticRegistry.js')
const { awaitDiagnosticStabilization } = await import('../../src/tools/lsp/mercuryOps.js')
const tx = await import('../../src/integrations/ide/ideTransaction.js')
const dap = await import('../../src/integrations/debugger/dapClient.js')
const { observeToolTerminal } = await import('../../src/engine/run-owner/effectObserver.js')
const { receiptsFor } = await import('../../src/tools/engines/change-transaction/receipts.js')
const { makeOwnerKey } = await import('../../src/engine/run-owner/ownerKey.js')

const owner = makeOwnerKey({ workspace: proj, sessionId: 'fixture-cpp', lane: 'main' })
const manager = createLSPServerManager()
const published: Array<{ serverName: string; files: Array<{ uri: string; diagnostics: Array<{ message: string }> }> }> = []
const unsubscribe = subscribeLSPDiagnosticPublish(e => published.push(e as never))

try {
  await manager.initialize()
  registerLSPNotificationHandlers(manager)
  const record = await tx.openTransaction({ owner, intent: 'fix accumulate arity mismatch + wrong total', from: proj })

  section('1 · diagnose — clangd publishes the REAL conflict')
  {
    await manager.openFile(srcC, readFileSync(srcC, 'utf8'))
    const deadline = Date.now() + 30_000
    let hit: { message: string } | undefined
    while (Date.now() < deadline && !hit) {
      hit = published
        .filter(p => p.serverName === 'mercury-clangd')
        .flatMap(p => p.files)
        .filter(f => f.uri.includes('tally.c'))
        .flatMap(f => f.diagnostics)
        .find(d => /conflicting types|arity|declared/i.test(d.message))
      if (!hit) await new Promise(r => setTimeout(r, 150))
    }
    check('the declaration conflict is diagnosed', hit !== undefined, JSON.stringify(published.flatMap(p => p.files.flatMap(f => f.diagnostics.map(d => d.message)))).slice(0, 200) + '; hint: clangd published no conflicting-types diagnostic for tally.c, so check src/integrations/lsp/clangdLane.ts (probeBuiltinClangd) and the publish forwarding in src/integrations/lsp/publishedDiagnostics.ts and LSPDiagnosticRegistry.ts')
    await tx.noteStep({
      id: record.id,
      owner,
      kind: 'diagnose',
      summary: `clangd: ${hit?.message.split('\n')[0]?.slice(0, 120) ?? 'no diagnostic'}`,
      refs: [`mercury://file/${srcC}`],
      from: proj,
    })
  }

  section('2 · mutate — the fix + the ChangeReceipt')
  {
    writeFileSync(
      srcC,
      '#include <stdio.h>\n' +
        'int accumulate(int base, int step, int times);\n' +
        'int accumulate(int base, int step, int times) {\n' +
        '  int total = base;\n' +
        '  for (int i = 0; i < times; i++) {\n' +
        '    total += step;\n' +
        '  }\n' +
        '  return total;\n' +
        '}\n' +
        'int main(void) {\n' +
        '  int total = accumulate(10, 5, 4);\n' +
        '  printf("total: %d\\n", total);\n' +
        '  return 0;\n' +
        '}\n',
    )
    observeToolTerminal({
      owner,
      toolName: 'Edit',
      toolUseId: 'fixture-cpp-fix',
      input: { file_path: srcC },
      effect: {
        outcome: 'succeeded',
        operation: 'edit',
        changedPaths: [srcC],
        evidence: 'align the definition with the 3-arg declaration',
        startedAt: Date.now() - 3,
        completedAt: Date.now(),
      },
    } as never)
    const receipt = receiptsFor(owner).at(-1)
    check('the receipt minted', receipt !== undefined, 'hint: observeToolTerminal in src/engine/run-owner/effectObserver.ts recorded no receipt for the Edit effect; check that a succeeded edit with changedPaths reaches receiptsFor in src/tools/engines/change-transaction/receipts.ts')
    const noted = await tx.noteStep({
      id: record.id,
      owner,
      kind: 'apply',
      summary: '3-arg accumulate definition + corrected call site',
      refs: [`mercury://receipt/${receipt?.id}`],
      from: proj,
    })
    check('apply step carries the receipt ref', noted.state === 'ok', `${JSON.stringify(noted).slice(0, 200)}; hint: noteStep in src/integrations/ide/ideTransaction.ts refused the apply step with a mercury://receipt ref`)
  }

  section('3 · stabilize — the push-lane barrier answers honestly')
  {
    await manager.changeAndSaveFile(srcC, readFileSync(srcC, 'utf8'))
    const verdict = await awaitDiagnosticStabilization(manager, srcC)
    check('an honest verdict (fresh/unchanged/unsupported/timed-out)', ['fresh', 'unchanged', 'unsupported', 'timed-out'].includes(verdict.state), `${JSON.stringify(verdict)}; hint: awaitDiagnosticStabilization in src/tools/lsp/mercury-ops/afterWrite.ts returned a state outside the four honest answers`)
    await tx.noteStep({
      id: record.id,
      owner,
      kind: 'stabilize',
      summary: `diagnostics ${verdict.state} — the real build follows`,
      outcome: verdict.state === 'failed' ? 'failed' : 'ok',
      from: proj,
    })
  }

  section('4 · build — the REAL compile is the check')
  {
    const out = path.join(proj, 'tally')
    const build = spawnSync('clang', ['-g', '-O0', '-o', out, srcC], { encoding: 'utf8', env: { ...process.env } })
    check('clang compiles the fixed source clean', build.status === 0, `${(build.stderr ?? '').slice(0, 200)}; hint: clang rejected the fixed tally.c source written in step 2 of this script, so fix that source text`)
    const noted = await tx.noteStep({
      id: record.id,
      owner,
      kind: 'build',
      summary: `clang -g -O0 exit ${build.status}`,
      refs: [`mercury://file/${srcC}`],
      outcome: build.status === 0 ? 'ok' : 'failed',
      from: proj,
    })
    check('build step noted', noted.state === 'ok', `${JSON.stringify(noted).slice(0, 200)}; hint: noteStep in src/integrations/ide/ideTransaction.ts refused the build step`)
  }

  section('5 · debug — lldb-dap proves the runtime value')
  {
    process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ 'native-fixture': { command: lldbPath, args: [] } })
    const session = await dap.createDapSession({
      owner,
      id: 'fixture-cpp',
      adapterKey: 'native-fixture',
      program: path.join(proj, 'tally'),
      cwd: proj,
      breakpoints: new Map([[srcC, [{ line: 6, condition: 'i == 3' }]]]),
    })
    const stop = await session.waitForStopOutcome(20_000)
    check('the conditional breakpoint stops (i == 3)', stop.state === 'stopped', `${JSON.stringify(stop)}; hint: the lldb-dap session from createDapSession in src/integrations/debugger/dapClient.ts never stopped on the conditional breakpoint (line 6, i == 3); check the breakpoint passing and waitForStopOutcome`)
    if (stop.state === 'stopped') {
      const threadId = stop.info.threadId ?? 1
      const stack = await session.request('stackTrace', { threadId, startFrame: 0, levels: 3 })
      const frameId = (stack.stackFrames as Array<{ id: number }>)[0]!.id
      const evald = await session.request('evaluate', { expression: 'total', frameId, context: 'repl' })
      check('the running total at i==3 is 25 (10 + 3*5)', String(evald.result).includes('= 25') || String(evald.result) === '25', `${JSON.stringify(evald).slice(0, 120)}; hint: the evaluate request in the dapClient.ts session returned a different value for total at the stop`)
      session.lastStopped = null
      await session.request('continue', { threadId })
      const end = await session.waitForStopOutcome(15_000)
      await session.drainOutput()
      check('clean termination with the FIXED total 30', end.state === 'terminated' && session.output.some(l => l.includes('total: 30')), `${JSON.stringify(session.output.slice(-4))}; hint: after continue the dapClient.ts session did not terminate cleanly or its output lacked total: 30`)
    }
    await dap.removeDapSession(owner, 'fixture-cpp')
    delete process.env.MERCURY_DAP_ADAPTERS
    await tx.noteStep({ id: record.id, owner, kind: 'debug', summary: 'total==25 at i==3; final total 30 — runtime verified via lldb-dap', from: proj })
  }

  section('6 · prove — the mechanical gate closes the loop')
  {
    const done = await tx.finishTransaction({ id: record.id, owner, verdict: 'completed', from: proj })
    check('the transaction completes through the gate', done.state === 'ok' && done.record.verdict === 'completed', `${JSON.stringify(done).slice(0, 200)}; hint: finishTransaction in src/integrations/ide/ideTransaction.ts did not complete; read the gate reason above and the steps noted earlier`)
  }
} finally {
  unsubscribe()
  await manager.shutdown().catch(() => {})
  process.chdir(ROOT)
  rmSync(proj, { recursive: true, force: true })
  delete process.env.MERCURY_DAP_ADAPTERS
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ THE C/C++ CLOSED LOOP IS REAL — diagnose→edit→build→debug→prove')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
