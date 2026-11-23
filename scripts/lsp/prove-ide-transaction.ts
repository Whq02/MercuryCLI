#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'ide-txn-'))
  process.env.MERCURY_VERIFY_EVIDENCE = '1'

  section('1. mutation truth comes from EFFECTS, never apply:true intent')
  {
    const ok = await import('../../src/engine/run-owner/ownerKey.js')
    const v = await import('../../src/platform/verification/verificationState.js')
    const { observeToolTerminal } = await import('../../src/engine/run-owner/effectObserver.js')
    const owner = ok.makeOwnerKey({ workspace: tmp, sessionId: 'ide-txn', lane: 'main' })
    v._resetVerificationStateForTesting()
    check(
      'apply:true INPUT no longer classifies as a mutation',
      v.isMutationToolCall('LSP', { operation: 'rename', apply: true }) === false,
      '',
      'isMutationToolCall in src/platform/verification/verificationState.ts must not classify an LSP call as a mutation from its apply input',
    )
    observeToolTerminal({
      owner,
      toolName: 'LSP',
      toolUseId: 'tu1',
      input: { operation: 'rename', apply: true },
      ok: false,
      durationMs: 5,
      effect: {
        outcome: 'failed',
        operation: 'lsp.rename',
        changedPaths: [],
        evidence: 'drift abort — nothing written',
        startedAt: 1,
        completedAt: 2,
      },
      cwd: tmp,
    })
    check(
      'a FAILED apply records zero mutations',
      v.verificationSummary(tmp, { skipDigest: true, owner }).mutationsSinceEvidence === 0,
      '',
      'observeToolTerminal in src/engine/run-owner/effectObserver.ts must not count an effect with outcome failed as a mutation',
    )
    observeToolTerminal({
      owner,
      toolName: 'LSP',
      toolUseId: 'tu2',
      input: { operation: 'codeActions' },
      ok: true,
      durationMs: 5,
      effect: {
        outcome: 'no-change',
        operation: 'lsp.codeActions',
        changedPaths: [],
        evidence: 'no actions offered',
        startedAt: 1,
        completedAt: 2,
      },
      cwd: tmp,
    })
    check(
      'a no-change observation records zero mutations',
      v.verificationSummary(tmp, { skipDigest: true, owner }).mutationsSinceEvidence === 0,
      '',
      'observeToolTerminal in src/engine/run-owner/effectObserver.ts must not count an effect with outcome no-change as a mutation',
    )
    observeToolTerminal({
      owner,
      toolName: 'LSP',
      toolUseId: 'tu3',
      input: { operation: 'rename', apply: true },
      ok: true,
      durationMs: 5,
      effect: {
        outcome: 'succeeded',
        operation: 'lsp.rename.apply',
        changedPaths: [`${tmp}/a.ts`, `${tmp}/b.ts`],
        evidence: '4 edit(s) written + servers synced',
        startedAt: 1,
        completedAt: 2,
      },
      cwd: tmp,
    })
    check(
      'a SUCCEEDED multi-file apply records exactly one mutation',
      v.verificationSummary(tmp, { skipDigest: true, owner }).mutationsSinceEvidence === 1,
      '',
      'observeToolTerminal in src/engine/run-owner/effectObserver.ts must count one mutation for a succeeded effect, whatever the number of changed paths',
    )
    v._resetVerificationStateForTesting()
  }


  section('3. the push-lane quiet-window barrier (live, no real server)')
  {
    const { awaitDiagnosticStabilization } = await import('../../src/tools/lsp/mercuryOps.js')
    const { registerPendingLSPDiagnostic, _publishListenerCountForTesting } = await import(
      '../../src/integrations/lsp/LSPDiagnosticRegistry.js'
    )
    const fakeManager = {
      getServerForFile: () => ({ name: 'fake', generation: 1, capabilities: {} }),
      getDocumentVersion: () => 3,
      sendRequest: async () => undefined,
    } as never
    const before = _publishListenerCountForTesting()
    const pending = awaitDiagnosticStabilization(fakeManager, '/tmp/push-lane/file.py', {
      deadlineMs: 1_500,
      quietWindowMs: 100,
    })
    setTimeout(() => {
      registerPendingLSPDiagnostic({
        serverName: 'fake',
        files: [
          {
            uri: 'file:///tmp/push-lane/file.py',
            diagnostics: [
              { severity: 'Error', message: 'boom' },
              { severity: 'Warning', message: 'meh' },
            ],
          } as never,
        ],
      })
    }, 50)
    const outcome = await pending
    check(
      'push publication → FRESH with honest counts',
      outcome.state === 'fresh' && outcome.errors === 1 && outcome.warnings === 1,
      JSON.stringify(outcome),
      'awaitDiagnosticStabilization in src/tools/lsp/mercury-ops/afterWrite.ts must settle fresh with the published error and warning counts once the quiet window passes',
    )
    check('the barrier unsubscribes (no leak)', _publishListenerCountForTesting() === before, '', 'awaitDiagnosticStabilization in src/tools/lsp/mercury-ops/afterWrite.ts must remove its publish listener when it settles')
    const silent = await awaitDiagnosticStabilization(fakeManager, '/tmp/push-lane/other.py', {
      deadlineMs: 300,
      quietWindowMs: 100,
    })
    check('push silence → timed-out (never a fabricated clean)', silent.state === 'timed-out', '', 'awaitDiagnosticStabilization in src/tools/lsp/mercury-ops/afterWrite.ts must return timed-out when no diagnostics are published before the deadline; got ' + JSON.stringify(silent))
    for (const [awaited, sibling] of [['/tmp/push-lane/a.ts', '/tmp/push-lane/a.tsx'], ['/tmp/push-lane/x.py', '/tmp/push-lane/x.pyi'], ['/tmp/push-lane/b.ts', '/tmp/push-lane/sub/b.ts']]) {
      const waiting = awaitDiagnosticStabilization(fakeManager, awaited, { deadlineMs: 400, quietWindowMs: 100 })
      setTimeout(() => registerPendingLSPDiagnostic({ serverName: 'fake', files: [{ uri: `file://${sibling}`, diagnostics: [{ severity: 'Error', message: 'not yours' }] } as never] }), 50)
      const outcome = await waiting
      check(`a publish for ${sibling} does not settle the wait on ${awaited} (timed-out, not fresh)`, outcome.state === 'timed-out', JSON.stringify(outcome), 'awaitDiagnosticStabilization in src/tools/lsp/mercury-ops/afterWrite.ts must match a published uri to the awaited file exactly, not by a shared prefix or a different path')
    }
    {
      const waiting = awaitDiagnosticStabilization(fakeManager, '/tmp/push-lane/c.ts', { deadlineMs: 1_500, quietWindowMs: 100 })
      setTimeout(() => registerPendingLSPDiagnostic({ serverName: 'fake', files: [{ uri: 'file:///tmp/push-lane/c.ts', diagnostics: [] } as never] }), 50)
      const outcome = await waiting
      check('control: a publish for the file itself (a clean one) still settles fresh with zero counts', outcome.state === 'fresh' && outcome.total === 0, JSON.stringify(outcome), 'awaitDiagnosticStabilization in src/tools/lsp/mercury-ops/afterWrite.ts must settle fresh with total 0 when the awaited file publishes an empty list')
    }
    check('no manager server → unsupported', (await awaitDiagnosticStabilization({ getServerForFile: () => undefined } as never, '/x')).state === 'unsupported', '', 'awaitDiagnosticStabilization in src/tools/lsp/mercury-ops/afterWrite.ts must return unsupported when getServerForFile finds no server')
  }

  rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
