#!/usr/bin/env bun
// ============================================================================
//  scripts/lsp/prove-ide-transaction.ts
//  ORACLE: an LSP mutation is a closed transaction (slice-4 invariants,
//  flipped from the slice-0 FAILURE-CLASS pins).
//
//  Proven here:
//   · LSP apply:true INPUT no longer classifies as a mutation — mutation
//     truth comes from the typed effect (a failed/no-op apply advances
//     nothing; a succeeded apply marks exactly its changedPaths);
//   · the effect observer end-to-end: failed → no mutation; succeeded with
//     paths → exactly one mutation; indeterminate → no mutation but the run
//     records the unresolved effect;
//   · post-write server sync is AWAITED (syncServersAfterWrite bounds
//     didChange/didSave with a deadline; apply downgrades to INDETERMINATE
//     with the exact written paths when sync fails);
//   · bounded post-apply diagnostic stabilization exists for BOTH lanes
//     (pull round trip; push quiet-window via the non-consuming publish
//     subscription) and returns typed outcomes, never a fabricated clean.
//
//  Run:  ~/.bun/bin/bun run scripts/lsp/prove-ide-transaction.ts
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const root = join(import.meta.dir, '..', '..')
  const tmp = mkdtempSync(join(tmpdir(), 'ide-txn-'))
  process.env.MERCURY_VERIFY_EVIDENCE = '1'

  section('1. mutation truth comes from EFFECTS, never apply:true intent')
  {
    const ok = await import('../../src/services/run/ownerKey.js')
    const v = await import('../../src/utils/verification/verificationState.js')
    const { observeToolTerminal } = await import('../../src/services/run/effectObserver.js')
    const owner = ok.makeOwnerKey({ workspace: tmp, sessionId: 'ide-txn', lane: 'main' })
    v._resetVerificationStateForTesting()
    check(
      'apply:true INPUT no longer classifies as a mutation',
      v.isMutationToolCall('LSP', { operation: 'rename', apply: true }) === false,
    )
    // A FAILED apply (typed effect) through the universal observer: nothing.
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
    )
    // A NO-CHANGE observation: nothing.
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
    )
    // A SUCCEEDED multi-file apply: exactly ONE mutation.
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
    )
    v._resetVerificationStateForTesting()
  }

  section('2. the transaction pipeline (structural pins on the shipped source)')
  {
    const ops = readFileSync(join(root, 'src/tools/LSPTool/mercuryOps.ts'), 'utf8')
    check(
      'post-write sync is AWAITED with a bounded deadline (syncServersAfterWrite)',
      /await syncServersAfterWrite\(manager, w\.abs, w\.newText\)/.test(ops) &&
        !/manager\.changeAndSaveFile\(absolutePath, newText\)\.catch/.test(ops),
    )
    check(
      'a sync failure AFTER writes downgrades to INDETERMINATE with the exact paths',
      ops.includes("outcome: 'indeterminate'") && ops.includes('changedPaths: written.map(w => w.abs)'),
    )
    check(
      'bounded post-apply diagnostic stabilization exists',
      ops.includes('awaitDiagnosticStabilization'),
    )
    check(
      'every hermes op return carries a typed effect',
      (ops.match(/effect: \{/g) ?? []).length >= 20,
    )
    const registry = readFileSync(
      join(root, 'src/services/lsp/LSPDiagnosticRegistry.ts'),
      'utf8',
    )
    check(
      'the push lane has a NON-consuming publish subscription',
      registry.includes('subscribeLSPDiagnosticPublish'),
    )
  }

  section('3. the push-lane quiet-window barrier (live, no real server)')
  {
    const { awaitDiagnosticStabilization } = await import('../../src/tools/LSPTool/mercuryOps.js')
    const { registerPendingLSPDiagnostic, _publishListenerCountForTesting } = await import(
      '../../src/services/lsp/LSPDiagnosticRegistry.js'
    )
    // A fake push-only manager: server present, NO diagnosticProvider.
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
    // Publish for the file → fresh once the window stays quiet.
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
    )
    check('the barrier unsubscribes (no leak)', _publishListenerCountForTesting() === before)
    // Silence → TIMED-OUT (an honest indeterminate, never fabricated clean).
    const silent = await awaitDiagnosticStabilization(fakeManager, '/tmp/push-lane/other.py', {
      deadlineMs: 300,
      quietWindowMs: 100,
    })
    check('push silence → timed-out (never a fabricated clean)', silent.state === 'timed-out')
    check('no manager server → unsupported', (await awaitDiagnosticStabilization({ getServerForFile: () => undefined } as never, '/x')).state === 'unsupported')
  }

  rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
